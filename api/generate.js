// ── Helper: Extract contact data from raw HTML ──
function extractFromHtml(html) {
  // Extract phone numbers — Austrian/German formats
  const phonePatterns = [
    /(?:Tel(?:efon)?|Phone|Telefon|Tel\.)[.\s:]*(\+?[0-9\s\(/\)\-\.]{8,20})/gi,
    /(\+43[\s\-]?[0-9\s\-\/]{6,20})/g,
    /(?:^|\s)(0[0-9]{2,4}[\s\/\-]?[0-9\s\-\/]{4,12})(?:\s|$)/gm,
  ];
  let phone = null;
  for (const pattern of phonePatterns) {
    const match = html.match(pattern);
    if (match && match[0]) {
      phone = match[0].replace(/Tel(?:efon)?[.:\s]*/gi, '').trim().slice(0, 30);
      if (phone.replace(/\D/g, '').length >= 6) break;
    }
  }

  // Extract email
  const emailMatch = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0] : null;

  // Extract CEO/Geschäftsführer
  const ceoPatterns = [
    /Gesch[äa]ftsf[üu]hr(?:er|ung|in)[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/i,
    /Inhaber(?:in)?[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/i,
    /CEO[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+)/i,
    /Leitung[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+)/i,
  ];
  let ceos = null;
  for (const p of ceoPatterns) {
    const m = html.match(p);
    if (m && m[1]) {
      ceos = m[1].trim().slice(0, 80);
      break;
    }
  }

  return { phone, email, ceos };
}

// ── Helper: Fetch single URL with timeout ──
async function scrapeUrl(url) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text')) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// ── Helper: Scrape contact info from a website ──
async function enrichFromWebsite(website) {
  const base = website.replace(/\/+$/, '');
  const pages = [base, `${base}/kontakt`, `${base}/impressum`, `${base}/contact`, `${base}/ueber-uns`, `${base}/team`, `${base}/jobs`, `${base}/karriere`];
  let allHtml = '';
  for (const url of pages) {
    const html = await scrapeUrl(url);
    if (html) {
      allHtml += ' ' + html;
      if (allHtml.length > 50000) break;
    }
  }
  return allHtml ? extractFromHtml(allHtml) : null;
}

// ── Helper: Verify a website actually exists (returns true/false) ──
async function verifyWebsite(url) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(url, { signal: ctrl.signal, method: 'HEAD', redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(timeout);
    return r.ok || r.status === 301 || r.status === 302;
  } catch {
    return false;
  }
}

// ── Helper: Robust JSON extraction ──
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    const cleaned = text.slice(start, end + 1).replace(/\/\/.*$/gm, '').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(cleaned); } catch { return null; }
  }
}

// ════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════
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

  // ══════════ STEP 1: Claude als Data Researcher ══════════
  const dataResearchPrompt = `Rolle: Du bist ein hochpräziser Data-Researcher. Dein Ziel ist es, immer reale Unternehmen (keine Fiktion!) aus der Branche "${branches}" in "${custom || 'Österreich'}" zu finden.
${size ? `Mitarbeitergröße: ${size}` : ''}
${tier ? `Tier: ${tier}` : ''}

DEINE MISSION: 100% REALITÄTS-CHECK
Du darfst niemals eine URL "raten" oder auf Basis des Namens konstruieren. Du musst jede Information durch einen internen A/B-Abgleich verifizieren, auch wenn die Domain vielleicht anders anfängt als der Firmen-/Hotel-/Gebäude-Name! Das ist essentiell.

SCHRITT 1: Die A/B Such-Verifizierung
Führe für jedes potenzielle Unternehmen zwei unabhängige Suchen durch:
  Suche A: [Name des Betriebs] + [Ort] + offizielle Webseite
  Suche B: [Name des Betriebs] + [Ort] + Impressum
Nur wenn beide Suchen auf die gleiche Basis-Domain führen (auch wenn diese anders heißt als der Betrieb, z.B. wirtshaus-mit-herz.at für Gasthof Huber), ist die Webseite valide.

SCHRITT 2: Strikte Filter-Regeln (Blacklist)
Jedes Ergebnis von booking.com, herold.at, firmenabc.at, tripadvisor.at, wko.at, facebook.com oder karriere.at wird sofort verworfen. Ich will die echte, eigene Webseite des Betriebs.

SCHRITT 3: Der Inhalts-Check (Deep Dive)
Besuche die Webseite virtuell und stelle sicher:
  Pfad-Check: Existiert eine Seite unter /jobs, /karriere oder /team? Wenn nein: Firma ignorieren, nächste suchen.
  Namens-Check: Steht im Impressum wirklich die Firma, die wir suchen?
  Personen-Check: Wer ist laut Impressum oder Team-Seite der Geschäftsführer (GF) oder die Marketingleitung? (Vorname + Nachname zwingend erforderlich).

SCHRITT 4: Lückenlose Datenausgabe
Gib die Daten nur aus, wenn JEDES Feld zu 100% korrekt befüllt werden kann. Keine Platzhalter. Kein "K.A.". Liefere lieber 10 perfekte Ergebnisse als 20 mit Lücken.

Antworte NUR als JSON ohne Erklärungen:
{
  "leads": [
    {
      "name": "Echter Firmenname",
      "industry": "Branche",
      "employees": "Mitarbeiteranzahl oder Schätzung",
      "region": "Exakter Standort mit Adresse",
      "website": "https://www.echte-domain.at",
      "phone": "Echte Telefonnummer",
      "ceos": "Vorname Nachname des/der Geschäftsführer(s)",
      "department_heads": "Marketing-/HR-Leitung wenn bekannt",
      "contact_persons": "Weitere Ansprechpartner wenn bekannt",
      "focus": "Was macht die Firma genau und worauf spezialisiert?"
    }
  ]
}`;

  let leads = [];

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
        max_tokens: 8000,
        system: 'Du bist ein reiner JSON-Generator und Data-Researcher. Antworte AUSSCHLIESSLICH mit validem JSON. Beginne mit { und ende mit }. Kein Text, kein Markdown. Liefere nur Ergebnisse die du zu 100% verifizieren kannst.',
        messages: [{ role: 'user', content: dataResearchPrompt }]
      })
    });

    if (!claudeRes.ok) {
      const et = await claudeRes.text();
      return res.status(claudeRes.status).json({ error: 'AI error: ' + et.slice(0, 200) });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData?.content?.[0]?.text || '';
    const parsed = extractJson(rawText);
    if (!parsed || !Array.isArray(parsed.leads)) {
      return res.status(500).json({ error: 'Keine gültige Antwort von der KI. Bitte erneut versuchen.' });
    }
    leads = parsed.leads;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // ══════════ STEP 2: Real Web Scraping — verify & enrich from actual websites ══════════
  const enrichedLeads = await Promise.all(leads.map(async (lead) => {
    let website = lead.website || null;
    if (website && !website.startsWith('http')) website = 'https://' + website;

    let phone = lead.phone || null;
    let ceos = lead.ceos || null;
    let email = null;
    let websiteValid = false;

    // Verify the website actually exists
    if (website) {
      websiteValid = await verifyWebsite(website);
    }

    // If website is valid, scrape it for additional/corrected data
    if (websiteValid) {
      const scraped = await enrichFromWebsite(website);
      if (scraped) {
        // Only override if we found something concrete on the real site
        if (scraped.phone && scraped.phone.replace(/\D/g, '').length >= 6) phone = scraped.phone;
        if (scraped.ceos) ceos = scraped.ceos;
        if (scraped.email) email = scraped.email;
      }
    }

    return {
      name: lead.name,
      industry: lead.industry || branches,
      employees: lead.employees || '',
      region: lead.region || custom || '',
      website: websiteValid ? website : null,
      phone: phone || '',
      ceos: ceos || '',
      department_heads: lead.department_heads || '',
      contact_persons: email || lead.contact_persons || '',
      focus: lead.focus || '',
      contact: phone || email || ''
    };
  }));

  // Filter out leads without a verified website (per user request: no K.A.)
  const validLeads = enrichedLeads.filter(l => l.website);

  return res.status(200).json({ leads: validLeads.length > 0 ? validLeads : enrichedLeads });
}
