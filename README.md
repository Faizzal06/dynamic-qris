# 🪙 dyqris — Mini QRIS Payment Gateway (Multi-Tenant)

Middleware Node.js yang mengubah **QRIS statis** menjadi **QRIS dinamis** (dengan nominal unik), memvalidasi pembayaran secara real-time lewat notifikasi aplikasi **PayHook** di Android, lalu meneruskan status pembayaran ke sistem merchant melalui **Webhook** (dengan HMAC signature).

**Satu instance gateway melayani banyak merchant/subtenant** — setiap merchant punya API key, QRIS statis, webhook URL + secret, dan PayHook token sendiri, plus dashboard monitoring.

Dibangun berdasarkan [PRD.md](./PRD.md).

## ✨ Fitur

**Merchant API**
- `POST /v1/transactions` — buat tagihan dengan nominal unik (unique amount)
- `GET /v1/transactions/:id` — polling status transaksi (fallback jika webhook gagal)
- `GET /v1/transactions/:id/qr.png` — gambar QR (publik, siap dipakai di `<img>`)

**PayHook & Webhook**
- `POST /internal/webhook/payhook` — penerima notifikasi PayHook (idempoten, **token per merchant**)
- Webhook keluar ke merchant dengan **HMAC-SHA256 signature** + retry backoff (1m → 5m → 30m → 2j)
- Logging **orphan payment** (pembayaran yang tidak cocok transaksi mana pun)

**Multi-Tenant (Fase 2)**
- Merchant disimpan di tabel `merchants` (bukan `.env`): API key, QRIS statis, webhook, PayHook token
- Migrasi otomatis dari konfigurasi env single-merchant lama → 1 merchant default
- Isolasi penuh antar merchant: transaksi, nominal unik, dan PayHook routing scoped per merchant

**Dashboard Admin & Monitoring (Fase 3)**
- Login admin (`/admin`) + dashboard merchant masing-masing (`/admin` → redirect sesuai peran)
- Admin: CRUD merchant, suspend/aktifkan, rotate API key & PayHook token, reset password user
- Monitoring: daftar transaksi (filter merchant/status), detail, orphan payments
- Aksi manual: force-expire transaksi pending, refund (kirim webhook `transaction.refunded`), kirim ulang webhook

## 🧱 Stack

Node.js v22+ • Express • SQLite (`better-sqlite3`) — tanpa database server terpisah, ringan untuk Pterodactyl / shared hosting. Password di-hash dengan `crypto.scrypt` bawaan Node (tanpa dependency tambahan).

## 🚀 Quick Start

```bash
npm install
cp .env.example .env   # lalu isi konfigurasi
npm start              # atau npm run dev (auto-reload)
```

### Variabel Environment

| Variabel | Keterangan |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Kredensial login dashboard admin (diseed ke DB, password ter-hash) |
| `PORT`, `BASE_URL`, `DB_PATH` | Konfigurasi server & database |

**Opsional (migrasi dari versi single-merchant):** jika `MERCHANT_API_KEY`, `MERCHANT_QRIS_STATIC`, `MERCHANT_WEBHOOK_URL`, `MERCHANT_WEBHOOK_SECRET`, dan `PAYHOOK_TOKEN` masih ada di `.env`, gateway otomatis membuat 1 merchant default di database saat start pertama.

Opsional lainnya: `QRIS_CONVERT_URL`, `MAX_AMOUNT`, `DEFAULT_EXPIRY_MINUTES`, `SESSION_TTL_MS`, `COOKIE_SECURE`, `LOGIN_RATE_LIMIT_*` (lihat `.env.example`).

## 🖥️ Dashboard

- Buka `https://gateway.domain.com/admin`, login dengan kredensial admin.
- **Admin**: kelola merchant (buat, suspend, rotate key/token), lihat semua transaksi & orphan, refund / force-expire.
- **Merchant**: setiap merchant punya user login sendiri (dibuat oleh admin saat membuat merchant) dan hanya melihat datanya sendiri.

## 📡 Contoh Penggunaan API

### 1. Buat transaksi

```bash
curl -X POST https://gateway.domain.com/v1/transactions \
  -H "Authorization: Bearer sk_live_xxx" \
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

> Duplikat `ref_id` dalam merchant yang sama tidak membuat transaksi baru — gateway mengembalikan transaksi yang sama dengan status `200`.

### 2. Cek status (polling)

```bash
curl https://gateway.domain.com/v1/transactions/txn_abc123 \
  -H "Authorization: Bearer sk_live_xxx"
```

### 3. PayHook mengirim notifikasi (token per merchant)

```bash
curl -X POST https://gateway.domain.com/internal/webhook/payhook \
  -H "Authorization: Bearer ph_xxx" \
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

> Endpoint ini **selalu membalas 200** agar PayHook tidak melakukan retry yang tidak perlu. PayHook token menentukan merchant pemilik notifikasi.

### 4. Webhook ke sistem merchant

Saat transaksi terbayar, gateway mengirim `POST` ke webhook URL merchant:

```
X-Signature: sha256=<hex HMAC-SHA256 dari raw body dengan webhook_secret merchant>
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

Saat refund oleh admin, dikirim event `transaction.refunded` dengan payload serupa (`status: "refunded"`, `refunded_at`).

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
3. Notifikasi "uang masuk" muncul di HP merchant → PayHook mengirim ke `/internal/webhook/payhook` dengan token merchant.
4. Gateway mencocokkan nominal unik **milik merchant tersebut** → status berubah `paid` → webhook ke merchant (dengan signature).
5. Merchant verifikasi signature, proses pesanan, balas 2xx.

## 🧪 Testing

```bash
npm test
```

Unit test (unique amount scoped per merchant, crypto, password hashing, converter) + integration test (alur penuh create → payhook → webhook, isolasi antar merchant, auth admin & rate limit, refund/force-expire, retry webhook, edge cases). Smoke test: `node scripts/smoke.js`.

## 🛡️ Keamanan

- Password dashboard di-hash dengan **scrypt** (KDF memory-hard, salt acak) — tidak pernah disimpan plaintext
- Session cookie **httpOnly + SameSite=Lax**; token session acak disimpan **ter-hash (SHA-256)** di database
- Rate limiting login (anti brute-force)
- Auth Bearer per merchant (API key & PayHook token) dengan lookup database + cek status aktif/suspended
- Webhook keluar ditandatangani HMAC-SHA256 dengan secret per merchant
- Tidak ada token/secret yang di-log
- HTTPS wajib di reverse proxy / platform hosting (set `COOKIE_SECURE=true`)

## 📦 Deployment

- **Pterodactyl (Node.js Egg)**: gunakan egg Node.js 22/24, install dependencies lalu `npm start`. Pastikan folder `data/` writable (SQLite).
- **PM2 / VPS**: `pm2 start src/server.js --name dyqris` (butuh Node ≥ 22).
- **Shared Hosting (cPanel/CloudPanel Node.js App)**: arahkan entry ke `src/server.js`.

## 🗺️ Roadmap

Fase 4–5 di PRD (rekonsiliasi otomatis, dukungan QRIS tanpa nominal unik) belum termasuk di rilis ini.

## 📄 Lisensi

MIT
