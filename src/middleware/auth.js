const jwt = require('jsonwebtoken');

// Authenticate JWT token
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht autorisiert' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
}

// Check role(s) - accepts single role or array
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Nicht autorisiert' });
    }
    // ADMIN has access to everything
    if (req.user.role === 'ADMIN') return next();

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }
    next();
  };
}

// PIN-based auth for workshop tablet
function authenticatePin(req, res, next) {
  const { userId, pin } = req.body;
  if (!userId || !pin) {
    return res.status(400).json({ error: 'User-ID und PIN erforderlich' });
  }
  // PIN validation happens in the route handler
  next();
}

// Role hierarchy for read access
const READ_ACCESS = {
  ADMIN:      ['customers', 'projects', 'time', 'documents', 'notes', 'calls', 'users', 'reports'],
  BUERO:      ['customers', 'projects', 'time', 'documents', 'notes', 'calls', 'reports'],
  HR:         ['users'],
  MARKETING:  ['customers'],
  WERKSTATT:  ['projects', 'time', 'documents'],
  MONTAGE:    ['projects', 'time', 'documents'],
  STEMPELN:   ['time'],
};

function canRead(role, resource) {
  if (role === 'ADMIN') return true;
  return READ_ACCESS[role]?.includes(resource) || false;
}

module.exports = { authenticate, requireRole, authenticatePin, canRead };
