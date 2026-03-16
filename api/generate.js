// Industry to OpenStreetMap tag mapping
const BRANCH_OSM_MAP = {
  'Gastronomie': [['amenity', 'restaurant'], ['amenity', 'cafe'], ['amenity', 'fast_food'], ['amenity', 'bar']],
  'Hotellerie': [['tourism', 'hotel'], ['tourism', 'motel'], ['tourism', 'hostel']],
  'Wellness/Spa': [['leisure', 'spa'], ['leisure', 'fitness_centre'], ['shop', 'massage']],
  'Tourismus': [['tourism', 'attraction'], ['tourism', 'guest_house'], ['office', 'travel_agent']],
  'Handel': [['shop', 'supermarket'], ['shop', 'department_store'], ['shop', 'mall'], ['shop', 'clothes']],
  'Metalltechnik': [['craft', 'metal_construction'], ['industrial', 'factory']],
  'Industrie': [['landuse', 'industrial'], ['industrial', 'factory']],
  'Handwerk': [['craft', 'carpenter'], ['craft', 'electrician'], ['craft', 'plumber'], ['craft', 'builder']],
  'Logistik': [['office', 'logistics'], ['amenity', 'post_office']],
  'IT/Software': [['office', 'it'], ['office', 'software']],
  'Finanzen/Versicherung': [['office', 'financial'], ['office', 'insurance'], ['amenity', 'bank']],
  'Immobilien': [['office', 'estate_agent']],
  'Gesundheit/Pflege': [['amenity', 'hospital'], ['amenity', 'clinic'], ['amenity', 'pharmacy'], ['social_facility', 'nursing_home']],
  'Bildung': [['amenity', 'school'], ['amenity', 'university'], ['amenity', 'college']],
};

// Build an Overpass QL query filtering by multiple tag options in a radius
function buildOverpassQuery(lat, lon, radiusMeters, tagPairs) {
  const radius = Math.min(radiusMeters, 50000); // cap at 50km
  const unionParts = tagPairs
    .map(([k, v]) => `node["${k}"="${v}"](around:${radius},${lat},${lon});\nway["${k}"="${v}"](around:${radius},${lat},${lon});`)
    .join('\n');
  return `[out:json][timeout:25];
(\n${unionParts}\n);
out center 40;`;
}

// Geocode a location string to lat/lon using Nominatim (OpenStreetMap)
async function geocode(locationStr) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr + ', Österreich')}&format=json&limit=1&addressdetails=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'HFMediaRecruitingTool/1.0 (hfmedia.at)' }
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data || data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name };
}

// Extract useful info from OSM element
function osmElementToLead(el, branch) {
  const tags = el.tags || {};
  const lat = el.lat || el.center?.lat;
  const lon = el.lon || el.center?.lon;

  const name = tags.name || tags['name:de'] || null;
  if (!name) return null;

  const website = tags.website || tags['contact:website'] || tags.url || null;
  const phone = tags.phone || tags['contact:phone'] || tags['addr:phone'] || null;
  const street = tags['addr:street'] || '';
  const housenumber = tags['addr:housenumber'] || '';
  const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || '';
  const postcode = tags['addr:postcode'] || '';
  const region = [city, postcode].filter(Boolean).join(' ') || 'Österreich';

  const mapUrl = lat && lon ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=17` : null;

  return {
    name,
    industry: branch,
    employees: 'Bitte prüfen (nicht öffentlich)',
    region,
    address: [street, housenumber, postcode, city].filter(Boolean).join(' '),
    website: website || null,
    phone: phone || null,
    ceos: 'Bitte im Firmenbuch prüfen',
    department_heads: 'Bitte im Firmenbuch prüfen',
    contact_persons: 'Bitte im Firmenbuch prüfen',
    focus: `${branch} in ${region}`,
    contact: phone || website || 'Keine Angabe',
    mapUrl,
    verified: true,
    source: 'OpenStreetMap'
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing the API key configuration.' });
  }

  const { branches, size, tier, custom } = req.body;
  if (!branches) {
    return res.status(400).json({ error: 'Branches parameter is required.' });
  }

  const branchList = branches.split(',').map(b => b.trim());

  // Step 1: Try to get real data from OpenStreetMap
  let osmLeads = [];
  const locationQuery = custom || 'Österreich';

  try {
    const geo = await geocode(locationQuery);
    if (geo) {
      const radiusMeters = custom ? 20000 : 100000; // 20km if city given, 100km for Austria

      for (const branch of branchList) {
        const tagPairs = BRANCH_OSM_MAP[branch];
        if (!tagPairs) continue;

        const query = buildOverpassQuery(geo.lat, geo.lon, radiusMeters, tagPairs);
        const overpassResponse = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`
        });

        if (overpassResponse.ok) {
          const overpassData = await overpassResponse.json();
          const elements = overpassData.elements || [];
          for (const el of elements) {
            const lead = osmElementToLead(el, branch);
            if (lead && !osmLeads.find(l => l.name === lead.name)) {
              osmLeads.push(lead);
            }
            if (osmLeads.length >= 20) break;
          }
        }
        if (osmLeads.length >= 20) break;
      }
    }
  } catch (osmErr) {
    console.error('OSM lookup error:', osmErr.message);
    // Fall through to Claude fallback
  }

  // Step 2: Enrich OSM data with Claude if we have leads
  if (osmLeads.length > 0) {
    console.log(`Enriching ${osmLeads.length} OSM leads with Claude...`);
    
    // Create a simplified list for Claude to enrich
    const leadsToEnrich = osmLeads.map((l, idx) => ({
      id: idx,
      name: l.name,
      address: l.address || l.region,
      knownWebsite: l.website
    }));

    const enrichPrompt = `Hier ist eine Liste echter österreichischer Unternehmen mit sicheren Standorten.
Bitte durchsuche dein Wissen nach fehlenden Daten für diese Firmen.
Wenn du dir bei einer Information unsicher bist, gib null oder "K.A." zurück. Rate keine Websites und erfinde keine Personen!

WICHTIGSTE REGELN ZUR QUALITÄT:
- "website": Muss eine echte, existierende und exakte URL sein (z.B. "https://www.firma.at"). Wenn du die URL nicht sicher kennst, gib null zurück!
- "employees": Schätze eine realistische Bandbreite (z.B. "10-50", "200-500") anstatt einer exakten Zahl, wenn du unsicher bist.
- "ceos": Nur die echten Geschäftsführer eintragen (häufig aus dem Impressum bekannt).

Antworte AUSSCHLIESSLICH mit valider JSON:
{"enriched": [
  {
    "id": 0, // Muss mit der ID der Eingabe übereinstimmen
    "website": "Die echte Website URL oder null",
    "employees": "Schätzung der Mitarbeiter (z.B. '10-50')",
    "ceos": "Namen der Geschäftsführer (oder K.A.)",
    "department_heads": "Namen zuständiger Abteilungsleiter (oder K.A.)",
    "contact_persons": "HR etc. (oder K.A.)"
  }
]}

Firmenliste:
${JSON.stringify(leadsToEnrich, null, 2)}`;

    try {
      const enrichRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          system: 'Du bist ein JSON-Generator. Antworte NUR UND AUSSCHLIESSLICH mit validem JSON. Keine Markdown Blöcke. Beginne mit { und ende mit }',
          messages: [{ role: 'user', content: enrichPrompt }]
        })
      });

      if (enrichRes.ok) {
        const enrichData = await enrichRes.json();
        const rawText = enrichData?.content?.[0]?.text || '';
        const jsonStart = rawText.indexOf('{');
        const jsonEnd = rawText.lastIndexOf('}');
        
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
          if (parsed.enriched && Array.isArray(parsed.enriched)) {
            // Merge enriched data back into osmLeads
            parsed.enriched.forEach(eLead => {
              const original = osmLeads[eLead.id];
              if (original) {
                if (eLead.website && !original.website) original.website = eLead.website;
                if (eLead.employees && eLead.employees !== 'K.A.') original.employees = eLead.employees;
                if (eLead.ceos && eLead.ceos !== 'K.A.') original.ceos = eLead.ceos;
                if (eLead.department_heads && eLead.department_heads !== 'K.A.') original.department_heads = eLead.department_heads;
                if (eLead.contact_persons && eLead.contact_persons !== 'K.A.') original.contact_persons = eLead.contact_persons;
              }
            });
          }
        }
      }
    } catch (e) {
      console.error('Claude Enrichment failed (ignoring and returning bare OSM data):', e.message);
    }
  }

  // Step 3: If we got enough real data, return it
  if (osmLeads.length >= 5) {
    return res.status(200).json({ leads: osmLeads.slice(0, 20), source: 'openstreetmap + enriched' });
  }

  // Step 4: Fallback to Claude only for regions with extremely low OSM coverage
  console.log(`OSM returned only ${osmLeads.length} results, falling back to Claude.`);

  const prompt = `Generiere eine JSON-Liste mit ${20 - osmLeads.length} realen österreichischen Unternehmen.
Suchparameter:
- Branchen: ${branches}
${custom ? `- PFLICHT-Region: ${custom} (nur Firmen innerhalb von ~20km)` : ''}

Wichtig: Gib nur Firmen aus, die du mit über 90% Sicherheit kennst. Wenn du dir bei einer Domain nicht sicher bist, setze "website": null. Wenn du CEOs nicht kennst, setze "ceos": "Bitte prüfen". Antworte NUR mit JSON ohne Erklärungen.

Format: {"leads":[{"name":"...","industry":"...","employees":"...","region":"...","website":null,"phone":"...","ceos":"...","department_heads":"...","contact_persons":"...","focus":"...","contact":"..."}]}`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: 'Du bist ein JSON-Generator. Antworte NUR mit validem JSON. Beginne direkt mit { und ende mit }. Keine Markdown-Blöcke.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const errorText = await claudeRes.text();
      return res.status(claudeRes.status).json({ error: 'AI error', details: errorText });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData?.content?.[0]?.text || '';
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      return res.status(500).json({ error: 'Keine gültige Antwort. Bitte erneut versuchen.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
    } catch (e) {
      return res.status(500).json({ error: 'Claude hat ungültiges JSON geliefert. Bitte erneut versuchen.' });
    }

    const claudeLeads = (parsed.leads || []).map(l => ({ ...l, verified: false, source: 'AI-generiert (bitte prüfen)' }));
    const allLeads = [...osmLeads, ...claudeLeads].slice(0, 20);

    return res.status(200).json({ leads: allLeads, source: osmLeads.length > 0 ? 'mixed' : 'ai' });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
