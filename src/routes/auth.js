'use strict';

const express = require('express');
const sessionService = require('../services/sessionService');
const { parseCookies } = require('../utils/cookies');
const logger = require('../utils/logger');

function createAuthRouter({ db, config, userService, rateLimiter }) {
  const router = express.Router();

  // POST /auth/login
  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password === '') {
        return res.status(400).json({ error: { code: 'invalid_credentials', message: 'Username dan password wajib diisi' } });
      }

      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!rateLimiter.allow(`${ip}:${username.trim()}`)) {
        return res.status(429).json({
          error: { code: 'too_many_attempts', message: 'Terlalu banyak percobaan login, coba lagi nanti' },
        });
      }

      const user = await userService.authenticateUser(username.trim(), password);
      if (!user) {
        logger.warn(`[auth] login gagal untuk ${username.trim()} dari ${ip}`);
        return res.status(401).json({ error: { code: 'invalid_credentials', message: 'Username atau password salah' } });
      }

      const session = sessionService.createSession(db, user.id, config.sessionTtlMs);
      sessionService.setSessionCookie(res, session.token, config);
      logger.info(`[auth] login sukses ${user.username} (${user.role})`);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/logout
  router.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) {
      sessionService.destroySession(db, token);
    }
    sessionService.clearSessionCookie(res, config);
    res.json({ status: 'ok' });
  });

  // GET /auth/me — info user saat ini (nullable jika belum login)
  router.get('/me', (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    const session = sessionService.findSession(db, token);
    if (!session) {
      return res.json({ user: null });
    }
    const user = db
      .prepare('SELECT id, merchant_id, role, username FROM users WHERE id = ?')
      .get(session.user_id);
    if (!user) {
      return res.json({ user: null });
    }
    res.json({ user });
  });

  return router;
}

module.exports = { createAuthRouter };
