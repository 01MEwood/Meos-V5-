require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const projectRoutes = require('./routes/projects');
const timeRoutes = require('./routes/time');
const callRoutes = require('./routes/calls');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/reports');
const syncRoutes = require('./routes/sync');
const distanceRoutes = require('./routes/distance');
const employeeRoutes = require('./routes/employees');
const calendarRoutes = require('./routes/calendar');
const calcRoutes = require('./routes/calc');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://meos.marioesch.de']
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 500
});
app.use('/api/', limiter);

// Auth rate limit (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20
});
app.use('/api/auth/', authLimiter);

// Static file serving for uploads
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ── Prisma available to all routes ──
app.use((req, res, next) => {
  req.prisma = prisma;
  next();
});

// ── Routes ──
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/distance', distanceRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/calc', calcRoutes);

// Start FluentCRM auto-sync cron
syncRoutes.startCron(prisma);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.0.0',
    timestamp: new Date().toISOString(),
    name: 'MEOS 4.0 - Schreinerhelden'
  });
});

// ── Serve Frontend (Production: React build) ──
const frontendPath = path.join(__dirname, '..', 'public');
app.use(express.static(frontendPath));

// HPM (Homag Production Manager) - separate app
app.get('/hpm', (req, res) => {
  res.sendFile(path.join(frontendPath, 'hpm.html'));
});

// Werkstatt Dashboard - standalone display
app.get('/werkstatt', (req, res) => {
  res.sendFile(path.join(frontendPath, 'werkstatt.html'));
});

// SPA fallback: any non-API route → index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── Error handler ──
app.use((err, req, res, next) => {
  console.error('[MEOS ERROR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Interner Serverfehler' : err.message
  });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   MEOS 4.0 - Industrial OS           ║
║   Schreinerhelden Backend API         ║
║   Port: ${PORT}                          ║
╚═══════════════════════════════════════╝`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
