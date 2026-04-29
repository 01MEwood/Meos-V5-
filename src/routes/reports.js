const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// Default checklists per report type
const DEFAULT_CHECKLISTS = {
  MONTAGE: [
    { key: 'transport', label: 'Transport unbeschädigt', checked: false, note: '' },
    { key: 'teile_vollstaendig', label: 'Alle Teile vollständig', checked: false, note: '' },
    { key: 'masse_korrekt', label: 'Maße stimmen mit Aufmaß überein', checked: false, note: '' },
    { key: 'befestigung', label: 'Wandbefestigung / Unterbau OK', checked: false, note: '' },
    { key: 'ausrichtung', label: 'Ausrichtung / Lot geprüft', checked: false, note: '' },
    { key: 'fugen', label: 'Fugen und Anschlüsse sauber', checked: false, note: '' },
    { key: 'oberflaeche', label: 'Oberfläche unbeschädigt', checked: false, note: '' },
    { key: 'elektro', label: 'Elektro-Anschlüsse geprüft', checked: false, note: '' },
    { key: 'wasser', label: 'Wasseranschlüsse geprüft (falls relevant)', checked: false, note: '' },
    { key: 'reinigung', label: 'Arbeitsplatz gereinigt', checked: false, note: '' },
  ],
  ABNAHME: [
    { key: 'optik', label: 'Optik / Gesamteindruck OK', checked: false, note: '' },
    { key: 'funktion_tueren', label: 'Türen / Schubladen Funktion OK', checked: false, note: '' },
    { key: 'funktion_beschlaege', label: 'Beschläge / Griffe fest', checked: false, note: '' },
    { key: 'oberflaeche_ok', label: 'Oberflächen ohne Kratzer/Dellen', checked: false, note: '' },
    { key: 'farbe_material', label: 'Farbe / Material wie vereinbart', checked: false, note: '' },
    { key: 'masse_stimmen', label: 'Maße entsprechen Angebot', checked: false, note: '' },
    { key: 'elektro_funktion', label: 'Beleuchtung / Elektro funktioniert', checked: false, note: '' },
    { key: 'sauberkeit', label: 'Baustelle sauber hinterlassen', checked: false, note: '' },
    { key: 'kunde_zufrieden', label: 'Kunde ist zufrieden', checked: false, note: '' },
    { key: 'maengel_notiert', label: 'Eventuelle Mängel dokumentiert', checked: false, note: '' },
  ],
};

// GET /api/reports/defaults/:type - Get default checklist
router.get('/defaults/:type', (req, res) => {
  const type = req.params.type.toUpperCase();
  const checklist = DEFAULT_CHECKLISTS[type];
  if (!checklist) return res.status(400).json({ error: 'Typ muss MONTAGE oder ABNAHME sein' });
  res.json({ type, checklist });
});

// GET /api/reports?projectId=...&type=... - List reports
router.get('/', async (req, res) => {
  try {
    const { projectId, type } = req.query;
    const where = {};
    if (projectId) where.projectId = projectId;
    if (type) where.type = type.toUpperCase();

    const reports = await req.prisma.montageReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, name: true, customer: { select: { firstName: true, lastName: true } } } },
        createdBy: { select: { name: true } },
      },
    });
    res.json(reports);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/:id - Single report
router.get('/:id', async (req, res) => {
  try {
    const report = await req.prisma.montageReport.findUnique({
      where: { id: req.params.id },
      include: {
        project: { select: { id: true, name: true, customer: { select: { firstName: true, lastName: true, company: true } } } },
        createdBy: { select: { name: true } },
      },
    });
    if (!report) return res.status(404).json({ error: 'Protokoll nicht gefunden' });
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/reports - Create new report
router.post('/', requireRole('MONTAGE', 'WERKSTATT', 'BUERO'), async (req, res) => {
  try {
    const { projectId, type, date, teamMembers, checklist, defects, customerNote } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId erforderlich' });

    const reportType = (type || 'MONTAGE').toUpperCase();
    if (!['MONTAGE', 'ABNAHME'].includes(reportType)) {
      return res.status(400).json({ error: 'Typ muss MONTAGE oder ABNAHME sein' });
    }

    // Use provided checklist or default
    const finalChecklist = checklist || DEFAULT_CHECKLISTS[reportType];

    const report = await req.prisma.montageReport.create({
      data: {
        projectId,
        type: reportType,
        date: date ? new Date(date) : new Date(),
        teamMembers: teamMembers || [req.user.name],
        checklist: finalChecklist,
        defects: defects || null,
        customerNote: customerNote || null,
        photos: [],
        userId: req.user.id,
      },
      include: {
        project: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
      },
    });

    res.status(201).json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/reports/:id - Update report (checklist, defects, notes, abnahme)
router.put('/:id', requireRole('MONTAGE', 'WERKSTATT', 'BUERO'), async (req, res) => {
  try {
    const { checklist, defects, customerNote, teamMembers, photos, restarbeiten, abnahmeOk, invoiceTriggered, invoiceTriggeredAt } = req.body;
    const data = {};
    if (checklist !== undefined) data.checklist = checklist;
    if (defects !== undefined) data.defects = defects;
    if (customerNote !== undefined) data.customerNote = customerNote;
    if (teamMembers !== undefined) data.teamMembers = teamMembers;
    if (photos !== undefined) data.photos = photos;
    if (restarbeiten !== undefined) data.restarbeiten = restarbeiten;
    if (abnahmeOk !== undefined) data.abnahmeOk = abnahmeOk;
    if (invoiceTriggered !== undefined) data.invoiceTriggered = invoiceTriggered;
    if (invoiceTriggeredAt !== undefined) data.invoiceTriggeredAt = new Date(invoiceTriggeredAt);

    const report = await req.prisma.montageReport.update({
      where: { id: req.params.id },
      data,
    });
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/reports/:id/sign - Add customer signature (base64 data URL)
router.put('/:id/sign', requireRole('MONTAGE', 'WERKSTATT', 'BUERO'), async (req, res) => {
  try {
    const { signatureData } = req.body;
    if (!signatureData) return res.status(400).json({ error: 'signatureData erforderlich' });

    const report = await req.prisma.montageReport.update({
      where: { id: req.params.id },
      data: { signatureData },
    });

    // If it's an ABNAHME report with signature, auto-advance project to ABNAHME phase
    if (report.type === 'ABNAHME') {
      const project = await req.prisma.project.findUnique({ where: { id: report.projectId } });
      if (project && project.phase === 'MONTAGE') {
        await req.prisma.project.update({ where: { id: report.projectId }, data: { phase: 'ABNAHME' } });
        await req.prisma.phaseLog.create({
          data: {
            projectId: report.projectId,
            fromPhase: 'MONTAGE',
            toPhase: 'ABNAHME',
            userId: req.user.id,
            comment: 'Abnahmeprotokoll unterschrieben',
          },
        });
      }
    }

    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
