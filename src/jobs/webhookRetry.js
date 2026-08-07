'use strict';

const logger = require('../utils/logger');

function createWebhookRetry(db, config, webhookSender) {
  let timer = null;

  function run() {
    const now = new Date().toISOString();
    const due = db
      .prepare(
        `SELECT * FROM transactions
         WHERE status = 'paid' AND webhook_status = 'pending'
           AND webhook_next_retry_at IS NOT NULL AND webhook_next_retry_at <= ?`
      )
      .all(now);

    for (const txn of due) {
      logger.info(`[webhook-retry] retry webhook untuk ${txn.id}`);
      webhookSender.send(txn).catch((err) => logger.error(`[webhook-retry] error: ${err.message}`));
    }
  }

  return {
    start() {
      run();
      timer = setInterval(run, config.webhookRetryIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createWebhookRetry };
