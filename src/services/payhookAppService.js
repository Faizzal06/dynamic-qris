'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const { randomKey } = require('../utils/tokens');
const logger = require('../utils/logger');

function createPayhookAppService(db) {
  function serialize(row) {
    return { ...row };
  }

  function getPayhookApp(id) {
    const row = db.prepare('SELECT * FROM payhook_apps WHERE id = ?').get(id);
    return row ? serialize(row) : null;
  }

  function getPayhookAppByToken(token) {
    const row = db.prepare('SELECT * FROM payhook_apps WHERE token = ?').get(token);
    return row ? serialize(row) : null;
  }

  /**
   * Buat aplikasi PayHook.
   * - owner_type 'admin': masuk pool admin, langsung aktif, bisa dipakai semua merchant.
   * - owner_type 'merchant': pengajuan merchant, status 'pending' sampai disetujui admin.
   * Token di-generate server-side (PayHook Android dikonfigurasi dengan token ini).
   */
  function createPayhookApp({ name, token, owner_type = 'admin', merchant_id = null }) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ApiError(400, 'invalid_payhook', 'Nama wajib diisi.');
    }
    if (!['admin', 'merchant'].includes(owner_type)) {
      throw new ApiError(400, 'invalid_payhook', 'owner_type harus admin atau merchant');
    }
    if (owner_type === 'merchant' && !merchant_id) {
      throw new ApiError(400, 'invalid_payhook', 'merchant_id wajib untuk PayHook milik merchant');
    }

    const now = new Date().toISOString();
    const app = {
      id: generateId('phapp'),
      name: name.trim(),
      token: token || randomKey('ph_'),
      owner_type,
      merchant_id: owner_type === 'merchant' ? merchant_id : null,
      status: owner_type === 'merchant' ? 'pending' : 'active',
      created_at: now,
      updated_at: now,
    };

    const insert = db.prepare(
      `INSERT INTO payhook_apps (id, name, token, owner_type, merchant_id, status, created_at, updated_at)
       VALUES (@id, @name, @token, @owner_type, @merchant_id, @status, @created_at, @updated_at)`
    );
    const tx = db.transaction(() => {
      insert.run(app);
      if (app.owner_type === 'merchant') {
        db.prepare(
          `INSERT INTO merchant_payhook (merchant_id, payhook_app_id, is_active, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?)`
        ).run(merchant_id, app.id, now, now);
      }
    });
    tx();

    logger.info(`[payhook] ${app.owner_type === 'admin' ? 'aplikasi admin dibuat' : `pengajuan merchant ${merchant_id}`} ${app.id}`);
    return serialize(app);
  }

  function listAll() {
    return db
      .prepare('SELECT * FROM payhook_apps ORDER BY owner_type ASC, created_at ASC')
      .all()
      .map(serialize);
  }

  /** Update by admin: nama / status. */
  function updatePayhookApp(id, fields) {
    const app = getPayhookApp(id);
    if (!app) return null;

    const next = { ...app, ...fields, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE payhook_apps
       SET name = @name, status = @status, updated_at = @updated_at
       WHERE id = @id`
    ).run(next);
    return serialize(next);
  }

  function setStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) {
      throw new ApiError(400, 'invalid_status', 'status harus active atau suspended');
    }
    return updatePayhookApp(id, { status });
  }

  /** Setujui pengajuan PayHook milik merchant → aktif + otomatis dipakai merchant pemilik. */
  function approve(id) {
    const app = getPayhookApp(id);
    if (!app) return null;
    if (app.owner_type !== 'merchant') {
      throw new ApiError(400, 'invalid_approval', 'hanya PayHook milik merchant yang perlu persetujuan');
    }
    if (app.status !== 'pending') {
      throw new ApiError(409, 'invalid_approval', `status saat ini: ${app.status}`);
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE payhook_apps SET status = ?, updated_at = ? WHERE id = ?').run('active', now, id);
      activateForMerchant(app.merchant_id, id, now);
    });
    tx();
    logger.info(`[payhook] pengajuan ${id} disetujui (merchant ${app.merchant_id})`);
    return { ...app, status: 'active', updated_at: now };
  }

  /** Tolak pengajuan PayHook milik merchant. */
  function reject(id) {
    const app = getPayhookApp(id);
    if (!app) return null;
    if (app.owner_type !== 'merchant') {
      throw new ApiError(400, 'invalid_approval', 'hanya PayHook milik merchant yang perlu persetujuan');
    }
    if (app.status !== 'pending') {
      throw new ApiError(409, 'invalid_approval', `status saat ini: ${app.status}`);
    }
    db.prepare('UPDATE payhook_apps SET status = ?, updated_at = ? WHERE id = ?').run(
      'rejected',
      new Date().toISOString(),
      id
    );
    logger.info(`[payhook] pengajuan ${id} ditolak`);
    return { ...app, status: 'rejected' };
  }

  /** Rotate token (admin untuk aplikasi mana pun; merchant hanya untuk miliknya). */
  function rotateToken(id) {
    const app = getPayhookApp(id);
    if (!app) return null;
    const token = randomKey('ph_');
    db.prepare('UPDATE payhook_apps SET token = ?, updated_at = ? WHERE id = ?').run(
      token,
      new Date().toISOString(),
      id
    );
    logger.info(`[payhook] token di-rotate untuk ${id}`);
    return { ...app, token, updated_at: new Date().toISOString() };
  }

  // ===== Pemakaian oleh merchant =====

  function activateForMerchant(merchantId, payhookAppId, now = new Date().toISOString()) {
    db.prepare('UPDATE merchant_payhook SET is_active = 0 WHERE merchant_id = ?').run(merchantId);
    db.prepare(
      `INSERT INTO merchant_payhook (merchant_id, payhook_app_id, is_active, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (merchant_id, payhook_app_id) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at`
    ).run(merchantId, payhookAppId, now, now);
  }

  /** Merchant memilih aplikasi PayHook (dari pool admin atau miliknya yang sudah disetujui). */
  function selectForMerchant(merchantId, payhookAppId) {
    const app = getPayhookApp(payhookAppId);
    if (!app) throw new ApiError(404, 'not_found', 'PayHook tidak ditemukan');
    if (app.owner_type === 'merchant' && app.merchant_id !== merchantId) {
      throw new ApiError(403, 'forbidden', 'PayHook ini bukan milik Anda.');
    }
    if (app.status !== 'active') {
      throw new ApiError(400, 'payhook_not_available', 'PayHook belum aktif atau tidak tersedia.');
    }
    activateForMerchant(merchantId, payhookAppId);
    logger.info(`[payhook] merchant ${merchantId} memakai ${payhookAppId}`);
    return app;
  }

  /** Aplikasi PayHook aktif yang sedang dipakai merchant (atau null). */
  function getActiveForMerchant(merchantId) {
    const row = db
      .prepare(
        `SELECT p.* FROM payhook_apps p
         JOIN merchant_payhook mp ON mp.payhook_app_id = p.id
         WHERE mp.merchant_id = ? AND mp.is_active = 1`
      )
      .get(merchantId);
    return row ? serialize(row) : null;
  }

  /** Info lengkap untuk dashboard merchant. */
  function listForMerchant(merchantId) {
    const selectable = db
      .prepare(
        `SELECT * FROM payhook_apps
         WHERE status = 'active' AND (owner_type = 'admin' OR merchant_id = ?)
         ORDER BY owner_type ASC, created_at ASC`
      )
      .all(merchantId)
      .map(serialize);
    const mine = db
      .prepare("SELECT * FROM payhook_apps WHERE owner_type = 'merchant' AND merchant_id = ? ORDER BY created_at ASC")
      .all(merchantId)
      .map(serialize);
    return { active: getActiveForMerchant(merchantId), selectable, mine };
  }

  return {
    getPayhookApp,
    getPayhookAppByToken,
    createPayhookApp,
    listAll,
    updatePayhookApp,
    setStatus,
    approve,
    reject,
    rotateToken,
    selectForMerchant,
    getActiveForMerchant,
    listForMerchant,
  };
}

module.exports = { createPayhookAppService };
