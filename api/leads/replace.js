import { kv } from '@vercel/kv';

const PASS = process.env.CRM_PASSWORD || 'nordstein2026';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      const { leads } = req.body;
      if (!Array.isArray(leads)) return res.status(400).json({ error: 'Invalid payload' });
      // Fully replace the stored leads (used for deletions)
      await kv.set('crm_global_leads_v1', leads);
      return res.status(200).json({ message: 'Replaced', total: leads.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
