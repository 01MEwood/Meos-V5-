const express = require('express');
const { authenticate } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// GET /api/dashboard
router.get('/', async (req, res) => {
  try {
    const [
      totalCustomers,
      activeProjects,
      projectsByPhase,
      allActive,
      recentCalls,
      todayHours,
      openPayments
    ] = await Promise.all([
      req.prisma.customer.count(),
      req.prisma.project.count({ where: { status: 'AKTIV' } }),
      req.prisma.project.groupBy({
        by: ['phase'],
        where: { status: 'AKTIV' },
        _count: true
      }),
      req.prisma.project.findMany({
        where: { status: 'AKTIV' },
        select: {
          id: true, name: true, phase: true, budgetHours: true, actualHours: true,
          offerAmount: true, depositAmount: true, depositPaidAt: true,
          invoiceAmount: true, invoiceSentAt: true, paidAt: true, montageDate: true,
          customer: { select: { firstName: true, lastName: true, company: true } }
        }
      }),
      req.prisma.callLog.findMany({
        take: 5, orderBy: { startTime: 'desc' },
        include: { customer: { select: { firstName: true, lastName: true } } }
      }).then(async calls => {
        // Enrich employee matches: when no customer linked, try resolving by phone
        const norm = (n) => (n || '').replace(/\D/g, '').replace(/^49(?=\d{10})/, '0').replace(/^0049/, '0');
        const employees = await req.prisma.user.findMany({ select: { id:true, name:true, phone:true, mobile:true } });
        return calls.map(c => {
          if (c.customer) return c;
          const last8 = norm(c.callerNumber).slice(-8);
          if (last8.length < 4) return c;
          const emp = employees.find(e => (norm(e.phone).endsWith(last8) || norm(e.mobile).endsWith(last8)));
          if (emp) {
            const parts = (emp.name || '').trim().split(/\s+/);
            c.customer = { firstName: parts[0] || emp.name, lastName: (parts.slice(1).join(' ') || '') + ' (MA)' };
          }
          return c;
        });
      }),
      req.prisma.timeEntry.aggregate({
        where: {
          date: { gte: new Date(new Date().setHours(0,0,0,0)), lte: new Date(new Date().setHours(23,59,59,999)) }
        },
        _sum: { hours: true }
      }),
      // Open payments (invoiced but not paid)
      req.prisma.payment.findMany({
        where: { paidAt: null },
        include: { project: { select: { id: true, name: true, customer: { select: { lastName: true } } } } },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const overBudget = allActive.filter(p => p.actualHours > 0 && p.actualHours > p.budgetHours);
    const awaitingPayment = allActive.filter(p => p.invoiceSentAt && !p.paidAt);
    const upcomingMontage = allActive
      .filter(p => p.montageDate && p.phase === 'FERTIGUNG')
      .sort((a, b) => new Date(a.montageDate) - new Date(b.montageDate));

    // Financial summary
    const totalOffer = allActive.reduce((s, p) => s + (p.offerAmount || 0), 0);
    const totalReceived = allActive.reduce((s, p) => s + (p.depositPaidAt ? (p.depositAmount || 0) : 0) + (p.paidAt ? (p.invoiceAmount || 0) : 0), 0);
    const totalOpen = openPayments.filter(p => !p.paidAt).reduce((s, p) => s + p.amount, 0);

    res.json({
      kpis: {
        totalCustomers,
        activeProjects,
        overBudget: overBudget.length,
        todayHours: todayHours._sum.hours || 0,
        awaitingPayment: awaitingPayment.length,
        totalOffer, totalReceived, totalOpen
      },
      projectsByPhase: projectsByPhase.map(p => ({ phase: p.phase, count: p._count })),
      overBudgetProjects: overBudget,
      awaitingPayment,
      upcomingMontage,
      openPayments,
      recentCalls
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
