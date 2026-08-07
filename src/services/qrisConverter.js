'use strict';

const { ApiError } = require('../utils/errors');

const DATA_URI_PREFIX = 'data:image/png;base64,';

function stripDataUriPrefix(base64) {
  if (typeof base64 !== 'string') return null;
  if (base64.startsWith('data:')) {
    const comma = base64.indexOf(',');
    return comma === -1 ? null : base64.slice(comma + 1);
  }
  return base64;
}

function createQrisConverter(config) {
  async function convert(qrisStatic, actualAmount) {
    let res;
    try {
      res = await fetch(config.qrisConvertUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: String(actualAmount), qris: qrisStatic }),
        signal: AbortSignal.timeout(config.qrisConvertTimeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ApiError(502, 'converter_timeout', 'QRIS converter timeout');
      }
      throw new ApiError(502, 'converter_unavailable', 'QRIS converter tidak dapat dijangkau');
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(502, 'converter_invalid_response', 'Respon QRIS converter tidak valid');
    }

    if (body.status !== 'success' || !body.data) {
      throw new ApiError(503, 'converter_error', body.message || 'Konversi QRIS gagal');
    }

    const qrBase64 = stripDataUriPrefix(body.data.qr_base64);
    if (!qrBase64) {
      throw new ApiError(503, 'converter_error', 'QR image tidak ditemukan pada respon converter');
    }

    return { qrString: body.data.qris_string, qrBase64 };
  }

  return { convert };
}

module.exports = { createQrisConverter, stripDataUriPrefix };
