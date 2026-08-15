'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  if (!form) return;

  const errorBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) {
      errorBox.textContent = 'Username dan password wajib diisi';
      errorBox.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Memproses…';
    errorBox.classList.add('hidden');

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      let json = null;
      try {
        json = await res.json();
      } catch (_) { /* ignore */ }

      if (res.status === 401) {
        errorBox.textContent = 'Username atau password salah. Cek kembali dan coba lagi.';
        errorBox.classList.remove('hidden');
      } else if (res.status === 429) {
        errorBox.textContent = 'Terlalu banyak percobaan login, coba lagi nanti';
        errorBox.classList.remove('hidden');
      } else if (!res.ok) {
        errorBox.textContent = (json && json.error && json.error.message) || 'Terjadi kesalahan, coba lagi';
        errorBox.classList.remove('hidden');
      } else {
        window.location.href = json.user && json.user.role === 'admin' ? '/admin' : '/dashboard';
        return;
      }
    } catch (_) {
      errorBox.textContent = 'Gagal terhubung ke server';
      errorBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Masuk';
    }
  });
});
