'use strict';

const { findSession } = require('../services/sessionService');
const { parseCookies } = require('../utils/cookies');

function unauthorized(res) {
  return res.status(401).json({ error: { code: 'unauthorized', message: 'Login diperlukan' } });
}

/**
 * Middleware session cookie.
 * @param {object} db
 * @param {'admin'|'merchant'} [role] batasi peran; kosong = peran apa pun.
 */
function requireSession(db, role) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    const session = findSession(db, token);
    if (!session) return unauthorized(res);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) return unauthorized(res);

    if (role && user.role !== role) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Akses ditolak' } });
    }

    req.user = user;
    req.sessionToken = token;
    return next();
  };
}

module.exports = { requireSession };
