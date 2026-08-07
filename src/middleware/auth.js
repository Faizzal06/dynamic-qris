'use strict';

const { timingSafeEqualStr } = require('../utils/crypto');

function requireBearer(expectedToken) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token || !timingSafeEqualStr(token, expectedToken)) {
      return res.status(401).json({
        error: { code: 'unauthorized', message: 'API key tidak valid' },
      });
    }
    return next();
  };
}

module.exports = { requireBearer };
