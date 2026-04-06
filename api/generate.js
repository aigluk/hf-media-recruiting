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

// E-Mail Regex
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
    const apiRes = await fetch(`https://api.leadsscraper.io/google-maps-search?${params}`, {
      headers: { 'X-API-KEY': outscraperKey, 'Accept': 'application/json' }
    });
    if (!apiRes.ok) {
      const e = await apiRes.text();
      return res.status(apiRes.status).json({ error: `Outscraper Fehler: ${e.slice(0, 200)}` });
    }
    const apiData = await apiRes.json();
    if (apiData.data && Array.isArray(apiData.data)) {
      places = Array.isArray(apiData.data[0]) ? apiData.data[0] : apiData.data;
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
