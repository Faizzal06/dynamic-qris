'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id                    TEXT PRIMARY KEY,
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
  webhook_last_error    TEXT
);

CREATE INDEX IF NOT EXISTS idx_txn_status_amount ON transactions (status, actual_amount);
CREATE INDEX IF NOT EXISTS idx_txn_external ON transactions (ref_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_ref_id_unique ON transactions (ref_id);

CREATE TABLE IF NOT EXISTS orphan_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT UNIQUE NOT NULL,
  amount      INTEGER NOT NULL,
  source      TEXT,
  reference   TEXT,
  received_at TEXT NOT NULL,
  note        TEXT
);
`;

function openDatabase(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase };
