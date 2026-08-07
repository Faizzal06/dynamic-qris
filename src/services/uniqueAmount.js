'use strict';

const crypto = require('crypto');
const { ApiError } = require('../utils/errors');

const MAX_ATTEMPTS = 20;
const SUFFIX_MIN = 1;
const SUFFIX_MAX = 499;

function createUniqueAmount(db) {
  function isCollision(amount) {
    const now = new Date().toISOString();
    const row = db
      .prepare(
        `SELECT 1 FROM transactions
         WHERE status = 'pending' AND actual_amount = ? AND expires_at > ? LIMIT 1`
      )
      .get(amount, now);
    return Boolean(row);
  }

  function generate(requestedAmount) {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const suffix = crypto.randomInt(SUFFIX_MIN, SUFFIX_MAX + 1); // 1..499
      const candidate = requestedAmount + suffix;
      if (!isCollision(candidate)) return candidate;
    }
    throw new ApiError(503, 'unique_amount_exhausted', 'Gagal membuat nominal unik, coba lagi');
  }

  return { generate };
}

module.exports = { createUniqueAmount };
