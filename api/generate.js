// ── Branch mapping to German Google Maps search terms ──
const BRANCH_SEARCH_MAP = {
  'Gastronomie': 'Restaurants',
  'Hotellerie': 'Hotels',
  'Wellness/Spa': 'Wellness Spa',
  'Tourismus': 'Tourismus Sehenswürdigkeiten',
  'Handel': 'Einzelhandel Geschäfte',
  'Metalltechnik': 'Metalltechnik Metallbau',
  'Industrie': 'Industrieunternehmen',
  'Handwerk': 'Handwerksbetriebe',
  'Logistik': 'Logistik Spedition',
  'IT/Software': 'IT Software Unternehmen',
  'Finanzen/Versicherung': 'Finanzberatung Versicherung',
  'Immobilien': 'Immobilien Makler',
  'Gesundheit/Pflege': 'Arztpraxis Pflegeheim Apotheke',
};

// ── Fetch a URL with timeout ──
async function fetchWithTimeout(url, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow'
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text')) return null;
    return await r.text();
  } catch { return null; }
}

// ── Scrape CEO name from impressum/homepage ──
async function scrapeCeoFromWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  const base = websiteUrl.replace(/\/+$/, '');
  const [homeHtml, impressumHtml] = await Promise.all([
    fetchWithTimeout(base, 2500),
    fetchWithTimeout(`${base}/impressum`, 2500)
  ]);
  const html = (homeHtml || '') + ' ' + (impressumHtml || '');
  if (!html.trim()) return null;

  // Strip all HTML tags first for cleaner matching
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const patterns = [
    /Gesch[äa]ftsf[üu]hr(?:er|erin|ung)[:\s,]+([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/,
    /Inhaber(?:in)?[:\s,]+([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/,
    /(?:Eigent[üu]mer|Betreiber)(?:in)?[:\s,]+([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+)/,
    /CEO[:\s]+([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+)/,
    /(?:Mag\.|Dr\.|Ing\.|DI|DI\(FH\))\.?\s+([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+)/,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const name = m[1].trim();
      if (name.split(' ').length >= 2) return name;
    }
  }
  return null;
}

// ── Claude batch CEO lookup for verified companies ──
async function lookupCeosWithClaude(leads, apiKey) {
  const needsCeo = leads.filter(l => !l.ceos);
  if (needsCeo.length === 0) return {};

  const companyList = needsCeo.map((l, i) =>
    `${i + 1}. "${l.name}" — ${l.region}`
  ).join('\n');

  const prompt = `Du bist ein österreichischer Firmenrecherche-Experte.

Suche den Geschäftsführer (GF) oder Inhaber für jede der folgenden ECHTEN, verifizierten Firmen.
Diese Firmen existieren wirklich — sie stammen direkt von Google Maps.
Antworte NUR wenn du den Namen mit hoher Sicherheit kennst (aus Firmenbuch, Impressum, Presseberichten).
Erfinde KEINE Namen.

${companyList}

Antworte NUR als JSON: {"results": {"1": "Vorname Nachname", "2": null, "3": "Vorname Nachname", ...}}
Verwende null wenn du den Namen nicht sicher kennst.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'Du bist ein österreichischer Firmenrecherche-Experte. Antworte AUSSCHLIESSLICH mit validem JSON. Erfinde keine Namen — nur Namen die du wirklich kennst.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) return {};
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1) return {};
    const parsed = JSON.parse(text.slice(start, end + 1));
    // Map back: results is { "1": "Name", ... } — convert to { companyName: ceo }
    const map = {};
    needsCeo.forEach((l, i) => {
      const ceo = parsed.results?.[String(i + 1)];
      if (ceo && typeof ceo === 'string' && ceo.trim().split(' ').length >= 2) {
        map[l.name] = ceo.trim();
      }
    });
    return map;
  } catch { return {}; }
}

// ════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const outscraperKey = process.env.OUTSCRAPER_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!outscraperKey) return res.status(500).json({ error: 'Outscraper API Key fehlt.' });
  if (!claudeKey) return res.status(500).json({ error: 'Anthropic API Key fehlt.' });

  const { branches, size, tier, custom } = req.body;
  if (!branches) return res.status(400).json({ error: 'Branches parameter fehlt.' });

  // ── STEP 1: Outscraper → Real Google Maps data ──
  const branchList = branches.split(',').map(b => b.trim());
  const searchTerms = branchList.map(b => BRANCH_SEARCH_MAP[b] || b).join(', ');
  const location = custom || 'Österreich';
  const query = `${searchTerms}, ${location}`;

  const params = new URLSearchParams({ query, limit: '20', language: 'de', region: 'AT', async: 'false' });

  let places = [];
  try {
    const apiRes = await fetch(`https://api.leadsscraper.io/google-maps-search?${params}`, {
      headers: { 'X-API-KEY': outscraperKey, 'Accept': 'application/json' }
    });
    if (!apiRes.ok) {
      const e = await apiRes.text();
      return res.status(apiRes.status).json({ error: `Outscraper Fehler: ${e.slice(0, 200)}` });
    }
    const apiData = await apiRes.json();
    if (apiData.data && Array.isArray(apiData.data)) {
      places = Array.isArray(apiData.data[0]) ? apiData.data[0] : apiData.data;
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (places.length === 0) {
    return res.status(200).json({ leads: [], message: 'Keine Ergebnisse. Versuche einen anderen Standort oder Branche.' });
  }

  // ── Map base fields from Outscraper ──
  const baseleads = places
    .filter(p => p.name && p.business_status !== 'CLOSED_PERMANENTLY')
    .map(place => {
      let website = place.website || null;
      if (website) {
        try {
          const decoded = decodeURIComponent(website);
          const url = new URL(decoded);
          ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(p => url.searchParams.delete(p));
          website = url.toString();
        } catch { /* keep as-is */ }
      }
      const addressParts = [place.street, place.postal_code, place.city].filter(Boolean);
      return {
        name: place.name,
        industry: place.type || branchList[0],
        employees: place.range || '',
        region: addressParts.join(', ') || place.full_address || location,
        website,
        phone: place.phone || '',
        ceos: '',
        department_heads: '',
        contact_persons: '',
        focus: place.description || place.subtypes || '',
        contact: place.phone || '',
        rating: place.rating || null,
        reviews: place.reviews || 0,
        google_verified: true
      };
    });

  // ── STEP 2: Scrape each website's /impressum for CEO name (parallel) ──
  await Promise.all(baseleads.map(async (lead) => {
    if (lead.website) {
      const ceo = await scrapeCeoFromWebsite(lead.website);
      if (ceo) lead.ceos = ceo;
    }
  }));

  // ── STEP 3: Claude batch lookup for companies still missing CEO ──
  const ceoMap = await lookupCeosWithClaude(baseleads, claudeKey);
  baseleads.forEach(lead => {
    if (!lead.ceos && ceoMap[lead.name]) {
      lead.ceos = ceoMap[lead.name];
    }
  });

  return res.status(200).json({
    leads: baseleads,
    source: 'Google Maps (Outscraper) + Impressum Scraping + Claude CEO Lookup',
    query,
    total: baseleads.length
  });
}
