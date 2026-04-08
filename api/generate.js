import { kv } from '@vercel/kv';

// ── Branch → Google Maps Suchbegriff ──
const BRANCH_SEARCH_MAP = {
  'Gastronomie':           'Restaurants',
  'Hotellerie':            'Hotels',
  'Wellness/Spa':          'Wellness Spa',
  'Tourismus':             'Tourismus Sehenswürdigkeiten',
  'Handel':                'Einzelhandel Geschäfte',
  'Metalltechnik':         'Metalltechnik Metallbau',
  'Industrie':             'Industrieunternehmen',
  'Handwerk':              'Handwerksbetriebe',
  'Logistik':              'Logistik Spedition',
  'IT/Software':           'IT Software Unternehmen',
  'Finanzen/Versicherung': 'Finanzberatung Versicherung',
  'Immobilien':            'Immobilien Makler',
  'Gesundheit/Pflege':     'Arztpraxis Pflegeheim Apotheke',
};

// ── OpenData.host Firmenbuch Lookup (AT) ──
// WICHTIG: https:// verwenden — http:// redirected auf https:// und Node.js verliert den Auth-Header!
async function lookupFirmenbuch(companyName, apiKey) {
  if (!apiKey || !companyName) return null;
  try {
    const basicAuth = Buffer.from(`${apiKey}:`).toString('base64');
    const params = new URLSearchParams({
      'company-name': companyName,
      'country': 'at',
      'limit': '5'
    });
    const r = await fetch(`https://api.opendata.host/1.0/registered-companies/find?${params}`, {
      headers: { 
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.companies || data.companies.length === 0) return null;

    // Finde die beste Übereinstimmung (aktiv bevorzugt)
    const company = data.companies.find(c => c['reg-status'] === 'registered') || data.companies[0];
    const addr = company['business-address'] || {};
    const fullAddress = [addr['street-address'], addr['street-number'], addr['postal-code'], addr.city]
      .filter(Boolean).join(', ');

    // Geschäftsführer aus officers (wenn vorhanden)
    const officers = company.officers || [];
    const gf = officers.find(o => /(geschäftsführer|gf|ceo|inhaber|vorstand)/i.test(o.role || ''));

    return {
      businessName: company['business-name'] || null,
      address: fullAddress || null,
      city: addr.city || null,
      legalForm: company['legal-form'] || null,
      ceo: gf ? `${gf['first-name'] || ''} ${gf['last-name'] || ''}`.trim() : null,
    };
  } catch { return null; }
}

// ── Outscraper Emails & Contacts: Email + Phone + Description per Domain ──
// Endpoint: /emails-and-contacts — returns {emails:[{value,source}], phones:[{value,source}], contacts:[], site_data:{description,title}}
async function companyInsights(domain, apiKey) {
  if (!apiKey || !domain) return null;
  try {
    const params = new URLSearchParams({ query: domain, async: 'false' });
    const r = await fetch(`https://api.outscraper.com/emails-and-contacts?${params}`, {
      headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { return null; }

    // Response: { data: [{ emails:[{value,source}], phones:[{value,source}], contacts:[], site_data:{description,title} }] }
    const c = Array.isArray(data?.data) ? data.data[0] : (data?.data || data || null);
    if (!c) return null;

    // CEO aus contacts[] (wenn vorhanden — oft leer für AT KMU)
    let ceo = null, emailCeo = null;
    const contacts = Array.isArray(c.contacts) ? c.contacts : [];
    if (contacts.length > 0) {
      const ceoContact = contacts.find(p =>
        CEO_TITLE_REGEX.test(p.title || p.position || p.role || '')
      ) || contacts[0];
      if (ceoContact) {
        const fn = ceoContact.first_name || ceoContact.firstName || '';
        const ln = ceoContact.last_name  || ceoContact.lastName  || '';
        ceo = (ceoContact.full_name || ceoContact.name || `${fn} ${ln}`).trim() || null;
        emailCeo = ceoContact.email || ceoContact.work_email || null;
      }
    }

    // Emails: Array von {value, source} Objekten
    const emailsArr = Array.isArray(c.emails) ? c.emails : [];
    const emailGen = emailsArr[0]?.value || null;

    // Phones: Array von {value, source} Objekten
    const phonesArr = Array.isArray(c.phones) ? c.phones : [];
    const phone = phonesArr[0]?.value || null;

    // Description aus site_data
    const description = c.site_data?.description || c.description || null;

    return {
      ceo:         ceo      || null,
      email_ceo:   emailCeo || null,
      email_gen:   emailGen || null,
      phone:       phone    || null,
      description,
    };
  } catch { return null; }
}

// ── Apollo.io: CEO + private E-Mail per Domain (Fallback) ──
async function searchApolloB2b(domain, apiKey) {
  if (!apiKey || !domain) return null;
  try {
    const r = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        q_organization_domains: domain,
        person_titles: ['ceo', 'owner', 'founder', 'geschäftsführer', 'inhaber', 'managing director'],
        page: 1, per_page: 1,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const p = data?.people?.[0];
    if (!p) return null;
    return { ceo: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email || null };
  } catch { return null; }
}

const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

// Generische Adressen (kein CEO)
const GENERIC_PREFIX = /^(info|office|kontakt|contact|hello|hallo|support|service|mail|team|post|anfrage|booking|reservation|sales|hr|buchhaltung|verwaltung|sekretariat|empfang|reception|marketing|noreply|no-reply|jobs|karriere)@/i;

// CEO / Decision-Maker Titel (Outscraper email_X_title Feld)
const CEO_TITLE_REGEX = /\b(ceo|chief executive|geschäftsführer|geschäftsführerin|gef\.|gf\b|inhaber|inhaberin|founder|co-founder|gründer|owner|direktor|direktorin|vorstand|managing director|president|principal|geschäftsleitung)\b/i;

// ════════════════════════════════════════════════════════════════════════════
// Extrahiert den Hauptteil einer Domain (meininger-hotels.com → meininger-hotels)
// ════════════════════════════════════════════════════════════════════════════
function getMainDomain(urlStr) {
  if (!urlStr) return null;
  try {
    const host = new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr).hostname;
    // Entferne www. prefix
    const parts = host.replace(/^www\./, '');
    return parts; // z.B. "meininger-hotels.com"
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// extractPersonData: Liest Outscraper email_X_* Felder aus.
// KRITISCH: Nur Emails akzeptieren, deren Domain zur Unternehmenswebsite passt.
// Verhindert false positives wie "erikstofrregen@medlanes.com" für MEININGER Hotel.
// ════════════════════════════════════════════════════════════════════════════
function extractPersonData(place) {
  const companyNameLower = (place.name || '').toLowerCase().trim();
  const websiteDomain = getMainDomain(place.website);
  // Extrahiere den "Hauptteil" ohne TLD für flexibleren Vergleich
  // z.B. "meininger-hotels.com" → "meininger-hotels"
  const websiteDomainBase = websiteDomain ? websiteDomain.split('.').slice(0, -1).join('.') : null;

  // Sammle alle email_X Einträge
  const contacts = [];
  for (let i = 1; i <= 30; i++) {
    const email = place[`email_${i}`];
    if (!email) break; // Outscraper listet sequenziell

    const emailStr = typeof email === 'string' ? email.toLowerCase().trim() : '';
    if (!EMAIL_REGEX.test(emailStr)) continue;

    const emailDomain = emailStr.split('@')[1] || '';
    const emailDomainBase = emailDomain.split('.').slice(0, -1).join('.');

    // ★ DOMAIN-VALIDIERUNG: Nur Emails die zum Unternehmen gehören
    // Akzeptiert wenn:  email domain == website domain ODER
    //                   email domain enthält den website-Hauptteil (oder umgekehrt)
    let domainMatch = false;
    if (!websiteDomain) {
      // Kein Website bekannt → Emails als unsicher markieren (nicht ablehnen, aber tiefer priorisieren)
      domainMatch = false;
    } else {
      domainMatch = (
        emailDomain === websiteDomain ||
        emailDomainBase === websiteDomainBase ||
        (websiteDomainBase && emailDomain.includes(websiteDomainBase)) ||
        (websiteDomainBase && websiteDomainBase.includes(emailDomainBase))
      );
    }

    contacts.push({
      email: emailStr,
      name:  place[`email_${i}_full_name`] || null,
      title: place[`email_${i}_title`]     || null,
      isGeneric: GENERIC_PREFIX.test(emailStr),
      domainMatch,
    });
  }

  // Nur Domain-passende Emails für CEO/General-Picker verwenden
  const verifiedContacts = contacts.filter(c => c.domainMatch);
  // Fallback: Alle Contacts wenn keine domain-validierten vorhanden
  const pool = verifiedContacts.length > 0 ? verifiedContacts : [];

  // CEO: Ersten Kontakt mit CEO-Titel und Namen nehmen
  const ceoContact = pool.find(c => c.title && CEO_TITLE_REGEX.test(c.title) && c.name);

  // Generische E-Mail: info@, office@, etc.
  const generalContact = pool.find(c => c.isGeneric);

  // Erste persönliche E-Mail (nicht generisch) als Alternativ
  const personalContact = pool.find(c => !c.isGeneric);

  const email_general = generalContact?.email || personalContact?.email || '';
  const email_ceo     = (ceoContact && ceoContact.email !== email_general) ? ceoContact.email : '';

  // CEO-Name: NUR wenn Outscraper eine echte Person mit CEO-Titel zurückgibt UND Domain stimmt
  let ceoName = '';
  if (ceoContact?.name) {
    const n = ceoContact.name.trim();
    if (n.toLowerCase() !== companyNameLower && n.split(/\s+/).length >= 2) {
      ceoName = n;
    }
  }
  // Fallback ohne Domain-Match: personalContact Name (ohne CEO-Titel) NICHT nehmen → leer lassen
  // → Lieber leer als falsch

  const emailDisplay = [email_general, email_ceo].filter(Boolean).join(', ');

  return { emailDisplay, email_general, email_ceo, ceoName, domainMatchCount: verifiedContacts.length };
}

// ════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const outscraperKey = process.env.OUTSCRAPER_API_KEY;
  const opendataKey   = process.env.OPENDATA_HOST_API_KEY || 'F6F1-D72F-7FEF-468A-82AC-B620-3091-B593';
  const apolloKey     = process.env.APOLLO_API_KEY; // NEU: Der Profit-Macher für echte E-Mails

  if (!outscraperKey) return res.status(500).json({ error: 'Outscraper API Key fehlt.' });

  const { branches, custom } = req.body;
  if (!branches) return res.status(400).json({ error: 'Branches Parameter fehlt.' });

  // ── STEP 1: Outscraper Google Maps + Domains Service ──
  const branchList   = branches.split(',').map(b => b.trim());
  const searchTerms  = branchList.map(b => BRANCH_SEARCH_MAP[b] || b).join(', ');
  const location     = custom || 'Österreich';
  const query        = `${searchTerms}, ${location}`;

  const params = new URLSearchParams({
    query,
    limit:    '15',
    language: 'de',
    region:   'AT',
    async:    'false',
  });
  // domains_service liefert email_1..N + email_X_full_name + email_X_title (verifiziert via Diagnostik)
  params.append('enrichment', 'domains_service');

  let places = [];
  try {
    const apiRes = await fetch(`https://api.outscraper.com/google-maps-search?${params}`, {
      headers: { 'X-API-KEY': outscraperKey, 'Accept': 'application/json' }
    });
    const rawText = await apiRes.text();
    let apiData;
    try { apiData = JSON.parse(rawText); } catch {
      if (/insufficient|credit|quota|limit|balance/i.test(rawText))
        return res.status(402).json({ error: 'Outscraper Credits aufgebraucht.' });
      return res.status(502).json({ error: `Outscraper Fehler: ${rawText.slice(0, 120)}` });
    }
    if (!apiRes.ok) {
      if (apiRes.status === 402) {
        return res.status(402).json({ error: 'Outscraper Credits aufgebraucht — bitte unter outscraper.com Guthaben aufladen.' });
      }
      const msg = (typeof apiData?.message === 'string' ? apiData.message : null) || apiData?.error || JSON.stringify(apiData).slice(0, 120);
      return res.status(apiRes.status).json({ error: `Outscraper Fehler (${apiRes.status}): ${msg}` });
    }
    places = Array.isArray(apiData.data?.[0]) ? apiData.data[0] : (apiData.data || []);
  } catch (err) {
    return res.status(500).json({ error: `Netzwerk-Fehler: ${err.message}` });
  }

  if (places.length === 0) {
    return res.status(200).json({ leads: [], message: 'Keine Ergebnisse von Outscraper.' });
  }

  // ── STEP 2: Felder mappen ──
  const baseleads = places
    .filter(p => p.name && p.business_status !== 'CLOSED_PERMANENTLY')
    .map(place => {
      // Website: UTM-Parameter entfernen
      let website = place.website || null;
      if (website) {
        try {
          const url = new URL(decodeURIComponent(website));
          ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid'].forEach(p => url.searchParams.delete(p));
          website = url.toString();
        } catch { /* as-is */ }
      }

      // Adresse
      const addressParts = [place.street, place.postal_code, place.city].filter(Boolean);
      const region = addressParts.join(', ') || place.full_address || location;

      // Emails + CEO — mit Domain-Validierung
      const { emailDisplay, email_general, email_ceo, ceoName } = extractPersonData(place);

      // Beschreibung: Eigene Google-Beschreibung zuerst, dann Subtypes
      const description = place.description
        || (Array.isArray(place.subtypes) && place.subtypes.length > 0 ? place.subtypes.join(', ') : '')
        || '';

      return {
        name:          place.name,
        industry:      branchList[0] || '',
        region,
        website,
        phone:         place.phone  || '',
        emails:        emailDisplay,
        email_general,
        email_ceo,
        ceos:          ceoName,  // Leer wenn nicht sicher — KEINE Halluzination
        description,
        rating:        place.rating  || null,
        reviews:       place.reviews || 0,
        google_verified: true,
        createdAt:    new Date().toISOString(),
        statusDate:   new Date().toLocaleString('de-AT', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        }),
      };
    });

  // ── STEP 2: Parallel Enrichment — Company Insights (Haupt) + Firmenbuch + Apollo (Fallback) ──
  await Promise.all(baseleads.map(async (lead) => {
    const domain = lead.website
      ? lead.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]
      : null;

    // Alle 3 Quellen gleichzeitig anfragen
    const [ci, fb, apollo] = await Promise.all([
      companyInsights(domain, outscraperKey),
      lookupFirmenbuch(lead.name, opendataKey),
      searchApolloB2b(domain, apolloKey),
    ]);

    // 1. Company Insights (beste Quelle: CEO + Email + Phone direkt)
    if (ci) {
      if (ci.ceo && ci.ceo.trim().split(/\s+/).length >= 2) {
        lead.ceos = ci.ceo.trim();
        lead.ci_verified = true;
      }
      if (ci.email_ceo && EMAIL_REGEX.test(ci.email_ceo) && !GENERIC_PREFIX.test(ci.email_ceo)) {
        lead.email_ceo = ci.email_ceo;
      }
      if (ci.email_gen && EMAIL_REGEX.test(ci.email_gen) && !lead.email_general) {
        lead.email_general = ci.email_gen;
      }
      if (ci.phone && !lead.phone) lead.phone = ci.phone;
      if (ci.description && !lead.description) lead.description = ci.description;
      // Emails zusammensetzen
      const allEmails = [lead.email_ceo, lead.email_general].filter(Boolean);
      if (allEmails.length) lead.emails = allEmails.join(', ');
    }

    // 2. Firmenbuch (offizielle AT-Quelle für Adresse + CEO)
    if (fb) {
      if (fb.address) lead.region = fb.address;
      if (fb.ceo && fb.ceo.split(/\s+/).length >= 2 && !lead.ceos) {
        lead.ceos = fb.ceo;
        lead.firmenbuch_verified = true;
      }
    }

    // 3. Apollo (Fallback wenn Company Insights keinen CEO/Email hat)
    if (apollo) {
      if (apollo.ceo && apollo.ceo.length > 3 && !lead.ceos) {
        lead.ceos = apollo.ceo;
        lead.apollo_verified = true;
      }
      if (apollo.email && EMAIL_REGEX.test(apollo.email) && !lead.email_ceo && !GENERIC_PREFIX.test(apollo.email)) {
        lead.email_ceo = apollo.email;
        const allEmails = [apollo.email, lead.email_general].filter(Boolean);
        lead.emails = allEmails.join(', ');
        lead.apollo_verified = true;
      }
    }
  }));

  // ── STEP 3: KV Status-Sync ──

  let kvStatuses = {};
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const encodeKey = (s) => Buffer.from(s, 'utf8').toString('base64');
      const keys = baseleads.map(l => 'lead_status_' + encodeKey(l.name + '|' + l.region));
      if (keys.length > 0) {
        const values = await kv.mget(...keys);
        keys.forEach((k, i) => { if (values[i]) kvStatuses[k] = values[i]; });
      }
    } catch (e) { console.warn('KV lookup failed:', e.message); }
  }

  baseleads.forEach(l => {
    const encodeKey = (s) => Buffer.from(s, 'utf8').toString('base64');
    const key = 'lead_status_' + encodeKey(l.name + '|' + l.region);
    l.status = kvStatuses[key] || 'Neu/Offen';
  });

  const ceoCount   = baseleads.filter(l => l.ceos).length;
  const emailCount = baseleads.filter(l => l.emails).length;

  return res.status(200).json({
    leads:      baseleads,
    query,
    total:      baseleads.length,
    ceoFound:   ceoCount,
    emailFound: emailCount,
    source:     'Google Maps + Contacts (Outscraper domains_service, domain-validated)',
  });
}
