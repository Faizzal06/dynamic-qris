'use strict';

const express = require('express');
const { requireBearer } = require('../middleware/auth');
const { toTransactionResponse } = require('../utils/serializers');

function createMerchantRouter({ config, transactionService }) {
  const router = express.Router();
  router.use(requireBearer(config.merchantApiKey));

  // POST /v1/transactions
  router.post('/transactions', async (req, res, next) => {
    try {
      const { transaction, created } = await transactionService.createTransaction(req.body);
      res.status(created ? 201 : 200).json(toTransactionResponse(transaction, config));
    } catch (err) {
      next(err);
    }
  });

  // GET /v1/transactions/:id
  router.get('/transactions/:id', (req, res) => {
    const txn = transactionService.getTransaction(req.params.id);
    if (!txn) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Transaksi tidak ditemukan' } });
    }
    res.json(toTransactionResponse(txn, config));
  });

  return router;
}

module.exports = { createMerchantRouter };
