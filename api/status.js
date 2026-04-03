import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Gracefully handle missing KV env variables (fallback behavior)
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.warn('Vercel KV is not configured. Returning success but not saving globally.');
    return res.status(200).json({ success: true, message: 'KV not configured' });
  }

  if (req.method === 'POST') {
    const { key, status } = req.body;
    if (!key || !status) return res.status(400).json({ error: 'Missing key or status' });
    
    try {
      await kv.set(key, status);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('KV Set Error:', e);
      return res.status(500).json({ error: 'Failed to save status' });
    }
  }

  if (req.method === 'GET') {
    const keys = req.query.keys ? req.query.keys.split(',') : [];
    if (!keys.length) return res.status(200).json({});
    
    try {
      const statuses = await kv.mget(...keys);
      let result = {};
      keys.forEach((k, i) => {
        if (statuses[i]) result[k] = statuses[i];
      });
      return res.status(200).json(result);
    } catch (e) {
      console.error('KV Get Error:', e);
      return res.status(500).json({ error: 'Failed to load statuses' });
    }
  }
}
