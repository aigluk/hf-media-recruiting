import { kv } from '@vercel/kv';

const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
const META_APP_ID = process.env.META_APP_ID || '';
const REDIRECT_URI = process.env.META_REDIRECT_URI || 'https://hf-media-recruiting.vercel.app/api/meta/callback';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${PASS}`) return res.status(401).json({ error: 'Unauthorized' });

  // DELETE: disconnect
  if (req.method === 'DELETE') {
    await kv.del('meta_connection');
    return res.status(200).json({ disconnected: true });
  }

  try {
    const conn = await kv.get('meta_connection');

    // Return config info even when not connected
    const config = {
      appId: META_APP_ID,
      redirectUri: REDIRECT_URI,
      loginUrl: META_APP_ID
        ? `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=ads_management,ads_read,business_management,public_profile&response_type=code`
        : null,
    };

    if (!conn || !conn.connected) {
      return res.status(200).json({ connected: false, config });
    }

    // Fetch latest ad account data if connected
    let campaigns = [];
    let insights = null;

    if (req.query.accountId && conn.accessToken) {
      const acctId = req.query.accountId;

      // Campaigns
      try {
        const campRes = await fetch(
          `https://graph.facebook.com/v19.0/${acctId}/campaigns?fields=id,name,status,objective&access_token=${conn.accessToken}&limit=10`
        );
        const campData = campRes.ok ? await campRes.json() : {};
        campaigns = campData.data || [];
      } catch (e) { /* silent */ }

      // Insights (last 30 days)
      try {
        const insRes = await fetch(
          `https://graph.facebook.com/v19.0/${acctId}/insights?fields=impressions,clicks,spend,cpc,cpm,reach,actions&date_preset=last_30d&access_token=${conn.accessToken}`
        );
        const insData = insRes.ok ? await insRes.json() : {};
        insights = insData.data?.[0] || null;
      } catch (e) { /* silent */ }
    }

    return res.status(200).json({
      connected: true,
      config,
      userName: conn.userName,
      userId: conn.userId,
      adAccounts: conn.adAccounts || [],
      connectedAt: conn.connectedAt,
      campaigns,
      insights,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
