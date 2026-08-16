/**
 * 安装 API
 *
 * GET  /api/install       检查安装状态
 * POST /api/install       执行安装（创建管理员账户）
 *
 * 安装流程：
 * 1. 用户通过 wrangler 创建 D1 数据库并执行 schema.sql
 * 2. 访问网站 → 前端检测未安装 → 跳转安装页
 * 3. 填写管理员用户名/密码 → POST /api/install
 * 4. 安装成功 → 跳转登录页
 */

import { jsonResponse } from '../_lib/helpers.js';
import { hashPassword } from '../_lib/auth.js';
import { isInstalled } from '../_lib/db.js';

/** GET：检查安装状态 */
export async function onRequestGet({ env }) {
  const installed = await isInstalled(env);
  return jsonResponse({ installed });
}

/** POST：执行安装 */
export async function onRequestPost({ request, env }) {
  // 已安装则拒绝
  const installed = await isInstalled(env);
  if (installed) {
    return jsonResponse({ error: '系统已安装，如需重新设置请先清除数据库' }, 400);
  }

  const formData = await request.formData();
  const username = (formData.get('adminUser') || '').trim();
  const password = formData.get('adminPass') || '';
  const password2 = formData.get('adminPass2') || '';

  // 字段校验
  const errors = [];
  if (username.length < 3) {
    errors.push('管理员用户名至少 3 个字符');
  }
  if (password.length < 6) {
    errors.push('管理员密码至少 6 个字符');
  }
  if (password !== password2) {
    errors.push('两次输入的密码不一致');
  }
  if (errors.length > 0) {
    return jsonResponse({ errors }, 400);
  }

  try {
    // 哈希密码
    const hash = await hashPassword(password);

    // 写入管理员账户
    await env.DB.prepare(
      'INSERT INTO users (username, password) VALUES (?, ?)'
    ).bind(username, hash).run();

    return jsonResponse({ success: true });
  } catch (e) {
    // 用户名已存在（UNIQUE 约束）
    if (String(e.message || '').includes('UNIQUE')) {
      return jsonResponse({ errors: ['用户名已存在'] }, 400);
    }
    return jsonResponse({ errors: ['安装失败：' + (e.message || '未知错误')] }, 500);
  }
}
