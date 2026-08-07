'use strict';

const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Endpoint tidak ditemukan' } });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }

  // Body JSON tidak valid (express.json)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Body bukan JSON yang valid' } });
  }

  // Error body-parser/http-errors lainnya (mis. payload terlalu besar → 413)
  if (err.expose && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    const code = err.type === 'entity.too.large' ? 'payload_too_large' : 'bad_request';
    return res.status(err.status).json({ error: { code, message: err.message } });
  }

  logger.error('[error] unhandled', err);
  return res.status(500).json({ error: { code: 'internal_error', message: 'Terjadi kesalahan internal' } });
}

module.exports = { notFoundHandler, errorHandler };
