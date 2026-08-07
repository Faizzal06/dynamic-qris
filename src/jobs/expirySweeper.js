'use strict';

const logger = require('../utils/logger');

function createExpirySweeper(db, config) {
  let timer = null;

  function run() {
    const result = db
      .prepare(`UPDATE transactions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`)
      .run(new Date().toISOString());
    if (result.changes > 0) {
      logger.info(`[sweeper] ${result.changes} transaksi ditandai expired`);
    }
  }

  return {
    start() {
      run();
      timer = setInterval(run, config.expirySweeperIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createExpirySweeper };
