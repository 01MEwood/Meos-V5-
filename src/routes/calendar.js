const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();

// ═══════════════════════════════════════
// Baden-Württemberg Feiertage
// ═══════════════════════════════════════
function getFeiertage(year) {
  // Oster-Berechnung (Gauss)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(year, month - 1, day);

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }
  function fmt(d) {
    return d.toISOString().substring(0, 10);
  }

  return [
    { date: `${year}-01-01`, name: 'Neujahr' },
    { date: `${year}-01-06`, name: 'Heilige Drei Könige' },
    { date: fmt(addDays(easter, -2)), name: 'Karfreitag' },
    { date: fmt(easter), name: 'Ostersonntag' },
    { date: fmt(addDays(easter, 1)), name: 'Ostermontag' },
    { date: `${year}-05-01`, name: 'Tag der Arbeit' },
    { date: fmt(addDays(easter, 39)), name: 'Christi Himmelfahrt' },
    { date: fmt(addDays(easter, 49)), name: 'Pfingstsonntag' },
    { date: fmt(addDays(easter, 50)), name: 'Pfingstmontag' },
    { date: fmt(addDays(easter, 60)), name: 'Fronleichnam' },
    { date: `${year}-10-03`, name: 'Tag der Deutschen Einheit' },
    { date: `${year}-11-01`, name: 'Allerheiligen' },
    { date: `${year}-12-25`, name: '1. Weihnachtstag' },
    { date: `${year}-12-26`, name: '2. Weihnachtstag' },
  ];
}

// ═══════════════════════════════════════
// Baden-Württemberg Schulferien (fest)
// ═══════════════════════════════════════
function getSchulferien(year) {
  const ferien = {
    2025: [
      { von: '2025-04-14', bis: '2025-04-25', name: 'Osterferien' },
      { von: '2025-06-10', bis: '2025-06-20', name: 'Pfingstferien' },
      { von: '2025-07-31', bis: '2025-09-13', name: 'Sommerferien' },
      { von: '2025-10-27', bis: '2025-10-31', name: 'Herbstferien' },
      { von: '2025-12-22', bis: '2025-12-31', name: 'Weihnachtsferien' },
    ],
    2026: [
      { von: '2026-01-01', bis: '2026-01-06', name: 'Weihnachtsferien 25/26' },
      { von: '2026-03-30', bis: '2026-04-11', name: 'Osterferien' },
      { von: '2026-05-26', bis: '2026-06-05', name: 'Pfingstferien' },
      { von: '2026-07-30', bis: '2026-09-12', name: 'Sommerferien' },
      { von: '2026-10-26', bis: '2026-10-30', name: 'Herbstferien' },
      { von: '2026-10-31', bis: '2026-10-31', name: 'Reformationstag (schulfrei)' },
      { von: '2026-12-23', bis: '2026-12-31', name: 'Weihnachtsferien' },
    ],
    2027: [
      { von: '2027-01-01', bis: '2027-01-09', name: 'Weihnachtsferien 26/27' },
      { von: '2027-03-30', bis: '2027-04-03', name: 'Osterferien' },
      { von: '2027-05-18', bis: '2027-05-29', name: 'Pfingstferien' },
      { von: '2027-07-29', bis: '2027-09-11', name: 'Sommerferien' },
      { von: '2027-11-02', bis: '2027-11-06', name: 'Herbstferien' },
      { von: '2027-12-23', bis: '2027-12-31', name: 'Weihnachtsferien' },
    ],
  };
  return ferien[year] || [];
}

// ═══════════════════════════════════════
// GET /api/calendar/:year
// Returns all calendar data for a year
// ═══════════════════════════════════════
router.get('/:year', authenticate, async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    if (isNaN(year) || year < 2020 || year > 2040) {
      return res.status(400).json({ error: 'Ungültiges Jahr' });
    }

    const feiertage = getFeiertage(year);
    const schulferien = getSchulferien(year);

    // Company closed days from DB
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    const closedDays = await req.prisma.companyClosedDay.findMany({
      where: {
        date: { gte: startDate, lte: endDate }
      },
      orderBy: { date: 'asc' }
    });

    // Montage dates from projects
    const projects = await req.prisma.project.findMany({
      where: {
        status: 'AKTIV',
        montageDate: { gte: startDate, lte: endDate }
      },
      select: { id: true, name: true, montageDate: true, customer: { select: { firstName: true, lastName: true } } }
    });

    // Aufmass dates
    const aufmassProjects = await req.prisma.project.findMany({
      where: {
        status: 'AKTIV',
        aufmassDate: { gte: startDate, lte: endDate }
      },
      select: { id: true, name: true, aufmassDate: true, customer: { select: { firstName: true, lastName: true } } }
    });

    res.json({
      year,
      feiertage,
      schulferien,
      closedDays: closedDays.map(d => ({
        id: d.id,
        date: d.date.toISOString().substring(0, 10),
        type: d.type,
        name: d.name
      })),
      montageTermine: projects.map(p => ({
        date: p.montageDate.toISOString().substring(0, 10),
        projectId: p.id,
        name: p.name,
        customer: p.customer ? `${p.customer.firstName} ${p.customer.lastName}` : ''
      })),
      aufmassTermine: aufmassProjects.map(p => ({
        date: p.aufmassDate.toISOString().substring(0, 10),
        projectId: p.id,
        name: p.name,
        customer: p.customer ? `${p.customer.firstName} ${p.customer.lastName}` : ''
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// POST /api/calendar/closed-days
// Add Betriebsurlaub / Brückentag
// ═══════════════════════════════════════
router.post('/closed-days', authenticate, requireRole('ADMIN', 'BUERO'), async (req, res) => {
  try {
    const { dates, type, name } = req.body;
    // dates can be single date string or array of dates
    const dateList = Array.isArray(dates) ? dates : [dates];
    if (!dateList.length || !type || !name) {
      return res.status(400).json({ error: 'dates, type und name erforderlich' });
    }

    const created = [];
    for (const dateStr of dateList) {
      try {
        const day = await req.prisma.companyClosedDay.create({
          data: {
            date: new Date(dateStr),
            type,
            name,
            createdBy: req.user.id
          }
        });
        created.push(day);
      } catch (e) {
        // Skip duplicates (unique constraint on date)
        if (!e.message.includes('Unique constraint')) throw e;
      }
    }

    res.status(201).json({ created: created.length, days: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// DELETE /api/calendar/closed-days/:id
// Remove a closed day
// ═══════════════════════════════════════
router.delete('/closed-days/:id', authenticate, requireRole('ADMIN', 'BUERO'), async (req, res) => {
  try {
    await req.prisma.companyClosedDay.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// GET /api/calendar/closed-days
// List all closed days
// ═══════════════════════════════════════
router.get('/closed-days/list', authenticate, async (req, res) => {
  try {
    const days = await req.prisma.companyClosedDay.findMany({
      orderBy: { date: 'asc' }
    });
    res.json(days.map(d => ({
      id: d.id,
      date: d.date.toISOString().substring(0, 10),
      type: d.type,
      name: d.name
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
