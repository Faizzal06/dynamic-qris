'use strict';

/**
 * Smoke test: menjalankan server + stub converter dalam satu proses,
 * lalu memverifikasi endpoint utama. Tidak butuh .env (config dibuat manual).
 * Jalankan: node scripts/smoke.js
 */

const http = require('http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const QRIS_STATIC =
  '00020101021126650014ID.CO.QRIS.WWW01189360091100000000000215204082010303UMI51440014ID.CO.QRIS.WWW0215ID10200169230303UMI5204581253033605405100005802ID5913Merchant Name6013Jakarta Selatan61051234562070703.016304';

function startStubConverter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              qris_string: `000201010212${JSON.parse(body).amount}${QRIS_STATIC.slice(0, 30)}`,
              qr_base64: `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`,
            },
          })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function main() {
  const converter = await startStubConverter();

  const config = {
    port: 0,
    baseUrl: 'http://gateway.test',
    dbPath: ':memory:',
    qrisConvertUrl: converter.url,
    qrisConvertTimeoutMs: 2000,
    maxAmount: 9999999,
    defaultExpiryMinutes: 15,
    webhookRetryIntervalMs: 60000,
    expirySweeperIntervalMs: 60000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 5,
    adminUsername: 'admin',
    adminPassword: 'admin123',
    sessionTtlMs: 3600_000,
    cookieSecure: false,
    loginRateLimitMax: 5,
    loginRateLimitWindowMs: 60_000,
  };

  const db = openDatabase(config.dbPath);
  const { app, merchantService, userService } = createApp({ db, config });

  // Seed admin + merchant untuk smoke test
  await userService.createUser({ role: 'admin', username: 'admin', password: 'admin123' });

  const merchant = merchantService.createMerchant({
    name: 'Smoke Merchant',
    qris_static: QRIS_STATIC,
    webhook_url: 'http://127.0.0.1:1/webhook', // port 1 = selalu gagal (simulasi)
    webhook_secret: 'whsec_test',
  });
  const apiKey = merchant.api_key;
  const payhookToken = merchant.payhook_token;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let failures = 0;
  async function check(name, fn) {
    try {
      await fn();
      console.log(`✔ ${name}`);
    } catch (err) {
      failures++;
      console.error(`✖ ${name}: ${err.message}`);
    }
  }

  await check('health ok', async () => {
    const res = await fetch(`${base}/health`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
  });

  await check('create transaksi → 201', async () => {
    const res = await fetch(`${base}/v1/transactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref_id: 'SMOKE-1', amount: 10000 }),
    });
    const json = await res.json();
    if (res.status !== 201) throw new Error(`status ${res.status}: ${JSON.stringify(json)}`);
    if (json.actual_amount <= 10000 || json.actual_amount > 10999) throw new Error(`actual_amount aneh: ${json.actual_amount}`);
  });

  await check('auth salah → 401', async () => {
    const res = await fetch(`${base}/v1/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref_id: 'X', amount: 1000 }),
    });
    if (res.status !== 401) throw new Error(`status ${res.status}`);
  });

  await check('qr.png publik → image/png', async () => {
    const create = await fetch(`${base}/v1/transactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref_id: 'SMOKE-2', amount: 20000 }),
    });
    const txn = await create.json();
    const res = await fetch(`${base}/v1/transactions/${txn.id}/qr.png`);
    const ct = res.headers.get('content-type');
    if (res.status !== 200 || ct !== 'image/png') throw new Error(`status ${res.status}, content-type ${ct}`);
  });

  await check('payhook → paid + webhook retry terjadwal', async () => {
    const create = await fetch(`${base}/v1/transactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref_id: 'SMOKE-3', amount: 30000 }),
    });
    const txn = await create.json();

    const payhook = await fetch(`${base}/internal/webhook/payhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${payhookToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: `evt_${Date.now()}`,
        event_type: 'payment.incoming',
        amount: txn.actual_amount,
        source: 'DANA',
      }),
    });
    const ph = await payhook.json();
    if (ph.processed !== true) throw new Error(`processed=${ph.processed}`);

    // Tunggu webhook gagal (port 1) → webhook_status pending, attempts=1
    for (let i = 0; i < 50; i++) {
      const row = db.prepare('SELECT webhook_status, webhook_attempts FROM transactions WHERE id = ?').get(txn.id);
      if (row && row.webhook_attempts >= 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const row = db.prepare('SELECT webhook_status, webhook_attempts, webhook_next_retry_at FROM transactions WHERE id = ?').get(txn.id);
    if (row.webhook_attempts < 1) throw new Error('webhook tidak pernah dicoba');
    if (row.webhook_status !== 'pending') throw new Error(`webhook_status=${row.webhook_status}`);
    if (!row.webhook_next_retry_at) throw new Error('tidak ada jadwal retry');
  });

  await check('login admin → session cookie', async () => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const me = await fetch(`${base}/auth/me`, { headers: { Cookie: cookie } });
    const meJson = await me.json();
    if (!meJson.user || meJson.user.role !== 'admin') throw new Error(`role tidak sesuai: ${JSON.stringify(meJson)}`);
  });

  server.close();
  converter.server.close();
  db.close();

  if (failures > 0) {
    console.error(`\n${failures} smoke test gagal`);
    process.exit(1);
  }
  console.log('\nSemua smoke test lulus ✅');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
