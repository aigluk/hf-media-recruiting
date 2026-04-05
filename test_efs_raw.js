const XLSX = require('xlsx');
const fs = require('fs');

const file = '/Users/lukasaignergotzenberger/Downloads/efs_locations.xlsx';
const buf = fs.readFileSync(file);
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

console.log('Total raw rows:', rows.length);

console.log('\n=== FIRST 5 RAW ROWS ===');
rows.slice(0, 5).forEach((r, i) => {
  console.log(`\nRow ${i}:`, JSON.stringify(r, null, 2));
});
