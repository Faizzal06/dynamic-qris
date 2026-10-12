'use strict';

const express = require('express');
const { requireSession } = require('../middleware/session');
const { safeParseJson } = require('../utils/serializers');

function createDashboardRouter({ db, config, merchantService, userService, transactionService, qrisAccountService, payhookAppService, webhookSender, withdrawalService }) {
  const router = express.Router();
  router.use(requireSession(db, 'merchant'));

  // Ambil merchant dari user session
  function currentMerchant(req) {
    return merchantService.getMerchant(req.user.merchant_id);
  }

  function toMerchantMe(merchant, qris, payhook) {
    return {
      id: merchant.id,
      name: merchant.name,
      api_key: merchant.api_key,
      webhook_url: merchant.webhook_url,
      webhook_secret: merchant.webhook_secret,
      status: merchant.status,
      created_at: merchant.created_at,
      qris: qris
        ? { id: qris.id, name: qris.name, owner_type: qris.owner_type, status: qris.status }
        : null,
      payhook: payhook
        ? {
            id: payhook.id,
            name: payhook.name,
            owner_type: payhook.owner_type,
            status: payhook.status,
            // Token hanya ditampilkan bila aplikasi milik merchant sendiri (untuk konfigurasi PayHook Android)
            token: payhook.owner_type === 'merchant' ? payhook.token : undefined,
          }
        : null,
    };
  }

  // GET /dashboard/api/me
  router.get('/me', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    }
    res.json({
      merchant: toMerchantMe(
        merchant,
        qrisAccountService.getActiveForMerchant(merchant.id),
        payhookAppService.getActiveForMerchant(merchant.id)
      ),
      user: { username: req.user.username, role: req.user.role },
    });
  });

  // GET /dashboard/api/config — konfigurasi QRIS & PayHook lengkap
  router.get('/config', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    res.json({
      merchant: toMerchantMe(
        merchant,
        qrisAccountService.getActiveForMerchant(merchant.id),
        payhookAppService.getActiveForMerchant(merchant.id)
      ),
      qris: qrisAccountService.listForMerchant(merchant.id),
      payhook: payhookAppService.listForMerchant(merchant.id),
    });
  });

  // POST /dashboard/api/qris/select — pilih QRIS dari pool admin / milik sendiri yang sudah disetujui
  router.post('/qris/select', (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const { qris_account_id } = req.body || {};
      const account = qrisAccountService.selectForMerchant(merchant.id, qris_account_id);
      res.json({ qris_account: account });
    } catch (err) {
      next(err);
    }
  });

  // POST /dashboard/api/qris/request — ajukan QRIS milik sendiri (butuh persetujuan admin)
  router.post('/qris/request', (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const { name, qris_static } = req.body || {};
      const account = qrisAccountService.createQrisAccount({
        name,
        qris_static,
        owner_type: 'merchant',
        merchant_id: merchant.id,
      });
      res.status(201).json({ qris_account: account });
    } catch (err) {
      next(err);
    }
  });

  // POST /dashboard/api/payhook/select — pilih aplikasi PayHook dari pool admin / milik sendiri yang sudah disetujui
  router.post('/payhook/select', (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const { payhook_app_id } = req.body || {};
      const app = payhookAppService.selectForMerchant(merchant.id, payhook_app_id);
      res.json({ payhook_app: app });
    } catch (err) {
      next(err);
    }
  });

  // POST /dashboard/api/payhook/request — ajukan aplikasi PayHook milik sendiri (token di-generate server)
  router.post('/payhook/request', (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const { name } = req.body || {};
      const app = payhookAppService.createPayhookApp({
        name,
        owner_type: 'merchant',
        merchant_id: merchant.id,
      });
      res.status(201).json({ payhook_app: app });
    } catch (err) {
      next(err);
    }
  });

  // POST /dashboard/api/payhook/rotate-token — rotate token aplikasi PayHook milik sendiri yang aktif
  router.post('/payhook/rotate-token', (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const active = payhookAppService.getActiveForMerchant(merchant.id);
      if (!active || active.owner_type !== 'merchant') {
        return res.status(400).json({
          error: { code: 'not_own_payhook', message: 'Hanya aplikasi PayHook milik sendiri yang bisa di-rotate tokennya.' },
        });
      }
      const app = payhookAppService.rotateToken(active.id);
      res.json({ payhook_app: app });
    } catch (err) {
      next(err);
    }
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

  // ===== Withdraw =====

  // GET /dashboard/api/withdrawals — saldo tersedia + riwayat withdraw merchant ini
  router.get('/withdrawals', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const balance = withdrawalService.getBalance(merchant.id);
    const list = withdrawalService.listWithdrawals({
      merchantId: merchant.id,
      status: req.query.status || undefined,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ ...list, balance, min_amount: withdrawalService.MIN_WITHDRAW_AMOUNT });
  });

  // POST /dashboard/api/withdrawals — ajukan withdraw (diproses manual oleh admin)
  router.post('/withdrawals', (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const { amount, bank_name, account_number, account_name, note } = req.body || {};
      const withdrawal = withdrawalService.requestWithdrawal(merchant, {
        amount,
        bank_name,
        account_number,
        account_name,
        note,
      });
      res.status(201).json({ withdrawal, balance: withdrawalService.getBalance(merchant.id) });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /dashboard/api/webhook — ubah webhook URL merchant, lalu kirim webhook uji ke URL baru
  router.patch('/webhook', async (req, res, next) => {
    try {
      const merchant = currentMerchant(req);
      if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
      const { webhook_url } = req.body || {};
      if (typeof webhook_url !== 'string' || !/^https?:\/\/.+/i.test(webhook_url)) {
        return res.status(400).json({ error: { code: 'invalid_webhook_url', message: 'URL webhook tidak valid. Gunakan format lengkap, contoh: https://toko.com/webhook' } });
      }
      const updated = merchantService.updateMerchant(merchant.id, { webhook_url: webhook_url.trim() });
      const testWebhook = await webhookSender.sendTest(updated, { reason: 'webhook_url_changed' });
      res.json({ merchant: updated, test_webhook: testWebhook });
    } catch (err) {
      next(err);
    }
  });

  // POST /dashboard/api/rotate-webhook-secret — reset webhook secret sendiri, lalu kirim webhook uji dengan secret baru
  router.post('/rotate-webhook-secret', async (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const updated = merchantService.rotateWebhookSecret(merchant.id);
    const testWebhook = await webhookSender.sendTest(updated, { reason: 'webhook_secret_rotated' });
    res.json({ webhook_secret: updated.webhook_secret, test_webhook: testWebhook });
  });

  // POST /dashboard/api/rotate-api-key
  router.post('/rotate-api-key', (req, res) => {
    const merchant = currentMerchant(req);
    if (!merchant) return res.status(404).json({ error: { code: 'not_found', message: 'Merchant tidak ditemukan' } });
    const updated = merchantService.rotateApiKey(merchant.id);
    res.json({ api_key: updated.api_key });
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
