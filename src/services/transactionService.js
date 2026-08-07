'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const logger = require('../utils/logger');

const URL_REGEX = /^https?:\/\/.+/i;

function createTransactionService(db, config, uniqueAmount, qrisConverter, webhookSender) {
  function validateCreateInput(input) {
    if (!input || typeof input !== 'object') {
      throw new ApiError(400, 'invalid_body', 'Request body tidak valid');
    }

    const { ref_id, amount, expiry_minutes, metadata, callback_url } = input;

    if (typeof ref_id !== 'string' || ref_id.trim() === '') {
      throw new ApiError(400, 'invalid_ref_id', 'ref_id wajib diisi');
    }
    if (ref_id.length > 128) {
      throw new ApiError(400, 'invalid_ref_id', 'ref_id terlalu panjang (maks 128)');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(400, 'invalid_amount', 'amount harus integer positif');
    }
    if (amount > config.maxAmount) {
      throw new ApiError(400, 'amount_too_large', `amount melebihi batas maksimal ${config.maxAmount}`);
    }
    if (
      expiry_minutes !== undefined &&
      (!Number.isInteger(expiry_minutes) || expiry_minutes <= 0 || expiry_minutes > 1440)
    ) {
      throw new ApiError(400, 'invalid_expiry_minutes', 'expiry_minutes harus 1-1440 menit');
    }
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
      throw new ApiError(400, 'invalid_metadata', 'metadata harus berupa object');
    }
    if (callback_url !== undefined && (typeof callback_url !== 'string' || !URL_REGEX.test(callback_url))) {
      throw new ApiError(400, 'invalid_callback_url', 'callback_url harus URL http(s) yang valid');
    }

    return {
      ref_id: ref_id.trim(),
      amount,
      expiry_minutes: expiry_minutes ?? config.defaultExpiryMinutes,
      metadata: metadata || null,
      callback_url: callback_url || null,
    };
  }

  function rowToObject(row) {
    if (!row) return null;
    return { ...row };
  }

  async function createTransaction(input) {
    const valid = validateCreateInput(input);

    // Idempotensi ref_id: kembalikan transaksi yang sudah ada
    const existing = db.prepare('SELECT * FROM transactions WHERE ref_id = ? LIMIT 1').get(valid.ref_id);
    if (existing) {
      return { transaction: rowToObject(existing), created: false };
    }

    const actualAmount = uniqueAmount.generate(valid.amount);
    const { qrString, qrBase64 } = await qrisConverter.convert(config.merchantQrisStatic, actualAmount);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + valid.expiry_minutes * 60_000);
    const txn = {
      id: generateId('txn'),
      ref_id: valid.ref_id,
      requested_amount: valid.amount,
      actual_amount: actualAmount,
      qr_string: qrString,
      qr_base64: qrBase64,
      status: 'pending',
      callback_url: valid.callback_url,
      metadata: valid.metadata ? JSON.stringify(valid.metadata) : null,
      paid_at: null,
      paid_source: null,
      paid_reference: null,
      payhook_event_id: null,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
      webhook_status: 'pending',
      webhook_attempts: 0,
      webhook_next_retry_at: null,
      webhook_last_error: null,
    };

    try {
      db.prepare(
        `INSERT INTO transactions (
          id, ref_id, requested_amount, actual_amount, qr_string, qr_base64, status,
          callback_url, metadata, paid_at, paid_source, paid_reference, payhook_event_id,
          expires_at, created_at, webhook_status, webhook_attempts, webhook_next_retry_at, webhook_last_error
        ) VALUES (
          @id, @ref_id, @requested_amount, @actual_amount, @qr_string, @qr_base64, @status,
          @callback_url, @metadata, @paid_at, @paid_source, @paid_reference, @payhook_event_id,
          @expires_at, @created_at, @webhook_status, @webhook_attempts, @webhook_next_retry_at, @webhook_last_error
        )`
      ).run(txn);
    } catch (err) {
      // Race condition ref_id: request lain sudah insert lebih dulu → kembalikan transaksi yang ada
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const concurrent = db.prepare('SELECT * FROM transactions WHERE ref_id = ? LIMIT 1').get(valid.ref_id);
        if (concurrent) {
          return { transaction: rowToObject(concurrent), created: false };
        }
      }
      throw err;
    }

    logger.info(`[txn] dibuat ${txn.id} ref_id=${txn.ref_id} actual=${actualAmount}`);
    return { transaction: txn, created: true };
  }

  function getTransaction(id) {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!txn) return null;

    // Lazy expire: jika pending dan sudah lewat expires_at
    if (txn.status === 'pending' && new Date(txn.expires_at).getTime() <= Date.now()) {
      db.prepare(`UPDATE transactions SET status = 'expired' WHERE id = ?`).run(id);
      txn.status = 'expired';
    }
    return rowToObject(txn);
  }

  function getQrBase64(id) {
    const row = db.prepare('SELECT qr_base64 FROM transactions WHERE id = ?').get(id);
    return row ? row.qr_base64 : null;
  }

  function handlePayhookNotification({ event_id, event_type, amount, source, reference }) {
    // Idempotensi event_id (cegah double process)
    const dupTxn = db.prepare('SELECT 1 FROM transactions WHERE payhook_event_id = ? LIMIT 1').get(event_id);
    const dupOrphan = db.prepare('SELECT 1 FROM orphan_payments WHERE event_id = ? LIMIT 1').get(event_id);
    if (dupTxn || dupOrphan) {
      logger.info(`[payhook] event ${event_id} duplikat, diabaikan`);
      return { matched: false, reason: 'duplicate' };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    // Cari transaksi pending dengan nominal unik yang belum expired
    const pending = db
      .prepare(
        `SELECT * FROM transactions
         WHERE status = 'pending' AND actual_amount = ? AND expires_at > ?
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(amount, nowIso);

    if (!pending) {
      db.prepare(
        `INSERT INTO orphan_payments (event_id, amount, source, reference, received_at, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(event_id, amount, source || null, reference || null, nowIso, 'tidak ada transaksi pending yang cocok');
      logger.warn(`[payhook] orphan payment event=${event_id} amount=${amount}`);
      return { matched: false, reason: 'no_match' };
    }

    db.prepare(
      `UPDATE transactions
       SET status = 'paid', paid_at = ?, paid_source = ?, paid_reference = ?, payhook_event_id = ?
       WHERE id = ?`
    ).run(nowIso, source || null, reference || null, event_id, pending.id);

    const paidTxn = { ...pending, status: 'paid', paid_at: nowIso, paid_source: source || null, paid_reference: reference || null, payhook_event_id: event_id };
    logger.info(`[payhook] transaksi ${pending.id} dibayar amount=${amount} source=${source || '-'}`);

    // Kirim webhook ke merchant secara async (retry di-handle job)
    webhookSender.send(paidTxn).catch((err) => logger.error(`[webhook] error tidak terduga: ${err.message}`));

    return { matched: true, transaction: paidTxn };
  }

  return { createTransaction, getTransaction, getQrBase64, handlePayhookNotification };
}

module.exports = { createTransactionService };
