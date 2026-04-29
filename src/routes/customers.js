const express = require('express');
const { authenticate, requireRole, canRead } = require('../middleware/auth');

const router = express.Router();

// All customer routes require auth
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
