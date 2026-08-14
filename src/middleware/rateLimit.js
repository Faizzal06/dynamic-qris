'use strict';

/**
 * Rate limiter in-memory (sliding window).
 * Catatan: per-proses; cukup untuk 1 instance / Pterodactyl / shared hosting.
 */
function createRateLimiter({ max, windowMs }) {
  const hits = new Map();

  return {
    /** @returns {boolean} true jika request diizinkan */
    allow(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createRateLimiter };
