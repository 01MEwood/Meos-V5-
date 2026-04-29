const express = require('express');
const jwtLib = require('jsonwebtoken');
const router = express.Router();

const SHARED_SECRET = process.env.WHATSAPP_SHARED_SECRET || '';
const OWN_NUMBERS = (process.env.OWN_NUMBERS || '4971929357200,071929357200,7192935720,9357200').split(',').map(s => s.trim()).filter(Boolean);

// ── Helper: normalize phone digits ──
function norm(n) {
  if (!n) return '';
  let d = String(n).replace(/\D/g, '');
  if (d.startsWith('49') && d.length > 10) d = '0' + d.substring(2);
  if (d.startsWith('0049')) d = '0' + d.substring(4);
  return d;
}
function isOwn(num) {
  const n = norm(num);
  return OWN_NUMBERS.some(o => norm(o) === n) || OWN_NUMBERS.some(o => norm(o).slice(-7) === n.slice(-7));
}
async function findCustomerByPhone(prisma, phone) {
  const d = norm(phone);
  if (d.length < 4) return null;
  const last8 = d.slice(-8);
  const c = await prisma.customer.findFirst({
    where: { OR: [
      { phone: { endsWith: last8 } },
      { mobile: { endsWith: last8 } },
      { partnerPhone: { endsWith: last8 } }
    ]},
    select: { id: true }
  });
  return c?.id || null;
}

// ── Inbound webhook: called by Baileys bridge ──
router.post('/whatsapp/inbound', async (req, res) => {
  if (req.headers['x-shared-secret'] !== SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { direction, fromAddr, toAddr, body, sentAt, externalId, threadId, mediaType, mediaUrl, source, meta } = req.body;
    if (!fromAddr || !toAddr) return res.status(400).json({ error: 'missing fields' });

    // Determine the "other party" — the customer we want to attribute the conversation to
    const otherParty = direction === 'INBOUND' ? fromAddr : toAddr;
    if (isOwn(otherParty)) {
      // skip self-talk
      return res.json({ ok: true, skipped: 'self' });
    }
    const customerId = await findCustomerByPhone(req.prisma, otherParty);

    // Dedup by externalId
    if (externalId) {
      const exists = await req.prisma.message.findFirst({ where: { externalId } });
      if (exists) return res.json({ ok: true, deduped: true });
    }

    const m = await req.prisma.message.create({ data: {
      customerId,
      channel: 'WHATSAPP',
      direction: direction || 'INBOUND',
      fromAddr,
      toAddr,
      body: body || '',
      sentAt: sentAt ? new Date(sentAt) : new Date(),
      externalId: externalId || null,
      threadId: threadId || null,
      mediaType: mediaType || null,
      mediaUrl: mediaUrl || null,
      source: source || 'baileys',
      meta: meta || null
    }});
    console.log('[WA INBOUND]', direction, otherParty, '→ customer:', customerId || 'none', '·', (body||'').slice(0,60));
    res.json({ ok: true, id: m.id, customerId });
  } catch (err) {
    console.error('[WA INBOUND ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Send: called by MEOS UI (token auth) ──
router.post('/whatsapp/send', async (req, res) => {
  // Auth: JWT either via Authorization header (in-app) or via ?t= query (popup)
  let user = null;
  try {
    let token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.t;
    if (!token) return res.status(401).json({ error: 'no token' });
    user = jwtLib.verify(token, process.env.JWT_SECRET);
  } catch { return res.status(401).json({ error: 'invalid token' }); }

  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to + body required' });

    // Forward to bridge
    const bridge = process.env.WHATSAPP_BRIDGE_URL || 'http://meos-whatsapp:4001';
    const r = await fetch(bridge + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shared-Secret': SHARED_SECRET },
      body: JSON.stringify({ to, body })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    res.json({ ok: true, ...j });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List messages for a customer (auth) ──
router.get('/customer/:id', async (req, res) => {
  try {
    let token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.t;
    if (!token) return res.status(401).json({ error: 'no token' });
    jwtLib.verify(token, process.env.JWT_SECRET);
  } catch { return res.status(401).json({ error: 'invalid token' }); }
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const channel = req.query.channel || undefined;
  const ms = await req.prisma.message.findMany({
    where: { customerId: req.params.id, ...(channel ? { channel } : {}) },
    orderBy: { sentAt: 'desc' },
    take: limit
  });
  res.json(ms);
});

module.exports = router;
