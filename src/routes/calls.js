const express = require('express');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

/**
 * Reventix Action URL Variables:
 * $action, $account, $call_direction, $local_party, $local_alias,
 * $remote_party, $remote_alias, $remotedisplayname, $hold_state,
 * $call_duration_seconds, $call_created_time, $call_connected_time,
 * $call_disconnected_time, $call_guid
 */

// ── Helper: Normalize phone number to just digits ──
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  // Remove country codes: +49/0049 → 0
  if (digits.startsWith('49') && digits.length > 10) digits = '0' + digits.substring(2);
  if (digits.startsWith('0049')) digits = '0' + digits.substring(4);
  return digits;
}

// ── Helper: Find customer by phone number ──
async function findCustomerByPhone(prisma, phone) {
  if (!phone) return null;
  const digits = normalizePhone(phone);
  if (digits.length < 4) return null;
  
  // Try multiple match lengths for robustness
  const last8 = digits.slice(-8);
  const last10 = digits.slice(-10);

  const customers = await prisma.customer.findMany({
    where: {
      OR: [
        { phone: { endsWith: last8 } },
        { mobile: { endsWith: last8 } },
        { partnerPhone: { endsWith: last8 } },
      ]
    },
    select: { id: true, firstName: true, lastName: true, company: true, phone: true, mobile: true, partnerName: true, partnerPhone: true }
  });

  return customers.length > 0 ? customers[0] : null;
}

// ── Helper: Find employee by phone number ──
async function findEmployeeByPhone(prisma, phone) {
  if (!phone) return null;
  const digits = normalizePhone(phone);
  if (digits.length < 4) return null;
  const last8 = digits.slice(-8);

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { phone: { endsWith: last8 } },
        { mobile: { endsWith: last8 } },
      ]
    },
    select: { id: true, name: true, role: true, phone: true, mobile: true }
  });

  return users.length > 0 ? users[0] : null;
}

// ══════════════════════════════════════════
// Reventix Action URL Endpoints (NO AUTH)
// Called automatically by the softphone
// ══════════════════════════════════════════

// GET /api/calls/incoming - Eingehender Anruf von Softphone Action-URL
// POST /api/calls/incoming - Eingehender Anruf von sipgate.io / Reventix Webhook
// Unterstützt ALLE Variablen-Formate:
//   Juggler/SNOM: $RemoteParty, $LocalParty (case-sensitive, kein Unterstrich)
//   sipgate.io POST: from, to, direction (POST body)
//   Custom GET: remoteparty, caller, from, number
async function handleIncomingCall(req, res) {
  try {
    // Merge GET + POST params
    const params = { ...req.query, ...req.body };
    const fullUrl = req.originalUrl || req.url;
    
    console.log(`[CALL INCOMING] ═══════════════════════════════`);
    console.log(`[CALL INCOMING] Method: ${req.method}`);
    console.log(`[CALL INCOMING] Full URL: ${fullUrl}`);
    console.log(`[CALL INCOMING] Query:`, JSON.stringify(req.query, null, 2));
    if (req.body && Object.keys(req.body).length) console.log(`[CALL INCOMING] Body:`, JSON.stringify(req.body, null, 2));
    console.log(`[CALL INCOMING] Headers:`, JSON.stringify(req.headers, null, 2));

    // ── Rufnummer extrahieren: Probiere ALLE bekannten Parameternamen ──
    const callerNumber = 
      // Juggler/SNOM Action-URL (case-sensitive!)
      params.RemoteParty || params.remoteparty || params.remote_party ||
      // sipgate.io webhook (POST)
      params.from || params.caller || params.callerNumber || params.number ||
      // Fallback
      '';
    
    const agentNumber = 
      params.LocalParty || params.localparty || params.local_party ||
      params.to || params.agent || params.callee || '';
    
    let callerName = 
      params.RemoteAlias || params.remotedisplayname || params.remote_alias ||
      params.RemoteDisplayName || params.remotealias || '';
    
    const direction = params.calldirection || params.CallOrigin || params.direction || params.event || 'in';
    const callGuid = params.CallGUID || params.callguid || params.callId || '';

    // $-Variablen die NICHT aufgelöst wurden filtern
    if (callerName.includes('$')) callerName = '';
    const isUnresolved = (v) => !v || v.includes('$');

    console.log(`[CALL INCOMING] callerNumber="${callerNumber}" (resolved: ${!isUnresolved(callerNumber)})`);
    console.log(`[CALL INCOMING] agentNumber="${agentNumber}" callerName="${callerName}"`);
    
    // Wenn KEINE Nummer aufgelöst wurde → Warnung
    if (isUnresolved(callerNumber)) {
      console.log(`[CALL INCOMING] ⚠️ KEINE NUMMER AUFGELÖST! Variablen nicht ersetzt.`);
    } else {
      console.log(`[CALL INCOMING] normalized="${normalizePhone(callerNumber)}" last8="${normalizePhone(callerNumber).slice(-8)}"`);
    }

    // Kunde suchen
    const safeNumber = isUnresolved(callerNumber) ? '' : callerNumber;
    const customer = safeNumber ? await findCustomerByPhone(req.prisma, safeNumber) : null;
    const employee = !customer && safeNumber ? await findEmployeeByPhone(req.prisma, safeNumber) : null;
    console.log(`[CALL INCOMING] customer=${customer?.firstName||'null'} employee=${employee?.name||'null'}`);

    // Call loggen
    let startTime = new Date();
    const rawTime = params.createdtime || params.CallCreatedTime || params.timestamp;
    if (rawTime && !rawTime.includes('$') && !isNaN(new Date(rawTime).getTime())) {
      startTime = new Date(rawTime);
    }

    const safeAgent = isUnresolved(agentNumber) ? '' : agentNumber;
    const call = await req.prisma.callLog.create({
      data: {
        callerNumber: safeNumber,
        targetNumber: safeAgent,
        direction: 'INBOUND',
        startTime,
        sipUser: safeAgent,
        source: req.method === 'POST' ? 'webhook' : 'action_url',
        customerId: customer ? customer.id : null
      }
    });

    // Notizen laden
    let recentNotes = [];
    if (customer) {
      recentNotes = await req.prisma.note.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { user: { select: { name: true } } }
      });
    }

    // HTML Popup zurückgeben
    const html = generateCallPopupHtml({
      direction: 'INBOUND',
      callerNumber: safeNumber,
      callerName,
      customer,
      employee,
      recentNotes,
      callId: call.id,
      callTime: call.startTime,
      debugUrl: fullUrl,
      debugQuery: JSON.stringify(params),
      unresolved: isUnresolved(callerNumber)
    });
    return res.type('html').send(html);

  } catch (err) {
    console.error('[CALL INCOMING]', err.message);
    res.status(200).type('html').send(`<html><body><h2>Fehler</h2><p>${err.message}</p></body></html>`);
  }
}
router.get('/incoming', handleIncomingCall);
router.post('/incoming', handleIncomingCall);

// GET /api/calls/outgoing - Ausgehender Anruf
router.get('/outgoing', async (req, res) => {
  try {
    const {
      remoteparty, localparty, local_alias, remotedisplayname,
      createdtime, callguid
    } = req.query;

    const targetNumber = remoteparty || req.query.target || '';
    const agentNumber = localparty || req.query.agent || '';
    let callerName = remotedisplayname || '';
    if (callerName.startsWith('<$') || callerName.startsWith('$')) callerName = '';

    // $-Variablen rausfiltern
    const safeTarget = targetNumber.startsWith('$') ? '' : targetNumber;
    const safeAgent = agentNumber.startsWith('$') ? '' : agentNumber;
    const safeSip = (local_alias || agentNumber || '').startsWith('$') ? '' : (local_alias || agentNumber || '');
    let startTime = new Date();
    if (createdtime && !createdtime.startsWith('$') && !isNaN(new Date(createdtime).getTime())) {
      startTime = new Date(createdtime);
    }

    const customer = await findCustomerByPhone(req.prisma, safeTarget);
    const employee = !customer ? await findEmployeeByPhone(req.prisma, safeTarget) : null;

    const call = await req.prisma.callLog.create({
      data: {
        callerNumber: safeAgent,
        targetNumber: safeTarget,
        direction: 'OUTBOUND',
        startTime,
        sipUser: safeSip,
        source: 'action_url',
        customerId: customer ? customer.id : null
      }
    });

    // Letzte Notizen laden
    let recentNotes = [];
    if (customer) {
      recentNotes = await req.prisma.note.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { user: { select: { name: true } } }
      });
    }

    // IMMER HTML Popup zurückgeben
    const html = generateCallPopupHtml({
      direction: 'OUTBOUND',
      callerNumber: targetNumber,
      callerName,
      customer,
      employee,
      recentNotes,
      callId: call.id,
      callTime: call.startTime
    });
    return res.type('html').send(html);

  } catch (err) {
    console.error('[CALL OUTGOING]', err.message);
    res.status(200).type('html').send(`<html><body><h2>Fehler</h2><p>${err.message}</p></body></html>`);
  }
});

// GET /api/calls/ended - Anruf beendet (callduration kommt mit!)
router.get('/ended', async (req, res) => {
  try {
    const {
      remoteparty, callduration, disconnectedtime, connectedtime,
      createdtime, callguid
    } = req.query;

    const callerNumber = remoteparty || req.query.caller || '';
    // Skip if variables not resolved
    if (callerNumber.startsWith('$') || !callerNumber) return res.status(200).send('OK');
    
    const duration = callduration && !callduration.startsWith('$') ? parseInt(callduration) : null;

    // Find most recent open call
    const recentCall = await req.prisma.callLog.findFirst({
      where: {
        OR: [
          { callerNumber: callerNumber },
          { targetNumber: callerNumber }
        ],
        source: 'action_url',
        endTime: null
      },
      orderBy: { startTime: 'desc' }
    });

    if (recentCall) {
      let endTime = new Date();
      if (disconnectedtime && !disconnectedtime.startsWith('$') && !isNaN(new Date(disconnectedtime).getTime())) {
        endTime = new Date(disconnectedtime);
      }
      await req.prisma.callLog.update({
        where: { id: recentCall.id },
        data: { endTime, duration }
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[CALL ENDED]', err.message);
    res.status(200).send('OK');
  }
});

// GET /api/calls/connect - Anruf annehmen
router.get('/connect', async (req, res) => {
  try {
    const { remoteparty, connectedtime } = req.query;
    const callerNumber = remoteparty || '';

    // Update connect time on most recent call
    const recentCall = await req.prisma.callLog.findFirst({
      where: {
        OR: [
          { callerNumber: callerNumber },
          { targetNumber: callerNumber }
        ],
        source: 'action_url',
        endTime: null
      },
      orderBy: { startTime: 'desc' }
    });

    // Just acknowledge - main tracking happens on ended
    res.status(200).send('OK');
  } catch (err) {
    console.error('[CALL CONNECT]', err.message);
    res.status(200).send('OK');
  }
});

// GET /api/calls/hold - Anruf halten
router.get('/hold', async (req, res) => {
  res.status(200).send('OK');
});

// GET /api/calls/debug - Zeigt ALLE URL-Parameter (zum Testen der Reventix-Konfiguration)
async function handleDebug(req, res) {
  const params = { ...req.query, ...req.body };
  const html = `<!DOCTYPE html>
<html><head><title>MEOS Call Debug</title>
<style>body{font-family:monospace;padding:20px;background:#1a1207;color:#f5f0eb;}
h1{color:#e87b1c;}pre{background:#2a2217;padding:16px;border-radius:8px;overflow-x:auto;}
.ok{color:#10b981;}.fail{color:#ef4444;}h3{margin-top:16px;}</style>
</head><body>
<h1>🔧 MEOS Call Debug</h1>
<p><strong>Methode:</strong> ${req.method}</p>
<h3>Empfangene URL:</h3>
<pre>${req.originalUrl || req.url}</pre>
<h3>Alle Parameter (Query + Body) (${Object.keys(params).length}):</h3>
<pre>${JSON.stringify(params, null, 2)}</pre>
<h3>Analyse:</h3>
<ul>
${Object.entries(params).map(([k,v]) => {
  const isRaw = typeof v === 'string' && (v.startsWith('$') || v.startsWith('<$'));
  return `<li><strong>${k}:</strong> <span class="${isRaw?'fail':'ok'}">${v}</span> ${isRaw?'❌ NICHT AUFGELÖST':'✅ OK'}</li>`;
}).join('\n')}
</ul>
<h3>Erkannte Rufnummer:</h3>
<p><strong>${params.RemoteParty || params.remoteparty || params.remote_party || params.from || params.caller || params.number || '❌ KEINE NUMMER GEFUNDEN'}</strong></p>
<h3>Unterstützte Parameter-Namen (einer reicht):</h3>
<pre>GET: ?RemoteParty=...  (Juggler/SNOM)
GET: ?remoteparty=...   (Reventix lowercase)
GET: ?from=...          (sipgate.io)
GET: ?caller=...        (generisch)
POST body: from=...     (sipgate.io webhook)</pre>
<h3>Headers:</h3>
<pre>${JSON.stringify(req.headers, null, 2)}</pre>
</body></html>`;
  res.type('html').send(html);
}
router.get('/debug', handleDebug);
router.post('/debug', handleDebug);

// ══════════════════════════════════════════
// HTML Popup for incoming calls
// ══════════════════════════════════════════

function generateCallPopupHtml({ direction, callerNumber, callerName, customer, employee, recentNotes, callId, callTime, debugUrl, debugQuery, unresolved }) {
  // Clean display values - filter out raw $-variables
  const displayNumber = (callerNumber && !callerNumber.includes('$')) ? callerNumber : '';
  const displayName = (callerName && !callerName.includes('$')) ? callerName : '';
  const time = new Date(callTime).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Berlin' });
  const date = new Date(callTime).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

  const notesHtml = recentNotes.length > 0
    ? recentNotes.map(n => `
      <div style="padding:10px;border-left:3px solid #3b82f6;margin-bottom:8px;background:#f8fafc;border-radius:0 8px 8px 0;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:600;font-size:12px;color:#1e40af;">${n.user?.name || 'System'}</span>
          <span style="font-size:11px;color:#94a3b8;">${new Date(n.createdAt).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} ${new Date(n.createdAt).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'})}</span>
        </div>
        <div style="font-size:13px;color:#334155;">${n.text}</div>
      </div>
    `).join('')
    : '<div style="color:#94a3b8;font-size:13px;padding:10px;">Keine bisherigen Notizen</div>';

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MEOS – ${direction === 'INBOUND' ? 'Eingehender' : 'Ausgehender'} Anruf</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f1f5f9; padding:16px; }
    .card { background:#fff; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,0.08); padding:20px; margin-bottom:16px; }
    .header { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
    .phone-icon { width:48px; height:48px; background:${direction === 'INBOUND' ? '#10b981' : '#3b82f6'}; border-radius:50%; display:flex; align-items:center; justify-content:center; animation:pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.1)} }
    .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700; }
    .badge-in { background:#dcfce7; color:#166534; }
    h1 { font-size:22px; color:#0f172a; }
    .company { font-size:14px; color:#64748b; }
    .phone-nr { font-size:16px; color:#3b82f6; font-weight:600; }
    .section-title { font-size:13px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; }
    textarea { width:100%; padding:10px; border:2px solid #e2e8f0; border-radius:8px; font-size:14px; resize:vertical; min-height:70px; font-family:inherit; }
    textarea:focus { outline:none; border-color:#3b82f6; }
    .btn { padding:10px 24px; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
    .btn-primary { background:#3b82f6; color:#fff; }
    .btn-primary:hover { background:#2563eb; }
    .btn-open { background:#0f172a; color:#fff; text-decoration:none; }
    .btn-open:hover { background:#1e293b; }
    .actions { display:flex; gap:8px; margin-top:12px; }
    .meta { display:flex; gap:16px; font-size:12px; color:#94a3b8; margin-top:8px; }
    .success { display:none; padding:10px; background:#dcfce7; color:#166534; border-radius:8px; margin-top:8px; font-size:13px; font-weight:600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="phone-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
      </div>
      <div>
        <span class="badge badge-in">${direction === 'INBOUND' ? '📞 Eingehender Anruf' : '📤 Ausgehender Anruf'}</span>
        <div class="meta">
          <span>📅 ${date}</span>
          <span>⏰ ${time}</span>
        </div>
      </div>
    </div>

    ${customer ? `
      <h1>${customer.firstName} ${customer.lastName}</h1>
      ${customer.company ? `<div class="company">${customer.company}</div>` : ''}
      <div class="phone-nr" style="margin-top:6px;">📱 ${displayNumber}</div>
    ` : employee ? `
      <h1>👤 ${employee.name}</h1>
      <div class="company">Mitarbeiter · ${employee.role}</div>
      <div class="phone-nr" style="margin-top:6px;">📱 ${displayNumber}</div>
    ` : `
      <h1>Unbekannter Anrufer</h1>
      <div class="phone-nr" style="margin-top:6px;">📱 ${displayNumber}</div>
      ${displayName ? `<div class="company">Anzeige: ${displayName}</div>` : ''}
    `}
  </div>

  <div class="card">
    <div class="section-title">📝 Letzte Notizen (${recentNotes.length})</div>
    ${notesHtml}
  </div>

  <div class="card">
    <div class="section-title">✏️ Neue Notiz zum Anruf</div>
    <textarea id="noteText" placeholder="Notiz zum Anruf eingeben..."></textarea>
    <div class="actions">
      <button class="btn btn-primary" onclick="saveNote()">💾 Notiz speichern</button>
      <!-- buttons removed: React-Frontend hat keine URL-Deep-Routes -->
    </div>
    <div id="success" class="success">✅ Notiz gespeichert!</div>
  </div>

  ${!customer && !employee ? `
  <div class="card" id="createContactCard">
    <div class="section-title">➕ Neuen Kunden anlegen</div>
    <p style="font-size:12px;color:#64748b;margin-bottom:12px;">Nummer nicht bekannt – direkt als Kunden anlegen:</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <div>
        <label style="font-size:11px;color:#64748b;font-weight:600;">Vorname</label>
        <input id="cFirstName" type="text" placeholder="Vorname" style="width:100%;padding:8px;border:2px solid #e2e8f0;border-radius:6px;font-size:13px;"/>
      </div>
      <div>
        <label style="font-size:11px;color:#64748b;font-weight:600;">Nachname *</label>
        <input id="cLastName" type="text" placeholder="Nachname" style="width:100%;padding:8px;border:2px solid #e2e8f0;border-radius:6px;font-size:13px;"/>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <div>
        <label style="font-size:11px;color:#64748b;font-weight:600;">Firma</label>
        <input id="cCompany" type="text" placeholder="Firma" style="width:100%;padding:8px;border:2px solid #e2e8f0;border-radius:6px;font-size:13px;"/>
      </div>
      <div>
        <label style="font-size:11px;color:#64748b;font-weight:600;">E-Mail</label>
        <input id="cEmail" type="email" placeholder="E-Mail" style="width:100%;padding:8px;border:2px solid #e2e8f0;border-radius:6px;font-size:13px;"/>
      </div>
    </div>
    <div style="margin-bottom:8px;">
      <label style="font-size:11px;color:#64748b;font-weight:600;">Telefon (aus Anruf)</label>
      <input id="cPhone" type="text" value="${displayNumber}" readonly style="width:100%;padding:8px;border:2px solid #e2e8f0;border-radius:6px;font-size:13px;background:#f8fafc;"/>
    </div>
    <button class="btn btn-primary" onclick="createContact()" style="background:#10b981;">➕ Kunden anlegen & Anruf zuordnen</button>
    <div id="createSuccess" class="success">✅ Kunde angelegt und Anruf zugeordnet!</div>
  </div>
  ` : ''}

  <script>
    async function saveNote() {
      const text = document.getElementById('noteText').value.trim();
      if (!text) return alert('Bitte Notiz eingeben');
      try {
        const res = await fetch('/api/calls/${callId}/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (res.ok) {
          document.getElementById('success').style.display = 'block';
          document.getElementById('noteText').value = '';
          setTimeout(() => document.getElementById('success').style.display = 'none', 3000);
        }
      } catch(e) { alert('Fehler beim Speichern'); }
    }

    async function createContact() {
      const lastName = document.getElementById('cLastName').value.trim();
      if (!lastName) return alert('Bitte mindestens Nachname eingeben');
      try {
        const res = await fetch('/api/calls/${callId}/create-contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName: document.getElementById('cFirstName').value.trim(),
            lastName: lastName,
            company: document.getElementById('cCompany').value.trim(),
            email: document.getElementById('cEmail').value.trim(),
            phone: document.getElementById('cPhone').value.trim()
          })
        });
        if (res.ok) {
          const data = await res.json();
          document.getElementById('createSuccess').style.display = 'block';
          document.getElementById('createContactCard').style.opacity = '0.5';
          // Nach 2s Seite neu laden um den Kunden zu zeigen
          setTimeout(() => window.location.reload(), 2000);
        } else {
          const err = await res.json();
          alert('Fehler: ' + (err.error || 'Unbekannt'));
        }
      } catch(e) { alert('Fehler beim Anlegen'); }
    }
  </script>

  <div class="card" style="margin-top:16px;background:#fffbeb;border:1px solid #fcd34d;">
    <div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:6px;cursor:pointer;" onclick="document.getElementById('debugInfo').style.display=document.getElementById('debugInfo').style.display==='none'?'block':'none'">
      🔧 Debug-Info (klicken zum Öffnen)
    </div>
    <div id="debugInfo" style="display:none;font-size:11px;color:#78716c;word-break:break-all;">
      <div><strong>Raw callerNumber:</strong> ${callerNumber || '(leer)'}</div>
      <div><strong>Display:</strong> ${displayNumber}</div>
      <div><strong>callerName:</strong> ${callerName || '(leer)'}</div>
      <div><strong>URL:</strong> ${debugUrl || '(nicht verfügbar)'}</div>
      <div><strong>Query:</strong> <pre style="font-size:10px;background:#fff;padding:6px;border-radius:4px;overflow-x:auto;max-height:150px;">${debugQuery || '{}'}</pre></div>
    </div>
  </div>

</body>
</html>`;
}

// ══════════════════════════════════════════
// Authenticated API endpoints
// ══════════════════════════════════════════

// GET /api/calls - Alle Anrufe auflisten
router.get('/', authenticate, async (req, res) => {
  try {
    const { customerId, direction, from, to, page = 1, limit = 50 } = req.query;
    const where = {};
    if (customerId) where.customerId = customerId;
    if (direction) where.direction = direction;
    if (from || to) {
      where.startTime = {};
      if (from) where.startTime.gte = new Date(from);
      if (to) where.startTime.lte = new Date(to);
    }

    const calls = await req.prisma.callLog.findMany({
      where,
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { startTime: 'desc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, company: true } },
        notes: { include: { user: { select: { name: true } } } }
      }
    });

    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/:id/notes - Notiz zu Anruf hinzufügen (auch ohne Auth für Popup)
router.post('/:id/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text erforderlich' });

    // Try to get user from auth, fallback to first admin
    let userId;
    try {
      const jwt = require('jsonwebtoken');
      const token = req.headers.authorization?.split(' ')[1];
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
      }
    } catch(e) {}

    if (!userId) {
      const admin = await req.prisma.user.findFirst({ where: { role: 'ADMIN' } });
      userId = admin?.id;
    }

    if (!userId) return res.status(400).json({ error: 'Kein User gefunden' });

    const note = await req.prisma.callNote.create({
      data: {
        callLogId: req.params.id,
        text,
        userId
      },
      include: { user: { select: { name: true } } }
    });

    // Also create a customer note if call has a customer
    const call = await req.prisma.callLog.findUnique({ where: { id: req.params.id } });
    if (call?.customerId) {
      await req.prisma.note.create({
        data: {
          customerId: call.customerId,
          type: 'ANRUF',
          text: `📞 Anruf-Notiz: ${text}`,
          userId
        }
      });
    }

    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calls/:id/assign - Anruf einem bestehenden Kunden zuordnen
router.put('/:id/assign', authenticate, async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId erforderlich' });

    const call = await req.prisma.callLog.update({
      where: { id: req.params.id },
      data: { customerId },
      include: {
        customer: { select: { firstName: true, lastName: true, company: true } }
      }
    });

    res.json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/:id/create-contact - Aus Anruf-Nummer neuen Kunden anlegen
// Works without auth from popup (callId serves as verification)
router.post('/:id/create-contact', async (req, res) => {
  try {
    const { firstName, lastName, company, email, phone } = req.body;
    if (!lastName) return res.status(400).json({ error: 'Nachname erforderlich' });

    const call = await req.prisma.callLog.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });

    // Nummer: aus Form oder aus Anruf
    const phoneNumber = phone || (call.direction === 'INBOUND' ? call.callerNumber : call.targetNumber);

    // Kunden anlegen
    const customer = await req.prisma.customer.create({
      data: {
        firstName: firstName || '',
        lastName,
        company: company || null,
        email: email || null,
        phone: phoneNumber,
        source: 'MANUAL',
        tags: ['Telefonkontakt']
      }
    });

    // Anruf dem neuen Kunden zuordnen
    await req.prisma.callLog.update({
      where: { id: req.params.id },
      data: { customerId: customer.id }
    });

    // Auch alle anderen Anrufe mit gleicher Nummer zuordnen
    const digits = phoneNumber.replace(/\D/g, '');
    const last8 = digits.slice(-8);
    if (last8.length >= 6) {
      await req.prisma.callLog.updateMany({
        where: {
          customerId: null,
          OR: [
            { callerNumber: { endsWith: last8 } },
            { targetNumber: { endsWith: last8 } },
          ]
        },
        data: { customerId: customer.id }
      });
    }

    res.status(201).json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/lookup/:phone - Nummer nachschlagen (Kunde + Mitarbeiter)
router.get('/lookup/:phone', authenticate, async (req, res) => {
  try {
    const phone = req.params.phone;
    const normalized = normalizePhone(phone);
    const last8 = normalized.slice(-8);
    const customer = await findCustomerByPhone(req.prisma, phone);
    const employee = await findEmployeeByPhone(req.prisma, phone);
    res.json({ 
      input: phone,
      normalized,
      last8,
      customer, 
      employee 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// PHONEBOOK ENDPOINTS (for Reventix / SIP Phones)
// ═══════════════════════════════════════

// GET /api/calls/phonebook.xml - Grandstream XML format
router.get('/phonebook.xml', async (req, res) => {
  try {
    const customers = await req.prisma.customer.findMany({
      where: { status: 'AKTIV' },
      select: { firstName: true, lastName: true, company: true, phone: true, mobile: true },
      orderBy: { lastName: 'asc' }
    });
    const employees = await req.prisma.user.findMany({
      where: { isActive: true },
      select: { name: true, phone: true, mobile: true, role: true }
    });

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<AddressBook>\n';
    
    // Kunden-Gruppe
    xml += '  <pbgroup>\n    <id>1</id>\n    <name>Kunden</name>\n  </pbgroup>\n';
    // Mitarbeiter-Gruppe
    xml += '  <pbgroup>\n    <id>2</id>\n    <name>Mitarbeiter</name>\n  </pbgroup>\n';

    // Kunden
    customers.forEach(c => {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      if (!name && !c.company) return;
      const displayName = c.company ? `${name} (${c.company})` : name;
      xml += '  <Contact>\n';
      xml += `    <FirstName>${escXml(c.firstName || '')}</FirstName>\n`;
      xml += `    <LastName>${escXml(c.lastName || '')}</LastName>\n`;
      xml += `    <Department>${escXml(c.company || '')}</Department>\n`;
      xml += '    <Group>1</Group>\n';
      if (c.phone) xml += `    <Phone type="Work"><phonenumber>${escXml(c.phone)}</phonenumber></Phone>\n`;
      if (c.mobile) xml += `    <Phone type="Mobile"><phonenumber>${escXml(c.mobile)}</phonenumber></Phone>\n`;
      xml += '  </Contact>\n';
    });

    // Mitarbeiter
    employees.forEach(e => {
      xml += '  <Contact>\n';
      xml += `    <FirstName>${escXml(e.name)}</FirstName>\n`;
      xml += `    <LastName></LastName>\n`;
      xml += `    <Department>${escXml(e.role)}</Department>\n`;
      xml += '    <Group>2</Group>\n';
      if (e.phone) xml += `    <Phone type="Work"><phonenumber>${escXml(e.phone)}</phonenumber></Phone>\n`;
      if (e.mobile) xml += `    <Phone type="Mobile"><phonenumber>${escXml(e.mobile)}</phonenumber></Phone>\n`;
      xml += '  </Contact>\n';
    });

    xml += '</AddressBook>';
    res.type('application/xml').send(xml);
  } catch (err) {
    res.status(500).send('<error>' + err.message + '</error>');
  }
});

// GET /api/calls/phonebook-yealink.xml - Yealink format
router.get('/phonebook-yealink.xml', async (req, res) => {
  try {
    const customers = await req.prisma.customer.findMany({
      where: { status: 'AKTIV' },
      select: { firstName: true, lastName: true, company: true, phone: true, mobile: true },
      orderBy: { lastName: 'asc' }
    });
    const employees = await req.prisma.user.findMany({
      where: { isActive: true },
      select: { name: true, phone: true, mobile: true }
    });

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<YealinkIPPhoneBook>\n<Title>MEOS Kontakte</Title>\n';
    
    xml += '<Menu Name="Kunden">\n';
    customers.forEach(c => {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      if (!name && !c.company) return;
      const displayName = c.company ? `${name} (${c.company})` : name;
      xml += `  <Unit Name="${escXml(displayName)}" Phone1="${escXml(c.phone || '')}" Phone2="${escXml(c.mobile || '')}" Phone3="" default_photo="Resource:"/>\n`;
    });
    xml += '</Menu>\n';

    xml += '<Menu Name="Mitarbeiter">\n';
    employees.forEach(e => {
      xml += `  <Unit Name="${escXml(e.name)}" Phone1="${escXml(e.phone || '')}" Phone2="${escXml(e.mobile || '')}" Phone3="" default_photo="Resource:"/>\n`;
    });
    xml += '</Menu>\n';

    xml += '</YealinkIPPhoneBook>';
    res.type('application/xml').send(xml);
  } catch (err) {
    res.status(500).send('<error>' + err.message + '</error>');
  }
});

// GET /api/calls/phonebook.json - Reventix JSON Kontaktquelle
// Uses Reventix LDAP-style field names: cn, sn, o, telephoneNumber, mobile
router.get('/phonebook.json', async (req, res) => {
  try {
    const customers = await req.prisma.customer.findMany({
      where: { status: 'AKTIV' },
      select: { id: true, firstName: true, lastName: true, company: true, phone: true, mobile: true, email: true, street: true, zip: true, city: true },
      orderBy: { lastName: 'asc' }
    });
    const employees = await req.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, phone: true, mobile: true, role: true, email: true }
    });

    const contacts = [];

    customers.forEach(c => {
      const displayName = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      if (!displayName && !c.company) return;
      contacts.push({
        id: `k-${c.id}`,
        cn: c.firstName || '',
        sn: c.lastName || '',
        mail: c.email || '',
        title: 'Kunde',
        o: c.company || '',
        ou: '',
        co: '',
        postalCode: c.zip || '',
        postalAddress: c.city || '',
        street: c.street || '',
        telephoneNumber: c.phone || '',
        mobile: c.mobile || '',
        phoneGroups: 'Kunden'
      });
    });

    employees.forEach(e => {
      const nameParts = (e.name || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      contacts.push({
        id: `m-${e.id}`,
        cn: firstName,
        sn: lastName,
        mail: e.email || '',
        title: e.role || 'Mitarbeiter',
        o: 'Schreinerhelden',
        ou: '',
        co: '',
        postalCode: '',
        postalAddress: '',
        street: '',
        telephoneNumber: e.phone || '',
        mobile: e.mobile || '',
        phoneGroups: 'Mitarbeiter'
      });
    });

    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/phonebook.csv - CSV export
router.get('/phonebook.csv', async (req, res) => {
  try {
    const customers = await req.prisma.customer.findMany({
      where: { status: 'AKTIV' },
      select: { firstName: true, lastName: true, company: true, phone: true, mobile: true },
      orderBy: { lastName: 'asc' }
    });
    const employees = await req.prisma.user.findMany({
      where: { isActive: true },
      select: { name: true, phone: true, mobile: true, role: true }
    });

    let csv = 'Name,Firma,Telefon,Mobil,Typ\n';
    customers.forEach(c => {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      csv += `"${name}","${c.company || ''}","${c.phone || ''}","${c.mobile || ''}","Kunde"\n`;
    });
    employees.forEach(e => {
      csv += `"${e.name}","Schreinerhelden","${e.phone || ''}","${e.mobile || ''}","Mitarbeiter"\n`;
    });

    res.type('text/csv').set('Content-Disposition', 'attachment; filename="phonebook.csv"').send(csv);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

function escXml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
