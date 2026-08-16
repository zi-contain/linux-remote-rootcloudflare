/**
 * 认证 API
 *
 * GET  /api/auth          检查登录状态，返回用户名 + CSRF 令牌
 * POST /api/auth          登录（username, password）
 * DELETE /api/auth        登出
 */

import { jsonResponse, getClientIp, randomHex } from '../_lib/helpers.js';
import {
  hashPassword, verifyPassword, createToken, verifyToken,
  setAuthCookie, clearAuthCookie, getCookie, COOKIE_NAME,
} from '../_lib/auth.js';
import { isInstalled } from '../_lib/db.js';

/** 获取 JWT 密钥，未设置时返回 null */
function getJwtSecret(env) {
  if (!env.JWT_SECRET) {
    console.error('JWT_SECRET environment variable not set');
    return null;
  }
  return env.JWT_SECRET;
}

/** GET：检查登录状态 */
export async function onRequestGet({ request, env }) {
  const token = getCookie(request);
  if (!token) return jsonResponse({ authenticated: false });

  const secret = getJwtSecret(env);
  if (!secret) return jsonResponse({ authenticated: false });
  const payload = await verifyToken(token, secret);
  if (!payload) return jsonResponse({ authenticated: false });

  return jsonResponse({
    authenticated: true,
    username: payload.uname || 'admin',
    csrf_token: payload.csrf || '',
  });
}

/** POST：登录 */
export async function onRequestPost({ request, env }) {
  const installed = await isInstalled(env);
  if (!installed) {
    return jsonResponse({ error: '系统未安装' }, 500);
  }

  const formData = await request.formData();
  const username = (formData.get('username') || '').trim();
  const password = formData.get('password') || '';
  const ip = getClientIp(request);

  // 登录限流：同一 IP 5 分钟内超过 5 次失败则锁定 30 秒
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM login_attempts WHERE ip = ? AND attempted_at > datetime('now', '-5 minutes')"
  ).bind(ip).first();
  if (recent && recent.count >= 5) {
    return jsonResponse({ error: '尝试次数过多，请稍后再试' }, 429);
  }

  // 查询用户
  const user = await env.DB.prepare(
    'SELECT id, username, password FROM users WHERE username = ? LIMIT 1'
  ).bind(username).first();

  if (user && await verifyPassword(password, user.password)) {
    // 登录成功：清除该 IP 的失败记录
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();

    // 创建 JWT 令牌（内嵌 CSRF 令牌）
    const csrfToken = randomHex(32);
    const secret = getJwtSecret(env);
    if (!secret) {
      return jsonResponse({ error: '服务器配置错误' }, 500);
    }
    const token = await createToken(
      { uid: user.id, uname: user.username, csrf: csrfToken },
      secret
    );

    const isSecure = new URL(request.url).protocol === 'https:';
    return jsonResponse(
      { success: true, username: user.username, csrf_token: csrfToken },
      200,
      { 'Set-Cookie': setAuthCookie(token, isSecure) }
    );
  }

  // 登录失败：记录尝试
  await env.DB.prepare(
    'INSERT INTO login_attempts (ip) VALUES (?)'
  ).bind(ip).run();

  return jsonResponse({ error: '用户名或密码错误' }, 401);
}

/** DELETE：登出 */
export async function onRequestDelete({ request, env }) {
  const isSecure = new URL(request.url).protocol === 'https:';
  return jsonResponse(
    { success: true },
    200,
    { 'Set-Cookie': clearAuthCookie(isSecure) }
  );
}
