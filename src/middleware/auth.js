'use strict';

function extractBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/** Auth untuk Merchant API (/v1). Token = api_key merchant. */
function requireApiKey(db) {
  return (req, res, next) => {
    const token = extractBearer(req);
    const merchant = token
      ? db.prepare('SELECT * FROM merchants WHERE api_key = ?').get(token)
      : null;
    if (!merchant || merchant.status !== 'active') {
      return res.status(401).json({
        error: { code: 'unauthorized', message: 'API key tidak valid' },
      });
    }
    req.merchant = merchant;
    return next();
  };
}

/** Auth untuk Internal API (/internal). Token = payhook_token merchant. */
function requirePayhookToken(db) {
  return (req, res, next) => {
    const token = extractBearer(req);
    const merchant = token
      ? db.prepare('SELECT * FROM merchants WHERE payhook_token = ?').get(token)
      : null;
    if (!merchant || merchant.status !== 'active') {
      return res.status(401).json({
        error: { code: 'unauthorized', message: 'PayHook token tidak valid' },
      });
    }
    req.merchant = merchant;
    return next();
  };
}

module.exports = { requireApiKey, requirePayhookToken, extractBearer };
