'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const logger = require('../utils/logger');

const MIN_WITHDRAW_AMOUNT = 10000;
const STATUSES = ['pending', 'paid', 'rejected'];
// pending + paid mengunci saldo (rejected tidak, karena dana tidak keluar)
const LOCKING_STATUSES = ['pending', 'paid'];

function createWithdrawalService(db) {
  function serialize(row) {
    if (!row) return null;
    return { ...row };
  }

  function requireText(value, field, label) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ApiError(400, `invalid_${field}`, `${label} wajib diisi.`);
    }
    return value.trim();
  }

  /**
   * Saldo tersedia merchant = total kredit transaksi paid
   * dikurangi withdraw yang masih mengunci (pending + paid).
   */
  function getBalance(merchantId) {
    const credit = db
      .prepare(
        `SELECT COALESCE(SUM(merchant_credit), 0) AS total
         FROM transactions WHERE merchant_id = ? AND status = 'paid'`
      )
      .get(merchantId).total;

    const locked = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM withdrawals WHERE merchant_id = ? AND status IN ('pending', 'paid')`
      )
      .get(merchantId).total;

    return { total_credit: credit, locked, available: credit - locked };
  }

  /** Ajukan withdraw baru (merchant). Saldo terkuunci saat status pending. */
  function requestWithdrawal(merchant, input) {
    if (!merchant || merchant.status !== 'active') {
      throw new ApiError(403, 'merchant_inactive', 'Merchant tidak aktif, tidak bisa mengajukan withdraw.');
    }
    if (!input || typeof input !== 'object') {
      throw new ApiError(400, 'invalid_body', 'Request body tidak valid');
    }

    const { amount } = input;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(400, 'invalid_amount', 'Nominal harus angka bulat positif (tanpa titik/desimal).');
    }
    if (amount < MIN_WITHDRAW_AMOUNT) {
      throw new ApiError(400, 'amount_too_small', `Minimal withdraw Rp ${MIN_WITHDRAW_AMOUNT.toLocaleString('id-ID')}.`);
    }

    const bankName = requireText(input.bank_name, 'bank_name', 'Nama bank');
    const accountNumber = requireText(input.account_number, 'account_number', 'Nomor rekening');
    const accountName = requireText(input.account_name, 'account_name', 'Nama pemilik rekening');
    const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;

    const now = new Date().toISOString();
    const withdrawal = {
      id: generateId('wth'),
      merchant_id: merchant.id,
      amount,
      bank_name: bankName,
      account_number: accountNumber,
      account_name: accountName,
      note,
      status: 'pending',
      admin_note: null,
      requested_at: now,
      decided_at: null,
      created_at: now,
      updated_at: now,
    };

    // Cek + insert dalam satu transaksi supaya dua request bersamaan tidak bisa melebihi saldo.
    const create = db.transaction(() => {
      const { available } = getBalance(merchant.id);
      if (amount > available) {
        throw new ApiError(
          400,
          'insufficient_balance',
          `Saldo tidak cukup. Tersedia Rp ${available.toLocaleString('id-ID')}.`
        );
      }
      db.prepare(
        `INSERT INTO withdrawals (
           id, merchant_id, amount, bank_name, account_number, account_name,
           note, status, admin_note, requested_at, decided_at, created_at, updated_at
         ) VALUES (
           @id, @merchant_id, @amount, @bank_name, @account_number, @account_name,
           @note, @status, @admin_note, @requested_at, @decided_at, @created_at, @updated_at
         )`
      ).run(withdrawal);
      return withdrawal;
    });

    const created = create();
    logger.info(`[withdraw] diajukan ${created.id} merchant=${merchant.id} amount=${amount}`);
    return created;
  }

  function getWithdrawal(id) {
    return serialize(db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id));
  }

  /** List withdraw dengan paginasi + join nama merchant (kosongkan merchant_id = semua). */
  function listWithdrawals({ merchantId, status, page = 1, limit = 25 } = {}) {
    const where = [];
    const params = [];
    if (merchantId) {
      where.push('w.merchant_id = ?');
      params.push(merchantId);
    }
    if (status) {
      if (!STATUSES.includes(status)) {
        throw new ApiError(400, 'invalid_status', `status harus salah satu dari: ${STATUSES.join(', ')}`);
      }
      where.push('w.status = ?');
      params.push(status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM withdrawals w ${whereSql}`)
      .get(...params).c;
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const rows = db
      .prepare(
        `SELECT w.*, m.name AS merchant_name
         FROM withdrawals w
         LEFT JOIN merchants m ON m.id = w.merchant_id
         ${whereSql}
         ORDER BY w.requested_at DESC, w.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, offset);

    return {
      data: rows.map(serialize),
      total,
      page: safePage,
      limit: safeLimit,
      total_pages: Math.max(Math.ceil(total / safeLimit), 1),
    };
  }

  /** Ringkasan per status untuk kartu admin. */
  function getSummary() {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total FROM withdrawals GROUP BY status')
      .all();
    const summary = { pending_count: 0, pending_amount: 0, paid_count: 0, paid_amount: 0, rejected_count: 0 };
    for (const r of rows) {
      if (r.status === 'pending') {
        summary.pending_count = r.c;
        summary.pending_amount = r.total;
      } else if (r.status === 'paid') {
        summary.paid_count = r.c;
        summary.paid_amount = r.total;
      } else if (r.status === 'rejected') {
        summary.rejected_count = r.c;
      }
    }
    return summary;
  }

  /**
   * Admin menandai withdraw sudah ditransfer manual (status pending -> paid).
   * pending + paid sama-sama mengunci saldo, jadi saldo tersedia tidak berubah di sini.
   */
  function markPaid(id, adminNote = null) {
    return decide(id, 'paid', adminNote);
  }

  /** Admin menolak pengajuan (pending -> rejected), saldo kembali tersedia. */
  function reject(id, adminNote = null) {
    return decide(id, 'rejected', adminNote);
  }

  function decide(id, nextStatus, adminNote) {
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'not_found', 'Pengajuan withdraw tidak ditemukan.');
    if (row.status !== 'pending') {
      throw new ApiError(
        409,
        'already_decided',
        `Pengajuan ini sudah berstatus ${row.status}, tidak bisa diubah lagi.`
      );
    }

    const now = new Date().toISOString();
    const note = typeof adminNote === 'string' && adminNote.trim() !== '' ? adminNote.trim() : null;
    db.prepare('UPDATE withdrawals SET status = ?, admin_note = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(
      nextStatus,
      note,
      now,
      now,
      id
    );

    const updated = { ...row, status: nextStatus, admin_note: note, decided_at: now, updated_at: now };
    logger.info(
      `[withdraw] ${nextStatus} ${id} merchant=${row.merchant_id} amount=${row.amount}${note ? ` note="${note}"` : ''}`
    );
    return updated;
  }

  return {
    getBalance,
    requestWithdrawal,
    getWithdrawal,
    listWithdrawals,
    getSummary,
    markPaid,
    reject,
    MIN_WITHDRAW_AMOUNT,
  };
}

module.exports = { createWithdrawalService, MIN_WITHDRAW_AMOUNT };
