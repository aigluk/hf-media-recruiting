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

// ── Legacy scraping removed for extreme token + speed efficiency ──

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

// Claude API removed.

// ════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const outscraperKey = process.env.OUTSCRAPER_API_KEY;
  const opendataKey = process.env.OPENDATA_HOST_API_KEY || 'F6F1-D72F-7FEF-468A-82AC-B620-3091-B593';
  if (!outscraperKey) return res.status(500).json({ error: 'Outscraper API Key fehlt.' });

  const { branches, size, tier, custom } = req.body;
  if (!branches) return res.status(400).json({ error: 'Branches parameter fehlt.' });

  // ── STEP 1: Outscraper → Real Google Maps data ──
  const branchList = branches.split(',').map(b => b.trim());
  const searchTerms = branchList.map(b => BRANCH_SEARCH_MAP[b] || b).join(', ');
  const location = custom || 'Österreich';
  const query = `${searchTerms}, ${location}`;

  // ── 90% Fill Rate Native Scraping Params ──
  const params = new URLSearchParams({ 
    query, 
    limit: '15', 
    language: 'de', 
    region: 'AT', 
    async: 'false',
    find_employees: 'true', 
    deep_scan: 'true',
    extract_social_profiles: 'true'
  });
  params.append('enrichment', 'company_insights,domains_service');

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
    return res.status(200).json({ leads: [], message: 'Keine Ergebnisse.' });
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
        if (e.includes('http') || e.includes('google.com') || e.includes('sentry') || e.includes('.png')) return false;
        return strictEmailRegex.test(e);
      });
      
      const uniqueEmails = [...new Set(cleanEmails)];
      let email_general = '';
      let email_ceo = '';

      const generalIndex = uniqueEmails.findIndex(e => e.startsWith('info@') || e.startsWith('office@') || e.startsWith('kontakt@'));
      if (generalIndex !== -1) {
        email_general = uniqueEmails[generalIndex];
        uniqueEmails.splice(generalIndex, 1);
      } else if (uniqueEmails.length > 0) {
        email_general = uniqueEmails[0];
        uniqueEmails.shift();
      }
      if (uniqueEmails.length > 0) email_ceo = uniqueEmails[0];
      
      let emails = [email_general, email_ceo].filter(Boolean).join(', ');
      let description = place.description || (Array.isArray(place.subtypes) ? place.subtypes.join(', ') : '') || '';

      // Prioritize structured person data from Outscraper
      let ceo_name = '';
      for (let i = 1; i <= 20; i++) {
        const title = place[`email_${i}_title`] || '';
        const role = place[`email_${i}_role`] || '';
        if (/(ceo|geschäftsführer|inhaber|founder|owner|direktor|vorstand)/i.test(title + ' ' + role)) {
           ceo_name = place[`email_${i}_full_name`] || (place[`email_${i}_first_name`] ? (place[`email_${i}_first_name`] + ' ' + place[`email_${i}_last_name`]) : '');
           if (ceo_name) break;
        }
      }
      
      let owner = ceo_name ? ceo_name.trim() : (place.owner_name || '');
      if (owner && owner.toLowerCase().trim() === place.name.toLowerCase().trim()) owner = '';
      
      return {
        name: place.name,
        industry: branchList[0] || '',
        region: addressParts.join(', ') || place.full_address || location,
        website,
        phone: place.phone || '',
        emails: emails,
        email_general: email_general,
        email_ceo: email_ceo,
        ceos: owner,
        description: description,
        rating: place.rating || null,
        reviews: place.reviews || 0,
        google_verified: true,
        createdAt: new Date().toISOString(),
        statusDate: new Date().toLocaleString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
      };
    });

  // ── STEP 2: Opendata Verification ──
  await Promise.all(baseleads.map(async (lead) => {
    const fb = await lookupFirmenbuch(lead.name, opendataKey);
    if (!fb) return;
    if (fb.address) lead.region = fb.address;
    if (fb.ceo && fb.ceo.split(/\s+/).length >= 2) {
      lead.ceos = fb.ceo;
      lead.firmenbuch_ceo = true;
    }
  }));

  // ── STEP 3: Sync Status from KV ──
  let kvStatuses = {};
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
      const encodeKey = (str) => btoa(unescape(encodeURIComponent(str)));
      const keys = baseleads.map(l => 'lead_status_' + encodeKey(l.name + '|' + l.region));
      if (keys.length > 0) {
        const values = await kv.mget(...keys);
        keys.forEach((k, i) => { if (values[i]) kvStatuses[k] = values[i]; });
      }
    } catch(e) { console.warn('KV failed:', e); }
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
    source: 'Google Maps + Emails & Company Insights (Outscraper) + Firmenbuch (opendata.host)',
    query,
    total: baseleads.length,
    ceoFound: ceoCount
  });
}
