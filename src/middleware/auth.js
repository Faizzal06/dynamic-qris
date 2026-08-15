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

/**
 * Auth untuk Internal API (/internal). Token = token aplikasi PayHook.
 * Satu aplikasi PayHook bisa dipakai banyak merchant (mis. pool admin),
 * jadi hanya menempelkan aplikasi ke req — matching transaksi dilakukan di service.
 */
function requirePayhookToken(db) {
  return (req, res, next) => {
    const token = extractBearer(req);
    const app = token ? db.prepare('SELECT * FROM payhook_apps WHERE token = ?').get(token) : null;
    if (!app || app.status !== 'active') {
      return res.status(401).json({
        error: { code: 'unauthorized', message: 'PayHook token tidak valid' },
      });
    }
    req.payhookApp = app;
    return next();
  };
}

module.exports = { requireApiKey, requirePayhookToken, extractBearer };
