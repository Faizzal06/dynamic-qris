'use strict';

const express = require('express');
const { requireBearer } = require('../middleware/auth');
const logger = require('../utils/logger');

function createInternalRouter({ config, transactionService }) {
  const router = express.Router();
  router.use(requireBearer(config.payhookToken));

  // POST /internal/webhook/payhook — selalu balas 200 agar PayHook tidak retry
  router.post('/webhook/payhook', (req, res) => {
    const { event_id, event_type, amount, source, reference } = req.body || {};

    // Hanya proses event pembayaran masuk
    if (event_type && event_type !== 'payment.incoming') {
      logger.info(`[payhook] event ${event_type} diabaikan`);
      return res.json({ status: 'ok', processed: false });
    }

    // Validasi minimal: event_id wajib, amount wajib (bisa number/string numerik)
    if (!event_id || amount === undefined || amount === null || amount === '') {
      logger.warn(`[payhook] body tidak valid: missing event_id/amount`);
      return res.json({ status: 'ok', processed: false });
    }

    const numericAmount = Number(amount);
    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      logger.warn(`[payhook] amount tidak valid: ${amount}`);
      return res.json({ status: 'ok', processed: false });
    }

    const result = transactionService.handlePayhookNotification({
      event_id: String(event_id),
      event_type,
      amount: numericAmount,
      source,
      reference,
    });

    res.json({ status: 'ok', processed: result.matched });
  });

  return router;
}

module.exports = { createInternalRouter };
