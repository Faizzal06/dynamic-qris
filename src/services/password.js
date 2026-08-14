'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// Parameter scrypt (N=2^15, ~32MB memory) — cukup kuat & ringan untuk shared hosting
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
// Batas memori scrypt; perlu dinaikkan dari default Node (32MB) karena 128*N*r = 32MB
const MAXMEM = 64 * 1024 * 1024;

/**
 * Hash password dengan scrypt + salt acak.
 * Format tersimpan: scrypt$N$r$p$salt_base64$hash_base64
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifikasi password terhadap hash tersimpan (timing-safe).
 * Parameter N/r/p dibaca dari hash agar format bisa di-upgrade di masa depan.
 */
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(String(password), salt, expected.length, { N, r, p, maxmem: MAXMEM });
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
