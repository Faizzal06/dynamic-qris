'use strict';

const express = require('express');
const { requireSession } = require('../middleware/session');
const { safeParseJson } = require('../utils/serializers');

function toMerchantResponse(m) {
  return { ...m };
}

function toTxnResponse(t) {
  return { ...t, metadata: safeParseJson(t.metadata) };
}

function createAdminRouter({ db, config, merchantService, userService, transactionService }) {
  const router = express.Router();
  router.use(requireSession(db, 'admin'));

  // ===== Merchants =====

  router.get('/merchants', (req, res) => {
    res.json({ data: merchantService.listMerchants().map(toMerchantResponse) });
  });

  router.get('/merchants/:id', (req, res) => {
    const merchant = merchantService.getMerchant(req.params.id);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const user = userService.getUserByMerchant(merchant.id, 'merchant');
    res.json({ merchant: toMerchantResponse(merchant), user: user ? { id: user.id, username: user.username } : null });
  });

  router.post('/merchants', async (req, res, next) => {
    try {
      const { name, qris_static, webhook_url, webhook_secret, username, password } = req.body || {};
      const merchant = merchantService.createMerchant({
        name,
        qris_static,
        webhook_url,
        webhook_secret: webhook_secret || merchantService.generateWebhookSecret(),
      });

      let user = null;
      if (username || password) {
        user = await userService.createUser({
          merchant_id: merchant.id,
          role: 'merchant',
          username,
          password,
        });
      }

      res.status(201).json({ merchant: toMerchantResponse(merchant), user });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/merchants/:id', (req, res, next) => {
    try {
      const { name, qris_static, webhook_url, webhook_secret, status } = req.body || {};
      const fields = {};
      if (name !== undefined) fields.name = name;
      if (qris_static !== undefined) fields.qris_static = qris_static;
      if (webhook_url !== undefined) fields.webhook_url = webhook_url;
      if (webhook_secret !== undefined) fields.webhook_secret = webhook_secret;
      if (status !== undefined) fields.status = status;

      const merchant = merchantService.updateMerchant(req.params.id, fields);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      res.json({ merchant: toMerchantResponse(merchant) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/merchants/:id/status', (req, res, next) => {
    try {
      const { status } = req.body || {};
      const merchant = merchantService.setStatus(req.params.id, status);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      res.json({ merchant: toMerchantResponse(merchant) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/merchants/:id/rotate-api-key', (req, res) => {
    const merchant = merchantService.rotateApiKey(req.params.id);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    res.json({ merchant: toMerchantResponse(merchant) });
  });

  router.post('/merchants/:id/rotate-payhook-token', (req, res) => {
    const merchant = merchantService.rotatePayhookToken(req.params.id);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    res.json({ merchant: toMerchantResponse(merchant) });
  });

  router.post('/merchants/:id/reset-password', async (req, res, next) => {
    try {
      const { password } = req.body || {};
      const merchant = merchantService.getMerchant(req.params.id);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const user = await userService.resetPassword(merchant.id, password);
      if (!user) {
        return res.status(400).json({
          error: { code: 'no_user', message: 'Merchant ini belum punya user login dashboard. Buat lewat form create dengan username/password.' },
        });
      }
      res.json({ ok: true, user });
    } catch (err) {
      next(err);
    }
  });

  // ===== Transactions =====

  router.get('/transactions', (req, res) => {
    const result = transactionService.listTransactions({
      merchantId: req.query.merchant_id || undefined,
      status: req.query.status || undefined,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ ...result, data: result.data.map(toTxnResponse) });
  });

  router.get('/transactions/:id', (req, res) => {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!txn) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    const merchant = merchantService.getMerchant(txn.merchant_id);
    res.json({ transaction: toTxnResponse(txn), merchant: merchant ? toMerchantResponse(merchant) : null });
  });

  router.post('/transactions/:id/expire', (req, res) => {
    const result = transactionService.forceExpire(req.params.id);
    if (!result) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    res.json({ transaction: toTxnResponse(result.transaction), changed: result.changed });
  });

  router.post('/transactions/:id/refund', (req, res) => {
    const result = transactionService.refund(req.params.id);
    if (!result) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    res.json({ transaction: toTxnResponse(result.transaction), changed: result.changed });
  });

  router.post('/transactions/:id/resend-webhook', (req, res) => {
    const txn = transactionService.resendWebhook(req.params.id);
    if (!txn) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan atau bukan status paid' } });
    res.json({ transaction: toTxnResponse(txn), queued: true });
  });

  // ===== Orphan payments =====

  router.get('/orphans', (req, res) => {
    const result = transactionService.listOrphanPayments({
      merchantId: req.query.merchant_id || undefined,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(result);
  });

  return router;
}

module.exports = { createAdminRouter };
