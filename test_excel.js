const XLSX = require('xlsx');
const fs = require('fs');

function mapRowToLead(row) {
      const entries = Object.entries(row).map(([k,v]) => [k, v !== null && v !== undefined ? String(v).trim() : '']);

      // ═══ STRICT VALIDATORS ═══
      const isEmail = v => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(v);
      const isPhone = v => { const d = v.replace(/\D/g,''); return d.length >= 7 && d.length <= 20 && /^[\+\d\s\-\/\(\)\.]{6,30}$/.test(v) && !/^[a-zA-Z]/.test(v); };
      const isUrl = v => /^(https?:\/\/|www\.)/i.test(v) || (/\.[a-z]{2,}$/i.test(v) && /[a-zA-Z]/.test(v) && v.includes('.'));
      const isPlzCity = v => /^\d{4,5}\s+[A-ZÄÖÜa-zäöüß]/.test(v);
      const isAddress = v => /[a-zA-ZäöüÄÖÜß]/.test(v) && (/\d+/.test(v) || isPlzCity(v)) && (/straße|strasse|gasse|weg|platz|ring|allee|ort|stadt|city/i.test(v) || isPlzCity(v));
      const isPureNum = v => /^\d+([.,]\d+)?$/.test(v.trim());
      const isJunkHeader = v => /^(spalte|column|col|field|nr|id|lfd|row|zeile|index|datum|date|status|typ|type|#|unnamed|__empty)\d*$/i.test(v.trim());
      const isJobTitle = v => /^(vertrieb|verkauf|marketing|leitung|direktor|manager|berater|consultant|account|abteilung|assistenz|verwaltung|buchhaltung|sekretariat|sachbearbeiter|projektleiter)/i.test(v);
      const isGenericCol = col => /^(spalte|column|col|field|__empty|feld|var|v)\s*\d*$/i.test(col.trim()) || /^\d+$/.test(col.trim());
      const hasLetters = v => /[a-zA-ZäöüÄÖÜß]{2,}/.test(v);
      const isCompanyName = v => v.length >= 3 && !isPureNum(v) && !isJunkHeader(v) && !isEmail(v) && !isPhone(v) && hasLetters(v);

      const allGeneric = entries.every(([col]) => isGenericCol(col));

      // ═══ NAMED COLUMN FINDER with optional validator ═══
      const find = (validator, ...keys) => {
        for (const k of keys) {
          for (const [col, val] of entries) {
            if (isGenericCol(col)) continue;
            const normCol = col.toLowerCase().replace(/[\s_\-\.\(\)\/\:;]/g, '');
            const normKey = k.toLowerCase().replace(/[\s_\-\.\(\)\/\:;]/g, '');
            if (normCol.includes(normKey) && val !== '') {
              if (validator && !validator(val)) continue; // value fails validation → skip
              return val;
            }
          }
        }
        return '';
      };
      // Find without validator (raw)
      const findRaw = (...keys) => find(null, ...keys);

      // ═══════════════════════════════════════════════════════════
      // CONTENT-BASED MODE: generic column names (Spalte1, etc.)
      // ═══════════════════════════════════════════════════════════
      if (allGeneric) {
        const vals = entries.map(([,v]) => v).filter(v => v.length >= 2);
        let name='', email='', phone='', region='', website='', ceo='';

        for (const v of vals) {
          if (isEmail(v))                          { if (!email) email = v.toLowerCase(); }
          else if (isPhone(v))                     { if (!phone) phone = v; }
          else if (isUrl(v))                       { if (!website) website = v; }
          else if (isAddress(v) || isPlzCity(v))   { if (!region) region = v; else if (region.length < v.length) region = v; }
          else if (!name && isCompanyName(v) && !isJobTitle(v)) { name = v; }
          else if (name && !ceo && hasLetters(v) && !isPureNum(v) && v.includes(' ') && /^[A-ZÄÖÜa-zäöüß]/.test(v) && !isJobTitle(v)) {
            ceo = v;
          }
        }

        if (!name || name.length < 3) return null;
        if (!email && !phone && !region) return null;

        return {
          name, email_general: email, emails: email, phone, region: region.substring(0,300),
          ceos: ceo, owner: ceo, status:'NEU',
          statusDate: new Date().toLocaleDateString('de-AT',{day:'2-digit',month:'2-digit',year:'numeric'}),
          createdAt: new Date().toISOString(),
          industry:'', notes:'',
          website: website && !/^https?/i.test(website) ? 'https://'+website : website,
          description:''
        };
      }

      // ═══════════════════════════════════════════════════════════
      // NAMED COLUMN MODE: match keywords AND validate values
      // ═══════════════════════════════════════════════════════════

      // Company name — MUST be a real company, not a job title or number
      let name = find(isCompanyName, 'firmenname','firma','unternehmensname','unternehmen','company','organisation','organization','businessname','business');
      if (!name) name = find(v => isCompanyName(v) && !isJobTitle(v), 'name','bezeichnung','betrieb','titel');
      if (!name || name.length < 3) return null;

      // Email — MUST contain @ with valid domain
      const emailRaw = find(isEmail, 'email','e-mail','mail','emailadresse','kontaktemail','contactemail','geschäftsemail','businessemail');
      const emailClean = emailRaw ? emailRaw.toLowerCase() : '';

      // Phone — MUST start with + or 0, have 7+ digits
      const phoneRaw = find(isPhone, 'telefon','tel','phone','mobil','mobiltelefon','handynummer','mobile','fon','rufnummer','direktwahl','geschäftstelefon','kontaktnummer');
      const phoneClean = phoneRaw || '';

      // Address: full field or compose from validated parts
      const fullAddr = find(v => hasLetters(v) && v.length > 3, 'vollständigeadresse','volladresse','anschrift','adresse','address','standortadresse','firmenadresse');
      const street = find(hasLetters, 'straße','strasse','street','strassenname','gasse','allee');
      const houseNum = findRaw('hausnummer','hnr','hausnr');
      const zip = find(v => /^\d{4,5}$/.test(v), 'plz','postleitzahl','zip','zipcode','postalcode','postcode');
      const city = find(hasLetters, 'ort','stadt','city','gemeinde','standort','bezirk','town','place');
      const country = find(hasLetters, 'land','country','staat');

      let region = '';
      if (fullAddr && fullAddr.length > 3) {
        region = fullAddr;
      } else {
        const streetLine = [street, houseNum].filter(Boolean).join(' ').trim();
        const cityLine = [zip, city].filter(Boolean).join(' ').trim();
        const countryLine = (country && !['austria','österreich','at','de','germany','ch','schweiz','deutschland'].includes(country.toLowerCase())) ? country : '';
        region = [streetLine, cityLine, countryLine].filter(Boolean).join(', ');
      }

      // CEO — must have letters, ideally first+last name
      const ceo = find(v => hasLetters(v) && !isPureNum(v) && !isJobTitle(v), 'geschäftsführer','geschäftsführerin','gf','ceo','inhaber','inhaberin','eigentümer','eigentümerin','leiter','leiterin','direktor','direktorin','vorstand','gründer','gründerin','owner','founder','president','ansprechperson','ansprechpartner','kontaktperson','hauptkontakt','kontakt','ansprechparter');

      // Website — MUST look like a URL
      let website = find(v => isUrl(v) || (/[a-zA-Z]/.test(v) && v.includes('.')), 'website','web','url','homepage','internetadresse','webseite','www');
      if (website && isPureNum(website)) website = ''; // never allow bare numbers
      if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website.replace(/^\/\//, '');

      // Industry — must have letters
      const industry = find(v => hasLetters(v) && !isPureNum(v), 'branche','industry','geschäftsfeld','sektor','kategorie','sector','type','typ') || '';

      // Notes
      const notes = find(v => hasLetters(v), 'notiz','notizen','note','notes','anmerkung','bemerkung','kommentar','info') || '';

      // Description
      const description = find(v => hasLetters(v), 'beschreibung','description','zusammenfassung','summary','profil','über','about') || '';

      // Final gate: need at least company + one useful data field
      if (!emailClean && !phoneClean && !region && !ceo) return null;

      return {
        name, email_general: emailClean, emails: emailClean, phone: phoneClean,
        region: region.substring(0,300), ceos: ceo, owner: ceo,
        status:'NEU', statusDate: new Date().toLocaleDateString('de-AT',{day:'2-digit',month:'2-digit',year:'numeric'}),
        createdAt: new Date().toISOString(), industry, notes, website, description,
      };
}

// Parse Excel
const file = '/Users/lukasaignergotzenberger/Downloads/PV Anlagen Lead Liste.xlsx';
const buf = fs.readFileSync(file);
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

console.log('Total raw rows:', rows.length);

const leads = rows.map(r => mapRowToLead(r)).filter(l => l && l.name);
console.log('Mapped leads:', leads.length);

console.log('\n=== FIRST 5 MAPPED LEADS ===');
leads.slice(0, 5).forEach((l, i) => {
  console.log(`\n--- Lead ${i}: ${l.name} ---`);
  console.log(`  Kontakt/CEO: "${l.ceos}"`);
  console.log(`  Email: "${l.email_general}"`);
  console.log(`  Phone: "${l.phone}"`);
  console.log(`  Region: "${l.region}"`);
  console.log(`  Website: "${l.website}"`);
  console.log(`  Industry: "${l.industry}"`);
});

// Check if any lead has numbers in wrong fields
console.log('\n=== QUALITY CHECK ===');
leads.forEach((l, i) => {
  const issues = [];
  if (l.email_general && !l.email_general.includes('@')) issues.push(`Email has no @: "${l.email_general}"`);
  if (l.website && l.website !== '–' && /^\d+$/.test(l.website.replace('https://',''))) issues.push(`Website is number: "${l.website}"`);
  if (l.industry && /^\d+$/.test(l.industry)) issues.push(`Industry is number: "${l.industry}"`);
  if (l.region && /^\d+$/.test(l.region)) issues.push(`Region is pure number: "${l.region}"`);
  if (l.ceos && /^\d+$/.test(l.ceos)) issues.push(`CEO is number: "${l.ceos}"`);
  if (l.name && /^(spalte|column)/i.test(l.name)) issues.push(`Name is header: "${l.name}"`);
  if (issues.length) console.log(`Lead ${i} "${l.name}": ${issues.join(', ')}`);
});
console.log('Quality check done.');
