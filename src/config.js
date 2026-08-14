'use strict';

require('dotenv').config();

function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 3000;

  return {
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    dbPath: env.DB_PATH || './data/gateway.db',
    qrisConvertUrl: env.QRIS_CONVERT_URL || 'https://qris.miraipedia.my.id/api/convert',
    qrisConvertTimeoutMs: Number(env.QRIS_CONVERT_TIMEOUT_MS) || 10000,
    maxAmount: Number(env.MAX_AMOUNT) || 9999999,
    defaultExpiryMinutes: Number(env.DEFAULT_EXPIRY_MINUTES) || 15,
    webhookRetryIntervalMs: Number(env.WEBHOOK_RETRY_INTERVAL_MS) || 30000,
    expirySweeperIntervalMs: Number(env.EXPIRY_SWEEPER_INTERVAL_MS) || 60000,
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS) || 10000,
    webhookMaxAttempts: Number(env.WEBHOOK_MAX_ATTEMPTS) || 5,

    // ===== Admin dashboard =====
    adminUsername: env.ADMIN_USERNAME || null,
    adminPassword: env.ADMIN_PASSWORD || null,
    // Session cookie
    sessionTtlMs: Number(env.SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000,
    cookieSecure: env.COOKIE_SECURE === 'true' || env.NODE_ENV === 'production',
    // Proteksi brute-force login
    loginRateLimitMax: Number(env.LOGIN_RATE_LIMIT_MAX) || 5,
    loginRateLimitWindowMs: Number(env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,

    // ===== Konfigurasi merchant legacy (opsional, untuk auto-migrasi) =====
    legacyMerchant: {
      apiKey: env.MERCHANT_API_KEY || null,
      qrisStatic: env.MERCHANT_QRIS_STATIC || null,
      webhookUrl: env.MERCHANT_WEBHOOK_URL || null,
      webhookSecret: env.MERCHANT_WEBHOOK_SECRET || null,
      payhookToken: env.PAYHOOK_TOKEN || null,
      name: env.MERCHANT_NAME || 'Default Merchant',
    },
  };
}

module.exports = { loadConfig };
