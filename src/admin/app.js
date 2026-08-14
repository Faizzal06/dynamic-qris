'use strict';

/* Dashboard SPA sederhana (vanilla JS, tanpa build step). */

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/admin/login.html';
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) { /* ignore */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function copyable(value, label) {
  if (!value) return '<span class="muted">-</span>';
  return `<code class="secret" title="Klik untuk salin">${esc(value)}</code>
    <button class="btn-ghost copy" data-value="${esc(value)}">${esc(label || 'Salin')}</button>`;
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('id-ID');
}

async function main() {
  const { user } = await api('/auth/me');
  if (!user) {
    window.location.href = '/admin/login.html';
    return;
  }

  $('#user-label').textContent = `${user.username} (${user.role})`;
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: {} });
    window.location.href = '/admin/login.html';
  });

  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.copy');
    if (copyBtn) {
      await navigator.clipboard.writeText(copyBtn.dataset.value).catch(() => {});
      copyBtn.textContent = 'Tersalin ✓';
      setTimeout(() => (copyBtn.textContent = 'Salin'), 1500);
    }
  });

  if (user.role === 'admin') {
    $('#view-admin').classList.remove('hidden');
    await initAdmin();
  } else {
    $('#view-merchant').classList.remove('hidden');
    await initMerchant();
  }
}

// ============ Admin view ============

async function initAdmin() {
  // merchant list
  async function loadMerchants() {
    const { data } = await api('/admin/api/merchants');
    const select = $('#filter-merchant');
    select.innerHTML = '<option value="">Semua merchant</option>' +
      data.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');

    $('#merchant-list').innerHTML = `<table>
      <thead><tr><th>Nama</th><th>Status</th><th>API Key</th><th>PayHook Token</th><th>Webhook URL</th><th>Aksi</th></tr></thead>
      <tbody>
        ${data.map((m) => `<tr>
          <td>${esc(m.name)}<br/><span class="muted">${esc(m.id)}</span></td>
          <td>${esc(m.status)}</td>
          <td>${copyable(m.api_key)}</td>
          <td>${copyable(m.payhook_token)}</td>
          <td>${esc(m.webhook_url)}</td>
          <td>
            <button class="btn-ghost action" data-action="status" data-id="${esc(m.id)}">${m.status === 'active' ? 'Suspend' : 'Aktifkan'}</button>
            <button class="btn-ghost action" data-action="rotate-key" data-id="${esc(m.id)}">Rotate API Key</button>
            <button class="btn-ghost action" data-action="rotate-ph" data-id="${esc(m.id)}">Rotate PayHook</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.action');
    if (!btn) return;
    const { action, id } = btn.dataset;
    try {
      if (action === 'status') {
        const merchant = await api(`/admin/api/merchants/${id}`, { method: 'GET' });
        const next = merchant.merchant.status === 'active' ? 'suspended' : 'active';
        await api(`/admin/api/merchants/${id}/status`, { method: 'POST', body: { status: next } });
      } else if (action === 'rotate-key') {
        await api(`/admin/api/merchants/${id}/rotate-api-key`, { method: 'POST', body: {} });
      } else if (action === 'rotate-ph') {
        await api(`/admin/api/merchants/${id}/rotate-payhook-token`, { method: 'POST', body: {} });
      }
      await loadMerchants();
    } catch (err) {
      alert(err.message);
    }
  });

  $('#btn-new-merchant').addEventListener('click', () => {
    $('#merchant-form-wrap').classList.remove('hidden');
  });
  $('#btn-cancel-merchant').addEventListener('click', () => {
    $('#merchant-form-wrap').classList.add('hidden');
  });
  $('#merchant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (body.password && body.password.length < 8) {
      alert('Password minimal 8 karakter');
      return;
    }
    if (!body.webhook_secret) delete body.webhook_secret;
    if (!body.username) delete body.username;
    if (!body.password) delete body.password;
    try {
      await api('/admin/api/merchants', { method: 'POST', body });
      e.target.reset();
      $('#merchant-form-wrap').classList.add('hidden');
      await loadMerchants();
    } catch (err) {
      alert(err.message);
    }
  });

  // transactions
  async function loadTxns() {
    const q = new URLSearchParams();
    const mid = $('#filter-merchant').value;
    const st = $('#filter-status').value;
    if (mid) q.set('merchant_id', mid);
    if (st) q.set('status', st);
    q.set('limit', '50');
    const { data } = await api(`/admin/api/transactions?${q}`);
    $('#txn-table').innerHTML = `<table>
      <thead><tr><th>ID</th><th>Ref</th><th>Merchant</th><th>Status</th><th>Nominal</th><th>Dibuat</th><th>Webhook</th><th>Aksi</th></tr></thead>
      <tbody>
        ${data.map((t) => `<tr>
          <td>${esc(t.id)}</td>
          <td>${esc(t.ref_id)}</td>
          <td>${esc(t.merchant_id)}</td>
          <td>${esc(t.status)}</td>
          <td>${t.actual_amount}</td>
          <td>${fmtTime(t.created_at)}</td>
          <td>${esc(t.webhook_status)} (${t.webhook_attempts}x)</td>
          <td>
            ${t.status === 'pending' ? `<button class="btn-ghost action" data-action="expire" data-id="${esc(t.id)}">Expire</button>` : ''}
            ${t.status === 'paid' ? `<button class="btn-ghost action" data-action="refund" data-id="${esc(t.id)}">Refund</button>` : ''}
            ${t.status === 'paid' ? `<button class="btn-ghost action" data-action="resend" data-id="${esc(t.id)}">Kirim Ulang Webhook</button>` : ''}
          </td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">Tidak ada data</td></tr>'}
      </tbody>
    </table>`;
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.action');
    if (!btn) return;
    const { action, id } = btn.dataset;
    try {
      if (action === 'expire') await api(`/admin/api/transactions/${id}/expire`, { method: 'POST', body: {} });
      else if (action === 'refund') {
        if (!confirm('Refund transaksi ini? Status akan berubah ke refunded dan merchant dinotifikasi.')) return;
        await api(`/admin/api/transactions/${id}/refund`, { method: 'POST', body: {} });
      } else if (action === 'resend') await api(`/admin/api/transactions/${id}/resend-webhook`, { method: 'POST', body: {} });
      await loadTxns();
    } catch (err) {
      alert(err.message);
    }
  });

  // orphans
  async function loadOrphans() {
    const { data } = await api('/admin/api/orphans?limit=50');
    $('#orphan-table').innerHTML = `<table>
      <thead><tr><th>#</th><th>Merchant</th><th>Amount</th><th>Source</th><th>Reference</th><th>Diterima</th><th>Catatan</th></tr></thead>
      <tbody>
        ${data.map((o) => `<tr>
          <td>${o.id}</td><td>${esc(o.merchant_id || '-')}</td><td>${o.amount}</td>
          <td>${esc(o.source || '-')}</td><td>${esc(o.reference || '-')}</td>
          <td>${fmtTime(o.received_at)}</td><td class="muted">${esc(o.note || '')}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">Tidak ada data</td></tr>'}
      </tbody>
    </table>`;
  }

  $('#btn-refresh-txn').addEventListener('click', loadTxns);
  $('#btn-refresh-orphans').addEventListener('click', loadOrphans);
  await loadMerchants();
  await loadTxns();
  await loadOrphans();
}

// ============ Merchant view ============

async function initMerchant() {
  const { merchant } = await api('/dashboard/api/me');
  $('#merchant-info').innerHTML = `
    <div class="kv"><span>Nama</span><b>${esc(merchant.name)}</b></div>
    <div class="kv"><span>Status</span><b>${esc(merchant.status)}</b></div>
    <div class="kv"><span>API Key</span>${copyable(merchant.api_key, 'Salin')}</div>
    <div class="kv"><span>PayHook Token</span>${copyable(merchant.payhook_token, 'Salin')}</div>
    <div class="kv"><span>Webhook URL</span><b>${esc(merchant.webhook_url)}</b></div>
    <div class="kv"><span>QRIS Statis</span>${copyable(merchant.qris_static, 'Salin')}</div>
    <div class="row">
      <button id="m-rotate-key" class="btn">Rotate API Key</button>
      <button id="m-rotate-ph" class="btn">Rotate PayHook Token</button>
      <button id="m-change-pass" class="btn">Ganti Password</button>
    </div>
    <p class="muted small">Petunjuk PayHook: gunakan PayHook Token di atas sebagai Bearer token saat mengirim notifikasi ke <code>/internal/webhook/payhook</code>.</p>`;

  $('#m-rotate-key').addEventListener('click', async () => {
    if (!confirm('Rotate API key? Key lama langsung tidak berlaku.')) return;
    const res = await api('/dashboard/api/rotate-api-key', { method: 'POST', body: {} });
    alert(`API key baru: ${res.api_key}`);
  });
  $('#m-rotate-ph').addEventListener('click', async () => {
    if (!confirm('Rotate PayHook token? Token lama langsung tidak berlaku.')) return;
    const res = await api('/dashboard/api/rotate-payhook-token', { method: 'POST', body: {} });
    alert(`PayHook token baru: ${res.payhook_token}`);
  });
  $('#m-change-pass').addEventListener('click', async () => {
    const password = prompt('Password baru (min 8 karakter):');
    if (!password) return;
    try {
      await api('/dashboard/api/change-password', { method: 'POST', body: { password } });
      alert('Password berhasil diganti');
    } catch (err) {
      alert(err.message);
    }
  });

  async function loadTxns() {
    const q = new URLSearchParams();
    const st = $('#m-filter-status').value;
    if (st) q.set('status', st);
    q.set('limit', '50');
    const { data } = await api(`/dashboard/api/transactions?${q}`);
    $('#m-txn-table').innerHTML = `<table>
      <thead><tr><th>ID</th><th>Ref</th><th>Status</th><th>Nominal</th><th>Dibayar</th><th>Webhook</th></tr></thead>
      <tbody>
        ${data.map((t) => `<tr>
          <td>${esc(t.id)}</td><td>${esc(t.ref_id)}</td><td>${esc(t.status)}</td>
          <td>${t.actual_amount}</td><td>${fmtTime(t.paid_at)}</td>
          <td>${esc(t.webhook_status)} (${t.webhook_attempts}x)${t.webhook_last_error ? ` <span class="muted">— ${esc(t.webhook_last_error)}</span>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">Tidak ada data</td></tr>'}
      </tbody>
    </table>`;
  }

  async function loadOrphans() {
    const { data } = await api('/dashboard/api/orphans?limit=50');
    $('#m-orphan-table').innerHTML = `<table>
      <thead><tr><th>#</th><th>Amount</th><th>Source</th><th>Reference</th><th>Diterima</th></tr></thead>
      <tbody>
        ${data.map((o) => `<tr><td>${o.id}</td><td>${o.amount}</td><td>${esc(o.source || '-')}</td><td>${esc(o.reference || '-')}</td><td>${fmtTime(o.received_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Tidak ada data</td></tr>'}
      </tbody>
    </table>`;
  }

  $('#m-btn-refresh-txn').addEventListener('click', loadTxns);
  $('#m-btn-refresh-orphans').addEventListener('click', loadOrphans);
  await loadTxns();
  await loadOrphans();
}

main().catch((err) => {
  if (err.message === 'unauthorized') return;
  console.error(err);
});
