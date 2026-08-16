/**
 * 通用辅助函数：JSON 响应、纯文本响应、URL 解析、base64、时间格式化等
 */

/** JSON 响应 */
export function jsonResponse(data, code = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/** 纯文本响应 */
export function textResponse(text, code = 200, extraHeaders = {}) {
  return new Response(text, {
    status: code,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    },
  });
}

/** 重定向响应 */
export function redirectResponse(url) {
  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}

/** 获取客户端真实 IP（兼容 CF 代理头） */
export function getClientIp(request) {
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp;
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return '0.0.0.0';
}

/** 从请求中推断基础 URL */
export function getBaseUrl(request) {
  const url = new URL(request.url);
  return url.origin;
}

/** UTF-8 安全的 base64 编码 */
export function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/** UTF-8 安全的 base64 解码 */
export function b64decode(str) {
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch {
    return str;
  }
}

/** 生成随机十六进制字符串 */
export function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64url 编码（字符串输入） */
function b64urlStr(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 编码（ArrayBuffer 输入） */
function b64urlBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码为字符串 */
function b64urlDecodeStr(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

/** base64url 解码为 Uint8Array */
function b64urlDecodeBytes(str) {
  const decoded = b64urlDecodeStr(str);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

export { b64urlStr, b64urlBuf, b64urlDecodeStr, b64urlDecodeBytes };

/** HTML 转义 */
export function escHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 把时间字符串转为相对时间（如"3 分钟前"） */
export function relativeTime(dateStr) {
  if (!dateStr || dateStr === '从未') return '从未';
  const ts = new Date(dateStr.replace(/-/g, '/')).getTime();
  if (isNaN(ts)) return dateStr;
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 5) return '刚刚';
  if (diff < 60) return diff + ' 秒前';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}

/** 格式化时间为 YYYY-MM-DD HH:mm:ss */
export function formatTime(dateStr) {
  if (!dateStr) return '从未';
  const d = new Date(dateStr.replace(/-/g, '/'));
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
