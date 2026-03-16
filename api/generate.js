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

  const prompt = `Generiere eine JSON-Liste mit 20 realistischen staatlich eingetragenen österreichischen Unternehmen.

Suchparameter:
- Branchen: ${branches}
- Mitarbeitergröße: ${size || 'beliebig'}
${tier ? `- Tier: ${tier}` : ''}
${custom ? `- Suchregion/Firma: ${custom} (PFLICHT: Alle Firmen müssen sich in dieser Region befinden!)` : ''}

Antworte NUR mit einem validen JSON-Objekt ohne Erklärungen. Format:
{"leads":[{"name":"...","industry":"...","employees":"...","region":"...","website":"...","phone":"...","ceos":"...","department_heads":"...","contact_persons":"...","focus":"...","contact":"..."}]}`;

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
        system: 'Du bist ein JSON-Generator. Du antwortest AUSSCHLIESSLICH mit validem JSON. Kein Markdown, keine Erklärungen, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.',
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
    const rawText = data?.content?.[0]?.text || '';

    // Server-side robust JSON extraction and validation
    // Find the outermost { ... } block
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.error('No valid JSON block found in Claude response:', rawText.slice(0, 500));
      return res.status(500).json({ error: 'Keine gültige Antwort von Claude erhalten. Bitte erneut versuchen.' });
    }

    const jsonStr = rawText.slice(jsonStart, jsonEnd + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message, '\nRaw excerpt:', jsonStr.slice(0, 500));
      return res.status(500).json({ error: 'Claude hat ungültiges JSON geliefert. Bitte erneut versuchen.' });
    }

    if (!parsed.leads || !Array.isArray(parsed.leads)) {
      return res.status(500).json({ error: 'Ungültiges Antwortformat. Bitte erneut versuchen.' });
    }

    // Return pre-parsed leads directly (no more frontend JSON parsing needed)
    return res.status(200).json({ leads: parsed.leads });
  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ error: error.message });
  }
}
