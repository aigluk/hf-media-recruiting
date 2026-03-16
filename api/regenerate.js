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
Website: ${lead.website}
Kontakt/CEO: ${lead.ceos || lead.contact || 'zuständige Leitung'}

WICHTIGE REGELN:
1. Absolut KEINE Emojis verwenden!
2. Schreibe immer in der Ich-Form ("ich" statt "wir"), außer bei "Wir von HF Media".
3. Kurz, modern, direkt und nicht schleimig.
4. Alle Varianten müssen den Link enthalten: https://www.hfmedia.at/recruiting

Variante 1: Exakt diese Struktur (Variablen sinnvoll füllen):
"Sehr geehrte(r) Herr/Frau [Name] (oder zuständige Leitung),
ich hab mir eure Jobseite auf [Website] angesehen. Der Auftritt schaut echt sauber aus und wirkt sehr professionell.
Gerade in der [Branche] ist ja die schnelle Besetzung oft der kritischste Punkt. Ich seh da bei euch noch einiges an Potenzial, wie man das Recruiting für die Gen Z deutlich nachhaltiger, effizienter und vor allem kostengünstiger hinkriegt als über das klassische Netzwerk oder teure Zeitungs-Inserate. Wir von HF Media sind genau darauf spezialisiert.
Ich würd euch das einfach mal kurz unverbindlich in einer 10-Minuten-Bedarfsanalyse kostenlos auschecken und die Hebel zeigen. Wenn's danach für Sie spannend klingt, können wir uns kurz dazu austauschen, wenn nicht, ist das natürlich auch völlig okay.
Vorab-Infos: https://www.hfmedia.at/recruiting"

Variante 2: Ähnlich, aber etwas frecher & direkter (auf ein akutes Problem bezogen).
Variante 3: Kurz & knackig (Fokus auf Kosteneinsparung & Zeitgewinn).

JSON Format:
{
  "template_1": "...",
  "template_2": "...",
  "template_3": "..."
}`;
  } else if (type === 'regenerate') {
    if (!lead || !currentMessage) return res.status(400).json({ error: 'Lead and currentMessage are required.' });
    maxTokens = 800;
    prompt = `Generiere eine NEUE Alternative zur folgenden LinkedIn-Nachricht für ${lead.name}.

Aktuelle Nachricht:
${currentMessage}

WICHTIGE REGELN:
1. Absolut KEINE Emojis!
2. Schreibe immer in der Ich-Form ("ich" statt "wir"), außer bei "Wir von HF Media".
3. Kurz, modern, direkt und nicht schleimig.
4. HF Media Link einbinden: https://www.hfmedia.at/recruiting

Gib NUR die Nachricht zurück (ohne Anführungszeichen, ohne Einleitungsvokabeln).`;
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
        model: 'claude-haiku-4-5-20251001',
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
