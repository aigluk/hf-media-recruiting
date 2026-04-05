import { kv } from '@vercel/kv';

// Dedicated import endpoint with field normalization + dedup
const PASS = process.env.CRM_PASSWORD || 'nordstein2026';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${PASS}`) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ error: 'No leads provided' });

    // Normalize fields
    const normalize = (l) => ({
      name: (l.name || l.Firma || l.firmenname || l.company || '').toString().trim(),
      region: (l.region || l.adresse || l.address || l.city || l.ort || '').toString().trim().substring(0, 200),
      phone: (l.phone || l.telefon || l.tel || '').toString().replace(/[^\d\s+\-]/g, '').trim(),
      email_general: (l.email_general || l.email || l.mail || '').toString().toLowerCase().trim(),
      emails: (l.emails || l.email_general || l.email || l.mail || '').toString().toLowerCase().trim(),
      ceos: (l.ceos || l.owner || l.gf || l.ceo || l.geschäftsführer || '').toString().trim(),
      owner: (l.owner || l.ceos || '').toString().trim(),
      website: (l.website || l.web || l.url || '').toString().trim(),
      industry: (l.industry || l.branche || '').toString().trim(),
      notes: (l.notes || l.note || l.notiz || '').toString().trim(),
      status: 'NEU',
      statusDate: new Date().toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      createdAt: new Date().toISOString(),
    });

    const normalized = leads.map(normalize).filter(l => l.name);

    // Merge with existing leads (dedup by name + region key)
    const existingData = await kv.get('crm_global_leads_v1') || [];
    const existing = Array.isArray(existingData) ? existingData : [];

    const btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
    const encodeKey = (str) => btoa(unescape(encodeURIComponent(str)));

    const leadMap = new Map();
    existing.forEach(l => leadMap.set(encodeKey((l.name||'') + '|' + (l.region||'')), l));

    let imported = 0;
    let skipped = 0;
    const duplicates = [];

    normalized.forEach(l => {
      const k = encodeKey((l.name||'') + '|' + (l.region||''));
      if (leadMap.has(k)) {
        skipped++;
        duplicates.push(l.name);
      } else {
        leadMap.set(k, l);
        imported++;
      }
    });

    const updated = Array.from(leadMap.values());
    await kv.set('crm_global_leads_v1', updated);

    return res.status(200).json({
      success: true,
      imported,
      skipped,
      duplicates: duplicates.slice(0, 20),
      total: updated.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
