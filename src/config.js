'use strict';

require('dotenv').config();

const REQUIRED = [
  'MERCHANT_API_KEY',
  'MERCHANT_QRIS_STATIC',
  'MERCHANT_WEBHOOK_URL',
  'MERCHANT_WEBHOOK_SECRET',
  'PAYHOOK_TOKEN',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const port = Number(env.PORT) || 3000;

  return {
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    merchantApiKey: env.MERCHANT_API_KEY,
    merchantQrisStatic: env.MERCHANT_QRIS_STATIC,
    merchantWebhookUrl: env.MERCHANT_WEBHOOK_URL,
    merchantWebhookSecret: env.MERCHANT_WEBHOOK_SECRET,
    payhookToken: env.PAYHOOK_TOKEN,
    dbPath: env.DB_PATH || './data/gateway.db',
    qrisConvertUrl: env.QRIS_CONVERT_URL || 'https://qris.miraipedia.my.id/api/convert',
    qrisConvertTimeoutMs: Number(env.QRIS_CONVERT_TIMEOUT_MS) || 10000,
    maxAmount: Number(env.MAX_AMOUNT) || 9999999,
    defaultExpiryMinutes: Number(env.DEFAULT_EXPIRY_MINUTES) || 15,
    webhookRetryIntervalMs: Number(env.WEBHOOK_RETRY_INTERVAL_MS) || 30000,
    expirySweeperIntervalMs: Number(env.EXPIRY_SWEEPER_INTERVAL_MS) || 60000,
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS) || 10000,
    webhookMaxAttempts: Number(env.WEBHOOK_MAX_ATTEMPTS) || 5,
  };
}

module.exports = { loadConfig };
