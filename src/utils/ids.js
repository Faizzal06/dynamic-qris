'use strict';

const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { generateId };
