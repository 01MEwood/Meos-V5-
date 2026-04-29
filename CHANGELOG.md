# Changelog

## 2026-04-29 — Reventix / TZ / Employee fixes (baked into initial snapshot)

### Fixed
- **Reventix Action URL parser**: backend already accepts `remoteparty`, `remote_party`, `RemoteParty`, `from`, `caller`, `callerNumber`, `number` — config issue at Reventix side was angle-bracket variable format (`<$remote_party>` instead of `$remote_party`)
- **Call popup time display (-2h offset)**: `src/routes/calls.js` line ~376 — added `timeZone: 'Europe/Berlin'` to all `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` calls in `generateCallPopupHtml`
- **Dashboard "Letzte Anrufe" showed phone number for employee matches**: `src/routes/dashboard.js` — added post-query enrichment that resolves `callerNumber` against the user table when no customer match exists, and populates the `customer` field with `{firstName: emp.name, lastName: '(MA)'}` for display

### Removed
- **"Kunde öffnen" / "Mitarbeiter öffnen" buttons in call popup**: the bundled React frontend (in `public/assets/index-*.js`) does not implement URL-based detail routing — `/#/kunden/{id}` and `/#/employees/{id}` both fall through to Dashboard. Buttons were misleading. Re-enable once the frontend is rebuilt with proper routing.

### Known issues (frontend rebuild required)
- Other parts of the UI (time tracking, calendar, project timestamps) may still show -2h because the bundled React code uses `.toISOString().substring(0,16)` patterns that ignore timezone. Frontend source is **not** in this snapshot — only the compiled bundle in `public/assets/`.
