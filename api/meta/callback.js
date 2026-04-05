import { kv } from '@vercel/kv';

const PASS = process.env.CRM_PASSWORD || 'nordstein2026';
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const REDIRECT_URI = process.env.META_REDIRECT_URI || 'https://hf-media-recruiting.vercel.app/api/meta/callback';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${PASS}` && !req.url.includes('code=')) {
    // allow unauthenticated callback from Meta
    if (!req.query.code) return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, state } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code received from Meta.' });
  }

  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:2rem;max-width:600px;margin:auto;">
        <h2>⚠️ Konfiguration fehlt</h2>
        <p>Bitte setze diese Vercel Environment Variables:</p>
        <ul>
          <li><code>META_APP_ID</code> – deine Facebook App ID</li>
          <li><code>META_APP_SECRET</code> – dein Facebook App Secret</li>
          <li><code>META_REDIRECT_URI</code> – https://hf-media-recruiting.vercel.app/api/meta/callback</li>
        </ul>
        <p>Dann Vercel neu deployen.</p>
        <a href="/#metasync">← Zurück zur App</a>
      </body></html>
    `);
  }

  try {
    // Exchange auth code for access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      `client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
    );
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(400).send(`<html><body><h2>Meta Fehler</h2><pre>${err}</pre><a href="/#metasync">← Zurück</a></body></html>`);
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('Kein access_token erhalten');

    // Get long-lived token
    const ltRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}&fb_exchange_token=${accessToken}`
    );
    const ltData = ltRes.ok ? await ltRes.json() : {};
    const longToken = ltData.access_token || accessToken;

    // Fetch user info
    const meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${longToken}`);
    const meData = meRes.ok ? await meRes.json() : {};

    // Fetch Ad Accounts
    const adsRes = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,currency,account_status&access_token=${longToken}&limit=20`
    );
    const adsData = adsRes.ok ? await adsRes.json() : { data: [] };

    // Store in KV
    await kv.set('meta_connection', {
      connected: true,
      accessToken: longToken,
      userId: meData.id,
      userName: meData.name,
      adAccounts: adsData.data || [],
      connectedAt: new Date().toISOString(),
    });

    // Redirect back to the app
    return res.status(302).setHeader('Location', '/#metasync').end();
  } catch (err) {
    console.error('Meta OAuth error:', err);
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:2rem;">
        <h2>Verbindung fehlgeschlagen</h2>
        <p>${err.message}</p>
        <a href="/#metasync">← Zurück zur App</a>
      </body></html>
    `);
  }
}
