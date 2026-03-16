// Helper: extract contact data from raw HTML
function extractFromHtml(html, companyName) {
  // Extract phone numbers - Austrian/German formats
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

  // Extract CEO/Geschäftsführer from impressum text
  const ceoPatterns = [
    /Geschäftsführ(?:er|ung|in)[:\s]+([A-ZÄÖÜa-z\s,\.]{5,60})/i,
    /Inhaber[:\s]+([A-ZÄÖÜa-z\s,\.]{5,40})/i,
    /CEO[:\s]+([A-ZÄÖÜa-z\s,\.]{5,40})/i,
    /Leitung[:\s]+([A-ZÄÖÜa-z\s,\.]{5,40})/i,
  ];
  let ceos = null;
  for (const p of ceoPatterns) {
    const m = html.match(p);
    if (m && m[1]) {
      ceos = m[1].trim().replace(/\n/g, ' ').slice(0, 80);
      break;
    }
  }

  return { phone, email, ceos };
}

// Helper: try to fetch & scrape a page (contact, impressum, etc.)
async function scrapeUrl(url) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HFMediaBot/1.0; +https://www.hfmedia.at)' }
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text')) return null;
    const text = await r.text();
    return text;
  } catch {
    return null;
  }
}

// Helper: try to get contact data from a website (tries homepage, /kontakt, /impressum)
async function enrichFromWebsite(website) {
  const base = website.endsWith('/') ? website.slice(0, -1) : website;
  const pages = [base, `${base}/kontakt`, `${base}/impressum`, `${base}/contact`, `${base}/ueber-uns`];
  let allHtml = '';
  for (const url of pages) {
    const html = await scrapeUrl(url);
    if (html) {
      allHtml += html;
      if (allHtml.length > 30000) break;
    }
  }
  return allHtml ? extractFromHtml(allHtml) : null;
}

// Helper: search for a company website using a free approach (constructing likely URLs)
async function findWebsite(companyName, region) {
  // Try to find with simple Google-style search on firmenabc.at API
  const query = encodeURIComponent(`${companyName} ${region} site:.at OR site:.com`);
  // Use Claude's knowledge about the company (already embedded in the AI generation step)
  return null; // Will be populated from Claude's initial response
}

// Robust JSON extraction from Claude's text
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    // Try to repair: remove JS comments (invalid JSON)
    const cleaned = text.slice(start, end + 1).replace(/\/\/.*$/gm, '').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(cleaned); } catch { return null; }
  }
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

  // ── STEP 1: Generate real company list with websites from Claude ──
  const step1Prompt = `Du bist ein österreichischer Unternehmensrechercheur. Finde 20 ECHTE, existierende österreichische Unternehmen.

SUCHKRITERIEN:
- Branchen: ${branches}
- Mitarbeitergröße: ${size || 'beliebig'}
${tier ? `- Tier: ${tier}` : ''}
${custom ? `- PFLICHTSTANDORT: "${custom}" — Alle Firmen MÜSSEN in dieser Stadt/Region sein (max. 10km Umkreis)!` : ''}

REGELN:
1. Nur ECHTE, nachweislich existierende Firmen.
2. "website": Die echte Website-URL. Du kennst die meisten großen Lokale. Wenn du eine Firma kennst und ihre Website weißt, trage sie ein. Sonst schreib die wahrscheinlichste URL (z.B. "https://www.restaurantname.at"). NIEMALS null oder K.A., wenn es realistisch eine Website gibt!
3. "phone": Aus deinem Wissen. Wenn du die Nummer kennst, eintragen. Sonst leer lassen.
4. "ceos": Aus deinem Wissen (Geschäftsführer, Inhaber). Wenn unbekannt, leer lassen.
5. "region": Exakte Adresse oder Stadt.

Antworte NUR mit validem JSON, kein Markdown.

{
  "leads": [
    {
      "name": "Echter Name",
      "industry": "${branches}",
      "employees": "Schätzung",
      "region": "Exakter Ort",
      "website": "https://...",
      "phone": "Nummer oder leer",
      "ceos": "Name(n) oder leer",
      "focus": "Kurzbeschreibung"
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
        max_tokens: 6000,
        system: 'Du bist ein reiner JSON-Generator. Antworte AUSSCHLIESSLICH mit validem JSON. Beginne mit { und ende mit }. Kein Text, kein Markdown.',
        messages: [{ role: 'user', content: step1Prompt }]
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
      return res.status(500).json({ error: 'Claude lieferte kein gültiges JSON. Bitte erneut versuchen.' });
    }
    leads = parsed.leads;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // ── STEP 2: Scrape each company's website for real phone/CEO data ──
  const enrichedLeads = await Promise.all(leads.map(async (lead) => {
    let website = lead.website && lead.website !== 'K.A.' && lead.website !== '' ? lead.website : null;
    if (website && !website.startsWith('http')) website = 'https://' + website;

    let phone = lead.phone && lead.phone !== 'K.A.' && lead.phone !== '' ? lead.phone : null;
    let ceos = lead.ceos && lead.ceos !== 'K.A.' && lead.ceos !== '' ? lead.ceos : null;
    let contact_persons = '';
    let department_heads = '';

    // Try scraping the website to fill missing fields
    if (website && (!phone || !ceos)) {
      const scraped = await enrichFromWebsite(website);
      if (scraped) {
        if (!phone && scraped.phone) phone = scraped.phone;
        if (!ceos && scraped.ceos) ceos = scraped.ceos;
        if (!contact_persons && scraped.email) contact_persons = scraped.email;
      }
    }

    return {
      name: lead.name,
      industry: lead.industry || branches,
      employees: lead.employees || 'k.A.',
      region: lead.region || custom || 'Österreich',
      website: website,
      phone: phone || 'K.A.',
      ceos: ceos || 'K.A.',
      department_heads: department_heads || 'K.A.',
      contact_persons: contact_persons || 'K.A.',
      focus: lead.focus || '',
      contact: phone || contact_persons || 'K.A.'
    };
  }));

  return res.status(200).json({ leads: enrichedLeads });
}
