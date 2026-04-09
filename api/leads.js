import { kv } from '@vercel/kv';

const PASS = process.env.CRM_PASSWORD || 'nordstein2026';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${PASS}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Set CORS headers if needed
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PATCH');
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

      // Merge leads based on unique key: name + website (stable across runs)
      // Fallback to name + first 30 chars of region if no website
      const btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
      const encodeKey = (str) => btoa(unescape(encodeURIComponent(str)));
      const getKey = (l) => {
        const name = (l.name || '').toLowerCase().trim();
        const website = (l.website || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase().trim();
        return encodeKey(website ? `${name}|${website}` : `${name}|${(l.region||'').substring(0,30)}`);
      };

      const leadMap = new Map();
      existingLeads.forEach(l => leadMap.set(getKey(l), l));

      leads.forEach(l => {
        const k = getKey(l);
        const existing = leadMap.get(k);
        if (existing) {
          // Lead already exists: update scraped data but preserve user-edited fields
          const userChangedStatus = existing.status && existing.status !== 'NEU' && existing.status !== 'Neu/Offen';
          const merged = { ...existing, ...l };
          // Always preserve BESTANDSKUNDE and NO GO — never overwrite
          const isProtected = existing.status === 'BESTANDSKUNDE' || existing.status === 'NO GO';
          // Keep user status + statusDate if they moved the lead past NEU
          if (userChangedStatus || isProtected) {
            merged.status = existing.status;
            merged.statusDate = existing.statusDate;
          }
          // Always preserve notes
          if (existing.notes) merged.notes = existing.notes;
          if (existing.note)  merged.note  = existing.note;
          // Preserve appointment data ONLY if the incoming update does NOT explicitly clear it (null = user deleted)
          if (existing.appointmentDate && l.appointmentDate !== null) merged.appointmentDate = existing.appointmentDate;
          if (existing.appointmentFrom && l.appointmentFrom !== null) merged.appointmentFrom = existing.appointmentFrom;
          if (existing.appointmentTo   && l.appointmentTo   !== null) merged.appointmentTo   = existing.appointmentTo;
          if (existing.appointmentHour && l.appointmentHour !== null) merged.appointmentHour = existing.appointmentHour;
          leadMap.set(k, merged);
        } else {
          leadMap.set(k, l);
        }
      });

      const updatedLeads = Array.from(leadMap.values());
      await kv.set('crm_global_leads_v1', updatedLeads);

      return res.status(200).json({ message: 'Success', total: updatedLeads.length });
    }

    // PATCH: Full replacement (used by deleteLead on client)
    if (req.method === 'PATCH') {
      const { leads } = req.body;
      if (!Array.isArray(leads)) return res.status(400).json({ error: 'Invalid payload' });
      await kv.set('crm_global_leads_v1', leads);
      return res.status(200).json({ message: 'Replaced', total: leads.length });
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
