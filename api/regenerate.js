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
    
    prompt = `Generiere 3 komplett unterschiedliche LinkedIn-Nachrichten-Vorlagen für einen Erstkontakt.

Lead-Informationen:
Firma: ${lead.name}
Branche: ${lead.industry}
Website: ${lead.website}
Kontakt/CEO: ${lead.ceos || lead.contact || 'zuständige Leitung'}

WICHTIGE REGELN FÜR ALLE BRANCHEN/NACHRICHTEN:
1. Absolut KEINE Emojis verwenden!
2. Schreibe immer in der Ich-Form ("ich" statt "wir"), außer bei "Wir (als Agentur/Unternehmen)".
3. Alle 3 Varianten müssen unten (z.B. als P.S. oder unauffällig am Ende) den Link enthalten: https://www.hfmedia.at/recruiting
4. Schreibe flüssig, professionell und nicht als marktschreierischer Pitch.

VARIANTE 1 (Klassisch & Höflich - Sie-Form):
- Fokus auf "Vielen Dank für die Vernetzung".
- Dezent auf das Thema Recruiting/Mitarbeitergewinnung in der [Branche] anspielen.
- Biete einen lockeren Erfahrungsaustausch an.

VARIANTE 2 (Direkt & Persönlich - Du-Form):
- Starte direkt (ohne "Danke fürs Vernetzen").
- Sprich den [CEO/Kontakt] per "Du" an (Hallo [Vorname]).
- Fokussiere dich auf ein typisches Branchen-Problem (Bsp: Gastronomie = Personalmangel/Köche; Immobilien = gute Makler finden; Industrie = Fachkräftemangel).
- Biete an, wie HF Media dabei helfen kann, und frage unverbindlich nach Interesse.

VARIANTE 3 (Extrem kurz & knackig - Sie-Form):
- Maximal 3-4 kurze Sätze.
- Komm sofort auf den Punkt: Ihr sucht gute Mitarbeiter im Bereich [Branche]? Wir haben aktuell sehr erfolgreiche Ansätze.
- Kurzer Call-to-Action (z.B. "Lust auf einen kurzen Austausch?").

Gib NUR das JSON im folgenden Format zurück:
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
        model: 'claude-3-5-haiku-20241022',
        max_tokens: maxTokens,
        system: type === 'initial' ? 'Antworte ausschließlich mit einem gültigen JSON-Objekt. Verwende KEIN Markdown, KEIN ```json. Nur das rohe JSON.' : 'Verwende absolut keine Markdown-Codeblöcke und schreibe den bloßen Text.',
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
