'use strict';

const { hmacSha256Hex } = require('../utils/crypto');
const { safeParseJson } = require('../utils/serializers');
const logger = require('../utils/logger');

const BACKOFF_MINUTES = [1, 5, 30, 120]; // 1m, 5m, 30m, 2j

function createWebhookSender(db, config) {
  function getMerchant(merchantId) {
    return db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchantId);
  }

  function buildPayload(txn, event) {
    const base = {
      id: txn.id,
      ref_id: txn.ref_id,
      actual_amount: txn.actual_amount,
      metadata: safeParseJson(txn.metadata),
    };
    if (event === 'transaction.refunded') {
      return {
        event: 'transaction.refunded',
        ...base,
        status: 'refunded',
        refunded_at: txn.refunded_at,
      };
    }
    return {
      event: 'transaction.paid',
      ...base,
      status: 'paid',
      paid_at: txn.paid_at,
    };
  }

  function sign(rawBody, secret) {
    return `sha256=${hmacSha256Hex(rawBody, secret)}`;
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

  /**
   * Kirim webhook ke merchant.
   * @param {object} txn transaksi (harus punya merchant_id)
   * @param {{event?: 'transaction.paid'|'transaction.refunded'}} [opts]
   */
  async function send(txn, opts = {}) {
    const merchant = getMerchant(txn.merchant_id);
    if (!merchant) {
      const errorMsg = 'merchant not found';
      logger.error(`[webhook] merchant ${txn.merchant_id} tidak ditemukan untuk txn ${txn.id}`);
      return updateAfterAttempt(txn, txn.webhook_attempts + 1, false, errorMsg);
    }

    const event = opts.event || 'transaction.paid';
    const callbackUrl = txn.callback_url || merchant.webhook_url;
    const payload = buildPayload(txn, event);
    const rawBody = JSON.stringify(payload);
    const attempts = txn.webhook_attempts + 1;

    let res;
    try {
      res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': sign(rawBody, merchant.webhook_secret),
          'X-Event': event,
        },
        body: rawBody,
        signal: AbortSignal.timeout(config.webhookTimeoutMs),
      });
    } catch (err) {
      const errorMsg = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message;
      logger.warn(`[webhook] attempt ${attempts} gagal untuk ${txn.id} (${event}): ${errorMsg}`);
      return updateAfterAttempt(txn, attempts, false, errorMsg);
    }

    if (res.ok) {
      logger.info(`[webhook] terkirim untuk ${txn.id} (${event}, attempt ${attempts})`);
      // drain body agar koneksi bisa dipakai ulang
      await res.text().catch(() => {});
      return updateAfterAttempt(txn, attempts, true, null);
    }

    const errorMsg = `HTTP ${res.status}`;
    logger.warn(`[webhook] attempt ${attempts} gagal untuk ${txn.id} (${event}): ${errorMsg}`);
    await res.text().catch(() => {});
    return updateAfterAttempt(txn, attempts, false, errorMsg);
  }

  /**
   * Kirim webhook uji (event `webhook.test`) — tidak menyentuh tabel transactions.
   * Dipakai merchant untuk memverifikasi URL & signature webhook setelah diubah/di-rotate.
   * @param {object} merchant merchant aktif (punya webhook_url & webhook_secret)
   * @param {{event?: string, reason?: string}} [opts]
   * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
   */
  async function sendTest(merchant, opts = {}) {
    const callbackUrl = merchant.webhook_url;
    if (!callbackUrl) {
      return { ok: false, error: 'webhook_url kosong' };
    }
    const event = opts.event || 'webhook.test';
    const payload = {
      event,
      test: true,
      merchant_id: merchant.id,
      merchant_name: merchant.name,
      reason: opts.reason || 'konfigurasi webhook diubah',
      sent_at: new Date().toISOString(),
    };
    const rawBody = JSON.stringify(payload);

    let res;
    try {
      res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': sign(rawBody, merchant.webhook_secret),
          'X-Event': event,
        },
        body: rawBody,
        signal: AbortSignal.timeout(config.webhookTimeoutMs),
      });
    } catch (err) {
      const errorMsg = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message;
      logger.warn(`[webhook-test] gagal ke ${callbackUrl}: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }
    await res.text().catch(() => {});
    if (res.ok) {
      logger.info(`[webhook-test] terkirim ke ${callbackUrl} (${event})`);
      return { ok: true, status: res.status };
    }
    logger.warn(`[webhook-test] gagal ke ${callbackUrl}: HTTP ${res.status}`);
    return { ok: false, error: `HTTP ${res.status}` };
  }

  return { send, sendTest, sign, buildPayload };
}

module.exports = { createWebhookSender };
