'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { bootstrap } = require('./services/bootstrap');
const { createExpirySweeper } = require('./jobs/expirySweeper');
const { createWebhookRetry } = require('./jobs/webhookRetry');
const logger = require('./utils/logger');

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { app, webhookSender, merchantService, userService } = createApp({ db, config });

  await bootstrap({ db, config, userService, merchantService });

  const expirySweeper = createExpirySweeper(db, config);
  const webhookRetry = createWebhookRetry(db, config, webhookSender);

  expirySweeper.start();
  webhookRetry.start();

  const server = app.listen(config.port, () => {
    logger.info(`Gateway QRIS berjalan di http://localhost:${config.port}`);
  });

  function shutdown(signal) {
    logger.info(`[server] ${signal} diterima, menutup server...`);
    expirySweeper.stop();
    webhookRetry.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Fallback jika koneksi masih terbuka
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('[server] gagal start', err);
  process.exit(1);
});
