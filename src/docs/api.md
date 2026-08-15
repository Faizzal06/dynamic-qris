# Dokumentasi API — Gateway QRIS

Gateway pembayaran QRIS dinamis: buat transaksi, tampilkan QR ke pelanggan, dan terima notifikasi pembayaran lewat webhook.

- **Base URL:** `{{BASE_URL}}`
- **Batas nominal:** Rp {{MAX_AMOUNT}}
- **Kedaluwarsa default:** {{DEFAULT_EXPIRY_MINUTES}} menit

## Alur Singkat

1. Sistem Anda memanggil `POST /v1/transactions` → gateway membuat nominal unik (mis. Rp 50.137) dan QRIS dinamis.
2. Pelanggan memindai QR dan membayar tepat sesuai nominal unik.
3. Aplikasi PayHook mengirim notifikasi ke gateway → transaksi berubah `paid` → gateway mengirim webhook ke sistem Anda (dengan signature).

## Autentikasi

Semua endpoint (kecuali QR image) memakai header `Authorization: Bearer <token>`. Token didapat dari dashboard:

| Token | Prefix | Untuk endpoint | Diambil dari |
| --- | --- | --- | --- |
| API Key merchant | `sk_live_` | `/v1/*` | Dashboard merchant → tab Konfigurasi |
| Token PayHook | `ph_` | `/internal/*` | Dashboard merchant → tab Channel (token aplikasi PayHook milik sendiri) |

```bash
# Contoh header auth
Authorization: Bearer sk_live_xxxxxxxx
```

## 1. Buat Transaksi

`POST /v1/transactions`

Membuat transaksi baru dan menghasilkan QRIS dinamis dengan nominal unik. **Idempoten:** memakai `ref_id` yang sama mengembalikan transaksi yang sama (status `200`, bukan 201).

### Parameter

| Field | Wajib | Tipe | Keterangan |
| --- | --- | --- | --- |
| `ref_id` | ✔ | string (≤ 128) | Referensi pesanan Anda (ID unik per merchant) |
| `amount` | ✔ | integer | Nominal dasar (Rp), maksimal {{MAX_AMOUNT}} |
| `expiry_minutes` | — | integer | Masa berlaku transaksi (1–1440). Default {{DEFAULT_EXPIRY_MINUTES}} menit |
| `metadata` | — | object | Data tambahan bebas, dikembalikan apa adanya di respons & webhook |
| `callback_url` | — | url | URL webhook khusus transaksi ini (menggantikan webhook URL merchant) |

### Contoh request

```bash
curl -X POST {{BASE_URL}}/v1/transactions \
  -H "Authorization: Bearer sk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "ref_id": "INV-2024-001",
    "amount": 50000,
    "expiry_minutes": 15,
    "metadata": { "customer_name": "Budi" }
  }'
```

### Contoh respons — `201 Created`

```json
{
  "id": "txn_abc123",
  "ref_id": "INV-2024-001",
  "status": "pending",
  "requested_amount": 50000,
  "actual_amount": 50137,
  "qr_string": "0002010102...",
  "qr_image_url": "{{BASE_URL}}/v1/transactions/txn_abc123/qr.png",
  "expires_at": "2024-05-20T10:15:00Z",
  "paid_at": null,
  "metadata": { "customer_name": "Budi" }
}
```

`actual_amount` adalah nominal unik yang harus dibayar pelanggan (nominal dasar + kode unik Rp 1–499). Tampilkan QR lewat `qr_string` (jika Anda punya pemindai QRIS) atau `qr_image_url` di tag `<img>`.

## 2. Cek Status Transaksi (polling)

`GET /v1/transactions/:id`

Cek status transaksi. Status berubah jadi `paid` saat pembayaran masuk. Alternatif yang lebih baik: tunggu webhook keluar.

```bash
curl {{BASE_URL}}/v1/transactions/txn_abc123 \
  -H "Authorization: Bearer sk_live_xxx"
```

## 3. Gambar QR (publik)

`GET /v1/transactions/:id/qr.png`

Tanpa autentikasi — siap dipakai di tag `<img>` di halaman checkout Anda.

```html
<img src="{{BASE_URL}}/v1/transactions/txn_abc123/qr.png" alt="QRIS" />
```

## 4. Notifikasi PayHook

`POST /internal/webhook/payhook`

Dikirim oleh aplikasi PayHook (di HP pemilik QRIS) saat ada uang masuk. Token = token aplikasi PayHook. Endpoint ini **selalu membalas 200** agar PayHook tidak mengulang pengiriman. Transaksi dicocokkan lewat **nominal unik global**.

```bash
curl -X POST {{BASE_URL}}/internal/webhook/payhook \
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

`amount` harus sama persis dengan `actual_amount` transaksi. `event_type` selain `payment.incoming` diabaikan.

## 5. Webhook ke Sistem Anda

Saat status transaksi berubah, gateway mengirim `POST` ke webhook URL merchant (atau `callback_url` transaksi) dengan dua header khusus:

```
X-Signature: sha256=<hex HMAC-SHA256 dari raw body memakai webhook_secret>
X-Event: transaction.paid
```

### Event yang dikirim

| Event | Kapan | Keterangan |
| --- | --- | --- |
| `transaction.paid` | Pembayaran cocok & terverifikasi | Proses pesanan Anda |
| `transaction.refunded` | Admin melakukan refund | Batalkan/kembalikan pesanan |
| `webhook.test` | URL/secret webhook diubah di dashboard | Webhook uji untuk memverifikasi konfigurasi |

### Contoh payload — transaction.paid

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

### Verifikasi signature (Node.js)

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

> ⚠️ **Penting:** verifikasi harus memakai **raw body** persis seperti diterima — jangan `JSON.stringify` ulang objek hasil parse. Balas **2xx** agar gateway tidak mengulang pengiriman (retry backoff: 1m → 5m → 30m → 2j).

## Status Transaksi

| Status | Arti |
| --- | --- |
| `pending` | Menunggu pembayaran |
| `paid` | Pembayaran masuk & terverifikasi |
| `expired` | Melewati masa berlaku tanpa dibayar |
| `refunded` | Dana dikembalikan oleh admin |
| `failed` | Gagal (mis. konversi QRIS bermasalah) |

## Format Error

Setiap error mengembalikan status HTTP yang sesuai dengan body:

```json
{
  "error": {
    "code": "invalid_amount",
    "message": "amount harus integer positif"
  }
}
```

| Kode | HTTP | Arti |
| --- | --- | --- |
| `unauthorized` | 401 | API key / PayHook token tidak valid |
| `invalid_ref_id` / `invalid_amount` / `invalid_metadata` / `invalid_callback_url` | 400 | Input tidak valid |
| `no_active_qris` / `qris_not_available` | 400 | Merchant belum punya QRIS aktif |
| `converter_*` | 502/503 | Konversi QRIS bermasalah — coba lagi |
| `unique_amount_exhausted` | 503 | Gagal membuat nominal unik — coba lagi |
| `not_found` | 404 | Transaksi tidak ditemukan |
