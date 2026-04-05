import { kv } from '@vercel/kv';

const PASS = process.env.CRM_PASSWORD || 'nordstein2026';

export default async function handler(req, res) {
  // Validate token from query string for calendar subscription
  const token = req.query.token;
  if (token !== PASS) {
    return res.status(401).send('Unauthorized. Bitte gültigen Token am Ende der URL als ?token=... anhängen.');
  }

  try {
    const data = await kv.get('crm_global_leads_v1');
    const existingLeads = Array.isArray(data) ? data : [];

    // Filter leads with appointments
    const appts = existingLeads.filter(l => l.appointmentDate && l.appointmentFrom && l.appointmentTo);

    // Build the .ics string
    let ics = "BEGIN:VCALENDAR\r\n";
    ics += "VERSION:2.0\r\n";
    ics += "PRODID:-//HF Media Lead Gen//CRM Sync//EN\r\n";
    ics += "CALSCALE:GREGORIAN\r\n";
    ics += "X-WR-CALNAME:HF Media CRM Termine\r\n";
    ics += "X-WR-TIMEZONE:Europe/Vienna\r\n";
    ics += "METHOD:PUBLISH\r\n";
    ics += "REFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n";
    ics += "X-PUBLISHED-TTL:PT15M\r\n";

    // Format Date helper: YYYYMMDDTHHmmssZ
    const formatDate = (dateStr, timeStr) => {
      // dateStr is DD.MM.YYYY or YYYY-MM-DD
      let y, m, d;
      if (dateStr.includes('.')) {
        [d, m, y] = dateStr.split('.');
      } else if (dateStr.includes('-')) {
        [y, m, d] = dateStr.split('-');
      } else {
        return null;
      }
      
      const hr = timeStr.split(':')[0].padStart(2, '0');
      const min = timeStr.split(':')[1].padStart(2, '0');
      
      // Assume local Europe/Vienna timezone for input, convert to UTC roughly 
      // iCal format: 20260405T100000Z
      // Since Javascript Date parses simple ISO strings as UTC, let's construct ISO with generic offset (e.g. +0200)
      const dateObj = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${hr}:${min}:00+02:00`);
      
      if (isNaN(dateObj)) return null;

      const utcStr = dateObj.toISOString(); // e.g. "2026-04-05T08:00:00.000Z"
      return utcStr.replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    appts.forEach(l => {
      const dtStart = formatDate(l.appointmentDate, l.appointmentFrom);
      const dtEnd = formatDate(l.appointmentDate, l.appointmentTo);
      if (!dtStart || !dtEnd) return;

      const nowStr = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const uid = (l.name || 'unbekannt').replace(/\s+/g,'').toLowerCase() + '-' + l.appointmentDate.replace(/\D/g,'') + '@hf-media.crm';

      ics += "BEGIN:VEVENT\r\n";
      ics += `UID:${uid}\r\n`;
      ics += `DTSTAMP:${nowStr}\r\n`;
      ics += `DTSTART:${dtStart}\r\n`;
      ics += `DTEND:${dtEnd}\r\n`;
      
      const summary = `Termin: ${l.name || 'Unbekannt'}`;
      ics += `SUMMARY:${summary.replace(/,/g, '\\,')}\r\n`;
      
      let description = '';
      if (l.ceos) description += `Ansprechperson: ${l.ceos}\\n`;
      if (l.phone) description += `Tel: ${l.phone}\\n`;
      if (l.email_general) description += `Email: ${l.email_general}\\n`;
      if (l.website) description += `Web: ${l.website}\\n`;
      if (l.notes) description += `\\nNotizen: ${l.notes.replace(/\n/g, '\\n')}`;
      
      if (description) {
        ics += `DESCRIPTION:${description.replace(/,/g, '\\,')}\r\n`;
      }
      
      if (l.region) {
        ics += `LOCATION:${l.region.replace(/,/g, '\\,')}\r\n`;
      }
      
      ics += "STATUS:CONFIRMED\r\n";
      ics += "SEQUENCE:0\r\n";
      ics += "END:VEVENT\r\n";
    });

    ics += "END:VCALENDAR\r\n";

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hf-media-crm.ics"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Avoid stale caching
    return res.status(200).send(ics);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
