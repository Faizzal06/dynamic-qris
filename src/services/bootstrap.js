'use strict';

const logger = require('../utils/logger');

/**
 * Seed data awal saat server start:
 * Admin user dari env (ADMIN_USERNAME / ADMIN_PASSWORD) — password di-hash.
 *
 * Merchant, QRIS, dan PayHook TIDAK lagi di-seed dari env: model baru berbasis
 * pool — admin menambah akun QRIS & aplikasi PayHook via dashboard, lalu
 * merchant memilih/mengajukan sendiri.
 */
async function bootstrap({ db, config, userService }) {
  const seeded = { admin: false };

  if (config.adminUsername && config.adminPassword) {
    const existing = userService.getUserByUsername(config.adminUsername);
    if (!existing) {
      await userService.createUser({
        role: 'admin',
        username: config.adminUsername,
        password: config.adminPassword,
      });
      seeded.admin = true;
    }
  } else {
    logger.warn('[bootstrap] ADMIN_USERNAME/ADMIN_PASSWORD tidak diset — dashboard admin dinonaktifkan');
  }

  return seeded;
}

module.exports = { bootstrap };
