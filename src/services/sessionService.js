'use strict';

const crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(db, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    expiresAt.toISOString(),
    now.toISOString()
  );
  return { token, expiresAt };
}

function findSession(db, token) {
  if (!token) return null;
  const hash = hashToken(token);
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return session;
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

function setSessionCookie(res, token, config) {
  const maxAgeSec = Math.floor(config.sessionTtlMs / 1000);
  const parts = [`sid=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, config) {
  const parts = ['sid=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

module.exports = {
  createSession,
  findSession,
  destroySession,
  purgeExpiredSessions,
  setSessionCookie,
  clearSessionCookie,
  hashToken,
};
