const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
    }

    const user = await req.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatarUrl: user.avatarUrl
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/pin - Workshop tablet quick login
router.post('/pin', async (req, res) => {
  try {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
      return res.status(400).json({ error: 'User-ID und PIN erforderlich' });
    }

    const user = await req.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || !user.pin) {
      return res.status(401).json({ error: 'PIN-Login nicht möglich' });
    }

    if (user.pin !== pin) {
      return res.status(401).json({ error: 'Ungültige PIN' });
    }

    // Short-lived token for tablet (8h)
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role, pinLogin: true },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, name: true, role: true,
        avatarUrl: true, active: true, createdAt: true
      }
    });
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users - List all users (for tablet worker selection)
router.get('/users', authenticate, async (req, res) => {
  try {
    const users = await req.prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true, avatarUrl: true },
      orderBy: { name: 'asc' }
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
