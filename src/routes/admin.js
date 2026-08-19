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

function createAdminRouter({ db, config, merchantService, userService, transactionService, qrisAccountService, payhookAppService }) {
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
    res.json({
      merchant: toMerchantResponse(merchant),
      user: user ? { id: user.id, username: user.username } : null,
      active_qris: qrisAccountService.getActiveForMerchant(merchant.id),
      active_payhook: payhookAppService.getActiveForMerchant(merchant.id),
    });
  });

  router.post('/merchants', async (req, res, next) => {
    try {
      const { name, webhook_url, webhook_secret, username, password } = req.body || {};
      const merchant = merchantService.createMerchant({
        name,
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
      const { name, webhook_url, webhook_secret, status } = req.body || {};
      const fields = {};
      if (name !== undefined) fields.name = name;
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

  // ===== Pool QRIS (admin) & pengajuan merchant =====

  router.get('/qris-accounts', (req, res) => {
    const list = qrisAccountService.listAll().map((q) => ({
      ...q,
      owner_name: q.owner_type === 'merchant' && q.merchant_id ? (merchantService.getMerchant(q.merchant_id) || {}).name || null : null,
    }));
    res.json({ data: list });
  });

  router.post('/qris-accounts', (req, res, next) => {
    try {
      const { name, qris_static } = req.body || {};
      const account = qrisAccountService.createQrisAccount({ name, qris_static, owner_type: 'admin' });
      res.status(201).json({ qris_account: account });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/qris-accounts/:id', (req, res, next) => {
    try {
      const { name, qris_static, status } = req.body || {};
      const fields = {};
      if (name !== undefined) fields.name = name;
      if (qris_static !== undefined) fields.qris_static = qris_static;
      if (status !== undefined) fields.status = status;

      const account = qrisAccountService.updateQrisAccount(req.params.id, fields);
      if (!account) return res.status(404).json({ error: { code: 'not_found', message: 'QRIS tidak ditemukan' } });
      res.json({ qris_account: account });
    } catch (err) {
      next(err);
    }
  });

  router.post('/qris-accounts/:id/approve', (req, res, next) => {
    try {
      const account = qrisAccountService.approve(req.params.id);
      if (!account) return res.status(404).json({ error: { code: 'not_found', message: 'QRIS tidak ditemukan' } });
      res.json({ qris_account: account });
    } catch (err) {
      next(err);
    }
  });

  router.post('/qris-accounts/:id/reject', (req, res, next) => {
    try {
      const account = qrisAccountService.reject(req.params.id);
      if (!account) return res.status(404).json({ error: { code: 'not_found', message: 'QRIS tidak ditemukan' } });
      res.json({ qris_account: account });
    } catch (err) {
      next(err);
    }
  });

  // ===== Pool PayHook (admin) & pengajuan merchant =====

  router.get('/payhook-apps', (req, res) => {
    const list = payhookAppService.listAll().map((p) => ({
      ...p,
      owner_name: p.owner_type === 'merchant' && p.merchant_id ? (merchantService.getMerchant(p.merchant_id) || {}).name || null : null,
    }));
    res.json({ data: list });
  });

  router.post('/payhook-apps', (req, res, next) => {
    try {
      const { name } = req.body || {};
      const app = payhookAppService.createPayhookApp({ name, owner_type: 'admin' });
      res.status(201).json({ payhook_app: app });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/payhook-apps/:id', (req, res, next) => {
    try {
      const { name, status } = req.body || {};
      const fields = {};
      if (name !== undefined) fields.name = name;
      if (status !== undefined) fields.status = status;

      const app = payhookAppService.updatePayhookApp(req.params.id, fields);
      if (!app) return res.status(404).json({ error: { code: 'not_found', message: 'PayHook tidak ditemukan' } });
      res.json({ payhook_app: app });
    } catch (err) {
      next(err);
    }
  });

  router.post('/payhook-apps/:id/rotate-token', (req, res) => {
    const app = payhookAppService.rotateToken(req.params.id);
    if (!app) return res.status(404).json({ error: { code: 'not_found', message: 'PayHook tidak ditemukan' } });
    res.json({ payhook_app: app });
  });

  router.post('/payhook-apps/:id/approve', (req, res, next) => {
    try {
      const app = payhookAppService.approve(req.params.id);
      if (!app) return res.status(404).json({ error: { code: 'not_found', message: 'PayHook tidak ditemukan' } });
      res.json({ payhook_app: app });
    } catch (err) {
      next(err);
    }
  });

  router.post('/payhook-apps/:id/reject', (req, res, next) => {
    try {
      const app = payhookAppService.reject(req.params.id);
      if (!app) return res.status(404).json({ error: { code: 'not_found', message: 'PayHook tidak ditemukan' } });
      res.json({ payhook_app: app });
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

  router.post('/transactions/:id/mark-paid', (req, res) => {
    const result = transactionService.markPaid(req.params.id);
    if (!result) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    res.json({ transaction: toTxnResponse(result.transaction), changed: result.changed });
  });

  router.post('/transactions/:id/mark-failed', (req, res) => {
    const result = transactionService.markFailed(req.params.id);
    if (!result) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    res.json({ transaction: toTxnResponse(result.transaction), changed: result.changed });
  });

  router.post('/transactions/:id/reopen', (req, res) => {
    const result = transactionService.reopen(req.params.id);
    if (!result) return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    res.json({ transaction: toTxnResponse(result.transaction), changed: result.changed });
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
