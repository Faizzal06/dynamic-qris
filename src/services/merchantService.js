'use strict';

const crypto = require('crypto');
const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const logger = require('../utils/logger');

function randomKey(prefix) {
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

function createMerchantService(db) {
  function serialize(merchant) {
    return { ...merchant };
  }

  /** Buat merchant (tanpa user login dashboard). */
  function createMerchant({ name, qris_static, webhook_url, webhook_secret, api_key, payhook_token, status = 'active' }) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ApiError(400, 'invalid_merchant', 'name wajib diisi');
    }
    if (typeof qris_static !== 'string' || qris_static.trim() === '') {
      throw new ApiError(400, 'invalid_merchant', 'qris_static wajib diisi');
    }
    if (typeof webhook_url !== 'string' || !/^https?:\/\/.+/i.test(webhook_url)) {
      throw new ApiError(400, 'invalid_merchant', 'webhook_url harus URL http(s) yang valid');
    }
    if (typeof webhook_secret !== 'string' || webhook_secret.trim() === '') {
      throw new ApiError(400, 'invalid_merchant', 'webhook_secret wajib diisi');
    }

    const now = new Date().toISOString();
    const merchant = {
      id: generateId('mch'),
      name: name.trim(),
      api_key: api_key || randomKey('sk_live_'),
      qris_static: qris_static.trim(),
      webhook_url: webhook_url.trim(),
      webhook_secret: webhook_secret.trim(),
      payhook_token: payhook_token || randomKey('ph_'),
      status,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO merchants (id, name, api_key, qris_static, webhook_url, webhook_secret, payhook_token, status, created_at, updated_at)
       VALUES (@id, @name, @api_key, @qris_static, @webhook_url, @webhook_secret, @payhook_token, @status, @created_at, @updated_at)`
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
       SET name = @name, qris_static = @qris_static, webhook_url = @webhook_url,
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

  function rotatePayhookToken(id) {
    const merchant = getMerchant(id);
    if (!merchant) return null;
    const payhookToken = randomKey('ph_');
    db.prepare('UPDATE merchants SET payhook_token = ?, updated_at = ? WHERE id = ?').run(
      payhookToken,
      new Date().toISOString(),
      id
    );
    return { ...merchant, payhook_token: payhookToken, updated_at: new Date().toISOString() };
  }

  /** Secret baru untuk webhook (dipakai saat reset). */
  function generateWebhookSecret() {
    return randomKey('whsec_');
  }

  return {
    createMerchant,
    getMerchant,
    listMerchants,
    updateMerchant,
    setStatus,
    rotateApiKey,
    rotatePayhookToken,
    generateWebhookSecret,
  };
}

module.exports = { createMerchantService };
