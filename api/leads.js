import { createClient } from '@vercel/kv';

const url = process.env.KV_REST_API_URL || process.env.KV_UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.KV_UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_TOKEN;

const kv = createClient({ url: url, token: token });

const PASS = process.env.CRM_PASSWORD || 'nordstein2026';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Set CORS headers if needed
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET: Fetch all leads
    if (req.method === 'GET') {
      const data = await kv.get('crm_global_leads_v1');
      return res.status(200).json({ leads: data || [] });
    }

    // POST: Sync/Update leads
    if (req.method === 'POST') {
      const { leads } = req.body;
      if (!Array.isArray(leads)) return res.status(400).json({ error: 'Invalid payload' });
      
      const existingData = await kv.get('crm_global_leads_v1') || [];
      const existingLeads = Array.isArray(existingData) ? existingData : [];
      
      // Merge leads based on unique key (name + region)
      const btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
      const encodeKey = (str) => btoa(unescape(encodeURIComponent(str)));
      
      const leadMap = new Map();
      existingLeads.forEach(l => leadMap.set(encodeKey((l.name||'') + '|' + (l.region||'')), l));
      
      leads.forEach(l => {
        const k = encodeKey((l.name||'') + '|' + (l.region||''));
        // Always overwrite with newest object to allow status/note updates
        leadMap.set(k, { ...leadMap.get(k), ...l });
      });

      const updatedLeads = Array.from(leadMap.values());
      await kv.set('crm_global_leads_v1', updatedLeads);

      return res.status(200).json({ message: 'Success', total: updatedLeads.length });
    }

    // DELETE: Clear Database
    if (req.method === 'DELETE') {
      await kv.set('crm_global_leads_v1', []);
      return res.status(200).json({ message: 'Database wiped' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
