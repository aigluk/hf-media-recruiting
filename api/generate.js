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

  const prompt = `Generiere 20 realistische österreichische Unternehmen für:

Branchen: ${branches}
Mitarbeitergröße: ${size || 'beliebig'}
${tier ? `Tier: ${tier}` : ''}
${custom ? `MUSS-KRITERIUM (Ort/Name/Fokus): ${custom} - Generiere AUSSCHLIESSLICH Firmen, die exakt zu diesem Begriff passen (z.B. in genau dieser Stadt/Region lokalisiert sind). Erfinde keine Orte!` : ''}

WICHTIGE REGELN:
1. Nutze ECHTE Firmennamen und echte Daten aus Österreich.
2. Gib AUSSCHLIESSLICH valides JSON zurück. Kein Text davor, kein Text danach.
3. Formatiere den Output als striktes, valides Standard-JSON. Wenn du Anführungszeichen innerhalb von Text-Feldern verwendest, MUSST du diese mit einem Backslash maskieren (\"), z.B. "description": "Das ist ein \"Test\"".
4. Schließe alle Arrays und Objekte korrekt. Das bedeutet: am Ende muss das JSON fehlerfrei mit } enden.

JSON Format EXAKT:
{
  "leads": [
    {
      "name": "Firmenname",
      "industry": "Branche",
      "employees": "Zahl",
      "region": "Region (Muss zu ${custom || 'Österreich'} passen)",
      "website": "domain.at",
      "phone": "Telefonnummer (aus Firmenbuch/Web)",
      "ceos": "Namen der Geschäftsführer/CEOs",
      "department_heads": "Namen zuständiger Abteilungsleiter",
      "contact_persons": "Sonstige wichtige Kontaktpersonen (HR etc.)",
      "focus": "Kurzbeschreibung: Was macht die Firma genau und worauf sind sie spezialisiert?",
      "contact": "Zentrale Kontaktinfo"
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
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API Error:', errorText);
      try {
        const errorJson = JSON.parse(errorText);
        return res.status(response.status).json({ error: errorJson.error?.message || 'Downstream API error', details: errorJson });
      } catch (e) {
        return res.status(response.status).json({ error: errorText || 'Downstream API error' });
      }
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ error: error.message });
  }
}
