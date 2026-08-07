# 🪙 dyqris — Mini QRIS Payment Gateway (Single Merchant Edition)

Middleware Node.js yang mengubah **QRIS statis** merchant menjadi **QRIS dinamis** (dengan nominal unik), memvalidasi pembayaran secara real-time lewat notifikasi aplikasi **PayHook** di Android, lalu meneruskan status pembayaran ke sistem merchant melalui **Webhook** (dengan HMAC signature).

Dibangun berdasarkan [PRD.md](./PRD.md) dan [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## ✨ Fitur

- `POST /v1/transactions` — buat tagihan dengan nominal unik (unique amount)
- `GET /v1/transactions/:id` — polling status transaksi (fallback jika webhook gagal)
- `GET /v1/transactions/:id/qr.png` — gambar QR (publik, siap dipakai di `<img>`)
- `POST /internal/webhook/payhook` — penerima notifikasi dari PayHook (idempoten)
- Webhook keluar ke merchant dengan **HMAC-SHA256 signature** + retry backoff (1m → 5m → 30m → 2j)
- Logging **orphan payment** (pembayaran yang tidak cocok transaksi mana pun)
- Single tenant: semua konfigurasi merchant di `.env`

## 🧱 Stack

Node.js v18+ • Express • SQLite (`better-sqlite3`) — tanpa database server terpisah, ringan untuk Pterodactyl / shared hosting.

## 🚀 Quick Start

```bash
npm install
cp .env.example .env   # lalu isi konfigurasi merchant
npm start              # atau npm run dev (auto-reload)
```

### Variabel Environment wajib

| Variabel | Keterangan |
|---|---|
| `MERCHANT_API_KEY` | Token Bearer untuk Merchant API |
| `MERCHANT_QRIS_STATIC` | String QRIS statis milik merchant |
| `MERCHANT_WEBHOOK_URL` | URL endpoint webhook di sistem merchant |
| `MERCHANT_WEBHOOK_SECRET` | Secret untuk verifikasi HMAC signature |
| `PAYHOOK_TOKEN` | Token Bearer untuk notifikasi PayHook |

Opsional: `PORT`, `BASE_URL`, `DB_PATH`, `QRIS_CONVERT_URL`, `MAX_AMOUNT`, `DEFAULT_EXPIRY_MINUTES`, dll (lihat `.env.example`).

## 📡 Contoh Penggunaan API

### 1. Buat transaksi

```bash
curl -X POST https://gateway.domain.com/v1/transactions \
  -H "Authorization: Bearer $MERCHANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ref_id": "INV-2024-001",
    "amount": 50000,
    "expiry_minutes": 15,
    "metadata": { "customer_name": "Budi" }
  }'
```

Response `201 Created`:

```json
{
  "id": "txn_abc123",
  "ref_id": "INV-2024-001",
  "status": "pending",
  "requested_amount": 50000,
  "actual_amount": 50137,
  "qr_string": "0002010102...",
  "qr_image_url": "https://gateway.domain.com/v1/transactions/txn_abc123/qr.png",
  "expires_at": "2024-05-20T10:15:00Z",
  "paid_at": null,
  "metadata": { "customer_name": "Budi" }
}
```

> Duplikat `ref_id` tidak membuat transaksi baru — gateway mengembalikan transaksi yang sama dengan status `200`.

### 2. Cek status (polling)

```bash
curl https://gateway.domain.com/v1/transactions/txn_abc123 \
  -H "Authorization: Bearer $MERCHANT_API_KEY"
```

### 3. PayHook mengirim notifikasi (dikonfigurasi di aplikasi PayHook)

```bash
curl -X POST https://gateway.domain.com/internal/webhook/payhook \
  -H "Authorization: Bearer $PAYHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "evt_xyz",
    "event_type": "payment.incoming",
    "amount": 50137,
    "source": "DANA",
    "reference": "REF123",
    "timestamp": "2024-05-20 10:05:00"
  }'
```

> Endpoint ini **selalu membalas 200** agar PayHook tidak melakukan retry yang tidak perlu.

### 4. Webhook ke sistem merchant

Saat transaksi terbayar, gateway mengirim `POST` ke `MERCHANT_WEBHOOK_URL`:

```
X-Signature: sha256=<hex HMAC-SHA256 dari raw body dengan MERCHANT_WEBHOOK_SECRET>
X-Event: transaction.paid
```

```json
{
  "event": "transaction.paid",
  "id": "txn_abc123",
  "ref_id": "INV-2024-001",
  "status": "paid",
  "actual_amount": 50137,
  "paid_at": "2024-05-20T10:05:05Z",
  "metadata": { "customer_name": "Budi" }
}
```

**Contoh verifikasi signature (Node.js di sisi merchant):**

```js
const crypto = require('crypto');

function verifyWebhook(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader)
  );
}
```

> ⚠️ Penting: verifikasi harus menggunakan **raw body** persis seperti yang diterima (jangan `JSON.stringify` ulang objek hasil parse).

## 🔄 Alur Kerja

1. Sistem merchant memanggil `POST /v1/transactions` → gateway membuat nominal unik (mis. Rp 50.137) dan QRIS dinamis via API konversi.
2. Pelanggan memindai QR dan membayar tepat Rp 50.137.
3. Notifikasi "uang masuk" muncul di HP merchant → PayHook mengirim ke `/internal/webhook/payhook`.
4. Gateway mencocokkan nominal unik → status berubah `paid` → webhook ke merchant (dengan signature).
5. Merchant verifikasi signature, proses pesanan, balas 2xx.

## 🧪 Testing

```bash
npm test
```

Unit test (unique amount, crypto, converter) + integration test (alur penuh create → payhook → webhook, edge cases: duplikat event, orphan payment, converter down, retry webhook, expired).

## 🛡️ Keamanan

- Auth Bearer statis (merchant & PayHook) dengan constant-time comparison
- Webhook keluar ditandatangani HMAC-SHA256
- Tidak ada token/secret yang di-log
- HTTPS wajib di reverse proxy / platform hosting

## 📦 Deployment

- **Pterodactyl (Node.js Egg)**: install dependencies lalu `npm start`. Pastikan folder `data/` writable (SQLite).
- **PM2 / VPS**: `pm2 start src/server.js --name dyqris` (butuh Node ≥ 18).
- **Shared Hosting (cPanel/CloudPanel Node.js App)**: arahkan entry ke `src/server.js`.

## 🗺️ Roadmap

Fase 2–5 di PRD (multi-tenant, dashboard, rekonsiliasi otomatis, dukungan QRIS tanpa nominal unik) belum termasuk di rilis ini.

## 📄 Lisensi

MIT
