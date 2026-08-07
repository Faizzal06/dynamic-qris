'use strict';

const crypto = require('crypto');

function hmacSha256Hex(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { hmacSha256Hex, timingSafeEqualStr };
