/**
 * 认证模块：JWT 令牌创建/验证、密码哈希、CSRF、登录限流
 *
 * 使用 Web Crypto API（CF Workers 原生支持）实现：
 * - HMAC-SHA256 签名的 JWT 令牌（无状态会话）
 * - PBKDF2-SHA256 密码哈希
 * - CSRF 令牌嵌入 JWT 负载
 */

import { b64urlStr, b64urlBuf, b64urlDecodeStr, b64urlDecodeBytes, randomHex, jsonResponse } from './helpers.js';

const COOKIE_NAME = 'ra_session';
const TOKEN_TTL = 7 * 24 * 3600; // 7 天（秒）
const PBKDF2_ITERATIONS = 100000;

/* ----------------------------------------------------------------- */
/*  密码哈希（PBKDF2-SHA256）                                         */
/* ----------------------------------------------------------------- */

/** 哈希密码，返回 "pbkdf2:iterations:salt:hash" 格式字符串 */
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = randomHex(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = b64urlBuf(bits);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

/** 验证密码是否匹配哈希 */
export async function verifyPassword(password, storedHash) {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const expectedHash = parts[3];

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' },
      keyMaterial, 256
    );
    const actualHash = b64urlBuf(bits);
    return constantTimeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

/** 恒定时间字符串比较 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/* ----------------------------------------------------------------- */
/*  JWT 令牌                                                          */
/* ----------------------------------------------------------------- */

/** 创建 JWT 令牌 */
export async function createToken(payload, secret) {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
  };

  const headerB64 = b64urlStr(JSON.stringify(header));
  const payloadB64 = b64urlStr(JSON.stringify(fullPayload));
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigB64 = b64urlBuf(signature);

  return `${data}.${sigB64}`;
}

/** 验证 JWT 令牌，返回负载或 null */
export async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const signature = b64urlDecodeBytes(sigB64);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
  if (!valid) return null;

  try {
    const payload = JSON.parse(b64urlDecodeStr(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- */
/*  Cookie 操作                                                       */
/* ----------------------------------------------------------------- */

/** 设置认证 Cookie（isSecure 根据请求协议决定） */
export function setAuthCookie(token, isSecure = true) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + TOKEN_TTL,
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** 清除认证 Cookie */
export function clearAuthCookie(isSecure = true) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

/** 从请求头中提取 Cookie 值 */
export function getCookie(request, name = COOKIE_NAME) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1].trim() : null;
}

export { COOKIE_NAME };

/* ----------------------------------------------------------------- */
/*  认证校验                                                          */
/* ----------------------------------------------------------------- */

/**
 * 校验请求是否已登录，返回 { authenticated, payload, csrfToken } 或 { authenticated: false }
 */
export async function checkAuth(request, env) {
  const token = getCookie(request);
  if (!token) return { authenticated: false };

  const secret = env.JWT_SECRET || 'default-secret-change-me';
  const payload = await verifyToken(token, secret);
  if (!payload) return { authenticated: false };

  return {
    authenticated: true,
    payload,
    csrfToken: payload.csrf || '',
    username: payload.uname || 'admin',
    userId: payload.uid,
  };
}

/**
 * 要求请求已登录，否则返回 401 JSON 响应
 * 返回 { ok: true, auth } 或 { ok: false, response }
 */
export async function requireAuth(request, env) {
  const auth = await checkAuth(request, env);
  if (!auth.authenticated) {
    return {
      ok: false,
      response: jsonResponse({ error: '未登录' }, 401),
    };
  }
  return { ok: true, auth };
}

/**
 * CSRF 校验：POST 请求需携带 X-CSRF-Token 头或表单中的 csrf_token 字段
 */
export function verifyCsrf(request, auth, formData) {
  const headerToken = request.headers.get('X-CSRF-Token') || '';
  const formToken = formData?.get('csrf_token') || '';
  const token = headerToken || formToken;
  const known = auth.csrfToken || '';
  return token !== '' && known !== '' && token === known;
}


