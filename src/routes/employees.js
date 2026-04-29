const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

const VALID_ROLES = ['ADMIN', 'BUERO', 'HR', 'MARKETING', 'WERKSTATT', 'MONTAGE', 'STEMPELN'];

// GET /api/employees - List all employees (active + inactive)
router.get('/', requireRole('ADMIN', 'BUERO', 'HR'), async (req, res) => {
  try {
    const { active, role, search } = req.query;
    const where = {};
    if (active !== undefined) where.active = active === 'true';
    if (role) where.role = role;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
      ];
    }

    const users = await req.prisma.user.findMany({
      where,
      select: {
        id: true, email: true, name: true, role: true, active: true,
        pin: true, phone: true, mobile: true, avatarUrl: true, createdAt: true, updatedAt: true,
        _count: { select: { timeEntries: true, notes: true, montageReports: true } }
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }]
    });

    // Don't expose password, just whether pin is set
    const result = users.map(u => ({
      ...u,
      hasPin: !!u.pin,
      pin: undefined,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employees/:id - Get single employee detail
router.get('/:id', requireRole('ADMIN', 'BUERO', 'HR'), async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, email: true, name: true, role: true, active: true,
        pin: true, phone: true, mobile: true, avatarUrl: true, createdAt: true, updatedAt: true,
        _count: { select: { timeEntries: true, notes: true, montageReports: true, phaseChanges: true } }
      }
    });
    if (!user) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
    res.json({ ...user, hasPin: !!user.pin, pin: undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employees - Create new employee
router.post('/', requireRole('ADMIN'), async (req, res) => {
  try {
    const { email, name, password, role, pin, phone, mobile } = req.body;
    if (!email || !name || !password || !role) {
      return res.status(400).json({ error: 'E-Mail, Name, Passwort und Rolle erforderlich' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Ungültige Rolle', validRoles: VALID_ROLES });
    }

    // Check if email already exists
    const existing = await req.prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'E-Mail bereits vergeben' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await req.prisma.user.create({
      data: {
        email, name, password: hashed, role,
        pin: pin || null,
        phone: phone || null,
        mobile: mobile || null,
        active: true,
      },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true }
    });

    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/employees/:id - Update employee
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const { email, name, password, role, pin, active, phone, mobile } = req.body;
    const data = {};

    if (email !== undefined) {
      // Check uniqueness
      const existing = await req.prisma.user.findFirst({ where: { email, NOT: { id: req.params.id } } });
      if (existing) return res.status(409).json({ error: 'E-Mail bereits vergeben' });
      data.email = email;
    }
    if (name !== undefined) data.name = name;
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Ungültige Rolle' });
      data.role = role;
    }
    if (password) data.password = await bcrypt.hash(password, 10);
    if (pin !== undefined) data.pin = pin || null;
    if (active !== undefined) data.active = active;
    if (phone !== undefined) data.phone = phone || null;
    if (mobile !== undefined) data.mobile = mobile || null;

    const user = await req.prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, email: true, name: true, role: true, active: true, updatedAt: true }
    });

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/employees/:id/toggle - Toggle active/inactive
router.put('/:id/toggle', requireRole('ADMIN'), async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });

    // Prevent deactivating yourself
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Du kannst dich nicht selbst deaktivieren' });
    }

    const updated = await req.prisma.user.update({
      where: { id: req.params.id },
      data: { active: !user.active },
      select: { id: true, name: true, active: true }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/employees/:id - Delete employee (only if no data linked)
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { timeEntries: true, notes: true, montageReports: true, phaseChanges: true } }
      }
    });
    if (!user) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });

    // Prevent deleting yourself
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen' });
    }

    const totalLinked = user._count.timeEntries + user._count.notes + user._count.montageReports + user._count.phaseChanges;
    if (totalLinked > 0) {
      return res.status(400).json({
        error: `Mitarbeiter hat ${totalLinked} verknüpfte Einträge. Bitte stattdessen deaktivieren.`,
        suggestion: 'deactivate'
      });
    }

    await req.prisma.user.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
