'use strict';

const { ApiError } = require('../utils/errors');
const { generateId } = require('../utils/ids');
const { hashPassword, verifyPassword } = require('./password');
const logger = require('../utils/logger');

function createUserService(db) {
  function getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  }

  function getUserByMerchant(merchantId, role = 'merchant') {
    return db.prepare('SELECT * FROM users WHERE merchant_id = ? AND role = ? LIMIT 1').get(merchantId, role) || null;
  }

  /** Buat user (admin atau merchant). Password di-hash dengan scrypt. */
  async function createUser({ merchant_id = null, role = 'merchant', username, password }) {
    if (typeof username !== 'string' || username.trim() === '') {
      throw new ApiError(400, 'invalid_user', 'username wajib diisi');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new ApiError(400, 'invalid_user', 'Password minimal 8 karakter.');
    }
    if (!['admin', 'merchant'].includes(role)) {
      throw new ApiError(400, 'invalid_user', 'role harus admin atau merchant');
    }
    if (getUserByUsername(username)) {
      throw new ApiError(409, 'username_exists', 'Username sudah dipakai. Pilih username lain.');
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    const user = {
      id: generateId('usr'),
      merchant_id,
      role,
      username: username.trim(),
      password_hash: passwordHash,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO users (id, merchant_id, role, username, password_hash, created_at, updated_at)
       VALUES (@id, @merchant_id, @role, @username, @password_hash, @created_at, @updated_at)`
    ).run(user);

    logger.info(`[user] dibuat ${user.id} role=${role} username=${user.username}`);
    return { id: user.id, merchant_id: user.merchant_id, role: user.role, username: user.username };
  }

  /** Autentikasi login dashboard. Return user publik atau null. */
  async function authenticateUser(username, password) {
    const user = getUserByUsername(username);
    if (!user) return null;
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return null;
    return { id: user.id, merchant_id: user.merchant_id, role: user.role, username: user.username };
  }

  /** Reset password user milik merchant tertentu. */
  async function resetPassword(merchantId, newPassword) {
    const user = getUserByMerchant(merchantId, 'merchant');
    if (!user) return null;
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new ApiError(400, 'invalid_user', 'Password minimal 8 karakter.');
    }
    const passwordHash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      passwordHash,
      new Date().toISOString(),
      user.id
    );
    logger.info(`[user] password di-reset untuk ${user.username}`);
    return { id: user.id, username: user.username };
  }

  /** Ganti password user saat ini (self-service). */
  async function changePassword(userId, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new ApiError(400, 'invalid_user', 'Password minimal 8 karakter.');
    }
    const passwordHash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      passwordHash,
      new Date().toISOString(),
      userId
    );
    return true;
  }

  return {
    getUserByUsername,
    getUserByMerchant,
    createUser,
    authenticateUser,
    resetPassword,
    changePassword,
  };
}

module.exports = { createUserService };
