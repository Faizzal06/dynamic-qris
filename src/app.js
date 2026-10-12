'use strict';

const path = require('path');
const express = require('express');
const { createTransactionService } = require('./services/transactionService');
const { createUniqueAmount } = require('./services/uniqueAmount');
const { createQrisConverter } = require('./services/qrisConverter');
const { createWebhookSender } = require('./services/webhookSender');
const { createMerchantService } = require('./services/merchantService');
const { createUserService } = require('./services/userService');
const { createQrisAccountService } = require('./services/qrisAccountService');
const { createPayhookAppService } = require('./services/payhookAppService');
const { createWithdrawalService } = require('./services/withdrawalService');
const { createMerchantRouter } = require('./routes/merchant');
const { createInternalRouter } = require('./routes/internal');
const { createAuthRouter } = require('./routes/auth');
const { createAdminRouter } = require('./routes/admin');
const { createDashboardRouter } = require('./routes/dashboard');
const { createPageRouter } = require('./routes/pages');
const { createRateLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp({ db, config }) {
  const uniqueAmount = createUniqueAmount(db);
  const qrisConverter = createQrisConverter(config);
  const webhookSender = createWebhookSender(db, config);
  const qrisAccountService = createQrisAccountService(db);
  const payhookAppService = createPayhookAppService(db);
  const transactionService = createTransactionService(db, config, uniqueAmount, qrisConverter, webhookSender, qrisAccountService);
  const merchantService = createMerchantService(db);
  const userService = createUserService(db);
  const withdrawalService = createWithdrawalService(db);
  const rateLimiter = createRateLimiter({
    max: config.loginRateLimitMax,
    windowMs: config.loginRateLimitWindowMs,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
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

  app.use('/v1', createMerchantRouter({ config, transactionService, db }));
  app.use('/internal', createInternalRouter({ transactionService, db }));

  // Session auth (login dashboard)
  app.use('/auth', createAuthRouter({ db, config, userService, rateLimiter }));

  // API admin & merchant dashboard
  app.use('/admin/api', createAdminRouter({ db, config, merchantService, userService, transactionService, qrisAccountService, payhookAppService, withdrawalService }));
  app.use('/dashboard/api', createDashboardRouter({ db, config, merchantService, userService, transactionService, qrisAccountService, payhookAppService, webhookSender, withdrawalService }));

  // Halaman EJS (login, dashboard admin & merchant) — dirender server-side
  app.use(
    createPageRouter({ db, config, merchantService, qrisAccountService, payhookAppService, transactionService, withdrawalService })
  );

  // Asset statis dashboard (style.css, dashboard.js, login.js)
  app.use('/admin', express.static(path.join(__dirname, 'admin'), { index: false }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    transactionService,
    webhookSender,
    merchantService,
    userService,
    qrisAccountService,
    payhookAppService,
    withdrawalService,
  };
}

module.exports = { createApp };
