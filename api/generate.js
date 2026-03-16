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
${custom ? `Zusatz: ${custom}` : ''}

Nutze ECHTE Firmennamen wenn möglich.

JSON Format EXAKT:
{
  "leads": [
    {
      "name": "Firmenname",
      "industry": "Branche",
      "employees": "Zahl",
      "region": "Region",
      "website": "domain.at",
      "focus": "Beschreibung",
      "contact": "HR/Leitung"
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
        model: 'claude-3-haiku-20240307',
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
