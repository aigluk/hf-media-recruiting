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

// ── Single Claude batch call: CEO lookup for all 20 verified companies ──
async function lookupCeosWithClaude(leads, apiKey) {
  const companyList = leads.map((l, i) =>
    `${i + 1}. "${l.name}", ${l.region}`
  ).join('\n');

  const prompt = `Diese Firmen wurden soeben live von Google Maps abgerufen und sind 100% real und verifiziert.

Deine Aufgabe: Nenne den Geschäftsführer (GF), Inhaber oder CEO jeder Firma.
- Nur echte Namen (Vorname + Nachname) die du aus deinem Trainingswissen kennst.
- Wenn du einen Namen nicht sicher weißt: null.
- KEINE erfundenen Namen.

${companyList}

Antworte NUR als JSON:
{"1": "Vorname Nachname", "2": null, "3": "Vorname Nachname"}`;

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
        max_tokens: 1500,
        system: 'Antworte ausschließlich mit validem JSON. Kein Markdown, kein Text davor oder danach.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) return {};
    const data = await res.json();
    const text = (data?.content?.[0]?.text || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1) return {};
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed; // { "1": "Name", "2": null, ... }
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

  // ── STEP 2: Claude fast batch CEO lookup for all verified companies ──
  const ceoMap = await lookupCeosWithClaude(baseleads, claudeKey);
  baseleads.forEach((lead, i) => {
    const ceo = ceoMap[String(i + 1)];
    if (ceo && typeof ceo === 'string' && ceo.trim().split(/\s+/).length >= 2) {
      lead.ceos = ceo.trim();
    }
  });

  return res.status(200).json({
    leads: baseleads,
    source: 'Google Maps (Outscraper) + Claude CEO Lookup',
    query,
    total: baseleads.length
  });
}
