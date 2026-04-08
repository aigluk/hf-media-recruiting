// Temporärer Debug-Endpoint: zeigt rohe Company Insights Antwort
export default async function handler(req, res) {
  const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.OUTSCRAPER_API_KEY;
  const domain = req.query.domain || 'ronacher.com';

  const params = new URLSearchParams({ query: domain, async: 'false' });
  try {
    const r = await fetch(`https://api.outscraper.com/company-insights?${params}`, {
      headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { return res.status(200).json({ raw: text }); }
    return res.status(200).json({ status: r.status, data: json });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
