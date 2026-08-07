'use strict';

const { ApiError } = require('../utils/errors');
const { hmacSha256Hex } = require('../utils/crypto');
const { safeParseJson } = require('../utils/serializers');
const logger = require('../utils/logger');

const BACKOFF_MINUTES = [1, 5, 30, 120]; // 1m, 5m, 30m, 2j

function createWebhookSender(db, config) {
  function buildPayload(txn) {
    return {
      event: 'transaction.paid',
      id: txn.id,
      ref_id: txn.ref_id,
      status: 'paid',
      actual_amount: txn.actual_amount,
      paid_at: txn.paid_at,
      metadata: safeParseJson(txn.metadata),
    };
  }

  function sign(rawBody) {
    return `sha256=${hmacSha256Hex(rawBody, config.merchantWebhookSecret)}`;
  }

  function updateAfterAttempt(txn, attempts, ok, errorMsg) {
    if (ok) {
      db.prepare(
        `UPDATE transactions
         SET webhook_status = 'sent', webhook_attempts = ?, webhook_next_retry_at = NULL, webhook_last_error = NULL
         WHERE id = ?`
      ).run(attempts, txn.id);
      return { ok: true };
    }

    let nextRetryAt = null;
    let status = 'failed';
    if (attempts < config.webhookMaxAttempts) {
      const delayMinutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      nextRetryAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
      status = 'pending';
    }

    db.prepare(
      `UPDATE transactions
       SET webhook_status = ?, webhook_attempts = ?, webhook_next_retry_at = ?, webhook_last_error = ?
       WHERE id = ?`
    ).run(status, attempts, nextRetryAt, errorMsg, txn.id);

    return { ok: false, retryAt: nextRetryAt };
  }

  async function send(txn) {
    const callbackUrl = txn.callback_url || config.merchantWebhookUrl;
    const payload = buildPayload(txn);
    const rawBody = JSON.stringify(payload);
    const attempts = txn.webhook_attempts + 1;

    let res;
    try {
      res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': sign(rawBody),
          'X-Event': 'transaction.paid',
        },
        body: rawBody,
        signal: AbortSignal.timeout(config.webhookTimeoutMs),
      });
    } catch (err) {
      const errorMsg = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message;
      logger.warn(`[webhook] attempt ${attempts} gagal untuk ${txn.id}: ${errorMsg}`);
      return updateAfterAttempt(txn, attempts, false, errorMsg);
    }

    if (res.ok) {
      logger.info(`[webhook] terkirim untuk ${txn.id} (attempt ${attempts})`);
      // drain body agar koneksi bisa dipakai ulang
      await res.text().catch(() => {});
      return updateAfterAttempt(txn, attempts, true, null);
    }

    const errorMsg = `HTTP ${res.status}`;
    logger.warn(`[webhook] attempt ${attempts} gagal untuk ${txn.id}: ${errorMsg}`);
    await res.text().catch(() => {});
    return updateAfterAttempt(txn, attempts, false, errorMsg);
  }

  return { send, sign, buildPayload };
}

module.exports = { createWebhookSender };
