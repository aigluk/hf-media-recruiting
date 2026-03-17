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

// ── Fetch URL with timeout ──
async function fetchUrl(url, ms = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      redirect: 'follow'
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text')) return null;
    return await r.text();
  } catch { return null; }
}

// ── Scrape CEO from impressum page ──
async function scrapeCeoFromImprint(websiteUrl) {
  if (!websiteUrl) return null;
  const base = websiteUrl.replace(/\/+$/, '');
  // Try /impressum first (fast), then homepage as fallback
  const html = await fetchUrl(`${base}/impressum`) || await fetchUrl(base);
  if (!html) return null;
  // Strip HTML tags for cleaner text matching
  const text = html.replace(/<style[^>]*>.*?<\/style>/gis, '')
                   .replace(/<script[^>]*>.*?<\/script>/gis, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ');

  const patterns = [
    /Gesch[äa]ftsf[üu]hr(?:er|erin|ung)\s*:?\s*(?:(?:Mag|Dr|Ing|DI)\.?\s+)?([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?\s+[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/,
    /Inhaber(?:in)?\s*:?\s*(?:(?:Mag|Dr|Ing|DI)\.?\s+)?([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/,
    /(?:Eigent[üu]mer|Betreiber)(?:in)?\s*:?\s*([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/,
    /CEO\s*:?\s*([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const name = m[1].trim();
      if (name.split(/\s+/).length >= 2) return name;
    }
  }
  return null;
}

// ── Parse JSON even if wrapped in markdown fences ──
function parseJsonSafe(text) {
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
}

// ── Claude batch CEO lookup ──
async function lookupCeosWithClaude(leads, apiKey) {
  const companyList = leads.map((l, i) =>
    `${i + 1}. "${l.name}", ${l.region}`
  ).join('\n');

  const prompt = `Diese Firmen wurden live von Google Maps verifiziert und existieren wirklich.
Nenne den Geschäftsführer/Inhaber jeder Firma (Vorname Nachname). Nur wenn du ihn wirklich kennst — sonst null.

${companyList}

JSON Antwort: {"1": "Name oder null", "2": "Name oder null", ...}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'Antworte NUR mit einem JSON-Objekt. Kein Markdown, kein Text davor/danach. Format: {"1":"Name","2":null}',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) return {};
    const d = await r.json();
    const parsed = parseJsonSafe(d?.content?.[0]?.text || '');
    return parsed || {};
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

  // ── Map base fields ──
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

  // ── STEP 2 + 3 in parallel: Impressum scraping AND Claude CEO lookup simultaneously ──
  const [ceoMap] = await Promise.all([
    // Claude batch lookup
    lookupCeosWithClaude(baseleads, claudeKey),
    // Impressum scraping for all leads with websites (runs in parallel with Claude)
    Promise.all(baseleads.map(async (lead) => {
      if (lead.website) {
        const ceo = await scrapeCeoFromImprint(lead.website);
        if (ceo) lead.ceos = ceo; // Write directly, scraped data is preferred
      }
    }))
  ]);

  // Apply Claude results only where scraping found nothing
  baseleads.forEach((lead, i) => {
    if (!lead.ceos) {
      const ceo = ceoMap[String(i + 1)];
      if (ceo && typeof ceo === 'string' && ceo !== 'null' && ceo.split(/\s+/).length >= 2) {
        lead.ceos = ceo.trim();
      }
    }
  });

  const ceoCount = baseleads.filter(l => l.ceos).length;
  return res.status(200).json({
    leads: baseleads,
    source: 'Google Maps (Outscraper) + Impressum Scraping + Claude',
    query,
    total: baseleads.length,
    ceoFound: ceoCount
  });
}
