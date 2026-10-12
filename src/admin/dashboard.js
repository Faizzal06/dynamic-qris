'use strict';

/* Helper fetch ke API — redirect ke login jika 401. */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) { /* ignore */ }
  if (!res.ok) {
    throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  }
  return json;
}

async function post(path, body = {}) {
  return api(path, { method: 'POST', body });
}

function reload() {
  window.location.reload();
}

function showError(err) {
  alert(err.message || String(err));
}

/* ============ Navigasi sidebar (panel) ============ */

function initNav() {
  const panels = document.querySelectorAll('.tab-panel');
  const navItems = document.querySelectorAll('.nav-item[data-tab]');
  if (panels.length === 0) return;

  function activate(name) {
    navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.tab === name);
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
    closeMobileMenu();
  }

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      const href = item.getAttribute('href');
      if (href) return; // navigasi penuh (server-render panel dari ?panel=)
      e.preventDefault();
      activate(item.dataset.tab);
      try {
        localStorage.setItem('activePanel', item.dataset.tab);
      } catch (_) { /* ignore */ }
    });
  });

  // Panel aktif: dari ?panel= di URL, lalu localStorage, fallback dashboard
  let initial = null;
  try {
    const params = new URLSearchParams(window.location.search);
    initial = params.get('panel');
  } catch (_) { /* ignore */ }
  if (!initial || ![...navItems].some((item) => item.dataset.tab === initial)) {
    try {
      initial = localStorage.getItem('activePanel');
    } catch (_) { /* ignore */ }
  }
  if (initial && [...navItems].some((item) => item.dataset.tab === initial)) {
    activate(initial);
  } else {
    activate('dashboard');
  }
}

function openMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.add('open');
}

function closeMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('open');
}

function initMobileMenu() {
  const btn = document.getElementById('mobile-menu-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    if (sidebar.classList.contains('open')) closeMobileMenu();
    else openMobileMenu();
  });
  document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !btn.contains(e.target)) {
      closeMobileMenu();
    }
  });
}

/* ============ Tema terang/gelap ============ */

function initTheme() {
  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  toggle.textContent = root.getAttribute('data-theme') === 'dark' ? '☀' : '◐';
  toggle.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    toggle.textContent = next === 'dark' ? '☀' : '◐';
    try {
      localStorage.setItem('theme', next);
    } catch (_) { /* ignore */ }
  });
}

/* ============ Logout ============ */

function initLogout() {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await post('/auth/logout');
    } catch (_) { /* tetap redirect */ }
    window.location.href = '/admin/login';
  });
}

/* ============ Tombol salin ============ */

function initCopy() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const value = btn.dataset.copy;
    if (!value) return;
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Tersalin ✓';
    } catch (_) {
      btn.textContent = 'Gagal';
    }
    setTimeout(() => (btn.textContent = original), 1500);
  });
}

/* ============ Aksi tombol (data-action) ============ */

const ACTION_URLS = {
  // Admin — merchant
  'merchant-status': { method: 'POST', url: (id) => `/admin/api/merchants/${id}/status`, body: (btn) => ({ status: btn.dataset.status }) },
  'merchant-rotate-key': { method: 'POST', url: (id) => `/admin/api/merchants/${id}/rotate-api-key` },
  // Admin — QRIS
  'qris-approve': { method: 'POST', url: (id) => `/admin/api/qris-accounts/${id}/approve` },
  'qris-reject': { method: 'POST', url: (id) => `/admin/api/qris-accounts/${id}/reject` },
  'qris-status': { method: 'PATCH', url: (id) => `/admin/api/qris-accounts/${id}`, body: (btn) => ({ status: btn.dataset.status }) },
  // Admin — PayHook
  'payhook-approve': { method: 'POST', url: (id) => `/admin/api/payhook-apps/${id}/approve` },
  'payhook-reject': { method: 'POST', url: (id) => `/admin/api/payhook-apps/${id}/reject` },
  'payhook-rotate': { method: 'POST', url: (id) => `/admin/api/payhook-apps/${id}/rotate-token` },
  'payhook-status': { method: 'PATCH', url: (id) => `/admin/api/payhook-apps/${id}`, body: (btn) => ({ status: btn.dataset.status }) },
  // Admin — transaksi
  'txn-expire': { method: 'POST', url: (id) => `/admin/api/transactions/${id}/expire` },
  'txn-refund': { method: 'POST', url: (id) => `/admin/api/transactions/${id}/refund`, confirm: 'Kembalikan dana transaksi ini? Status jadi refunded dan merchant dinotifikasi.' },
  'txn-resend': { method: 'POST', url: (id) => `/admin/api/transactions/${id}/resend-webhook` },
  'txn-mark-paid': { method: 'POST', url: (id) => `/admin/api/transactions/${id}/mark-paid`, confirm: 'Tandai transaksi ini dibayar manual? Saldo merchant & fee dihitung, lalu webhook dikirim ke merchant.' },
  'txn-mark-failed': { method: 'POST', url: (id) => `/admin/api/transactions/${id}/mark-failed`, confirm: 'Tandai transaksi ini gagal?' },
  'txn-reopen': { method: 'POST', url: (id) => `/admin/api/transactions/${id}/reopen`, confirm: 'Buka kembali transaksi ini ke status pending? Data pembayaran akan direset.' },
  // Admin — withdraw (diproses manual)
  'withdraw-paid': {
    method: 'POST',
    url: (id) => `/admin/api/withdrawals/${id}/paid`,
    confirm: 'Tandai withdraw ini sudah dibayar? Pastikan dana sudah ditransfer manual ke rekening merchant.',
  },
  'withdraw-reject': {
    method: 'POST',
    url: (id) => `/admin/api/withdrawals/${id}/reject`,
    confirm: 'Tolak pengajuan withdraw ini? Nominal akan kembali tersedia ke saldo merchant.',
  },
  // Merchant — konfigurasi
  'dash-rotate-key': { method: 'POST', url: () => '/dashboard/api/rotate-api-key', confirm: 'Buat API key baru? Key lama langsung tidak berlaku.', alert: (json) => `API key baru: ${json.api_key}` },
  'dash-rotate-webhook-secret': {
    method: 'POST',
    url: () => '/dashboard/api/rotate-webhook-secret',
    confirm: 'Buat secret webhook baru? Secret lama langsung tidak berlaku.',
    alert: (json) => testWebhookAlert(`Webhook secret baru: ${json.webhook_secret}`, json.test_webhook),
  },
  'dash-payhook-rotate': { method: 'POST', url: () => '/dashboard/api/payhook/rotate-token', confirm: 'Buat token PayHook baru? Token lama langsung tidak berlaku.', alert: (json) => `Token baru: ${json.payhook_app.token}` },
  'dash-change-password': { prompt: true },
};

const CONFIRM_MESSAGE = {
  'merchant-status': (btn) => (btn.dataset.status === 'suspended' ? 'Nonaktifkan merchant ini? API key langsung tidak berlaku.' : 'Aktifkan merchant ini?'),
  'qris-status': (btn) => (btn.dataset.status === 'suspended' ? 'Nonaktifkan QRIS ini? Transaksi merchant yang memakainya akan gagal.' : 'Aktifkan QRIS ini?'),
  'payhook-status': (btn) => (btn.dataset.status === 'suspended' ? 'Nonaktifkan PayHook ini? Pembayaran tidak akan diproses.' : 'Aktifkan PayHook ini?'),
};

function initActions() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const spec = ACTION_URLS[action];
    if (!spec) return;

    try {
      if (action === 'dash-change-password') {
        const password = prompt('Password baru (minimal 8 karakter):');
        if (!password) return;
        await post('/dashboard/api/change-password', { password });
        alert('Password berubah. Pakai password baru saat login berikutnya.');
        return;
      }

      const confirmMsg = spec.confirm || CONFIRM_MESSAGE[action];
      if (confirmMsg && !window.confirm(typeof confirmMsg === 'function' ? confirmMsg(btn) : confirmMsg)) return;

      const json = await api(spec.url(id), { method: spec.method, body: spec.body ? spec.body(btn) : {} });
      if (spec.alert) alert(spec.alert(json));
      reload();
    } catch (err) {
      showError(err);
    }
  });
}

/* ============ Pilih QRIS / PayHook (merchant) ============ */

function initSelect() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="qris-select"], button[data-action="payhook-select"]');
    if (!btn) return;
    const isQris = btn.dataset.action === 'qris-select';
    const select = document.getElementById(isQris ? 'qris-select' : 'payhook-select');
    const value = select && select.value;
    if (!value) {
      alert(isQris ? 'Pilih QRIS dulu' : 'Pilih PayHook dulu');
      return;
    }
    try {
      await post(isQris ? '/dashboard/api/qris/select' : '/dashboard/api/payhook/select', {
        [isQris ? 'qris_account_id' : 'payhook_app_id']: value,
      });
      reload();
    } catch (err) {
      showError(err);
    }
  });
}

/* ============ Form ============ */

const FORMS = {
  'merchant-create-form': {
    url: '/admin/api/merchants',
    build: (data) => {
      if (!data.webhook_secret) delete data.webhook_secret;
      if (!data.username) delete data.username;
      if (!data.password) delete data.password;
      return data;
    },
    validate: (data) => (data.password && data.password.length < 8 ? 'Password minimal 8 karakter.' : null),
  },
  'qris-create-form': { url: '/admin/api/qris-accounts' },
  'payhook-create-form': { url: '/admin/api/payhook-apps' },
  'withdraw-request-form': {
    url: '/dashboard/api/withdrawals',
    success: 'Pengajuan withdraw terkirim. Menunggu diproses admin.',
    // FormData mengirim string; server memvalidasi amount harus integer.
    build: (data) => ({ ...data, amount: Number(data.amount) }),
    validate: (data) => {
      if (!Number.isInteger(data.amount) || data.amount <= 0) return 'Nominal harus angka bulat positif.';
      return null;
    },
  },
  'qris-request-form': { url: '/dashboard/api/qris/request', success: 'Pengajuan QRIS terkirim. Tunggu persetujuan admin.' },
  'payhook-request-form': { url: '/dashboard/api/payhook/request', success: (json) => `Pengajuan PayHook terkirim. Setelah disetujui, gunakan token: ${json.payhook_app.token}` },
  'dash-webhook-form': {
    url: '/dashboard/api/webhook',
    success: (json) => testWebhookAlert('Webhook URL diperbarui', json.test_webhook),
  },
};

function testWebhookAlert(base, testWebhook) {
  if (!testWebhook) return base;
  return testWebhook.ok
    ? `${base} — webhook uji terkirim ✓`
    : `${base} — webhook uji GAGAL terkirim (${testWebhook.error || 'gagal'})`;
}

function initForms() {
  Object.entries(FORMS).forEach(([formId, spec]) => {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const built = spec.build ? spec.build(data) : data;
      if (spec.validate) {
        const err = spec.validate(built);
        if (err) return showError({ message: err });
      }
      try {
        const json = await api(spec.url, { method: 'POST', body: built });
        if (typeof spec.success === 'string') alert(spec.success);
        else if (typeof spec.success === 'function') alert(spec.success(json));
        form.reset();
        reload();
      } catch (err) {
        showError(err);
      }
    });
  });
}

/* ============ Tampil/sembunyikan form wrap ============ */

function initFormToggles() {
  document.addEventListener('click', (e) => {
    const showBtn = e.target.closest('#btn-new-merchant, #btn-new-qris, #btn-new-payhook, #btn-new-withdrawal, [data-show]');
    if (showBtn) {
      const map = {
        'btn-new-merchant': 'merchant-create-wrap',
        'btn-new-qris': 'qris-create-wrap',
        'btn-new-payhook': 'payhook-create-wrap',
        'btn-new-withdrawal': 'withdraw-create-wrap',
      };
      const wrap = document.getElementById(showBtn.dataset.show || map[showBtn.id]);
      if (wrap) wrap.classList.remove('hidden');
      return;
    }
    const hideBtn = e.target.closest('[data-hide]');
    if (hideBtn) {
      const wrap = document.getElementById(hideBtn.dataset.hide);
      if (wrap) wrap.classList.add('hidden');
    }
  });
}

/* ============ Overlay / modal ============ */

function initModal() {
  const overlay = document.getElementById('channel-modal');
  if (!overlay) return;

  function open() {
    overlay.hidden = false;
  }
  function close() {
    overlay.hidden = true;
  }

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('#btn-request-channel');
    if (opener) {
      open();
      return;
    }
    const closer = e.target.closest('[data-close-modal]');
    if (closer || e.target === overlay) {
      close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
}

/* ============ Chart (Chart.js) ============ */

const CHART_COLORS = ['#2563eb', '#22d3ee', '#c084fc', '#f59e0b', '#10b981', '#ef4444', '#38bdf8', '#8b93a7'];

function chartTextColor() {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'light' ? '#5b6478' : '#8b93a7';
}

function chartGridColor() {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'light' ? '#e2e6ef' : '#232a3b';
}

function makeDonut(canvasId, items, centerLabel, centerSubLabel) {
  const el = document.getElementById(canvasId);
  if (!el || typeof Chart === 'undefined') return;
  const itemsArr = items || [];
  const labels = itemsArr.map((i) => i.label);
  const data = itemsArr.map((i) => i.value);
  const textColor = chartTextColor();

  new Chart(el, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: CHART_COLORS.slice(0, Math.max(labels.length, 1)),
        borderColor: 'transparent',
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: textColor, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.parsed}`,
          },
        },
      },
    },
    plugins: centerLabel
      ? [{
          id: 'centerText',
          afterDraw(chart) {
            const { ctx, chartArea } = chart;
            const cx = (chartArea.left + chartArea.right) / 2;
            const cy = (chartArea.top + chartArea.bottom) / 2;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = chartTextColor();
            ctx.font = '600 13px "IBM Plex Sans"';
            ctx.fillText(centerSubLabel || '', cx, cy + 16);
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#e8ecf4';
            ctx.font = '800 24px "IBM Plex Sans"';
            ctx.fillText(String(centerLabel), cx, cy - 4);
            ctx.restore();
          },
        }]
      : [],
  });
}

function makeLine(canvasId, labels, data, label) {
  const el = document.getElementById(canvasId);
  if (!el || typeof Chart === 'undefined') return;
  const textColor = chartTextColor();
  const gridColor = chartGridColor();

  new Chart(el, {
    type: 'line',
    data: {
      labels: labels || [],
      datasets: [{
        label: label || '',
        data: data || [],
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37, 99, 235, 0.12)',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: '#2563eb',
        pointBorderColor: 'transparent',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` Rp ${Number(ctx.parsed.y || 0).toLocaleString('id-ID')}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: textColor, font: { size: 11 } },
          grid: { color: gridColor },
        },
        y: {
          beginAtZero: true,
          ticks: { color: textColor, font: { size: 11 }, callback: (v) => (v >= 1000 ? `${v / 1000}k` : v) },
          grid: { color: gridColor },
        },
      },
    },
  });
}

function initCharts() {
  const el = document.getElementById('chart-data');
  if (!el) return;
  let data = null;
  try {
    data = JSON.parse(el.textContent);
  } catch (_) { return; }
  if (!data) return;

  if (data.sourceDonut) {
    makeDonut('source-donut', data.sourceDonut, null, null);
  }
  if (data.statusDonut) {
    makeDonut('status-donut', data.statusDonut, null, null);
  }
  if (data.incomeLine) {
    makeLine('income-line', data.incomeLine.labels, data.incomeLine.data, 'Penghasilan');
  }
  if (data.saldoLine) {
    makeLine('saldo-line', data.saldoLine.labels, data.saldoLine.data, 'Saldo masuk');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initMobileMenu();
  initTheme();
  initLogout();
  initCopy();
  initActions();
  initSelect();
  initForms();
  initFormToggles();
  initModal();
  initCharts();
});
