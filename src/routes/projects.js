const express = require('express');
const { authenticate, requireRole, canRead } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// ── Geocoding + Routing helpers (OpenStreetMap, kostenlos) ──
async function geocodeAddr(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=de`;
    const r = await globalThis.fetch(url, { headers: { 'User-Agent': 'MEOS4/1.0' }, signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return d.length > 0 ? { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) } : null;
  } catch { return null; }
}
async function calcRoute(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const r = await globalThis.fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d.code === 'Ok' && d.routes?.length) return d.routes[0];
    throw new Error('no route');
  } catch {
    // Fallback: Haversine × 1.35
    const R = 6371e3;
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLon = (to.lon - from.lon) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(from.lat*Math.PI/180) * Math.cos(to.lat*Math.PI/180) * Math.sin(dLon/2)**2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.35;
    return { distance: dist, duration: (dist/1000)/70*3600 };
  }
}

// Der Schreinerhelden-Ablauf: 9 MEOS-Phasen (Schritte 4-12)
const PHASE_ORDER = [
  'ANGEBOT',     // 4: CAD, Kalkulation, Angebot
  'AUFTRAG',     // 5: AB + AZ
  'AUFMASS',     // 6: Exakte Maße vor Ort
  'AV_PLANUNG',  // 7: Zeichnungen, Stücklisten, CNC, Montagetermin
  'FERTIGUNG',   // 8: CNC, Zuschnitt, Oberfläche
  'MONTAGE',     // 9: Transport + Aufbau
  'ABNAHME',     // 10: Funktionsprüfung, Protokoll, Unterschrift
  'RECHNUNG',    // 11: Schlussrechnung
  'ZAHLUNG'      // 12: Zahlungsüberwachung
];

const PHASE_LABELS = {
  ANGEBOT: 'Angebot & Entwurf', AUFTRAG: 'Auftrag (AB+AZ)', AUFMASS: 'Aufmaß vor Ort',
  AV_PLANUNG: 'AV & Planung', FERTIGUNG: 'Fertigung', MONTAGE: 'Montage',
  ABNAHME: 'Abnahme', RECHNUNG: 'Rechnung', ZAHLUNG: 'Zahlungsüberwachung'
};

async function getNextProjectId(prisma) {
  const year = new Date().getFullYear().toString().slice(-2);
  const prefix = `P${year}-`;
  const last = await prisma.project.findFirst({
    where: { id: { startsWith: prefix } },
    orderBy: { id: 'desc' }
  });
  const num = last ? parseInt(last.id.split('-')[1]) + 1 : 1;
  return `${prefix}${num.toString().padStart(3, '0')}`;
}

// GET /api/projects/phases - Phase metadata
router.get('/phases', (req, res) => {
  res.json({ order: PHASE_ORDER, labels: PHASE_LABELS });
});

// GET /api/projects/next-id
router.get('/next-id', async (req, res) => {
  try {
    res.json({ id: await getNextProjectId(req.prisma) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/projects
router.get('/', async (req, res) => {
  try {
    if (!canRead(req.user.role, 'projects')) return res.status(403).json({ error: 'Kein Zugriff' });
    const { phase, status, customerId, search, page = 1, limit = 25 } = req.query;
    const where = {};
    if (phase) where.phase = phase;
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (search) {
      where.OR = [
        { id: { contains: search } },
        { name: { contains: search } },
        { customer: { lastName: { contains: search } } },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [projects, total] = await Promise.all([
      req.prisma.project.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { updatedAt: 'desc' },
        include: {
          customer: { select: { firstName: true, lastName: true, company: true } },
          _count: { select: { timeEntries: true, documents: true, payments: true } }
        }
      }),
      req.prisma.project.count({ where })
    ]);
    res.json({ data: projects, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/projects/pipeline - Projects grouped by phase for pipeline view
router.get('/pipeline', async (req, res) => {
  try {
    if (!canRead(req.user.role, 'projects')) return res.status(403).json({ error: 'Kein Zugriff' });
    const projects = await req.prisma.project.findMany({
      where: { status: 'AKTIV' },
      include: {
        customer: { select: { firstName: true, lastName: true, company: true } },
        _count: { select: { timeEntries: true, documents: true } }
      },
      orderBy: { updatedAt: 'desc' }
    });
    // Group by phase
    const pipeline = {};
    for (const phase of PHASE_ORDER) {
      pipeline[phase] = { label: PHASE_LABELS[phase], projects: [] };
    }
    for (const p of projects) {
      if (pipeline[p.phase]) pipeline[p.phase].projects.push(p);
    }
    res.json(pipeline);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/projects/:id
router.get('/:id', async (req, res) => {
  try {
    const project = await req.prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        timeEntries: { orderBy: { date: 'desc' }, take: 50, include: { user: { select: { name: true } } } },
        phaseLogs: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
        documents: { orderBy: { createdAt: 'desc' }, include: { uploadedBy: { select: { name: true } } } },
        notes: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
        payments: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
        montageReports: { orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { name: true } } } },
        _count: { select: { timeEntries: true, documents: true, notes: true, payments: true } }
      }
    });
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    res.json(project);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/projects
router.post('/', requireRole('BUERO', 'WERKSTATT'), async (req, res) => {
  try {
    const { customerId, name, description, budgetHours, offerAmount, startDate, dueDate,
      // New fields
      planer, zustaendig, aufmassDate, aufmassInfo, kmEinfach, montageDate,
      materialKorpus, materialFront, kanteFront, arbeitsplatte, weiteresMaterial,
      aufhaengung, griffloesung, aussenseiteRechts, aussenseiteLinks,
      fugenbild, sockel, passleiste, oberkante, oberflaeche, beschlaege,
      spiegelGlas, kleiderlift, klappen, ledLichtfarbe, ledSchalter,
      kabeldurchlass, garderobenhaken, elektrogeraete, sonstigeDetails,
      rsoFaktor, stundenAufmass, stundenWerkstatt, stundenMontage, stundenAzubi,
      erstEindruck, gespraechsort, geraet
    } = req.body;
    if (!customerId || !name) return res.status(400).json({ error: 'Kunde und Projektname erforderlich' });

    const id = await getNextProjectId(req.prisma);
    const project = await req.prisma.project.create({
      data: {
        id, customerId, name, description,
        budgetHours: budgetHours || 0,
        offerAmount: offerAmount || null,
        startDate: startDate ? new Date(startDate) : new Date(),
        dueDate: dueDate ? new Date(dueDate) : null,
        montageDate: montageDate ? new Date(montageDate) : null,
        // Planer
        planer: planer || null, zustaendig: zustaendig || null,
        // Aufmaß
        aufmassDate: aufmassDate ? new Date(aufmassDate) : null,
        aufmassInfo: aufmassInfo || null, kmEinfach: kmEinfach || null,
        // Material
        materialKorpus: materialKorpus || null, materialFront: materialFront || null,
        kanteFront: kanteFront || null, arbeitsplatte: arbeitsplatte || null,
        weiteresMaterial: weiteresMaterial || null, aufhaengung: aufhaengung || null,
        griffloesung: griffloesung || null, aussenseiteRechts: aussenseiteRechts || null,
        aussenseiteLinks: aussenseiteLinks || null, fugenbild: fugenbild || null,
        sockel: sockel || null, passleiste: passleiste || null,
        oberkante: oberkante || null, oberflaeche: oberflaeche || null,
        beschlaege: beschlaege || null, spiegelGlas: spiegelGlas || null,
        kleiderlift: kleiderlift || null, klappen: klappen || null,
        ledLichtfarbe: ledLichtfarbe || null, ledSchalter: ledSchalter || null,
        kabeldurchlass: kabeldurchlass || null, garderobenhaken: garderobenhaken || null,
        elektrogeraete: elektrogeraete || null, sonstigeDetails: sonstigeDetails || null,
        // Kalkulation
        rsoFaktor: rsoFaktor || null, stundenAufmass: stundenAufmass || null,
        stundenWerkstatt: stundenWerkstatt || null, stundenMontage: stundenMontage || null,
        stundenAzubi: stundenAzubi || null,
        // Erstgespräch
        erstEindruck: erstEindruck || null, gespraechsort: gespraechsort || null,
        geraet: geraet || null,
      },
      include: { customer: { select: { firstName: true, lastName: true } } }
    });

    // ── Auto-km: Berechne Entfernung zum Kunden wenn nicht manuell gesetzt ──
    if (!kmEinfach && customerId) {
      try {
        const cust = await req.prisma.customer.findUnique({
          where: { id: customerId }, select: { street: true, zip: true, city: true }
        });
        if (cust?.street && cust?.zip) {
          const FIRMA = 'Lindenstraße 9-15, 71540 Murrhardt-Fornsbach';
          const addr = [cust.street, cust.zip, cust.city].filter(Boolean).join(', ');
          const [g1, g2] = await Promise.all([geocodeAddr(FIRMA), geocodeAddr(addr)]);
          if (g1 && g2) {
            const rt = await calcRoute(g1, g2);
            if (rt) {
              const km = Math.round(rt.distance / 1000 * 10) / 10;
              await req.prisma.project.update({ where: { id }, data: { kmEinfach: km } });
              project.kmEinfach = km;
              console.log(`[AUTO-KM] ${id}: ${km}km → ${addr}`);
            }
          }
        }
      } catch (e) { console.log('[AUTO-KM] Skip:', e.message); }
    }

    await req.prisma.phaseLog.create({
      data: { projectId: id, fromPhase: 'ANGEBOT', toPhase: 'ANGEBOT', userId: req.user.id, comment: 'Projekt erstellt' }
    });

    res.status(201).json(project);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/projects/:id/phase - Advance or step back phase
router.put('/:id/phase', requireRole('BUERO', 'WERKSTATT', 'MONTAGE'), async (req, res) => {
  try {
    const { toPhase, comment } = req.body;
    if (!toPhase || !PHASE_ORDER.includes(toPhase)) {
      return res.status(400).json({ error: 'Ungültige Phase', validPhases: PHASE_ORDER });
    }

    const project = await req.prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });

    const fromIdx = PHASE_ORDER.indexOf(project.phase);
    const toIdx = PHASE_ORDER.indexOf(toPhase);

    // Allow forward or max one step back
    if (toIdx < fromIdx - 1) {
      return res.status(400).json({ error: 'Phase kann maximal einen Schritt zurückgesetzt werden' });
    }

    const updateData = { phase: toPhase };

    // Auto-complete when payment is done and moving past ZAHLUNG
    if (toPhase === 'ZAHLUNG' && project.paidAt) {
      updateData.status = 'ABGESCHLOSSEN';
      updateData.completedAt = new Date();
    }

    const [updated] = await Promise.all([
      req.prisma.project.update({ where: { id: req.params.id }, data: updateData }),
      req.prisma.phaseLog.create({
        data: { projectId: req.params.id, fromPhase: project.phase, toPhase, userId: req.user.id, comment }
      })
    ]);

    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/projects/:id - Update project details
router.put('/:id', requireRole('BUERO', 'WERKSTATT'), async (req, res) => {
  try {
    const { name, description, budgetHours, status, startDate, dueDate, montageDate,
            offerAmount, depositAmount, invoiceAmount,
            // Kalkulation
            kmEinfach, rsoFaktor, stundenAufmass, stundenWerkstatt, stundenMontage, stundenAzubi,
            // Planer
            planer, zustaendig,
            // Aufmaß
            aufmassDate, aufmassInfo,
            // Material
            materialKorpus, materialFront, kanteFront, arbeitsplatte, weiteresMaterial,
            aufhaengung, griffloesung, aussenseiteRechts, aussenseiteLinks,
            fugenbild, sockel, passleiste, oberkante, oberflaeche, beschlaege,
            spiegelGlas, kleiderlift, klappen, ledLichtfarbe, ledSchalter,
            kabeldurchlass, garderobenhaken, elektrogeraete, sonstigeDetails,
            // Erstgespräch
            erstEindruck, gespraechsort, geraet
    } = req.body;
    const data = {};
    if (name) data.name = name;
    if (description !== undefined) data.description = description;
    if (budgetHours !== undefined) data.budgetHours = budgetHours;
    if (status) data.status = status;
    if (startDate) data.startDate = new Date(startDate);
    if (dueDate) data.dueDate = new Date(dueDate);
    if (montageDate !== undefined) data.montageDate = montageDate ? new Date(montageDate) : null;
    if (offerAmount !== undefined) data.offerAmount = offerAmount;
    if (depositAmount !== undefined) data.depositAmount = depositAmount;
    if (invoiceAmount !== undefined) data.invoiceAmount = invoiceAmount;

    // Kalkulation
    if (kmEinfach !== undefined) data.kmEinfach = kmEinfach;
    if (rsoFaktor !== undefined) data.rsoFaktor = rsoFaktor;
    if (stundenAufmass !== undefined) data.stundenAufmass = stundenAufmass;
    if (stundenWerkstatt !== undefined) data.stundenWerkstatt = stundenWerkstatt;
    if (stundenMontage !== undefined) data.stundenMontage = stundenMontage;
    if (stundenAzubi !== undefined) data.stundenAzubi = stundenAzubi;

    // Planer
    if (planer !== undefined) data.planer = planer;
    if (zustaendig !== undefined) data.zustaendig = zustaendig;

    // Aufmaß
    if (aufmassDate !== undefined) data.aufmassDate = aufmassDate ? new Date(aufmassDate) : null;
    if (aufmassInfo !== undefined) data.aufmassInfo = aufmassInfo;

    // Material - alle Felder
    const stringFields = { materialKorpus, materialFront, kanteFront, arbeitsplatte, weiteresMaterial,
      aufhaengung, griffloesung, aussenseiteRechts, aussenseiteLinks, fugenbild, sockel,
      passleiste, oberkante, oberflaeche, beschlaege, spiegelGlas, kleiderlift, klappen,
      ledLichtfarbe, ledSchalter, kabeldurchlass, garderobenhaken, elektrogeraete, sonstigeDetails,
      erstEindruck, gespraechsort, geraet };
    Object.entries(stringFields).forEach(([k, v]) => {
      if (v !== undefined) data[k] = v;
    });

    // Auto-complete
    if (status === 'ABGESCHLOSSEN') data.completedAt = new Date();

    const project = await req.prisma.project.update({ where: { id: req.params.id }, data });
    res.json(project);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/projects/:id/complete - Mark project as complete (after ZAHLUNG)
router.post('/:id/complete', requireRole('BUERO'), async (req, res) => {
  try {
    const project = await req.prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    if (project.phase !== 'ZAHLUNG') {
      return res.status(400).json({ error: 'Projekt muss in Phase ZAHLUNG sein' });
    }
    const updated = await req.prisma.project.update({
      where: { id: req.params.id },
      data: { status: 'ABGESCHLOSSEN', completedAt: new Date(), paidAt: new Date() }
    });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PAYMENTS ──

// POST /api/projects/:id/payments
router.post('/:id/payments', requireRole('BUERO'), async (req, res) => {
  try {
    const { type, amount, dueDate, note } = req.body;
    if (!type || !amount) return res.status(400).json({ error: 'Typ und Betrag erforderlich' });

    const payment = await req.prisma.payment.create({
      data: {
        projectId: req.params.id, type, amount,
        dueDate: dueDate ? new Date(dueDate) : null,
        note, createdBy: req.user.id
      }
    });

    // If it's a deposit, update project
    if (type === 'ABSCHLAG') {
      await req.prisma.project.update({
        where: { id: req.params.id },
        data: { depositAmount: amount }
      });
    }
    if (type === 'SCHLUSSRECHNUNG') {
      await req.prisma.project.update({
        where: { id: req.params.id },
        data: { invoiceAmount: amount, invoiceSentAt: new Date() }
      });
    }

    res.status(201).json(payment);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/projects/:id/payments/:paymentId/paid - Mark payment as received
router.put('/:id/payments/:paymentId/paid', requireRole('BUERO'), async (req, res) => {
  try {
    const payment = await req.prisma.payment.update({
      where: { id: req.params.paymentId },
      data: { paidAt: new Date() }
    });

    // If deposit, update project
    if (payment.type === 'ABSCHLAG') {
      await req.prisma.project.update({
        where: { id: req.params.id },
        data: { depositPaidAt: new Date() }
      });
    }
    // If final invoice, mark project as paid
    if (payment.type === 'SCHLUSSRECHNUNG') {
      await req.prisma.project.update({
        where: { id: req.params.id },
        data: { paidAt: new Date() }
      });
    }

    res.json(payment);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
