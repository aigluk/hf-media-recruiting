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
    const timeout = setTimeout(() => ctrl.abort(), 2500);
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
  // Only fetch homepage and impressum (fast, 2 requests max)
  const [homeHtml, impressumHtml] = await Promise.all([
    scrapeUrl(base),
    scrapeUrl(`${base}/impressum`)
  ]);
  const allHtml = (homeHtml || '') + ' ' + (impressumHtml || '');
  return allHtml.length > 10 ? extractFromHtml(allHtml) : null;
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

  const dataResearchPrompt = `Du bist ein Lead-Generator für österreichische Unternehmen. Branche: "${branches}". Standort: "${custom || 'ganz Österreich'}".
${size ? `Mitarbeitergröße: ${size}` : ''}
${tier ? `Tier: ${tier}` : ''}

Erstelle eine Liste mit exakt 20 ECHTEN Unternehmen dieser Branche an diesem Standort.

ANFORDERUNGEN:
- Nur real existierende Unternehmen, die du aus deinem Trainingswissen kennst.
- Für jedes Unternehmen MUSS die echte Website angegeben werden (z.B. https://www.firmenname.at). Die Domain muss nicht dem Firmennamen entsprechen!
- VERBOTEN als Website: booking.com, herold.at, firmenabc.at, tripadvisor, wko.at, facebook.com, google.com, instagram.com
- Telefonnummer: Die echte Nummer der Firma (aus Website-Footer, Kontakt oder Impressum).
- Geschäftsführer: Der echte Name (Vorname + Nachname), meist im Impressum oder Firmenbuch zu finden.
- Standort: Exakte Adresse oder Stadtteil.

Liefere 20 Ergebnisse. Antworte NUR mit JSON:
{"leads":[{"name":"...","industry":"${branches}","employees":"5-20","region":"Straße, PLZ Ort","website":"https://...","phone":"+43...","ceos":"Vorname Nachname","department_heads":"...","contact_persons":"...","focus":"Spezialisierung"}]}`;

  const systemPrompt = 'Du bist ein österreichischer Firmenrecherche-Experte. Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt. Beginne mit { und beende mit }. Kein Markdown, kein erklärende Text. Du kennst hunderte echte österreichische Unternehmen aus deinem Training — nutze dieses Wissen.';


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
        system: systemPrompt,
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

  // ══════════ STEP 2: Verify websites & scrape contact data (parallel, fast) ══════════
  const enrichedLeads = await Promise.all(leads.map(async (lead) => {
    let website = lead.website || null;
    if (website && !website.startsWith('http')) website = 'https://' + website;

    let phone = lead.phone || null;
    let ceos = lead.ceos || null;
    let email = null;
    let websiteValid = false;

    // Verify and scrape in one go (no separate HEAD request)
    if (website) {
      try {
        const scraped = await enrichFromWebsite(website);
        if (scraped) {
          websiteValid = true;
          if (scraped.phone && scraped.phone.replace(/\D/g, '').length >= 6) phone = scraped.phone;
          if (scraped.ceos) ceos = scraped.ceos;
          if (scraped.email) email = scraped.email;
        } else {
          // Page returned nothing — still verify with a quick fetch
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2000);
          try {
            const r = await fetch(website, { signal: ctrl.signal, method: 'HEAD', redirect: 'follow' });
            websiteValid = r.ok || r.status === 301 || r.status === 302;
          } catch { websiteValid = false; }
          clearTimeout(t);
        }
      } catch { websiteValid = false; }
    }

    return {
      name: lead.name,
      industry: lead.industry || branches,
      employees: lead.employees || '',
      region: lead.region || custom || '',
      website: websiteValid ? website : (lead.website || null),
      phone: phone || lead.phone || '',
      ceos: ceos || lead.ceos || '',
      department_heads: lead.department_heads || '',
      contact_persons: email || lead.contact_persons || '',
      focus: lead.focus || '',
      contact: phone || email || lead.phone || ''
    };
  }));

  return res.status(200).json({ leads: enrichedLeads });
}
