const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();

// Rollen die Zugriff auf Kalkulation haben
const CALC_ROLES = ['ADMIN', 'BUERO'];

// ═══════════════════════════════════════
// KALKULATIONS-PARAMETER (Admin)
// ═══════════════════════════════════════

// GET /api/calc/params - Aktive Parameter laden
router.get('/params', authenticate, requireRole(...CALC_ROLES), async (req, res) => {
  try {
    let params = await req.prisma.calcParams.findFirst({ where: { isActive: true } });
    if (!params) {
      // Default-Parameter anlegen
      params = await req.prisma.calcParams.create({
        data: { name: 'Standard', isActive: true }
      });
    }
    res.json(params);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calc/params/:id - Parameter aktualisieren
router.put('/params/:id', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const data = req.body;
    delete data.id;
    delete data.createdAt;

    // km-Satz automatisch berechnen
    if (data.spritPreisLiter !== undefined || data.verbrauchPro100km !== undefined || data.allgFzgKosten !== undefined) {
      const sprit = data.spritPreisLiter ?? 1.9;
      const verbrauch = data.verbrauchPro100km ?? 9;
      const fzg = data.allgFzgKosten ?? 0.25;
      data.kmSatz = Math.round((sprit * verbrauch / 100 + fzg) * 1000) / 1000;
    }

    const params = await req.prisma.calcParams.update({
      where: { id: req.params.id },
      data
    });
    res.json(params);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// PROJEKT-KALKULATION
// ═══════════════════════════════════════

// GET /api/calc/project/:projectId - Kalkulation eines Projekts
router.get('/project/:projectId', authenticate, requireRole(...CALC_ROLES), async (req, res) => {
  try {
    const calc = await req.prisma.projectCalc.findFirst({
      where: { projectId: req.params.projectId },
      orderBy: { version: 'desc' }
    });
    res.json(calc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calc/project/:projectId/versions - Alle Versionen
router.get('/project/:projectId/versions', authenticate, requireRole(...CALC_ROLES), async (req, res) => {
  try {
    const calcs = await req.prisma.projectCalc.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, nettoAngebot: true, bruttoAngebot: true, createdAt: true, createdBy: true }
    });
    res.json(calcs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calc/project/:projectId - Neue Kalkulation anlegen
router.post('/project/:projectId', authenticate, requireRole(...CALC_ROLES), async (req, res) => {
  try {
    const projectId = req.params.projectId;

    // Projekt prüfen
    const project = await req.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });

    // Aktive Parameter laden
    const params = await req.prisma.calcParams.findFirst({ where: { isActive: true } });

    // Höchste Version finden
    const lastCalc = await req.prisma.projectCalc.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' }
    });
    const version = (lastCalc?.version || 0) + 1;

    // km aus Projekt übernehmen
    const kmEinfach = project.kmEinfach || 0;

    const calc = await req.prisma.projectCalc.create({
      data: {
        projectId,
        version,
        // Sätze aus Parametern
        rsoFaktor: params?.rsoDefaultFaktor || 2.7,
        bearbeitungSatz: params?.bearbeitungProTeil || 12,
        lackSatz: params?.lackierungProQm || 70,
        lackPauschale: params?.lackPauschale || 80,
        sockelSatz: params?.sockelProTeil || 30,
        horatecFaktor: params?.horatecZuschlag || 1.2,
        materialFaktor: params?.materialFaktor || 1.35,
        satzAufmass: params?.stundeAufmass || 95,
        satzFahrtAufmass: params?.stundeFahrtAufmass || 95,
        satzGeselle: params?.stundeGeselle || 80,
        satzAzubi: params?.stundeAzubi || 36,
        satzBeladen: params?.stundeBeladen || 116,
        satzFahrtMontage: params?.stundeFahrtMontage || 116,
        satzMeister: params?.stundeMeister || 80,
        satzHelfer: params?.stundeHelfer || 36,
        kmSatz: params?.kmSatz || 0.421,
        wagnisGewinn: params?.wagnisGewinn || 1.15,
        mwst: params?.mwst || 1.19,
        // km aus Projekt
        kmAufmass: kmEinfach,
        kmMontageTag1: kmEinfach,
        createdBy: req.user.id
      }
    });

    res.status(201).json(calc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calc/project/:projectId/:calcId - Kalkulation aktualisieren + neu berechnen
router.put('/project/:projectId/:calcId', authenticate, requireRole(...CALC_ROLES), async (req, res) => {
  try {
    const data = req.body;
    delete data.id;
    delete data.projectId;
    delete data.createdAt;

    // ═══ BERECHNUNG ═══

    // Summe 1: RSO + Bearbeitung + Lack + Sockel + Horatec
    const rsoBetrag = data.rsoBetrag || 0;
    const rsoFaktor = data.rsoFaktor || 2.7;
    const rsoGesamt = rsoBetrag * rsoFaktor;
    const aufpreisSpezial = data.aufpreisSpezial || 0;

    const bearbeitungTeile = data.bearbeitungTeile || 0;
    const bearbeitungSatz = data.bearbeitungSatz || 12;
    const bearbeitungGesamt = bearbeitungTeile * bearbeitungSatz;

    const lackQm = data.lackQm || 0;
    const lackSatz = data.lackSatz || 70;
    const lackPauschale = data.lackPauschale || 80;
    let lackGesamt = lackQm * lackSatz;
    if (data.lackBrutto) lackGesamt = lackGesamt / 1.19; // netto machen
    if (lackQm > 0) lackGesamt += lackPauschale;

    const sockelTeile = data.sockelTeile || 0;
    const sockelSatz = data.sockelSatz || 30;
    const sockelGesamt = sockelTeile * sockelSatz;

    const horatecBetrag = data.horatecBetrag || 0;
    const horatecFaktor = data.horatecFaktor || 1.2;
    const horatecGesamt = horatecBetrag * horatecFaktor;

    const summe1 = rsoGesamt + aufpreisSpezial + bearbeitungGesamt + lackGesamt + sockelGesamt + horatecGesamt;

    // Summe 2: Materialkosten Zusatz
    const matSpiegel = data.matSpiegel || 0;
    const matLed = data.matLed || 0;
    const matLWinkel = data.matLWinkel || 0;
    const matGarderobe = data.matGarderobe || 0;
    const matSonstiges1 = data.matSonstiges1 || 0;
    const matSonstiges2 = data.matSonstiges2 || 0;
    const matSonstiges3 = data.matSonstiges3 || 0;
    const ekNetto = summe1 + matSpiegel + matLed + matLWinkel + matGarderobe + matSonstiges1 + matSonstiges2 + matSonstiges3;
    const materialFaktor = data.materialFaktor || 1.35;
    const summe2 = ekNetto * (materialFaktor - 1); // Nur der Zuschlag

    // Summe 3: Arbeitszeiten
    const satzAufmass = data.satzAufmass || 95;
    const satzFahrtAufmass = data.satzFahrtAufmass || 95;
    const satzGeselle = data.satzGeselle || 80;
    const satzAzubi = data.satzAzubi || 36;
    const satzBeladen = data.satzBeladen || 116;
    const satzFahrtMontage = data.satzFahrtMontage || 116;
    const satzMeister = data.satzMeister || 80;
    const satzHelfer = data.satzHelfer || 36;
    const kmSatz = data.kmSatz || 0.421;

    const arbAufmass = (data.stundenAufmass || 0) * satzAufmass;
    const arbFahrtAufmass = (data.stundenFahrtAufmass || 0) * satzFahrtAufmass;
    const arbKmAufmass = (data.kmAufmass || 0) * kmSatz;
    const arbGeselle = (data.stundenGeselle || 0) * satzGeselle;
    const arbAzubi = (data.stundenAzubi || 0) * satzAzubi;
    const arbBeladen = (data.stundenBeladen || 0) * satzBeladen;
    const arbFahrtMontage = (data.stundenFahrtMontage || 0) * satzFahrtMontage;
    const arbMeister = (data.stundenMeister || 0) * satzMeister;
    const arbHelfer1 = (data.stundenHelfer1 || 0) * satzHelfer;
    const arbHelfer2 = (data.stundenHelfer2 || 0) * satzHelfer;
    const arbKmMontage1 = (data.kmMontageTag1 || 0) * kmSatz;
    const arbKmMontage2 = (data.kmMontageTag2 || 0) * kmSatz;

    const summe3 = arbAufmass + arbFahrtAufmass + arbKmAufmass + arbGeselle + arbAzubi +
                   arbBeladen + arbFahrtMontage + arbMeister + arbHelfer1 + arbHelfer2 +
                   arbKmMontage1 + arbKmMontage2;

    // Ergebnis
    const summeOhneZuschlag = ekNetto + summe2 + summe3; // = ekNetto * materialFaktor + summe3
    const wagnisGewinn = data.wagnisGewinn || 1.15;
    const nettoAngebot = summeOhneZuschlag * wagnisGewinn;
    const mwst = data.mwst || 1.19;
    const bruttoAngebot = nettoAngebot * mwst;

    // Berechnete Werte setzen
    data.summe1 = Math.round(summe1 * 100) / 100;
    data.ekNetto = Math.round(ekNetto * 100) / 100;
    data.summe2 = Math.round(summe2 * 100) / 100;
    data.summe3 = Math.round(summe3 * 100) / 100;
    data.summeOhneZuschlag = Math.round(summeOhneZuschlag * 100) / 100;
    data.nettoAngebot = Math.round(nettoAngebot * 100) / 100;
    data.bruttoAngebot = Math.round(bruttoAngebot * 100) / 100;

    const calc = await req.prisma.projectCalc.update({
      where: { id: req.params.calcId },
      data
    });

    // offerAmount im Projekt aktualisieren
    await req.prisma.project.update({
      where: { id: req.params.projectId },
      data: {
        offerAmount: calc.bruttoAngebot,
        budgetHours: (data.stundenGeselle || 0) + (data.stundenAzubi || 0) + (data.stundenMeister || 0) + (data.stundenHelfer1 || 0) + (data.stundenHelfer2 || 0)
      }
    });

    res.json(calc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calc/project/:projectId/:calcId - Kalkulation löschen
router.delete('/project/:projectId/:calcId', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    await req.prisma.projectCalc.delete({ where: { id: req.params.calcId } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
