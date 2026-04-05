import { kv } from '@vercel/kv';

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

// ── OpenData Firmenbuch lookup ──
async function lookupFirmenbuch(companyName, apiKey) {
  if (!apiKey || !companyName) return null;
  try {
    const params = new URLSearchParams({ 'company-name': companyName, 'country': 'at', 'limit': '3' });
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(`http://api.opendata.host/1.0/registered-companies/find?${params}`, {
      headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.companies || data.companies.length === 0) return null;
    const c = data.companies[0];
    const addr = c.address || {};
    const street = [addr.street, addr.house_number].filter(Boolean).join(' ');
    const fullAddress = [street, addr.zip, addr.city].filter(Boolean).join(', ');
    const ceo = (c.officers || []).find(o => /(geschäftsführer|gf|ceo|inhaber|vorstand)/i.test(o.role || ''));
    return {
      address: fullAddress || null,
      city: addr.city || null,
      zip: addr.zip || null,
      ceo: ceo ? `${ceo.first_name || ''} ${ceo.last_name || ''}`.trim() : null,
      legalForm: c.legal_form || null
    };
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

// ── Aggressive deep search for emails ──
function extractEmails(obj) {
  let found = [];
  if (typeof obj === 'string') {
    if (obj.includes('@') && obj.includes('.')) found.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) found.push(...extractEmails(item));
  } else if (obj !== null && typeof obj === 'object') {
    for (const key in obj) found.push(...extractEmails(obj[key]));
  }
  return found;
}

// ── Claude batch CEO lookup ──
async function lookupCeosWithClaude(leads, apiKey) {
  const companyList = leads.map((l, i) =>
    `${i + 1}. "${l.name}", ${l.region}`
  ).join('\n');

  const prompt = `Diese Firmen wurden live von Google Maps verifiziert und existieren wirklich.
Erstelle für JEDE Firma ZWEI Dinge:
1. Den exakten Geschäftsführer/Inhaber (Vorname Nachname). GANZ WICHTIG: Gib niemals einfach den Firmennamen an, es sei denn, der Firmenname ist ein 100% echter Personenname (z.B. "Erwin Hausermaier"). Wenn du den Geschäftsführer nicht sofort kennst, suche fiktiv mit dem exakten Firmennamen auf Firmenbuch ABC / firmenabc.at, gehe zu "handelnde Personen" und extrahiere dort den Geschäftsführer. Damit es sicher richtig ist! Wenn kein Personenname auffindbar ist, antworte zwingend mit "null".
2. Eine flüssige, sehr gut lesbare 3-5 zeilige Zusammenfassung auf Deutsch, was diese Firma genau macht (Schwerpunkt, Angebot). Dies ersetzt ein leeres [object Object].

${companyList}

Antworte NUR mit diesem exakten JSON Format:
{
  "1": { "ceo": "Vorname Nachname oder null", "summary": "Die 3-5 zeilige Zusammenfassung..." },
  "2": { "ceo": "Name oder null", "summary": "..." }
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: 'Antworte NUR mit einem JSON-Objekt. Kein Markdown, kein Text davor/danach. Format wie vorgegeben.',
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
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const outscraperKey = process.env.OUTSCRAPER_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const opendataKey = process.env.OPENDATA_HOST_API_KEY;
  if (!outscraperKey) return res.status(500).json({ error: 'Outscraper API Key fehlt.' });
  if (!claudeKey) return res.status(500).json({ error: 'Anthropic API Key fehlt.' });

  const { branches, size, tier, custom } = req.body;
  if (!branches) return res.status(400).json({ error: 'Branches parameter fehlt.' });

  // ── STEP 1: Outscraper → Real Google Maps data ──
  const branchList = branches.split(',').map(b => b.trim());
  const searchTerms = branchList.map(b => BRANCH_SEARCH_MAP[b] || b).join(', ');
  const location = custom || 'Österreich';
  const query = `${searchTerms}, ${location}`;
  // Reduced limit from 40 to 15 to prevent 30s Serverless 504 Execution Timeout
  const params = new URLSearchParams({ query, limit: '15', language: 'de', region: 'AT', async: 'false' });
  params.append('enrichment', 'domains_service'); // Emails & Contacts Scraper

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
      
      const rawEmails = extractEmails(place);
      const strictEmailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      const cleanEmails = rawEmails.map(e => typeof e === 'string' ? e.trim().toLowerCase() : '').filter(e => {
        if (!e) return false;
        if (e.includes('http') || e.includes('://') || e.includes('google.com') || e.includes('maps.google') || e.includes('sentry') || e.includes('.png') || e.includes('.jpg') || e.includes('.gif')) return false;
        return strictEmailRegex.test(e);
      });
      
      const uniqueEmails = [...new Set(cleanEmails)];
      let email_general = '';
      let email_ceo = '';

      const generalIndex = uniqueEmails.findIndex(e => e.startsWith('info@') || e.startsWith('office@') || e.startsWith('kontakt@') || e.startsWith('hallo@') || e.startsWith('welcome@'));
      if (generalIndex !== -1) {
        email_general = uniqueEmails[generalIndex];
        uniqueEmails.splice(generalIndex, 1);
      } else if (uniqueEmails.length > 0) {
        email_general = uniqueEmails[0];
        uniqueEmails.shift();
      }

      if (uniqueEmails.length > 0) {
        email_ceo = uniqueEmails[0];
      }
      
      let emails = [email_general, email_ceo].filter(Boolean).join(', ');

      // Fallback description in case Claude fails
      let description = place.description || (Array.isArray(place.subtypes) ? place.subtypes.join(', ') : '') || '';

      let ceo_name = '';
      for (let i = 1; i <= 10; i++) {
        const title = place[`email_${i}_title`] || '';
        if (/(ceo|geschäftsführer|inhaber|founder|owner|manager|direktor)/i.test(title)) {
           ceo_name = place[`email_${i}_full_name`] || (place[`email_${i}_first_name`] ? (place[`email_${i}_first_name`] + ' ' + place[`email_${i}_last_name`]) : '');
           break;
        }
      }
      if (!ceo_name || ceo_name.trim() === 'null') {
         for (let i = 1; i <= 10; i++) {
            if (place[`email_${i}_full_name`]) {
               ceo_name = place[`email_${i}_full_name`];
               break;
            }
         }
      }
      
      let owner = ceo_name ? ceo_name.trim() : (place.owner_name || place.owner_title || '');
      if (owner && owner.toLowerCase().trim() === place.name.toLowerCase().trim()) {
        owner = '';
      }
      
      return {
        name: place.name,
        industry: branchList[0] || '', // Force user-selected branch instead of place.type
        employees: place.range || '',
        region: addressParts.join(', ') || place.full_address || location,
        website,
        phone: place.phone || '',
        emails: emails,
        email_general: email_general,
        email_ceo: email_ceo,
        owner: owner,
        ceos: owner, // Will be updated by scraping/Claude if empty
        department_heads: '',
        contact_persons: '',
        description: description,
        focus: description,
        contact: place.phone || '',
        rating: place.rating || null,
        reviews: place.reviews || 0,
        google_verified: true,
        createdAt: new Date().toISOString(),
        statusDate: new Date().toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' })
      };
    });

  // ── STEP 2 + 3 + 4 in parallel: Firmenbuch + Impressum scraping + Claude ──
  const [ceoMap] = await Promise.all([
    // Claude batch lookup
    lookupCeosWithClaude(baseleads, claudeKey),
    // Impressum scraping for all leads with websites
    Promise.all(baseleads.map(async (lead) => {
      if (lead.website) {
        const ceo = await scrapeCeoFromImprint(lead.website);
        if (ceo) lead.ceos = ceo;
      }
    })),
    // Firmenbuch lookup — overrides address + CEO with official data
    Promise.all(baseleads.map(async (lead) => {
      const fb = await lookupFirmenbuch(lead.name, opendataKey);
      if (!fb) return;
      if (fb.address) {
        lead.region = fb.address;
        lead.firmenbuch_address = fb.address;
      }
      if (fb.ceo && fb.ceo.split(/\s+/).length >= 2) {
        lead.ceos = fb.ceo;
        lead.firmenbuch_ceo = true;
      }
      if (fb.legalForm) lead.legalForm = fb.legalForm;
    }))
  ]);

  // Apply Claude results only where Firmenbuch + scraping found nothing
  baseleads.forEach((lead, i) => {
    const claudeData = ceoMap[String(i + 1)];
    if (claudeData) {
      if (!lead.ceos && claudeData.ceo && typeof claudeData.ceo === 'string' && claudeData.ceo !== 'null' && claudeData.ceo.split(/\s+/).length >= 2) {
        lead.ceos = claudeData.ceo.trim();
      }
      if (claudeData.summary && typeof claudeData.summary === 'string' && claudeData.summary.length > 10) {
        lead.description = claudeData.summary;
        lead.focus = claudeData.summary;
      }
    }
  });

  // Fallback has been removed as per user request (no auto-converting company names to CEOs).

  // ── Sync with global Vercel KV if available ──
  let kvStatuses = {};
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
      const encodeKey = (str) => btoa(unescape(encodeURIComponent(str)));
      const keys = baseleads.map(l => 'lead_status_' + encodeKey(l.name + '|' + l.region));
      if (keys.length > 0) {
        const values = await kv.mget(...keys);
        keys.forEach((k, i) => {
          if (values[i]) kvStatuses[k] = values[i];
        });
      }
    } catch(e) {
      console.warn('KV mget failed:', e);
    }
  }

  baseleads.forEach(l => {
    const btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
    const encodeKey = (str) => btoa(unescape(encodeURIComponent(str)));
    const key = 'lead_status_' + encodeKey(l.name + '|' + l.region);
    l.status = kvStatuses[key] || 'Neu/Offen';
  });

  const ceoCount = baseleads.filter(l => l.ceos).length;
  return res.status(200).json({
    leads: baseleads,
    source: 'Google Maps (Outscraper) + Firmenbuch (opendata.host) + Impressum Scraping + Claude',
    query,
    total: baseleads.length,
    ceoFound: ceoCount
  });
}
