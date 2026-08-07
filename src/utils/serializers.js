'use strict';

function safeParseJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function toTransactionResponse(txn, config) {
  return {
    id: txn.id,
    ref_id: txn.ref_id,
    status: txn.status,
    requested_amount: txn.requested_amount,
    actual_amount: txn.actual_amount,
    qr_string: txn.qr_string,
    qr_image_url: `${config.baseUrl}/v1/transactions/${txn.id}/qr.png`,
    expires_at: txn.expires_at,
    paid_at: txn.paid_at || null,
    metadata: safeParseJson(txn.metadata),
  };
}

module.exports = { toTransactionResponse, safeParseJson };
