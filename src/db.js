'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  api_key        TEXT NOT NULL UNIQUE,
  qris_static    TEXT NOT NULL,
  webhook_url    TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  payhook_token  TEXT NOT NULL UNIQUE,
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

CREATE TABLE IF NOT EXISTS transactions (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL,
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
  refunded_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_txn_status_amount ON transactions (status, actual_amount);

CREATE TABLE IF NOT EXISTS orphan_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT,
  event_id    TEXT UNIQUE NOT NULL,
  amount      INTEGER NOT NULL,
  source      TEXT,
  reference   TEXT,
  received_at TEXT NOT NULL,
  note        TEXT
);
`;

/**
 * Migrasi idempoten untuk database lama (single-merchant) -> multi-tenant.
 * Dipanggil setelah SCHEMA dieksekusi, sehingga kolom/index merchant baru
 * dibuat dengan aman baik untuk DB baru maupun DB lama.
 */
function migrate(db) {
  const txCols = new Set(db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name));
  if (!txCols.has('merchant_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN merchant_id TEXT');
  }
  if (!txCols.has('refunded_at')) {
    db.exec('ALTER TABLE transactions ADD COLUMN refunded_at TEXT');
  }

  const orCols = new Set(db.prepare('PRAGMA table_info(orphan_payments)').all().map((c) => c.name));
  if (!orCols.has('merchant_id')) {
    db.exec('ALTER TABLE orphan_payments ADD COLUMN merchant_id TEXT');
  }

  // Index legacy diganti: ref_id unik global -> unik per merchant
  db.exec('DROP INDEX IF EXISTS idx_txn_ref_id_unique');
  db.exec('DROP INDEX IF EXISTS idx_txn_external');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_merchant_ref ON transactions (merchant_id, ref_id);
    CREATE INDEX IF NOT EXISTS idx_txn_merchant_status_amount ON transactions (merchant_id, status, actual_amount);
    CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions (merchant_id);
    CREATE INDEX IF NOT EXISTS idx_orphan_merchant ON orphan_payments (merchant_id);
  `);
}

function openDatabase(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDatabase };
