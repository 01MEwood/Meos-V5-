const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 MEOS 4.0 Seed – Checking database...');

  // ── Always ensure admin account exists (upsert = safe) ──
  const pw = await bcrypt.hash('meos2026!', 12);
  const pinHash = async (p) => bcrypt.hash(p, 10);

  const adminUsers = [
    { email: 'mario@schreinerhelden.de',   name: 'Mario Esch',   role: 'ADMIN',     pin: await pinHash('0000') },
    { email: 'petra@schreinerhelden.de',   name: 'Petra',        role: 'BUERO',     pin: null },
    { email: 'janina@schreinerhelden.de',  name: 'Janina',       role: 'HR',        pin: null },
    { email: 'melanie@schreinerhelden.de', name: 'Melanie',      role: 'MARKETING', pin: null },
    { email: 'corina@schreinerhelden.de',  name: 'Corina',       role: 'BUERO',     pin: null },
    { email: 'philipp@schreinerhelden.de', name: 'Philipp',      role: 'WERKSTATT', pin: await pinHash('7711') },
    { email: 'denise@schreinerhelden.de',  name: 'Denise',       role: 'WERKSTATT', pin: await pinHash('6806') },
    { email: 'robin@schreinerhelden.de',   name: 'Robin',        role: 'MONTAGE',   pin: await pinHash('8205') },
    { email: 'lea@schreinerhelden.de',     name: 'Lea',          role: 'WERKSTATT', pin: await pinHash('7603') },
  ];

  let created = 0;
  let existing = 0;
  for (const u of adminUsers) {
    const exists = await prisma.user.findUnique({ where: { email: u.email } });
    if (!exists) {
      await prisma.user.create({ data: { email: u.email, name: u.name, password: pw, pin: u.pin, role: u.role } });
      created++;
    } else {
      existing++;
    }
  }
  console.log(`  ✅ Users: ${created} neu, ${existing} vorhanden`);

  // ── Check if test data needed (only if no customers exist) ──
  const customerCount = await prisma.customer.count();
  if (customerCount > 0) {
    console.log(`  ℹ️  ${customerCount} Kunden vorhanden – Testdaten übersprungen`);
    console.log('\n🎉 Seed complete!');
    return;
  }

  console.log('  📦 Erstelle Testdaten (erstmaliger Start)...');

  // ── CUSTOMERS ──
  const customers = await Promise.all([
    prisma.customer.create({ data: {
      firstName: 'Thomas', lastName: 'Müller', company: 'Architekturbüro Müller',
      email: 'mueller@architektur-mueller.de', phone: '+49 7191 345678', mobile: '+49 170 1234567',
      street: 'Marktplatz 12', city: 'Backnang', zip: '71522', tags: ['Architekt', 'Bestandskunde'], source: 'FLUENTCRM', fluentcrmId: 1001
    }}),
    prisma.customer.create({ data: {
      firstName: 'Sandra', lastName: 'Weber',
      email: 'sandra.weber@gmx.de', phone: '+49 7191 567890', mobile: '+49 171 9876543',
      street: 'Gartenstr. 5', city: 'Winnenden', zip: '71364', tags: ['Privat', 'Video-Beratung'], source: 'FLUENTCRM', fluentcrmId: 1002
    }}),
    prisma.customer.create({ data: {
      firstName: 'Dr. Martin', lastName: 'Schneider', company: 'Zahnarztpraxis Dr. Schneider',
      email: 'schneider@zahnarzt-schneider.de', phone: '+49 7191 112233',
      street: 'Stuttgarter Str. 44', city: 'Backnang', zip: '71522', tags: ['Praxis', 'Empfehlung'], source: 'MANUAL'
    }}),
    prisma.customer.create({ data: {
      firstName: 'Lisa', lastName: 'Hofmann',
      email: 'lisa.hofmann@web.de', phone: '+49 7195 223344', mobile: '+49 172 5556677',
      street: 'Ringstr. 18', city: 'Murrhardt', zip: '71540', tags: ['Privat', 'Neubau'], source: 'FLUENTCRM', fluentcrmId: 1003
    }}),
    prisma.customer.create({ data: {
      firstName: 'Klaus', lastName: 'Bauer', company: 'Restaurant Zum Lamm',
      email: 'bauer@zum-lamm.de', phone: '+49 7191 998877',
      street: 'Bahnhofstr. 3', city: 'Backnang', zip: '71522', tags: ['Gewerbe', 'Gastronomie'], source: 'MANUAL'
    }}),
  ]);
  const [mueller, weber, schneider, hofmann, bauer] = customers;
  console.log(`  ✅ ${customers.length} Customers`);

  // Get user refs for test data
  const mario = await prisma.user.findUnique({ where: { email: 'mario@schreinerhelden.de' } });
  const petra = await prisma.user.findUnique({ where: { email: 'petra@schreinerhelden.de' } });
  const corina = await prisma.user.findUnique({ where: { email: 'corina@schreinerhelden.de' } });
  const philipp = await prisma.user.findUnique({ where: { email: 'philipp@schreinerhelden.de' } });
  const denise = await prisma.user.findUnique({ where: { email: 'denise@schreinerhelden.de' } });
  const robin = await prisma.user.findUnique({ where: { email: 'robin@schreinerhelden.de' } });
  const lea = await prisma.user.findUnique({ where: { email: 'lea@schreinerhelden.de' } });
  const melanie = await prisma.user.findUnique({ where: { email: 'melanie@schreinerhelden.de' } });

  // ── PROJECTS ──
  await Promise.all([
    prisma.project.create({ data: {
      id: 'P26-001', customerId: mueller.id, name: 'Einbauküche mit Kochinsel',
      description: 'Moderne Einbauküche mit Eiche-Fronten, Kochinsel und integrierter Beleuchtung',
      phase: 'FERTIGUNG', budgetHours: 120, actualHours: 68,
      offerAmount: 28500, depositAmount: 8550, depositPaidAt: new Date('2026-01-20'),
      montageDate: new Date('2026-03-15'), startDate: new Date('2025-12-01')
    }}),
    prisma.project.create({ data: {
      id: 'P26-002', customerId: weber.id, name: 'Begehbarer Kleiderschrank',
      phase: 'AV_PLANUNG', budgetHours: 60, actualHours: 8,
      offerAmount: 12800, startDate: new Date('2026-01-15')
    }}),
    prisma.project.create({ data: {
      id: 'P26-003', customerId: schneider.id, name: 'Empfangstheke Praxis',
      phase: 'ANGEBOT', budgetHours: 0, offerAmount: 9200, startDate: new Date('2026-02-20')
    }}),
    prisma.project.create({ data: {
      id: 'P26-004', customerId: hofmann.id, name: 'Einbauschränke Neubau',
      phase: 'MONTAGE', budgetHours: 80, actualHours: 71,
      offerAmount: 18600, montageDate: new Date('2026-02-25'), startDate: new Date('2025-11-20')
    }}),
    prisma.project.create({ data: {
      id: 'P26-005', customerId: bauer.id, name: 'Thekenumbau Restaurant',
      phase: 'RECHNUNG', budgetHours: 45, actualHours: 52,
      offerAmount: 14200, invoiceAmount: 9940, invoiceSentAt: new Date('2026-02-22'),
      startDate: new Date('2025-12-01')
    }}),
  ]);
  console.log(`  ✅ 5 Projects`);

  // ── Phase logs + notes (minimal) ──
  await prisma.phaseLog.create({ data: { projectId: 'P26-001', fromPhase: 'ANGEBOT', toPhase: 'ANGEBOT', userId: corina.id, comment: 'Projekt erstellt' } });
  await prisma.phaseLog.create({ data: { projectId: 'P26-002', fromPhase: 'ANGEBOT', toPhase: 'ANGEBOT', userId: corina.id, comment: 'Projekt erstellt' } });
  await prisma.phaseLog.create({ data: { projectId: 'P26-003', fromPhase: 'ANGEBOT', toPhase: 'ANGEBOT', userId: corina.id, comment: 'Projekt erstellt' } });
  await prisma.phaseLog.create({ data: { projectId: 'P26-004', fromPhase: 'ANGEBOT', toPhase: 'ANGEBOT', userId: corina.id, comment: 'Projekt erstellt' } });
  await prisma.phaseLog.create({ data: { projectId: 'P26-005', fromPhase: 'ANGEBOT', toPhase: 'ANGEBOT', userId: corina.id, comment: 'Projekt erstellt' } });

  await prisma.note.create({ data: { customerId: mueller.id, type: 'INTERN', text: 'Stammkunde, immer pünktliche Zahlung', userId: petra.id } });
  await prisma.note.create({ data: { customerId: schneider.id, type: 'ANRUF', text: 'Dr. Schneider braucht Angebot bis Ende der Woche', userId: corina.id } });

  console.log('  ✅ Phase Logs + Notes');
  console.log('\n🎉 Seed complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
