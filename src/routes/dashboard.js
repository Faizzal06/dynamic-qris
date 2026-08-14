'use strict';

const express = require('express');
const { requireSession } = require('../middleware/session');
const { safeParseJson } = require('../utils/serializers');

function createDashboardRouter({ db, config, merchantService, userService, transactionService }) {
  const router = express.Router();
  router.use(requireSession(db, 'merchant'));

  // Ambil merchant dari user session
  function currentMerchant(req) {
    return merchantService.getMerchant(req.user.merchant_id);
  }

  // GET /dashboard/api/me
  router.get('/me', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    }
    res.json({
      merchant: {
        id: merchant.id,
        name: merchant.name,
        api_key: merchant.api_key,
        payhook_token: merchant.payhook_token,
        webhook_url: merchant.webhook_url,
        qris_static: merchant.qris_static,
        status: merchant.status,
        created_at: merchant.created_at,
      },
      user: { username: req.user.username, role: req.user.role },
    });
  });

  // GET /dashboard/api/transactions
  router.get('/transactions', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const result = transactionService.listTransactions({
      merchantId: merchant.id,
      status: req.query.status || undefined,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ ...result, data: result.data.map((t) => ({ ...t, metadata: safeParseJson(t.metadata) })) });
  });

  // GET /dashboard/api/orphans
  router.get('/orphans', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const result = transactionService.listOrphanPayments({
      merchantId: merchant.id,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(result);
  });

  // POST /dashboard/api/rotate-api-key
  router.post('/rotate-api-key', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const updated = merchantService.rotateApiKey(merchant.id);
    res.json({ api_key: updated.api_key });
  });

  // POST /dashboard/api/rotate-payhook-token
  router.post('/rotate-payhook-token', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const updated = merchantService.rotatePayhookToken(merchant.id);
    res.json({ payhook_token: updated.payhook_token });
  });

  // POST /dashboard/api/change-password
  router.post('/change-password', async (req, res, next) => {
    try {
      const { password } = req.body || {};
      await userService.changePassword(req.user.id, password);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDashboardRouter };
