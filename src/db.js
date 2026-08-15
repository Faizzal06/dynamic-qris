'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  api_key        TEXT NOT NULL UNIQUE,
  webhook_url    TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT,
  role          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Akun QRIS: milik admin (pool bersama) atau milik merchant (butuh approval admin).
-- status: admin -> 'active' | 'suspended'; merchant -> 'pending' | 'active' | 'rejected' | 'suspended'
CREATE TABLE IF NOT EXISTS qris_accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  qris_static TEXT NOT NULL,
  owner_type  TEXT NOT NULL DEFAULT 'admin',
  merchant_id TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Aplikasi PayHook: milik admin (pool bersama) atau milik merchant (butuh approval admin).
CREATE TABLE IF NOT EXISTS payhook_apps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  owner_type  TEXT NOT NULL DEFAULT 'admin',
  merchant_id TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Pemakaian QRIS oleh merchant (satu aktif per merchant, bisa ganti-ganti).
CREATE TABLE IF NOT EXISTS merchant_qris (
  merchant_id     TEXT NOT NULL,
  qris_account_id TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (merchant_id, qris_account_id)
);

-- Pemakaian aplikasi PayHook oleh merchant (satu aktif per merchant, bisa ganti-ganti).
CREATE TABLE IF NOT EXISTS merchant_payhook (
  merchant_id    TEXT NOT NULL,
  payhook_app_id TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payhook_app_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL,
  qris_account_id       TEXT,
  ref_id                TEXT NOT NULL,
  requested_amount      INTEGER NOT NULL,
  actual_amount         INTEGER NOT NULL,
  qr_string             TEXT NOT NULL,
  qr_base64             TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  callback_url          TEXT,
  metadata              TEXT,
  paid_at               TEXT,
  paid_source           TEXT,
  paid_reference        TEXT,
  payhook_event_id      TEXT UNIQUE,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  webhook_status        TEXT NOT NULL DEFAULT 'pending',
  webhook_attempts      INTEGER NOT NULL DEFAULT 0,
  webhook_next_retry_at TEXT,
  webhook_last_error    TEXT,
  refunded_at           TEXT,
  -- Kredit saldo merchant & fee admin (kode unik). Di-set saat transaksi dibayar,
  -- di-snapshot dari pemilik QRIS saat itu (admin vs milik merchant).
  merchant_credit       INTEGER NOT NULL DEFAULT 0,
  admin_fee             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_txn_status_amount ON transactions (status, actual_amount);
CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions (merchant_id);
CREATE INDEX IF NOT EXISTS idx_txn_qris_account ON transactions (qris_account_id);

CREATE TABLE IF NOT EXISTS orphan_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id     TEXT,
  qris_account_id TEXT,
  event_id        TEXT UNIQUE NOT NULL,
  amount          INTEGER NOT NULL,
  source          TEXT,
  reference       TEXT,
  received_at     TEXT NOT NULL,
  note            TEXT
);
`;

/**
 * Deteksi skema lama (v1: qris_static/payhook_token menempel di tabel merchants)
 * dan HAPUS semua data. Skema v2 tidak kompatibel dengan v1; sesuai keputusan
 * desain, data lama dibuang lalu dibuat ulang dari nol.
 */
function wipeLegacy(db) {
  const mCols = new Set(db.prepare('PRAGMA table_info(merchants)').all().map((c) => c.name));
  const isLegacy = mCols.has('qris_static') || mCols.has('payhook_token');
  if (isLegacy) {
    db.exec(`
      DROP TABLE IF EXISTS transactions;
      DROP TABLE IF EXISTS orphan_payments;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS merchants;
      DROP TABLE IF EXISTS merchant_qris;
      DROP TABLE IF EXISTS merchant_payhook;
      DROP TABLE IF EXISTS payhook_apps;
      DROP TABLE IF EXISTS qris_accounts;
    `);
  }
  return isLegacy;
}

/** Index tambahan (dibuat setelah skema selesai, aman untuk DB baru). */
function createIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_merchant_ref ON transactions (merchant_id, ref_id);
    CREATE INDEX IF NOT EXISTS idx_txn_merchant_status_amount ON transactions (merchant_id, status, actual_amount);
    CREATE INDEX IF NOT EXISTS idx_txn_merchant_status_credit ON transactions (merchant_id, status, merchant_credit);
    CREATE INDEX IF NOT EXISTS idx_orphan_merchant ON orphan_payments (merchant_id);
  `);
}

/**
 * Migrasi idempoten untuk DB lama (skema v2 dibuat sebelum kolom merchant_credit/admin_fee ada).
 * Tambahkan kolom bila belum ada, lalu backfill transaksi paid lama berdasarkan pemilik QRIS saat itu.
 */
function migrateV2Columns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name));
  if (!cols.has('merchant_credit')) {
    db.exec('ALTER TABLE transactions ADD COLUMN merchant_credit INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('admin_fee')) {
    db.exec('ALTER TABLE transactions ADD COLUMN admin_fee INTEGER NOT NULL DEFAULT 0');
  }

  // Backfill transaksi paid lama yang belum punya nilai kredit/fee
  const rows = db
    .prepare(
      "SELECT id, qris_account_id, requested_amount, actual_amount FROM transactions WHERE status = 'paid' AND merchant_credit = 0 AND admin_fee = 0"
    )
    .all();
  const getOwner = db.prepare('SELECT owner_type FROM qris_accounts WHERE id = ?');
  const update = db.prepare('UPDATE transactions SET merchant_credit = ?, admin_fee = ? WHERE id = ?');
  const backfill = db.transaction(() => {
    for (const t of rows) {
      const qris = t.qris_account_id ? getOwner.get(t.qris_account_id) : null;
      const isAdminQris = !!qris && qris.owner_type === 'admin';
      update.run(
        isAdminQris ? t.requested_amount : t.actual_amount,
        isAdminQris ? t.actual_amount - t.requested_amount : 0,
        t.id
      );
    }
  });
  backfill();
}

function openDatabase(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');
  // Wipe data legacy DULU, baru eksekusi skema baru (skema v2 pakai kolom baru
  // yang tidak ada di tabel lama — eksekusi skema lebih dulu akan gagal).
  wipeLegacy(db);
  db.exec(SCHEMA);
  createIndexes(db);
  migrateV2Columns(db);
  return db;
}

module.exports = { openDatabase, migrateV2Columns };
