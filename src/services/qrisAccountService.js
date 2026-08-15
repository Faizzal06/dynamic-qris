'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const logger = require('../utils/logger');

function createQrisAccountService(db) {
  function serialize(row) {
    return { ...row };
  }

  function getQrisAccount(id) {
    const row = db.prepare('SELECT * FROM qris_accounts WHERE id = ?').get(id);
    return row ? serialize(row) : null;
  }

  /**
   * Buat akun QRIS.
   * - owner_type 'admin': masuk pool admin, langsung aktif, bisa dipakai semua merchant.
   * - owner_type 'merchant': pengajuan merchant, status 'pending' sampai disetujui admin.
   */
  function createQrisAccount({ name, qris_static, owner_type = 'admin', merchant_id = null }) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ApiError(400, 'invalid_qris', 'Nama wajib diisi.');
    }
    if (typeof qris_static !== 'string' || qris_static.trim() === '') {
      throw new ApiError(400, 'invalid_qris', 'QRIS statis wajib diisi.');
    }
    if (!['admin', 'merchant'].includes(owner_type)) {
      throw new ApiError(400, 'invalid_qris', 'owner_type harus admin atau merchant');
    }
    if (owner_type === 'merchant' && !merchant_id) {
      throw new ApiError(400, 'invalid_qris', 'merchant_id wajib untuk QRIS milik merchant');
    }

    const now = new Date().toISOString();
    const account = {
      id: generateId('qrs'),
      name: name.trim(),
      qris_static: qris_static.trim(),
      owner_type,
      merchant_id: owner_type === 'merchant' ? merchant_id : null,
      status: owner_type === 'merchant' ? 'pending' : 'active',
      created_at: now,
      updated_at: now,
    };

    const insert = db.prepare(
      `INSERT INTO qris_accounts (id, name, qris_static, owner_type, merchant_id, status, created_at, updated_at)
       VALUES (@id, @name, @qris_static, @owner_type, @merchant_id, @status, @created_at, @updated_at)`
    );
    const tx = db.transaction(() => {
      insert.run(account);
      if (account.owner_type === 'merchant') {
        db.prepare(
          `INSERT INTO merchant_qris (merchant_id, qris_account_id, is_active, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?)`
        ).run(merchant_id, account.id, now, now);
      }
    });
    tx();

    logger.info(`[qris] ${account.owner_type === 'admin' ? 'akun admin dibuat' : `pengajuan merchant ${merchant_id}`} ${account.id}`);
    return serialize(account);
  }

  function listAll() {
    return db
      .prepare('SELECT * FROM qris_accounts ORDER BY owner_type ASC, created_at ASC')
      .all()
      .map(serialize);
  }

  /** Update by admin: nama / qris_static / status. */
  function updateQrisAccount(id, fields) {
    const account = getQrisAccount(id);
    if (!account) return null;

    const next = { ...account, ...fields, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE qris_accounts
       SET name = @name, qris_static = @qris_static, status = @status, updated_at = @updated_at
       WHERE id = @id`
    ).run(next);
    return serialize(next);
  }

  /** Status aktif/suspended (untuk akun admin, atau akun merchant yang sudah disetujui). */
  function setStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) {
      throw new ApiError(400, 'invalid_status', 'status harus active atau suspended');
    }
    return updateQrisAccount(id, { status });
  }

  /** Setujui pengajuan QRIS milik merchant → aktif + otomatis dipakai merchant pemilik. */
  function approve(id) {
    const account = getQrisAccount(id);
    if (!account) return null;
    if (account.owner_type !== 'merchant') {
      throw new ApiError(400, 'invalid_approval', 'hanya QRIS milik merchant yang perlu persetujuan');
    }
    if (account.status !== 'pending') {
      throw new ApiError(409, 'invalid_approval', `status saat ini: ${account.status}`);
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE qris_accounts SET status = ?, updated_at = ? WHERE id = ?').run('active', now, id);
      activateForMerchant(account.merchant_id, id, now);
    });
    tx();
    logger.info(`[qris] pengajuan ${id} disetujui (merchant ${account.merchant_id})`);
    return { ...account, status: 'active', updated_at: now };
  }

  /** Tolak pengajuan QRIS milik merchant. */
  function reject(id) {
    const account = getQrisAccount(id);
    if (!account) return null;
    if (account.owner_type !== 'merchant') {
      throw new ApiError(400, 'invalid_approval', 'hanya QRIS milik merchant yang perlu persetujuan');
    }
    if (account.status !== 'pending') {
      throw new ApiError(409, 'invalid_approval', `status saat ini: ${account.status}`);
    }
    db.prepare('UPDATE qris_accounts SET status = ?, updated_at = ? WHERE id = ?').run(
      'rejected',
      new Date().toISOString(),
      id
    );
    logger.info(`[qris] pengajuan ${id} ditolak`);
    return { ...account, status: 'rejected' };
  }

  // ===== Pemakaian oleh merchant =====

  function activateForMerchant(merchantId, qrisAccountId, now = new Date().toISOString()) {
    db.prepare('UPDATE merchant_qris SET is_active = 0 WHERE merchant_id = ?').run(merchantId);
    db.prepare(
      `INSERT INTO merchant_qris (merchant_id, qris_account_id, is_active, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (merchant_id, qris_account_id) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at`
    ).run(merchantId, qrisAccountId, now, now);
  }

  /** Merchant memilih akun QRIS (dari pool admin atau miliknya yang sudah disetujui). */
  function selectForMerchant(merchantId, qrisAccountId) {
    const account = getQrisAccount(qrisAccountId);
    if (!account) throw new ApiError(404, 'not_found', 'QRIS tidak ditemukan');
    if (account.owner_type === 'merchant' && account.merchant_id !== merchantId) {
      throw new ApiError(403, 'forbidden', 'QRIS ini bukan milik Anda.');
    }
    if (account.status !== 'active') {
      throw new ApiError(400, 'qris_not_available', 'QRIS belum aktif atau tidak tersedia.');
    }
    activateForMerchant(merchantId, qrisAccountId);
    logger.info(`[qris] merchant ${merchantId} memakai ${qrisAccountId}`);
    return account;
  }

  /** Akun QRIS aktif yang sedang dipakai merchant (atau null). */
  function getActiveForMerchant(merchantId) {
    const row = db
      .prepare(
        `SELECT q.* FROM qris_accounts q
         JOIN merchant_qris mq ON mq.qris_account_id = q.id
         WHERE mq.merchant_id = ? AND mq.is_active = 1`
      )
      .get(merchantId);
    return row ? serialize(row) : null;
  }

  /** Info lengkap untuk dashboard merchant. */
  function listForMerchant(merchantId) {
    const selectable = db
      .prepare(
        `SELECT * FROM qris_accounts
         WHERE status = 'active' AND (owner_type = 'admin' OR merchant_id = ?)
         ORDER BY owner_type ASC, created_at ASC`
      )
      .all(merchantId)
      .map(serialize);
    const mine = db
      .prepare("SELECT * FROM qris_accounts WHERE owner_type = 'merchant' AND merchant_id = ? ORDER BY created_at ASC")
      .all(merchantId)
      .map(serialize);
    return { active: getActiveForMerchant(merchantId), selectable, mine };
  }

  return {
    getQrisAccount,
    createQrisAccount,
    listAll,
    updateQrisAccount,
    setStatus,
    approve,
    reject,
    selectForMerchant,
    getActiveForMerchant,
    listForMerchant,
  };
}

module.exports = { createQrisAccountService };
