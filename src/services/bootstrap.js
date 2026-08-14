'use strict';

const logger = require('../utils/logger');

/**
 * Seed data awal saat server start:
 * 1. Admin user dari env (ADMIN_USERNAME / ADMIN_PASSWORD) — password di-hash.
 * 2. Merchant default dari konfigurasi env legacy (MERCHANT_*), jika ada.
 * 3. Backfill merchant_id transaksi/orphan lama ke merchant default.
 */
async function bootstrap({ db, config, userService, merchantService }) {
  const seeded = { admin: false, merchant: null };

  // 1. Admin user
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

  // 2. Merchant default dari env legacy
  const legacy = config.legacyMerchant;
  const hasLegacy = legacy.apiKey && legacy.qrisStatic && legacy.webhookUrl && legacy.webhookSecret && legacy.payhookToken;
  if (hasLegacy) {
    const all = merchantService.listMerchants();
    let merchant = all.find((m) => m.api_key === legacy.apiKey) || null;
    if (!merchant) {
      merchant = merchantService.createMerchant({
        name: legacy.name,
        api_key: legacy.apiKey,
        qris_static: legacy.qrisStatic,
        webhook_url: legacy.webhookUrl,
        webhook_secret: legacy.webhookSecret,
        payhook_token: legacy.payhookToken,
      });
      seeded.merchant = merchant;
      logger.info(`[bootstrap] merchant default dibuat dari env legacy: ${merchant.id} (${merchant.name})`);
    }

    // 3. Backfill data lama
    const backfillTxn = db.prepare('UPDATE transactions SET merchant_id = ? WHERE merchant_id IS NULL').run(merchant.id);
    const backfillOrphan = db
      .prepare('UPDATE orphan_payments SET merchant_id = ? WHERE merchant_id IS NULL')
      .run(merchant.id);
    if (backfillTxn.changes > 0 || backfillOrphan.changes > 0) {
      logger.info(
        `[bootstrap] backfill merchant_id: ${backfillTxn.changes} transaksi, ${backfillOrphan.changes} orphan -> ${merchant.id}`
      );
    }
  }

  return seeded;
}

module.exports = { bootstrap };
