const XLSX = require('xlsx');
const fs = require('fs');

const html = fs.readFileSync('/Users/lukasaignergotzenberger/HF Media Lead Gen/public/index.html', 'utf8');

const funcStart = html.indexOf('function mapRowToLead(row)');
let braceCount = 0;
let funcEnd = funcStart;
let inFunc = false;
for (let i = funcStart; i < html.length; i++) {
  if (html[i] === '{') { braceCount++; inFunc = true; }
  if (html[i] === '}') { braceCount--; }
  if (inFunc && braceCount === 0) { funcEnd = i + 1; break; }
}
const funcStr = html.substring(funcStart, funcEnd);
const mapRowToLead = new Function('row', funcStr.replace('function mapRowToLead(row)', '').slice(1, -1));

const file = '/Users/lukasaignergotzenberger/Downloads/efs_locations.xlsx';
const buf = fs.readFileSync(file);
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

console.log('Total raw rows in EFS:', rows.length);

const leads = rows.map(r => mapRowToLead(r)).filter(l => l && l.name);
console.log('Mapped leads:', leads.length);

console.log('\n=== PROBLEM ROWS (Vertriebsdirektor) ===');
leads.forEach((l, i) => {
  if (l.name.includes('Vertriebsdirektor') || l.ceos.includes('Vertriebsdirektor')) {
    console.log(`\nLead ${i}:`);
    console.log(`  Name:   "${l.name}"`);
    console.log(`  Region: "${l.region}"`);
    console.log(`  CEO:    "${l.ceos}"`);
  }
});

console.log('\n=== ALL MAPPED LEADS ===');
leads.slice(0, 10).forEach((l, i) => {
  console.log(`\nLead ${i}: Name="${l.name}" Region="${l.region}" CEO="${l.ceos}" phone="${l.phone}"`);
});
