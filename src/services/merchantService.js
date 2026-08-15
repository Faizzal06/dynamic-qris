'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const { randomKey } = require('../utils/tokens');
const logger = require('../utils/logger');

function createMerchantService(db) {
  function serialize(merchant) {
    return { ...merchant };
  }

  /**
   * Buat merchant. QRIS & PayHook TIDAK lagi menempel di merchant —
   * merchant memilih/mengajukan dari pool (lihat qrisAccountService/payhookAppService).
   */
  function createMerchant({ name, webhook_url, webhook_secret, api_key, status = 'active' }) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ApiError(400, 'invalid_merchant', 'Nama merchant wajib diisi.');
    }
    if (typeof webhook_url !== 'string' || !/^https?:\/\/.+/i.test(webhook_url)) {
      throw new ApiError(400, 'invalid_merchant', 'URL webhook tidak valid. Gunakan format lengkap, contoh: https://toko.com/webhook');
    }
    if (typeof webhook_secret !== 'string' || webhook_secret.trim() === '') {
      throw new ApiError(400, 'invalid_merchant', 'Webhook secret wajib diisi.');
    }

    const now = new Date().toISOString();
    const merchant = {
      id: generateId('mch'),
      name: name.trim(),
      api_key: api_key || randomKey('sk_live_'),
      webhook_url: webhook_url.trim(),
      webhook_secret: webhook_secret.trim(),
      status,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO merchants (id, name, api_key, webhook_url, webhook_secret, status, created_at, updated_at)
       VALUES (@id, @name, @api_key, @webhook_url, @webhook_secret, @status, @created_at, @updated_at)`
    ).run(merchant);

    logger.info(`[merchant] dibuat ${merchant.id} (${merchant.name})`);
    return serialize(merchant);
  }

  function getMerchant(id) {
    const row = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
    return row ? serialize(row) : null;
  }

  function listMerchants() {
    return db.prepare('SELECT * FROM merchants ORDER BY created_at ASC').all().map(serialize);
  }

  function updateMerchant(id, fields) {
    const merchant = getMerchant(id);
    if (!merchant) return null;

    const next = { ...merchant, ...fields, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE merchants
       SET name = @name, webhook_url = @webhook_url,
           webhook_secret = @webhook_secret, status = @status, updated_at = @updated_at
       WHERE id = @id`
    ).run(next);
    return serialize(next);
  }

  function setStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) {
      throw new ApiError(400, 'invalid_status', 'status harus active atau suspended');
    }
    return updateMerchant(id, { status });
  }

  function rotateApiKey(id) {
    const merchant = getMerchant(id);
    if (!merchant) return null;
    const apiKey = randomKey('sk_live_');
    db.prepare('UPDATE merchants SET api_key = ?, updated_at = ? WHERE id = ?').run(apiKey, new Date().toISOString(), id);
    return { ...merchant, api_key: apiKey, updated_at: new Date().toISOString() };
  }

  /** Secret baru untuk webhook (dipakai saat reset). */
  function generateWebhookSecret() {
    return randomKey('whsec_');
  }

  /** Rotate webhook secret — secret lama langsung tidak berlaku. */
  function rotateWebhookSecret(id) {
    const merchant = getMerchant(id);
    if (!merchant) return null;
    const secret = generateWebhookSecret();
    db.prepare('UPDATE merchants SET webhook_secret = ?, updated_at = ? WHERE id = ?').run(secret, new Date().toISOString(), id);
    return { ...merchant, webhook_secret: secret, updated_at: new Date().toISOString() };
  }

  return {
    createMerchant,
    getMerchant,
    listMerchants,
    updateMerchant,
    setStatus,
    rotateApiKey,
    generateWebhookSecret,
    rotateWebhookSecret,
  };
}

module.exports = { createMerchantService };
