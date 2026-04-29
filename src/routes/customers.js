const express = require('express');
const jwtLib = require('jsonwebtoken');
const { authenticate, requireRole, canRead } = require('../middleware/auth');

const router = express.Router();


// GET /api/customers/:id/card - Server-rendered customer info card (token via ?t= query)
// MUST come before router.use(authenticate) so we can use our own query-token auth
router.get('/:id/card', async (req, res) => {
  try {
    const token = req.query.t || '';
    if (!token) return res.status(401).type('html').send('<h2>Token fehlt</h2>');
    const decoded = jwtLib.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
  } catch (e) {
    return res.status(401).type('html').send('<h2>Ungültiges Token</h2>');
  }

  try {
    const c = await req.prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        notes: { take: 5, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
        projects: { take: 8, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, phase: true, status: true, montageDate: true } }
      }
    });
    if (!c) return res.status(404).type('html').send('<h2>Kunde nicht gefunden</h2>');

    const recentCalls = await req.prisma.callLog.findMany({
      where: { customerId: c.id },
      take: 5,
      orderBy: { startTime: 'desc' }
    });
    const waMessages = await req.prisma.message.findMany({
      where: { customerId: c.id, channel: 'WHATSAPP' },
      take: 12,
      orderBy: { sentAt: 'desc' }
    });

    const fmtDate = d => new Date(d).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
    const fmtTime = d => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    const tag = (t) => '<span style="display:inline-block;padding:2px 8px;background:#e0e7ff;color:#3730a3;border-radius:10px;font-size:11px;margin:2px 4px 2px 0;">' + t + '</span>';
    const tags = c.tags ? (Array.isArray(c.tags) ? c.tags : []) : [];

    const html = '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>' + c.firstName + ' ' + (c.lastName||'') + ' – MEOS Kunde</title>' +
      '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f5f0eb;padding:20px;color:#1a1a1a;}' +
      '.card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.06);padding:24px;margin-bottom:16px;}' +
      'h1{font-size:26px;color:#0f172a;margin-bottom:4px;}.company{color:#64748b;font-size:15px;margin-bottom:12px;}' +
      '.section{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;}' +
      '.row{display:flex;gap:8px;margin-bottom:6px;font-size:14px;}.label{color:#94a3b8;min-width:90px;}.val{color:#0f172a;font-weight:500;}' +
      'a{color:#3b82f6;text-decoration:none;}a:hover{text-decoration:underline;}' +
      '.note{padding:10px;border-left:3px solid #c4650f;margin-bottom:8px;background:#fdf6ec;border-radius:0 6px 6px 0;}' +
      '.proj{display:flex;justify-content:space-between;padding:8px 10px;background:#f8fafc;border-radius:6px;margin-bottom:6px;font-size:13px;}' +
      '.phase{padding:2px 8px;background:#e2e8f0;border-radius:10px;font-size:11px;font-weight:600;color:#475569;}' +
      '.callrow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#475569;}' +
      '</style></head><body>' +
      '<div class="card">' +
      '<h1>' + c.firstName + ' ' + (c.lastName||'') + '</h1>' +
      (c.company ? '<div class="company">' + c.company + '</div>' : '') +
      (tags.length ? '<div style="margin-bottom:12px;">' + tags.map(tag).join('') + '</div>' : '') +
      (c.email   ? '<div class="row"><span class="label">📧 E-Mail</span><a class="val" href="mailto:' + c.email + '">' + c.email + '</a></div>' : '') +
      (c.phone   ? '<div class="row"><span class="label">☎ Telefon</span><a class="val" href="tel:' + c.phone + '">' + c.phone + '</a></div>' : '') +
      (c.mobile  ? '<div class="row"><span class="label">📱 Mobil</span><a class="val" href="tel:' + c.mobile + '">' + c.mobile + '</a></div>' : '') +
      ((c.street||c.city) ? '<div class="row"><span class="label">📍 Adresse</span><span class="val">' + (c.street||'') + ((c.zip||c.city) ? ', ' + (c.zip||'') + ' ' + (c.city||'') : '') + '</span></div>' : '') +
      (c.partnerName ? '<div class="row"><span class="label">👥 Partner</span><span class="val">' + c.partnerName + (c.partnerPhone ? ' · ' + c.partnerPhone : '') + '</span></div>' : '') +
      (c.info    ? '<div class="row" style="margin-top:10px;"><span class="label">ℹ️ Notiz</span><span class="val" style="white-space:pre-wrap;">' + (c.info||'') + '</span></div>' : '') +
      '</div>' +
      (c.projects.length ? '<div class="card"><div class="section">Projekte (' + c.projects.length + ')</div>' +
        c.projects.map(p => '<div class="proj"><span><strong>' + p.name + '</strong>' + (p.montageDate ? ' · Montage ' + fmtDate(p.montageDate) : '') + '</span><span class="phase">' + p.phase + '</span></div>').join('') +
        '</div>' : '') +
      (waMessages.length ? '<div class="card"><div class="section">💬 WhatsApp (' + waMessages.length + ')</div>' +
        '<div style="max-height:380px;overflow-y:auto;padding:4px;">' +
        waMessages.slice().reverse().map(m => {
          const isIn = m.direction === 'INBOUND';
          const align = isIn ? 'flex-start' : 'flex-end';
          const bg = isIn ? '#fff' : '#dcf8c6';
          const border = isIn ? '#e5e5e5' : '#bce39a';
          return '<div style="display:flex;justify-content:' + align + ';margin-bottom:6px;"><div style="max-width:75%;background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;padding:6px 10px;font-size:13px;color:#0f172a;">' + (m.mediaType ? '<div style="color:#64748b;font-size:11px;margin-bottom:2px;">📎 ' + m.mediaType + '</div>' : '') + (m.body || '<i style="color:#94a3b8;">(leer)</i>').replace(/</g,'&lt;').replace(/\n/g,'<br>') + '<div style="font-size:10px;color:#94a3b8;margin-top:2px;text-align:right;">' + fmtTime(m.sentAt) + ' · ' + fmtDate(m.sentAt) + (m.status ? ' · ' + m.status : '') + '</div></div></div>';
        }).join('') +
        '</div>' +
        '<div style="margin-top:10px;border-top:1px solid #e5e5e5;padding-top:10px;display:flex;gap:6px;"><textarea id="waText" placeholder="Antwort schreiben…" style="flex:1;padding:8px;border:1px solid #e5e5e5;border-radius:6px;font-family:inherit;resize:vertical;min-height:50px;"></textarea><button onclick="sendWa()" style="padding:8px 14px;background:#25d366;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;">Senden</button></div>' +
        '<script>function sendWa(){const t=document.getElementById("waText").value.trim();if(!t)return;const tok=new URLSearchParams(location.search).get("t");fetch("/api/messages/whatsapp/send?t="+encodeURIComponent(tok),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:"' + (c.phone || c.mobile || '') + '",body:t})}).then(r=>r.json()).then(j=>{if(j.ok){document.getElementById("waText").value="";setTimeout(()=>location.reload(),700);}else alert("Fehler: "+JSON.stringify(j));}).catch(e=>alert(e.message));}</script>' +
        '</div>' : '') +
            (recentCalls.length ? '<div class="card"><div class="section">Letzte Anrufe (' + recentCalls.length + ')</div>' +
        recentCalls.map(call => '<div class="callrow"><span>' + (call.direction === 'INBOUND' ? '📞 eingehend' : '📤 ausgehend') + ' · ' + (call.callerNumber||call.targetNumber||'-') + '</span><span>' + fmtDate(call.startTime) + ' ' + fmtTime(call.startTime) + '</span></div>').join('') +
        '</div>' : '') +
      (c.notes.length ? '<div class="card"><div class="section">Letzte Notizen (' + c.notes.length + ')</div>' +
        c.notes.map(n => '<div class="note"><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;font-weight:600;">' + (n.user?.name || 'System') + ' · ' + fmtDate(n.createdAt) + ' ' + fmtTime(n.createdAt) + '</div>' + (n.text||'') + '</div>').join('') +
        '</div>' : '') +
      '</body></html>';
    res.type('html').send(html);
  } catch (err) {
    console.error('[CUSTOMER CARD]', err.message);
    res.status(500).type('html').send('<h2>Fehler</h2><pre>' + err.message + '</pre>');
  }
});

// All other customer routes require auth
router.use(authenticate);

// GET /api/customers - List with search, filter, pagination
router.get('/', async (req, res) => {
  try {
    if (!canRead(req.user.role, 'customers')) {
      return res.status(403).json({ error: 'Kein Zugriff auf Kunden' });
    }

    const { search, source, tag, page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};

    // Full-text search across name, email, company, phone
    if (search) {
      where.OR = [
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { email: { contains: search } },
        { company: { contains: search } },
        { phone: { contains: search } },
        { mobile: { contains: search } },
      ];
    }

    if (source) where.source = source;
    // MySQL: JSON-Array durchsuchen mit string_contains
    if (tag) where.tags = { string_contains: tag };

    const [customers, total] = await Promise.all([
      req.prisma.customer.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: { select: { projects: true, notes: true, calls: true } }
        }
      }),
      req.prisma.customer.count({ where })
    ]);

    res.json({
      data: customers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/search-phone/:number - Reventix phone lookup
router.get('/search-phone/:number', async (req, res) => {
  try {
    const rawNumber = req.params.number.replace(/\D/g, '');
    const last8 = rawNumber.slice(-8);

    // Search in both phone and mobile fields
    const customers = await req.prisma.customer.findMany({
      where: {
        OR: [
          { phone: { endsWith: last8 } },
          { mobile: { endsWith: last8 } },
        ]
      },
      include: {
        _count: { select: { projects: true } },
        projects: {
          where: { status: 'AKTIV' },
          take: 3,
          orderBy: { updatedAt: 'desc' },
          select: { id: true, name: true, phase: true }
        }
      }
    });

    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/:id - Single customer with relations
router.get('/:id', async (req, res) => {
  try {
    if (!canRead(req.user.role, 'customers')) {
      return res.status(403).json({ error: 'Kein Zugriff' });
    }

    const customer = await req.prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        projects: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, name: true, phase: true, status: true,
            budgetHours: true, actualHours: true, createdAt: true
          }
        },
        notes: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { user: { select: { name: true } } }
        },
        calls: {
          orderBy: { startTime: 'desc' },
          take: 20,
          include: { notes: { include: { user: { select: { name: true } } } } }
        },
        _count: { select: { projects: true, notes: true, calls: true } }
      }
    });

    if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers - Create manual customer
router.post('/', requireRole('BUERO', 'ADMIN'), async (req, res) => {
  try {
    const { firstName, lastName, email, company, phone, mobile, street, city, zip, tags, partnerName, partnerPhone, info } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Vor- und Nachname erforderlich' });
    }

    const customer = await req.prisma.customer.create({
      data: {
        firstName, lastName, email, company, phone, mobile,
        street, city, zip,
        partnerName: partnerName || null,
        partnerPhone: partnerPhone || null,
        info: info || null,
        tags: tags || [],
        source: 'MANUAL'
      }
    });

    res.status(201).json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/customers/:id - Update customer (only manual fields, never overwrite FluentCRM)
router.put('/:id', requireRole('BUERO', 'ADMIN'), async (req, res) => {
  try {
    const existing = await req.prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Kunde nicht gefunden' });

    const { phone, mobile, street, city, zip, tags, company, partnerName, partnerPhone, info } = req.body;
    const updateData = {};

    if (existing.source === 'MANUAL') {
      // Manual customers: update everything
      Object.assign(updateData, req.body);
    } else {
      // FluentCRM customers: only update local extensions
      if (phone !== undefined) updateData.phone = phone;
      if (mobile !== undefined) updateData.mobile = mobile;
      if (street !== undefined) updateData.street = street;
      if (city !== undefined) updateData.city = city;
      if (zip !== undefined) updateData.zip = zip;
    }

    // These fields can always be updated (local-only, not synced from CRM)
    if (partnerName !== undefined) updateData.partnerName = partnerName;
    if (partnerPhone !== undefined) updateData.partnerPhone = partnerPhone;
    if (info !== undefined) updateData.info = info;

    const customer = await req.prisma.customer.update({
      where: { id: req.params.id },
      data: updateData
    });

    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/:id/notes - Add note to customer
router.post('/:id/notes', authenticate, async (req, res) => {
  try {
    const { text, type = 'INTERN' } = req.body;
    if (!text) return res.status(400).json({ error: 'Text erforderlich' });

    const note = await req.prisma.note.create({
      data: {
        customerId: req.params.id,
        text,
        type,
        userId: req.user.id
      },
      include: { user: { select: { name: true } } }
    });

    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/tags/all - Get all unique tags
router.get('/tags/all', async (req, res) => {
  try {
    const customers = await req.prisma.customer.findMany({
      select: { tags: true },
      where: { tags: { not: null } }
    });
    const allTags = [...new Set(customers.flatMap(c => Array.isArray(c.tags) ? c.tags : []))].sort();
    res.json(allTags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
