const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const PORT          = process.env.PORT          || 4001;
const SESSION_DIR   = process.env.SESSION_DIR   || '/data/session';
const MEOS_WEBHOOK  = process.env.MEOS_WEBHOOK  || 'http://meos-app:4000/api/messages/whatsapp/inbound';
const SHARED_SECRET = process.env.SHARED_SECRET || 'change-me';
const OWN_NUMBER    = process.env.OWN_NUMBER    || '';

const log = pino({ level: 'info' });

let sock = null;
let lastQR = null;
let connected = false;
let lastError = null;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log.info({ version }, 'Baileys WA-version');

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }),
    browser: ['MEOS-Bridge', 'Chrome', '1.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { lastQR = qr; connected = false; log.info('QR generated, waiting for scan'); }
    if (connection === 'open') {
      connected = true; lastQR = null; lastError = null;
      log.info('WhatsApp connected as ' + sock.user?.id);
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      lastError = lastDisconnect?.error?.message || 'closed';
      log.warn({ code, msg: lastError }, 'connection closed');
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(start, 3000);
      } else {
        log.error('logged out — clear /data/session and re-pair');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message) continue;
        const remoteJid = m.key.remoteJid || '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue; // skip groups for now
        const fromMe = m.key.fromMe;
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          m.message.videoMessage?.caption ||
          (m.message.imageMessage ? '[Bild]' : '') ||
          (m.message.audioMessage ? '[Sprachnachricht]' : '') ||
          (m.message.videoMessage ? '[Video]' : '') ||
          (m.message.documentMessage ? '[Dokument: ' + (m.message.documentMessage.fileName || '') + ']' : '') ||
          (m.message.stickerMessage ? '[Sticker]' : '') ||
          '';
        const remoteNum = remoteJid.split('@')[0];
        const ownNum = (sock.user?.id || '').split(':')[0].split('@')[0];

        const payload = {
          direction: fromMe ? 'OUTBOUND' : 'INBOUND',
          fromAddr:  fromMe ? ownNum    : remoteNum,
          toAddr:    fromMe ? remoteNum : ownNum,
          body: text,
          sentAt: new Date(((m.messageTimestamp || 0) * 1000) || Date.now()).toISOString(),
          externalId: m.key.id,
          threadId: remoteJid,
          mediaType:
            m.message.imageMessage ? 'image' :
            m.message.videoMessage ? 'video' :
            m.message.audioMessage ? 'audio' :
            m.message.documentMessage ? 'document' :
            m.message.stickerMessage ? 'sticker' : null,
          source: 'baileys',
          meta: { pushName: m.pushName || null }
        };

        const res = await fetch(MEOS_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shared-Secret': SHARED_SECRET },
          body: JSON.stringify(payload)
        });
        if (!res.ok) log.warn({ status: res.status }, 'webhook non-200');
      } catch (e) { log.error({ err: e.message }, 'inbound handler failed'); }
    }
  });
}

start().catch(e => { lastError = e.message; log.error(e); });

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => res.redirect('/qr'));

app.get('/status', (_req, res) => {
  res.json({
    connected,
    lastError,
    user: sock?.user?.id || null,
    hasQR: !!lastQR
  });
});

app.get('/qr', async (_req, res) => {
  if (connected) return res.type('html').send('<h2 style="font-family:sans-serif;color:#10b981;">Verbunden als ' + (sock?.user?.id||'') + '</h2><p>Keine QR-Aktion nötig.</p>');
  if (!lastQR) return res.type('html').send('<h2>Noch kein QR vorhanden — kurz warten und reload</h2>');
  const png = await QRCode.toDataURL(lastQR, { width: 360, margin: 2 });
  res.type('html').send('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:30px;background:#f5f0eb;"><h1>WhatsApp Bridge — QR scannen</h1><p>WhatsApp Business → Einstellungen → Verknüpfte Geräte → Gerät verknüpfen</p><img src="'+png+'" style="border:1px solid #e5e5e5;border-radius:12px;padding:8px;background:#fff;"><p style="color:#666;font-size:12px;margin-top:20px;">QR aktualisiert sich automatisch. Diese Seite alle ~30s neu laden, falls QR abläuft.</p><script>setTimeout(()=>location.reload(),20000)</script></body></html>');
});

app.post('/send', async (req, res) => {
  if (req.headers['x-shared-secret'] !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to + body required' });
    const num = String(to).replace(/\D/g, '').replace(/^0(?=\d{10,})/, '49');
    const jid = num + '@s.whatsapp.net';
    const result = await sock.sendMessage(jid, { text: body });
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => log.info('bridge listening on :' + PORT));
