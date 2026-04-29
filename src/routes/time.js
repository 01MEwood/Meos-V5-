const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// POST /api/time - Log time entry
router.post('/', async (req, res) => {
  try {
    const { projectId, area, hours, date, note } = req.body;
    if (!projectId || !area || !hours) {
      return res.status(400).json({ error: 'Projekt, Bereich und Stunden erforderlich' });
    }

    const entry = await req.prisma.timeEntry.create({
      data: {
        projectId,
        userId: req.user.id,
        area,
        hours: parseFloat(hours),
        date: date ? new Date(date) : new Date(),
        note
      },
      include: { user: { select: { name: true } }, project: { select: { name: true } } }
    });

    // Update project actualHours
    const total = await req.prisma.timeEntry.aggregate({
      where: { projectId },
      _sum: { hours: true }
    });
    await req.prisma.project.update({
      where: { id: projectId },
      data: { actualHours: total._sum.hours || 0 }
    });

    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/time?projectId=&userId=&from=&to=
router.get('/', async (req, res) => {
  try {
    const { projectId, userId, area, from, to, page = 1, limit = 50 } = req.query;
    const where = {};
    if (projectId) where.projectId = projectId;
    if (userId) where.userId = userId;
    if (area) where.area = area;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }

    const entries = await req.prisma.timeEntry.findMany({
      where,
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { date: 'desc' },
      include: {
        user: { select: { name: true } },
        project: { select: { id: true, name: true } }
      }
    });

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/time/summary - Hours per project
router.get('/summary', async (req, res) => {
  try {
    const projects = await req.prisma.project.findMany({
      where: { status: 'AKTIV' },
      select: {
        id: true, name: true, budgetHours: true, actualHours: true, phase: true,
        customer: { select: { lastName: true, company: true } }
      },
      orderBy: { actualHours: 'desc' }
    });

    res.json(projects.map(p => ({
      ...p,
      remaining: p.budgetHours - p.actualHours,
      percent: p.budgetHours > 0 ? Math.round((p.actualHours / p.budgetHours) * 100) : 0
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/time/active - Get currently running timer for user
router.get('/active', async (req, res) => {
  try {
    const active = await req.prisma.timeEntry.findFirst({
      where: { userId: req.user.id, isRunning: true },
      include: { project: { select: { id: true, name: true } } }
    });
    res.json(active || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/time/start - Start timer (clock in)
router.post('/start', async (req, res) => {
  try {
    const { projectId, area } = req.body;
    if (!projectId) return res.status(400).json({ error: 'Projekt erforderlich' });

    // Stop any running timer first
    const running = await req.prisma.timeEntry.findFirst({
      where: { userId: req.user.id, isRunning: true }
    });
    if (running) {
      const elapsed = (Date.now() - new Date(running.startTime).getTime()) / 3600000;
      await req.prisma.timeEntry.update({
        where: { id: running.id },
        data: { isRunning: false, endTime: new Date(), hours: Math.round(elapsed * 4) / 4 }
      });
      // Update old project hours
      const total = await req.prisma.timeEntry.aggregate({
        where: { projectId: running.projectId, isRunning: false },
        _sum: { hours: true }
      });
      await req.prisma.project.update({
        where: { id: running.projectId },
        data: { actualHours: total._sum.hours || 0 }
      });
    }

    // Start new timer
    const entry = await req.prisma.timeEntry.create({
      data: {
        projectId,
        userId: req.user.id,
        area: area || 'WERKSTATT',
        hours: 0,
        startTime: new Date(),
        isRunning: true,
        date: new Date()
      },
      include: { project: { select: { id: true, name: true } } }
    });

    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/time/stop/:id - Stop timer (clock out)
router.post('/stop/:id', async (req, res) => {
  try {
    const entry = await req.prisma.timeEntry.findUnique({ where: { id: req.params.id } });
    if (!entry || !entry.isRunning) return res.status(400).json({ error: 'Kein laufender Timer' });

    const elapsed = (Date.now() - new Date(entry.startTime).getTime()) / 3600000;
    const hours = Math.round(elapsed * 4) / 4; // Round to nearest 15min

    const updated = await req.prisma.timeEntry.update({
      where: { id: req.params.id },
      data: { isRunning: false, endTime: new Date(), hours: Math.max(hours, 0.25) }
    });

    // Update project hours
    const total = await req.prisma.timeEntry.aggregate({
      where: { projectId: entry.projectId, isRunning: false },
      _sum: { hours: true }
    });
    await req.prisma.project.update({
      where: { id: entry.projectId },
      data: { actualHours: total._sum.hours || 0 }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
