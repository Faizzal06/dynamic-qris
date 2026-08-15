'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const logger = require('../utils/logger');

const URL_REGEX = /^https?:\/\/.+/i;

function createTransactionService(db, config, uniqueAmount, qrisConverter, webhookSender, qrisAccountService) {
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

  /** Buat transaksi untuk merchant tertentu. */
  async function createTransaction(merchant, input) {
    const valid = validateCreateInput(input);

    // Idempotensi (merchant_id, ref_id): kembalikan transaksi yang sudah ada
    const existing = db
      .prepare('SELECT * FROM transactions WHERE merchant_id = ? AND ref_id = ? LIMIT 1')
      .get(merchant.id, valid.ref_id);
    if (existing) {
      return { transaction: rowToObject(existing), created: false };
    }

    // QRIS aktif merchant (dari pool admin atau miliknya yang disetujui)
    const qrisAccount = qrisAccountService.getActiveForMerchant(merchant.id);
    if (!qrisAccount) {
      throw new ApiError(
        400,
        'no_active_qris',
        'Merchant belum memiliki QRIS aktif. Pilih QRIS dari admin atau ajukan QRIS sendiri di dashboard.'
      );
    }
    if (qrisAccount.status !== 'active') {
      throw new ApiError(400, 'qris_not_available', 'QRIS aktif merchant sedang tidak tersedia');
    }

    const actualAmount = uniqueAmount.generate(valid.amount);
    const { qrString, qrBase64 } = await qrisConverter.convert(qrisAccount.qris_static, actualAmount);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + valid.expiry_minutes * 60_000);
    const txn = {
      id: generateId('txn'),
      merchant_id: merchant.id,
      qris_account_id: qrisAccount.id,
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
      refunded_at: null,
    };

    try {
      db.prepare(
        `INSERT INTO transactions (
          id, merchant_id, qris_account_id, ref_id, requested_amount, actual_amount, qr_string, qr_base64, status,
          callback_url, metadata, paid_at, paid_source, paid_reference, payhook_event_id,
          expires_at, created_at, webhook_status, webhook_attempts, webhook_next_retry_at, webhook_last_error, refunded_at
        ) VALUES (
          @id, @merchant_id, @qris_account_id, @ref_id, @requested_amount, @actual_amount, @qr_string, @qr_base64, @status,
          @callback_url, @metadata, @paid_at, @paid_source, @paid_reference, @payhook_event_id,
          @expires_at, @created_at, @webhook_status, @webhook_attempts, @webhook_next_retry_at, @webhook_last_error, @refunded_at
        )`
      ).run(txn);
    } catch (err) {
      // Race condition ref_id: request lain sudah insert lebih dulu → kembalikan transaksi yang ada
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const concurrent = db
          .prepare('SELECT * FROM transactions WHERE merchant_id = ? AND ref_id = ? LIMIT 1')
          .get(merchant.id, valid.ref_id);
        if (concurrent) {
          return { transaction: rowToObject(concurrent), created: false };
        }
      }
      throw err;
    }

    logger.info(`[txn] dibuat ${txn.id} merchant=${merchant.id} qris=${qrisAccount.id} ref_id=${txn.ref_id} actual=${actualAmount}`);
    return { transaction: txn, created: true };
  }

  /** Ambil transaksi milik merchant tertentu (scoped). */
  function getTransaction(merchant, id) {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND merchant_id = ?').get(id, merchant.id);
    if (!txn) return null;

    // Lazy expire: jika pending dan sudah lewat expires_at
    if (txn.status === 'pending' && new Date(txn.expires_at).getTime() <= Date.now()) {
      db.prepare(`UPDATE transactions SET status = 'expired' WHERE id = ?`).run(id);
      txn.status = 'expired';
    }
    return rowToObject(txn);
  }

  /** QR publik (tanpa auth). */
  function getQrBase64(id) {
    const row = db.prepare('SELECT qr_base64 FROM transactions WHERE id = ?').get(id);
    return row ? row.qr_base64 : null;
  }

  /**
   * Proses notifikasi PayHook.
   * @param {object} payhookApp aplikasi PayHook (dari token) — bisa dipakai banyak merchant
   */
  function handlePayhookNotification(payhookApp, { event_id, event_type, amount, source, reference }) {
    // Idempotensi event_id (cegah double process)
    const dupTxn = db.prepare('SELECT 1 FROM transactions WHERE payhook_event_id = ? LIMIT 1').get(event_id);
    const dupOrphan = db.prepare('SELECT 1 FROM orphan_payments WHERE event_id = ? LIMIT 1').get(event_id);
    if (dupTxn || dupOrphan) {
      logger.info(`[payhook] event ${event_id} duplikat, diabaikan`);
      return { matched: false, reason: 'duplicate' };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    // Nominal unik bersifat GLOBAL → cari transaksi pending dengan nominal ini
    const pending = db
      .prepare(
        `SELECT * FROM transactions
         WHERE status = 'pending' AND actual_amount = ? AND expires_at > ?
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(amount, nowIso);

    function recordOrphan(merchantId, note) {
      db.prepare(
        `INSERT INTO orphan_payments (merchant_id, event_id, amount, source, reference, received_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(merchantId, event_id, amount, source || null, reference || null, nowIso, note);
      logger.warn(`[payhook] orphan payment event=${event_id} amount=${amount} note=${note}`);
    }

    if (!pending) {
      const ownerMerchantId = payhookApp.owner_type === 'merchant' ? payhookApp.merchant_id : null;
      recordOrphan(ownerMerchantId, `tidak ada transaksi pending yang cocok (payhook: ${payhookApp.name})`);
      return { matched: false, reason: 'no_match' };
    }

    // Verifikasi merchant pemilik transaksi boleh memakai aplikasi PayHook ini
    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(pending.merchant_id);
    const allowed =
      merchant &&
      merchant.status === 'active' &&
      payhookApp.status === 'active' &&
      ((payhookApp.owner_type === 'merchant' && payhookApp.merchant_id === merchant.id) ||
        (payhookApp.owner_type === 'admin' &&
          db
            .prepare('SELECT 1 FROM merchant_payhook WHERE merchant_id = ? AND payhook_app_id = ? AND is_active = 1')
            .get(merchant.id, payhookApp.id)));

    if (!allowed) {
      recordOrphan(
        pending.merchant_id,
        `nominal cocok dengan ${pending.id} tapi aplikasi PayHook "${payhookApp.name}" tidak terdaftar untuk merchant tersebut`
      );
      return { matched: false, reason: 'app_not_assigned' };
    }

    // Hitung pembagian saldo saat pembayaran (snapshot pemilik QRIS saat itu):
    // - QRIS admin (pool): kode unik (actual - requested) jadi fee admin, saldo merchant = requested_amount
    // - QRIS milik merchant sendiri: saldo merchant = actual_amount (full), fee admin 0
    const qrisOwner = pending.qris_account_id
      ? db.prepare('SELECT owner_type FROM qris_accounts WHERE id = ?').get(pending.qris_account_id)
      : null;
    const isAdminQris = !!qrisOwner && qrisOwner.owner_type === 'admin';
    const merchantCredit = isAdminQris ? pending.requested_amount : pending.actual_amount;
    const adminFee = isAdminQris ? pending.actual_amount - pending.requested_amount : 0;

    db.prepare(
      `UPDATE transactions
       SET status = 'paid', paid_at = ?, paid_source = ?, paid_reference = ?, payhook_event_id = ?,
           merchant_credit = ?, admin_fee = ?
       WHERE id = ?`
    ).run(nowIso, source || null, reference || null, event_id, merchantCredit, adminFee, pending.id);

    const paidTxn = {
      ...pending,
      status: 'paid',
      paid_at: nowIso,
      paid_source: source || null,
      paid_reference: reference || null,
      payhook_event_id: event_id,
      merchant_credit: merchantCredit,
      admin_fee: adminFee,
    };
    logger.info(
      `[payhook] transaksi ${pending.id} dibayar amount=${amount} source=${source || '-'} kredit=${merchantCredit} fee=${adminFee}`
    );

    // Kirim webhook ke merchant secara async (retry di-handle job)
    webhookSender.send(paidTxn).catch((err) => logger.error(`[webhook] error tidak terduga: ${err.message}`));

    return { matched: true, transaction: paidTxn };
  }

  // ===== Saldo & penghasilan =====

  /** Saldo merchant = total kredit dari transaksi paid (refund tidak dihitung). */
  function getMerchantSaldo(merchantId) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(merchant_credit), 0) AS saldo, COUNT(*) AS paid_count
         FROM transactions WHERE merchant_id = ? AND status = 'paid'`
      )
      .get(merchantId);
    return { saldo: row.saldo, paid_count: row.paid_count };
  }

  /** Ringkasan penghasilan admin: total fee kode unik + breakdown per merchant. */
  function getAdminIncomeSummary() {
    const total = db
      .prepare(
        `SELECT COALESCE(SUM(admin_fee), 0) AS total_fee,
                COALESCE(SUM(merchant_credit), 0) AS total_merchant_credit,
                COUNT(*) AS paid_count
         FROM transactions WHERE status = 'paid'`
      )
      .get();

    const perMerchant = db
      .prepare(
        `SELECT m.id, m.name,
                COALESCE(SUM(t.admin_fee), 0) AS fee,
                COALESCE(SUM(t.merchant_credit), 0) AS merchant_credit,
                COUNT(*) AS paid_count
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
         WHERE t.status = 'paid'
         GROUP BY m.id, m.name
         ORDER BY fee DESC, m.name ASC`
      )
      .all();

    return { ...total, per_merchant: perMerchant };
  }

  // ===== Query untuk dashboard (admin) & dashboard merchant =====

  function listTransactions({ merchantId, status, page = 1, limit = 25 }) {
    const where = [];
    const params = [];
    if (merchantId) {
      where.push('merchant_id = ?');
      params.push(merchantId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM transactions ${whereSql}`).get(...params).c;
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const rows = db
      .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, offset);

    return {
      data: rows.map(rowToObject),
      total,
      page: safePage,
      limit: safeLimit,
      total_pages: Math.max(Math.ceil(total / safeLimit), 1),
    };
  }

  function listOrphanPayments({ merchantId, page = 1, limit = 25 }) {
    const where = [];
    const params = [];
    if (merchantId) {
      where.push('merchant_id = ?');
      params.push(merchantId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM orphan_payments ${whereSql}`).get(...params).c;
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const rows = db
      .prepare(`SELECT * FROM orphan_payments ${whereSql} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, offset);

    return {
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
      total_pages: Math.max(Math.ceil(total / safeLimit), 1),
    };
  }

  // ===== Statistik & chart untuk dashboard =====

  /** Bagikan { label, value } dari kolom tertentu transaksi paid (untuk donut). */
  function distributionOf(column, where = 'status = \'paid\'') {
    const allowed = ['paid_source', 'qris_account_id'];
    if (!allowed.includes(column)) throw new Error(`kolom tidak diizinkan: ${column}`);
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(${column}, ''), 'Lainnya') AS label, COUNT(*) AS value
         FROM transactions WHERE ${where} GROUP BY label ORDER BY value DESC`
      )
      .all();
    return rows.map((r) => ({ label: r.label, value: r.value }));
  }

  /** Baris waktu harian: { day, value } untuk rentang [fromIso, toIso). */
  function dailySeries(column, fromIso, toIso, where = 'status = \'paid\'') {
    if (!['admin_fee', 'merchant_credit'].includes(column)) throw new Error(`kolom tidak diizinkan: ${column}`);
    const rows = db
      .prepare(
        `SELECT date(paid_at) AS day, COALESCE(SUM(${column}), 0) AS value
         FROM transactions WHERE ${where} AND paid_at >= ? AND paid_at < ?
         GROUP BY day ORDER BY day ASC`
      )
      .all(fromIso, toIso);
    return rows.map((r) => ({ day: r.day, value: r.value }));
  }

  /** Kenaikan/penurunan persen antara dua nilai (null jika tidak bisa dihitung). */
  function pctChange(current, previous) {
    if (!previous || previous === 0) return null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  /** 7 hari terakhir (termasuk hari ini) + 7 hari sebelumnya, dalam zona waktu lokal. */
  function last7AndPrior7() {
    const days = [];
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.unshift(d);
    }
    const start = new Date(days[0]);
    start.setHours(0, 0, 0, 0);
    const priorEnd = new Date(start);
    const priorStart = new Date(priorEnd);
    priorStart.setDate(priorStart.getDate() - 7);
    return { days, startIso: start.toISOString(), priorStartIso: priorStart.toISOString(), priorEndIso: priorEnd.toISOString() };
  }

  /** Statistik dashboard admin (donut, line, general, top merchant). */
  function getAdminDashboardStats() {
    const { days, startIso, priorStartIso, priorEndIso } = last7AndPrior7();

    const series = dailySeries('admin_fee', startIso, new Date(days[6]).toISOString());
    const seriesMap = new Map(series.map((r) => [r.day, r.value]));

    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(admin_fee), 0) AS fee,
                COALESCE(SUM(merchant_credit), 0) AS credit,
                COUNT(*) AS paid_count
         FROM transactions WHERE status = 'paid'`
      )
      .get();
    const totalTxns = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;

    const periodTotals = db
      .prepare(
        `SELECT COALESCE(SUM(admin_fee), 0) AS fee, COALESCE(SUM(merchant_credit), 0) AS credit
         FROM transactions WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`
      )
      .get(startIso, priorEndIso);
    const priorTotals = db
      .prepare(
        `SELECT COALESCE(SUM(admin_fee), 0) AS fee, COALESCE(SUM(merchant_credit), 0) AS credit
         FROM transactions WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`
      )
      .get(priorStartIso, startIso);

    const topMerchants = db
      .prepare(
        `SELECT m.name, m.id,
                COUNT(*) AS paid_count,
                COALESCE(SUM(t.admin_fee), 0) AS fee,
                COALESCE(SUM(t.merchant_credit), 0) AS credit
         FROM transactions t JOIN merchants m ON m.id = t.merchant_id
         WHERE t.status = 'paid'
         GROUP BY m.id, m.name
         ORDER BY fee DESC, credit DESC
         LIMIT 10`
      )
      .all();

    return {
      sourceDist: distributionOf('paid_source'),
      incomeSeries: {
        labels: days.map((d) => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`),
        data: days.map((d) => {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return seriesMap.get(key) || 0;
        }),
      },
      generalStats: {
        revenue: totals.fee,
        revenueTrend: pctChange(periodTotals.fee, priorTotals.fee),
        income: totals.credit,
        incomeTrend: pctChange(periodTotals.credit, priorTotals.credit),
      },
      paidCount: totals.paid_count,
      totalTxns,
      topMerchants,
    };
  }

  /** Statistik dashboard merchant (donut status, line saldo masuk, general). */
  function getMerchantDashboardStats(merchantId) {
    const { days, startIso, priorStartIso, priorEndIso } = last7AndPrior7();

    // Distribusi status transaksi
    const statusDist = db
      .prepare(
        `SELECT status AS label, COUNT(*) AS value
         FROM transactions
         WHERE merchant_id = ? GROUP BY status ORDER BY value DESC`
      )
      .all(merchantId)
      .map((r) => ({ label: r.label, value: r.value }));

    // Series saldo masuk (merchant_credit) per hari 7 terakhir
    const creditRows = db
      .prepare(
        `SELECT date(paid_at) AS day, COALESCE(SUM(merchant_credit), 0) AS value
         FROM transactions
         WHERE status = 'paid' AND merchant_id = ? AND paid_at >= ? AND paid_at < ?
         GROUP BY day ORDER BY day ASC`
      )
      .all(merchantId, startIso, priorEndIso);
    const creditMap = new Map(creditRows.map((r) => [r.day, r.value]));

    const saldoSeries = {
      labels: days.map((d) => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`),
      data: days.map((d) => {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return creditMap.get(key) || 0;
      }),
    };

    // Trendi saldo 7 hari vs 7 hari sebelumnya
    const periodTotals = db
      .prepare(
        `SELECT COALESCE(SUM(merchant_credit), 0) AS credit
         FROM transactions
         WHERE status = 'paid' AND merchant_id = ? AND paid_at >= ? AND paid_at < ?`
      )
      .get(merchantId, startIso, priorEndIso);
    const priorTotals = db
      .prepare(
        `SELECT COALESCE(SUM(merchant_credit), 0) AS credit
         FROM transactions
         WHERE status = 'paid' AND merchant_id = ? AND paid_at >= ? AND paid_at < ?`
      )
      .get(merchantId, priorStartIso, startIso);

    return {
      statusDist,
      saldoSeries,
      saldoTrend: pctChange(periodTotals.credit, priorTotals.credit),
    };
}

  // ===== Aksi admin =====

  function forceExpire(id) {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!txn) return null;
    if (txn.status !== 'pending') return { transaction: txn, changed: false };
    db.prepare(`UPDATE transactions SET status = 'expired' WHERE id = ?`).run(id);
    logger.info(`[admin] transaksi ${id} di-expire manual`);
    return { transaction: { ...txn, status: 'expired' }, changed: true };
  }

  function refund(id) {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!txn) return null;
    if (txn.status !== 'paid') return { transaction: txn, changed: false };

    const refundedAt = new Date().toISOString();
    db.prepare(`UPDATE transactions SET status = 'refunded', refunded_at = ? WHERE id = ?`).run(refundedAt, id);
    const updated = { ...txn, status: 'refunded', refunded_at: refundedAt };
    logger.info(`[admin] transaksi ${id} di-refund`);

    // Notifikasi merchant
    webhookSender.send(updated, { event: 'transaction.refunded' }).catch((err) =>
      logger.error(`[webhook] error refund tidak terduga: ${err.message}`)
    );

    return { transaction: updated, changed: true };
  }

  function resendWebhook(id) {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!txn || txn.status !== 'paid') return null;
    logger.info(`[admin] kirim ulang webhook untuk ${id}`);
    webhookSender.send(txn, { event: 'transaction.paid' }).catch((err) =>
      logger.error(`[webhook] error resend tidak terduga: ${err.message}`)
    );
    return txn;
  }

  return {
    createTransaction,
    getTransaction,
    getQrBase64,
    handlePayhookNotification,
    getMerchantSaldo,
    getAdminIncomeSummary,
    getAdminDashboardStats,
    getMerchantDashboardStats,
    listTransactions,
    listOrphanPayments,
    forceExpire,
    refund,
    resendWebhook,
  };
}

module.exports = { createTransactionService };
