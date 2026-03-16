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

  const prompt = `Du bist ein professioneller Daten-Rechercheur für b2b Lead-Generierung in Österreich.
Deine Aufgabe ist es, exakt 20 hochqualitative, ECHTE Unternehmen zu finden, die im österreichischen Firmenbuch (WKO/FirmenABC) stehen.

SUCHKRITERIEN:
- Branchen: ${branches}
- Mitarbeitergröße: ${size || 'beliebig'}
${tier ? `- Tier: ${tier}` : ''}
${custom ? `- ZWINGENDER STANDORT/ZUSATZ: ${custom}` : ''}

WICHTIGSTE QUALITÄTSREGELN (BEI NICHTEINHALTUNG SCHEITERT DER PROZESS):
1. **Standort-Treue:** Wenn ein Ort (z.B. "Salzburg", "Wels") angegeben ist, MÜSSEN alle Firmen physisch exakt dort oder im unmittelbaren Umkreis (max. 5-10km) sein. Keine Firmen aus Wien, wenn Salzburg gefragt ist!
2. **Echte Websiten:** Erfinde NIEMALS eine URL. Gib die exakte Webadresse an (z.B. "https://www.firma.at"). Wenn die Firma keine Website hat oder du sie nicht zu 100% kennst, lass das Feld leer oder schreibe "K.A.". Keine "null" Strings!
3. **Echte CEOs & Kontakte:** Recherchiere die echten Geschäftsführer (wie im Impressum/Firmenbuch). Wenn unbekannt, schreibe "K.A.".
4. **Telefonnummern:** Gib die echte Telefonnummer der Zentrale an (oder "K.A.").

Antworte NUR mit einem validen JSON-Objekt. Kein Text davor, kein Text danach.

JSON Format EXAKT:
{
  "leads": [
    {
      "name": "Echter Firmenname",
      "industry": "Branche",
      "employees": "Realistische Schätzung (z.B. 10-50)",
      "region": "Genauer Ort/Adresse (z.B. Salzburg Stadt)",
      "website": "Die echte URL (oder K.A.)",
      "phone": "Echte Telefonnummer (oder K.A.)",
      "ceos": "Name(n) der echten Geschäftsführer (oder K.A.)",
      "department_heads": "K.A.",
      "contact_persons": "K.A.",
      "focus": "Kurzbeschreibung: Was macht die Firma genau?",
      "contact": "E-Mail oder Telefon (oder K.A.)"
    }
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 6000,
        system: 'Du bist ein reiner JSON-Generator. Antworte AUSSCHLIESSLICH mit validem Standard-JSON. Beginne direkt mit { und beende mit }.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        return res.status(response.status).json({ error: errorJson.error?.message || 'Downstream API error', details: errorJson });
      } catch (e) {
        return res.status(response.status).json({ error: errorText || 'Downstream API error' });
      }
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text || '';

    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      return res.status(500).json({ error: 'Keine gültige Antwort von Claude erhalten.' });
    }

    const jsonStr = rawText.slice(jsonStart, jsonEnd + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Claude JSON Error' });
    }

    if (!parsed.leads || !Array.isArray(parsed.leads)) {
      return res.status(500).json({ error: 'Ungültiges Antwortformat.' });
    }

    // Sanitize leads to remove 'null' strings or undefined, enforcing "K.A."
    const cleanLeads = parsed.leads.map(lead => {
      const isAbsent = (val) => !val || val === 'null' || val === 'K.A.' || val === 'N/A' || val.trim() === '';
      return {
        ...lead,
        website: isAbsent(lead.website) ? null : lead.website,
        phone: isAbsent(lead.phone) ? 'K.A.' : lead.phone,
        ceos: isAbsent(lead.ceos) ? 'K.A.' : lead.ceos,
        contact: isAbsent(lead.contact) ? 'K.A.' : lead.contact,
        source: 'Claude AI (Generiert)'
      };
    });

    return res.status(200).json({ leads: cleanLeads });
  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ error: error.message });
  }
}
