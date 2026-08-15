'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { parseCookies } = require('../utils/cookies');
const { findSession } = require('../services/sessionService');

// Dokumentasi API versi Markdown (placeholder diisi nilai config saat request)
const API_DOCS_MD = fs.readFileSync(path.join(__dirname, '..', 'docs', 'api.md'), 'utf8');

function createPageRouter({ db, config, merchantService, qrisAccountService, payhookAppService, transactionService }) {
  const router = express.Router();

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    const session = findSession(db, token);
    if (!session) return null;
    return db.prepare('SELECT id, merchant_id, role, username FROM users WHERE id = ?').get(session.user_id) || null;
  }

  function homePath(user) {
    if (!user) return '/admin/login';
    return user.role === 'admin' ? '/admin' : '/dashboard';
  }

  function guard(role) {
    return (req, res, next) => {
      const user = currentUser(req);
      if (!user) return res.redirect('/admin/login');
      if (role && user.role !== role) return res.redirect(homePath(user));
      req.user = user;
      return next();
    };
  }

  router.get('/', (req, res) => {
    res.redirect(homePath(currentUser(req)));
  });

  router.get('/admin/login', (req, res) => {
    const user = currentUser(req);
    if (user) return res.redirect(homePath(user));
    res.render('login', { title: 'Login — Gateway QRIS', error: req.query.error || null });
  });

  // ===== Dashboard Admin =====
  router.get('/admin', guard('admin'), (req, res) => {
    const merchantId = req.query.merchant_id || undefined;
    const status = req.query.status || undefined;

    const merchants = merchantService.listMerchants().map((m) => ({
      ...m,
      active_qris: qrisAccountService.getActiveForMerchant(m.id),
      active_payhook: payhookAppService.getActiveForMerchant(m.id),
    }));

    const withOwnerName = (item) => ({
      ...item,
      owner_name:
        item.owner_type === 'merchant' && item.merchant_id
          ? (merchantService.getMerchant(item.merchant_id) || {}).name || null
          : null,
    });

    const qrisAccounts = qrisAccountService.listAll().map(withOwnerName);
    const payhookApps = payhookAppService.listAll().map(withOwnerName);

    const txns = transactionService.listTransactions({
      merchantId,
      status,
      page: req.query.page,
      limit: req.query.limit,
    });
    const orphans = transactionService.listOrphanPayments({ page: req.query.page, limit: req.query.limit });
    const income = transactionService.getAdminIncomeSummary();
    const stats = transactionService.getAdminDashboardStats();
    const panels = ['dashboard', 'income', 'merchants', 'channels', 'transactions', 'orphans'];
    const activePanel = panels.includes(req.query.panel) ? req.query.panel : 'dashboard';

    res.render('admin', {
      title: 'Admin — Gateway QRIS',
      user: req.user,
      merchants,
      qrisAccounts,
      payhookApps,
      txns,
      orphans,
      income,
      stats,
      activePanel,
      filters: { merchantId: merchantId || '', status: status || '' },
    });
  });

  // ===== Dokumentasi API (publik) =====
  router.get('/docs', (req, res) => {
    res.render('docs', {
      title: 'Dokumentasi API — Gateway QRIS',
      user: currentUser(req),
      baseUrl: config.baseUrl,
      maxAmount: config.maxAmount,
      defaultExpiryMinutes: config.defaultExpiryMinutes,
    });
  });

  // Download dokumentasi API versi Markdown
  router.get('/docs.md', (req, res) => {
    const md = API_DOCS_MD.replaceAll('{{BASE_URL}}', config.baseUrl)
      .replaceAll('{{MAX_AMOUNT}}', config.maxAmount.toLocaleString('id-ID'))
      .replaceAll('{{DEFAULT_EXPIRY_MINUTES}}', String(config.defaultExpiryMinutes));
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="api-docs.md"');
    res.send(md);
  });

  // ===== Dashboard Merchant =====
  router.get('/dashboard', guard('merchant'), (req, res) => {
    const merchant = merchantService.getMerchant(req.user.merchant_id);
    if (!merchant) return res.redirect('/admin/login');

    const status = req.query.status || undefined;
    const qris = qrisAccountService.listForMerchant(merchant.id);
    const payhook = payhookAppService.listForMerchant(merchant.id);
    const txns = transactionService.listTransactions({
      merchantId: merchant.id,
      status,
      page: req.query.page,
      limit: req.query.limit,
    });
    const orphans = transactionService.listOrphanPayments({ merchantId: merchant.id, page: req.query.page, limit: req.query.limit });
    const saldo = transactionService.getMerchantSaldo(merchant.id);
    const stats = transactionService.getMerchantDashboardStats(merchant.id);
    const panels = ['dashboard', 'saldo', 'config', 'channels', 'transactions', 'orphans'];
    const activePanel = panels.includes(req.query.panel) ? req.query.panel : 'dashboard';

    res.render('merchant', {
      title: 'Dashboard — Gateway QRIS',
      user: req.user,
      merchant,
      qris,
      payhook,
      txns,
      orphans,
      saldo,
      stats,
      activePanel,
      filters: { status: status || '' },
    });
  });

  return router;
}

module.exports = { createPageRouter };
