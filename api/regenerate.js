export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing the API key configuration.' });
  }

  const { type, lead, currentMessage } = req.body;

  let prompt = '';
  let maxTokens = 2000;

  if (type === 'initial') {
    if (!lead) return res.status(400).json({ error: 'Lead data is required.' });
    
    prompt = `Generiere 3 unterschiedliche LinkedIn-Nachrichten für:

Firma: ${lead.name}
Branche: ${lead.industry}
Mitarbeiter: ${lead.employees}

Template 1: FORMAL - Jobseite-Check + Potenzial
Template 2: DIREKT - Problem-Lösung-CTA
Template 3: ENGAGEMENT - Frage stellen

Alle: HF Media erwähnen, Link: https://www.hfmedia.at/recruiting

JSON Format:
{
  "template_1": "...",
  "template_2": "...",
  "template_3": "..."
}`;
  } else if (type === 'regenerate') {
    if (!lead || !currentMessage) return res.status(400).json({ error: 'Lead and currentMessage are required.' });
    maxTokens = 800;
    prompt = `Generiere eine NEUE Alternative zur folgenden LinkedIn-Nachricht für ${lead.name}:

Aktuelle Nachricht:
${currentMessage}

Gleicher Stil, aber komplett anders formuliert!

Gib NUR die Nachricht zurück.`;
  } else {
    return res.status(400).json({ error: 'Invalid type' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API Error:', errorText);
      return res.status(response.status).json({ error: 'Downstream API error' });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ error: error.message });
  }
}
