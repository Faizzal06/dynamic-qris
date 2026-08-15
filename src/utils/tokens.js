'use strict';

const crypto = require('crypto');

/** Generate token acak dengan prefix (mis. sk_live_, ph_, whsec_). */
function randomKey(prefix) {
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

module.exports = { randomKey };
