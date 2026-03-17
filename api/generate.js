// Branch mapping to German Google Maps search terms
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { branches, size, tier, custom } = req.body;
  if (!branches) {
    return res.status(400).json({ error: 'Branches parameter is required.' });
  }

  // ── Build the Google Maps search query ──
  const branchList = branches.split(',').map(b => b.trim());
  const searchTerms = branchList.map(b => BRANCH_SEARCH_MAP[b] || b).join(', ');
  const location = custom || 'Österreich';
  const query = `${searchTerms}, ${location}`;

  // Outscraper API Key
  const outscraperKey = process.env.OUTSCRAPER_API_KEY;
  if (!outscraperKey) {
    return res.status(500).json({ error: 'Outscraper API Key nicht konfiguriert.' });
  }

  // ── Call Outscraper Google Maps API ──
  // COST CONTROL: limit=20 means max 20 records per search = max 20 of your 500 free credits
  const params = new URLSearchParams({
    query: query,
    limit: '20',
    language: 'de',
    region: 'AT',
    async: 'false'
  });

  try {
    console.log(`Outscraper query: "${query}" (limit=20)`);

    const apiRes = await fetch(`https://api.leadsscraper.io/google-maps-search?${params.toString()}`, {
      method: 'GET',
      headers: {
        'X-API-KEY': outscraperKey,
        'Accept': 'application/json'
      }
    });

    if (!apiRes.ok) {
      const errorText = await apiRes.text();
      console.error('Outscraper error:', apiRes.status, errorText);
      return res.status(apiRes.status).json({ error: `Outscraper API Fehler: ${errorText.slice(0, 200)}` });
    }

    const apiData = await apiRes.json();

    // Outscraper returns { data: [[...places...]] } for single query
    let places = [];
    if (apiData.data && Array.isArray(apiData.data)) {
      // data is [[place1, place2, ...]] (array of arrays, one per query)
      if (Array.isArray(apiData.data[0])) {
        places = apiData.data[0];
      } else {
        places = apiData.data;
      }
    }

    if (places.length === 0) {
      return res.status(200).json({ leads: [], message: 'Keine Ergebnisse gefunden. Versuche einen anderen Standort oder Branche.' });
    }

    // ── Map Outscraper data to our lead format ──
    const leads = places
      .filter(p => p.name && p.business_status !== 'CLOSED_PERMANENTLY')
      .map(place => {
        // Clean up website URL (field is 'website', not 'site')
        let website = place.website || null;
        if (website) {
          // Decode percent-encoded URL first, then remove UTM tracking
          try {
            const decoded = decodeURIComponent(website);
            const url = new URL(decoded);
            url.searchParams.delete('utm_source');
            url.searchParams.delete('utm_medium');
            url.searchParams.delete('utm_campaign');
            url.searchParams.delete('utm_content');
            url.searchParams.delete('utm_term');
            website = url.toString();
          } catch {
            // Keep as-is if URL parsing fails
          }
        }

        // Build address string
        const addressParts = [place.street, place.postal_code, place.city].filter(Boolean);
        const region = addressParts.length > 0 ? addressParts.join(', ') : place.full_address || location;

        return {
          name: place.name,
          industry: place.type || branchList[0],
          employees: place.range || '',
          region: region,
          website: website,
          phone: place.phone || '',
          ceos: '', // Google Maps doesn't provide CEO info
          department_heads: '',
          contact_persons: '',
          focus: place.description || place.subtypes || '',
          contact: place.phone || '',
          rating: place.rating || null,
          reviews: place.reviews || 0,
          // Google Maps verified data flag
          google_verified: true
        };
      });

    return res.status(200).json({
      leads: leads,
      source: 'Google Maps (via Outscraper)',
      query: query,
      total: leads.length
    });

  } catch (error) {
    console.error('Outscraper fetch error:', error);
    return res.status(500).json({ error: error.message });
  }
}
