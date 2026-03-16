// ── Helper: Check if a company name (or parts of it) appear on the website ──
function nameMatchesWebsite(companyName, html) {
  if (!html || !companyName) return false;
  const lower = html.toLowerCase();
  const nameLower = companyName.toLowerCase();
  // Direct match
  if (lower.includes(nameLower)) return true;
  // Check if major words (>3 chars) from the name appear
  const words = nameLower.split(/[\s\-&,]+/).filter(w => w.length > 3);
  if (words.length === 0) return true; // Single short word, can't verify
  const matchCount = words.filter(w => lower.includes(w)).length;
  return matchCount >= Math.ceil(words.length * 0.5); // At least 50% of significant words match
}

// ── Helper: Extract contact data from raw HTML ──
function extractFromHtml(html) {
  // Extract phone numbers — Austrian/German formats
  const phonePatterns = [
    /(?:Tel(?:efon)?|Phone|Fon|Tel\.)[.\s:]*(\+?[0-9\s\(/\)\-\.]{8,20})/gi,
    /(\+43[\s\-]?(?:\(0\))?[\s]?[0-9\s\-\/]{6,20})/g,
    /href="tel:([^"]+)"/gi,
  ];
  let phone = null;
  for (const pattern of phonePatterns) {
    const match = html.match(pattern);
    if (match && match[0]) {
      let raw = match[0];
      raw = raw.replace(/href="tel:/gi, '').replace(/"/g, '');
      raw = raw.replace(/Tel(?:efon)?[.:\s]*/gi, '').replace(/Phone[.:\s]*/gi, '').replace(/Fon[.:\s]*/gi, '').trim();
      if (raw.replace(/\D/g, '').length >= 6) {
        phone = raw.slice(0, 30);
        break;
      }
    }
  }

  // Extract email
  const emailMatch = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0] : null;

  // Extract CEO/Geschäftsführer — STRICT: must be Vorname Nachname format
  const ceoPatterns = [
    /Gesch[äa]ftsf[üu]hr(?:er|ung|erin)[:\s]+([A-ZÄÖÜ][a-zäöüß]+(?:\s(?:Dr\.|Mag\.|Ing\.|DI)?\.?\s?)?[A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/,
    /Inhaber(?:in)?[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/,
    /(?:Eigent[üu]mer|Betreiber)(?:in)?[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+)/,
    /CEO[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s[A-ZÄÖÜ][a-zäöüß]+)/,
  ];
  let ceos = null;
  for (const p of ceoPatterns) {
    const m = html.match(p);
    if (m && m[1]) {
      const candidate = m[1].trim();
      // Verify it has at least 2 words (Vorname + Nachname)
      if (candidate.split(/\s+/).length >= 2) {
        ceos = candidate.slice(0, 80);
        break;
      }
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

// ── Helper: Scrape & verify a website (returns null if site doesn't exist) ──
async function scrapeAndVerify(website, companyName) {
  const base = website.replace(/\/+$/, '');
  const [homeHtml, impressumHtml] = await Promise.all([
    scrapeUrl(base),
    scrapeUrl(`${base}/impressum`)
  ]);

  const homeExists = homeHtml && homeHtml.length > 100;
  if (!homeExists) return { valid: false };

  const allHtml = (homeHtml || '') + ' ' + (impressumHtml || '');

  // Cross-check: does the company name appear on the website?
  const nameMatch = nameMatchesWebsite(companyName, allHtml);

  // Extract contact data
  const extracted = extractFromHtml(allHtml);

  return {
    valid: true,
    nameVerified: nameMatch,
    phone: extracted.phone,
    email: extracted.email,
    ceos: extracted.ceos,
  };
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

  // ══════════ STEP 1: Claude generates company list ══════════
  const prompt = `Du bist ein Lead-Generator für österreichische Unternehmen. Branche: "${branches}". Standort: "${custom || 'ganz Österreich'}".
${size ? `Mitarbeitergröße: ${size}` : ''}
${tier ? `Tier: ${tier}` : ''}

Erstelle eine Liste mit exakt 20 ECHTEN Unternehmen dieser Branche an diesem Standort.

STRIKTE REGELN:
1. Nur REAL existierende Firmen mit exaktem Firmennamen laut Handelsregister oder offiziellem Webauftritt. Erfinde niemals Firmennamen!
2. Website: Die echte, offizielle Webseite. Die Domain kann anders heißen als der Betrieb! Achte darauf. VERBOTEN: booking.com, herold.at, firmenabc.at, tripadvisor, wko.at, facebook.com, google.com, instagram.com
3. Geschäftsführer: Echter Vorname + Nachname. Keine generischen Bezeichnungen wie "Management" oder "Team"!
4. Adresse: Exakte Straße, PLZ und Ort. Gleiche diese mit dem Firmensitz ab.
5. Telefon: Echte Nummer.

Antworte NUR mit JSON:
{"leads":[{"name":"...","industry":"${branches}","employees":"5-20","region":"Straße, PLZ Ort","website":"https://...","phone":"+43...","ceos":"Vorname Nachname","department_heads":"...","contact_persons":"...","focus":"Spezialisierung"}]}`;

  const systemPrompt = 'Du bist ein österreichischer Firmenrecherche-Experte. Antworte AUSSCHLIESSLICH mit validem JSON. Beginne mit { und beende mit }. Kein Markdown. Du kennst hunderte echte österreichische Unternehmen — nutze dieses Wissen. Gib NUR Firmen aus, die du SICHER kennst. Erfinde KEINE Firmennamen.';

  let leads = [];
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const et = await claudeRes.text();
      return res.status(claudeRes.status).json({ error: 'AI error: ' + et.slice(0, 200) });
    }

    const claudeData = await claudeRes.json();
    const parsed = extractJson(claudeData?.content?.[0]?.text || '');
    if (!parsed || !Array.isArray(parsed.leads)) {
      return res.status(500).json({ error: 'Keine gültige Antwort. Bitte erneut versuchen.' });
    }
    leads = parsed.leads;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // ══════════ STEP 2: Server-side Cross-Check & Enrichment ══════════
  const enrichedLeads = await Promise.all(leads.map(async (lead) => {
    let website = lead.website || null;
    if (website && !website.startsWith('http')) website = 'https://' + website;

    let phone = lead.phone || '';
    let ceos = lead.ceos || '';
    let email = '';
    let verified = false;

    if (website) {
      const result = await scrapeAndVerify(website, lead.name);
      if (result.valid) {
        verified = true;
        // Override with scraped data if found (real data > Claude's guess)
        if (result.phone) phone = result.phone;
        if (result.ceos) ceos = result.ceos;
        if (result.email) email = result.email;
      }
    }

    // Clean up generic CEO names that Claude invents
    const genericCeoPatterns = /^(Management|Team|Familie|Managementgeführt|Verwaltung|Betreiber|Inhaber|Geschäftsführung|Leitung|Eigentümer|Chef|.*Management$|.*Team$|.*Verwaltung$|.*Familie$|.*Betreiber$)/i;
    if (genericCeoPatterns.test(ceos)) ceos = '';

    return {
      name: lead.name,
      industry: lead.industry || branches,
      employees: lead.employees || '',
      region: lead.region || custom || '',
      website: verified ? website : (website || null),
      phone: phone,
      ceos: ceos,
      department_heads: lead.department_heads || '',
      contact_persons: email || lead.contact_persons || '',
      focus: lead.focus || '',
      contact: phone || email || ''
    };
  }));

  return res.status(200).json({ leads: enrichedLeads });
}
