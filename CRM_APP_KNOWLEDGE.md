# HF Media Lead CRM — App Knowledge File
> Updated: 2026-04-03 | Version: v3.x
> This file is a living reference for future AI sessions. Update whenever major changes are made.

---

## 1. Projekt-Übersicht

**App-Name:** Lead CRM Engine (HF Media)  
**URL (Produktion):** https://hf-media-recruiting.vercel.app  
**GitHub Repo:** https://github.com/aigluk/hf-media-recruiting  
**Deployment:** Vercel (auto-deploy via GitHub main branch push)  
**Stack:** Single-Page HTML + Vanilla JS + CSS (kein Framework), Vercel Serverless Functions (Node.js API routes), Vercel KV (Redis-kompatibel) für persistente Datenspeicherung

---

## 2. Dateistruktur

```
/
├── public/
│   └── index.html          ← Gesamte Frontend-App (HTML + CSS + JS, single-file)
├── api/
│   ├── leads.js            ← GET/POST Leads aus/in Vercel KV
│   ├── leads/
│   │   └── replace.js      ← PUT: Gesamte Lead-Liste überschreiben (für Delete)
│   ├── generate.js         ← Lead-Generierung via Outscraper API
│   ├── generate-message.js ← LinkedIn-Nachricht via Anthropic Claude API
│   └── auth.js             ← Passwort-Authentifizierung gegen CRM_PASSWORD Env
├── vercel.json             ← Vercel-Konfig (rewrites, headers)
├── package.json
└── CRM_APP_KNOWLEDGE.md    ← DIESE DATEI
```

---

## 3. Authentifizierung

- **Login:** Master-Passwort (gesetzt als Vercel Environment Variable `CRM_PASSWORD`)
- Das Passwort wird client-seitig via `/api/auth` validiert, Response gibt `{ok: true/false}`
- Login-Screen mit Passwort-Toggle (Auge-Icon via Lucide)

---

## 4. Datenstruktur (Leads)

Leads werden als **JSON-Array** in Vercel KV unter dem Key `crm_global_leads_v1` gespeichert.

**Lead-Objekt (Felder):**
```json
{
  "name": "Firmenname",
  "ceos": "Max Mustermann",
  "owner": "Alternativfeld für Inhaber",
  "industry": "Restaurant",
  "branche": "Alternativfeld Branche",
  "region": "Linz",
  "address": "Musterstraße 1, 4020 Linz",
  "phone": "+43 123 456789",
  "email": "info@firma.at",
  "website": "https://firma.at",
  "linkedin": "https://linkedin.com/in/...",
  "status": "NEU / OFFEN",
  "note": "Dealnotiz",
  "notes": "Längere Notiz / Termininfos",
  "description": "Firmenbeschreibung"
}
```

---

## 5. CRM Status-Pipeline

Statuses (normalisiert via `normalizeStatus()`):
| Raw Input | Normalisiert |
|---|---|
| "NEU", "NEU / OFFEN", "Neu/Offen", etc. | `NEU` |
| "IN KONTAKT", "In Kontakt", "INKONTAKT" | `IN KONTAKT` |
| "TERMIN FIXIERT", "Termin fixiert" | `TERMIN FIXIERT` |
| "KEIN INTERESSE", "Kein Interesse" | `KEIN INTERESSE` |
| "ABSCHLUSS / ABSAGE", "Abschluss" | `ABSCHLUSS / ABSAGE` |

---

## 6. API-Endpunkte

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/api/auth` | POST | Passwort prüfen |
| `/api/leads` | GET | Alle Leads laden |
| `/api/leads` | POST | Leads speichern (volle Liste) |
| `/api/leads/replace` | PUT | Leads ersetzen (für Delete-Operationen) |
| `/api/generate` | POST | Leads via Outscraper generieren |
| `/api/generate-message` | POST | LinkedIn-DM via Claude generieren |

---

## 7. Frontend-Architektur (index.html)

### State-Management
```javascript
const state = {
  leads: [],        // aktuell geladene Leads
  activeTab: 'NEU', // aktive Pipeline-Spalte
  password: ''      // auth token
};
window.__leads = state.leads; // globaler Index-Zugriff für onclick-Handler
```

### Wichtige JS-Funktionen
| Funktion | Beschreibung |
|---|---|
| `login()` | Authentifizierung |
| `logout()` | Session beenden |
| `syncDatabase()` | Leads von KV laden |
| `syncLeads(arr)` | Leads in KV speichern |
| `normalizeStatus(s)` | Status-String normalisieren |
| `updateKPIs()` | Dashboard-Metriken aktualisieren |
| `renderTable()` | Lead-Tabelle rendern |
| `renderCalendar()` | Kalender rendern (calView: day/week/month) |
| `renderActivityFeed()` | Aktivitäts-Feed rendern |
| `renderReports()` | Analytics rendern |
| `showLeadDetail(idx)` | Lead-Detail-Modal öffnen |
| `showStatusLeads(status)` | Status-Filter-Modal öffnen |
| `openNewAppointment()` | Neuer-Termin-Modal öffnen |
| `saveAppt()` | Termin speichern + Lead-Status updaten |
| `deleteLead(idx)` | Lead löschen (via replace API) |
| `addToCalendar(idx)` | .ics Datei exportieren |
| `renderDayView(grid,...)` | Tagesansicht rendern |
| `renderWeekView(grid,...)` | Wochenansicht rendern |
| `renderMonthView(grid,...)` | Monatsansicht rendern |
| `calNav(dir, reset)` | Kalender-Monat navigieren |
| `setCalView(view)` | Kalender-Ansicht wechseln (day/week/month) |
| `switchView(view)` | Hauptansicht wechseln |
| `closeModal(id)` / `openModal(id)` | Modals öffnen/schließen |

### Views / Sections
- `view-dashboard` — KPI-Karten + Aktivitäts-Feed
- `view-leads` — Pipeline-Tabs + Lead-Tabelle
- `view-calendar` — Kalender (Tag/Woche/Monat)
- `view-reports` — Analytics/Donut-Charts
- `view-generator` — Lead-Generierungs-Formular

---

## 8. CI-Design

**Primärfarbe:** `#0E2A47` (Navy Dark Blue)  
**Primary Hover:** `#0a1f35`  
**Blau-Abstufungen für KPIs:**
- Neue Leads: `#c8d8e8` (Rand), `#4a7fa5` (Icon)
- In Akquise: `#3a6ea5`  
- Termin Fixiert: `#0E2A47`
- Abschlüsse: `#16a34a` (Grün)
- Orange für TERMIN FIXIERT Events im Kalender: `#f97316`

**Font:** Inter (Google Fonts)  
**Icons:** Lucide Icons (via CDN)

---

## 9. Modals / Popups

| Modal ID | Beschreibung | JS-Funktion |
|---|---|---|
| `leadModal` | Lead-Detailansicht | `showLeadDetail(idx)` |
| `statusModal` | Leads nach Status filtern | `showStatusLeads(status)` |
| `apptModal` | Neuer Termin anlegen | `openNewAppointment()` |
| `pitchModal` | LinkedIn-Pitch generieren | `openModal(idx)` |

---

## 10. Bekannte technische Details & Gotchas

- **onclick-Handler:** Immer `window.__leads[idx]` oder `state.leads[idx]` verwenden — NIEMALS JSON.stringify in onclick (crasht bei Sonderzeichen)
- **KV-Client:** Muss als Singleton initialisiert werden: `const kv = createClient({ url, token })` — nicht mehrfach instanziieren
- **Status-Normalisierung:** `normalizeStatus()` muss überall verwendet werden, da Leads unterschiedliche Schreibweisen haben können
- **calView:** Globale Variable `let calView = 'day'` — AUSSERHALB von `calNav()` deklariert (sonst JS-Syntax-Error!)
- **renderCalendar Aufruf:** Immer nach `setCalView()` oder `calNav()` aufrufen
- **Responsive Breakpoints:** 1100px (3-col metrics), 900px (sidebar hidden), 600px (mobile)
- **Authentifizierung:** Login-Screen hat Passwort-Toggle (Auge-Icon, `id="eyeIcon"`)

---

## 11. Vercel Environment Variables

| Variable | Beschreibung |
|---|---|
| `CRM_PASSWORD` | Master-Passwort für Login |
| `KV_REST_API_URL` | Vercel KV API URL |
| `KV_REST_API_TOKEN` | Vercel KV API Token |
| `OUTSCRAPER_API_KEY` | Outscraper für Lead-Generierung |
| `ANTHROPIC_API_KEY` | Claude API für LinkedIn-Nachrichten |

---

## 12. Letzte Änderungen (Chronologie)

| Datum | Änderung |
|---|---|
| 2026-04-03 | Initiales Setup: Lead-Generierung, KV-Sync, Outscraper-Integration |
| 2026-04-03 | Pipeline-Rendering-Fix: JSON.stringify → window.__leads[idx] |
| 2026-04-03 | Delete-Funktion: /api/leads/replace.js Endpunkt erstellt |
| 2026-04-03 | Kalender: Mono-Design, orange nur TERMIN FIXIERT |
| 2026-04-03 | Responsives Layout: Media-Queries für mobile/tablet |
| 2026-04-03 | Kalender: JS-gerendert mit Live-Datum, Mini-Cal mit Navigation |
| 2026-04-03 | CI-Farbe: #0E2A47 Navy als --primary gesetzt |
| 2026-04-03 | Login: Passwort-Toggle (Auge-Icon) |
| 2026-04-03 | Bug-Fix: calView-Deklaration war innerhalb calNav() — JS komplett kaputt |
| 2026-04-03 | Kalender: Tag/Woche/Monat Ansichten mit echten Zeitslots |
| 2026-04-03 | Dashboard: Metric Cards mit CI-Blautönen und Detail-Buttons |
| 2026-04-03 | Modals: Lead-Detail, Status-Liste, Neuer Termin |
| 2026-04-03 | Aktivitäts-Feed: Echte Lead-Daten, sortiert nach Status |
| 2026-04-03 | Action Icons: Overflow-Fix (kein Clipping beim Hover) |
| 2026-04-03 | Dynamic Branch Filter: Populates from current lead data |
| 2026-04-03 | Deal Note Modal: Pop-up for larger text editing |
| 2026-04-04 | Lead Import: Manual CSV/Excel/PDF upload with duplicate check |
| 2026-04-04 | statusDate: Tracks the day a lead changed its CRM status |
| 2026-04-04 | Calendar Fix: Only shows confirmed appointments (TERMIN FIXIERT) |
| 2026-04-04 | UI Details: Separated City/Address, removed LinkedIn, fixed arrows |
