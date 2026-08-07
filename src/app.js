'use strict';

const express = require('express');
const { createTransactionService } = require('./services/transactionService');
const { createUniqueAmount } = require('./services/uniqueAmount');
const { createQrisConverter } = require('./services/qrisConverter');
const { createWebhookSender } = require('./services/webhookSender');
const { createMerchantRouter } = require('./routes/merchant');
const { createInternalRouter } = require('./routes/internal');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp({ db, config }) {
  const uniqueAmount = createUniqueAmount(db);
  const qrisConverter = createQrisConverter(config);
  const webhookSender = createWebhookSender(db, config);
  const transactionService = createTransactionService(db, config, uniqueAmount, qrisConverter, webhookSender);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // QR image publik (tanpa auth, agar bisa tampil di <img> frontend merchant)
  app.get('/v1/transactions/:id/qr.png', (req, res) => {
    const qrBase64 = transactionService.getQrBase64(req.params.id);
    if (!qrBase64) {
      return res.status(404).json({ error: { code: 'not_found', message: 'QR tidak ditemukan' } });
    }
    const buffer = Buffer.from(qrBase64, 'base64');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buffer);
  });

  app.use('/v1', createMerchantRouter({ config, transactionService }));
  app.use('/internal', createInternalRouter({ config, transactionService }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, transactionService, webhookSender };
}

module.exports = { createApp };
