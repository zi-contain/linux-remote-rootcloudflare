/**
 * 管理端 API（JSON 协议）
 *
 * 供前端 Dashboard 调用，统一返回 JSON。
 * 所有请求需登录认证；POST 请求需 CSRF 校验。
 *
 * 操作（action 参数）：
 *   get_agents      GET   获取 Agent 列表
 *   send_command    POST  下发命令
 *   get_result      GET   获取单条命令结果
 *   get_history     GET   获取命令历史
 *   update_remark   POST  更新备注
 *   delete_agent    POST  删除 Agent
 *   get_install_cmd GET   生成一键植入命令
 */

import { jsonResponse, getBaseUrl, b64encode, randomHex } from '../_lib/helpers.js';
import { requireAuth, verifyCsrf } from '../_lib/auth.js';
import { markOfflineAgents, getSetting, setSetting, ensureSettingsTable } from '../_lib/db.js';

/** 统一入口：根据 action 分发 */
async function handleRequest(context, method) {
  const { request, env } = context;

  // 登录校验
  const authResult = await requireAuth(request, env);
  if (!authResult.ok) return authResult.response;
  const { auth } = authResult;

  let action, formData;

  if (method === 'POST') {
    formData = await request.formData();
    action = formData.get('action') || '';
    // CSRF 校验
    if (!verifyCsrf(request, auth, formData)) {
      return jsonResponse({ error: 'CSRF 校验失败，请刷新页面后重试' }, 403);
    }
  } else {
    const url = new URL(request.url);
    action = url.searchParams.get('action') || '';
    formData = new FormData();
    // 将 query params 复制到 formData 以便统一处理
    for (const [k, v] of url.searchParams) {
      formData.append(k, v);
    }
  }

  switch (action) {
    case 'get_agents':
      return getAgents(env);

    case 'send_command':
      return sendCommand(env, formData);

    case 'get_result':
      return getResult(env, formData);

    case 'get_history':
      return getHistory(env, formData);

    case 'update_remark':
      return updateRemark(env, formData);

    case 'delete_agent':
      return deleteAgent(env, formData);

    case 'get_install_cmd':
      return getInstallCmd(request);

    case 'generate_api_key':
      return generateApiKey(env);

    case 'get_api_key':
      return getApiKey(env);

    default:
      return jsonResponse({ error: '未知操作' }, 400);
  }
}

/** 获取 Agent 列表 */
async function getAgents(env) {
  // 将超过 60 秒未心跳的 Agent 置为离线
  await markOfflineAgents(env);

  const result = await env.DB.prepare(
    `SELECT agent_id, hostname, ip_address, os_info, remark, status, last_seen, created_at
     FROM agents ORDER BY status DESC, last_seen DESC`
  ).all();

  const agents = (result.results || []).map((row) => ({
    agent_id: row.agent_id,
    hostname: row.hostname || '',
    ip_address: row.ip_address || '',
    os_info: row.os_info || '',
    remark: row.remark || '',
    status: row.status,
    status_text: row.status === 1 ? '在线' : '离线',
    last_seen: row.last_seen ? row.last_seen + 'Z' : '从未',
    created_at: row.created_at ? row.created_at + 'Z' : '从未',
  }));

  return jsonResponse({ agents });
}

/** 下发命令 */
async function sendCommand(env, formData) {
  const agentId = (formData.get('agent_id') || '').trim();
  const command = (formData.get('command') || '').trim();

  if (!agentId || !command) {
    return jsonResponse({ error: '参数不能为空' }, 400);
  }

  // 校验 Agent 是否存在
  const agent = await env.DB.prepare('SELECT id FROM agents WHERE agent_id = ?').bind(agentId).first();
  if (!agent) {
    return jsonResponse({ error: 'Agent不存在' }, 404);
  }

  // 写入待执行命令
  const result = await env.DB.prepare(
    "INSERT INTO commands (agent_id, command, status) VALUES (?, ?, 'pending')"
  ).bind(agentId, command).run();

  return jsonResponse({
    success: true,
    command_id: result.meta.last_row_id,
    command,
  });
}

/** 获取单条命令结果 */
async function getResult(env, formData) {
  const cmdId = parseInt(formData.get('cmd_id') || '0', 10);
  if (!cmdId) {
    return jsonResponse({ error: '参数缺失' }, 400);
  }

  const cmd = await env.DB.prepare(
    'SELECT id, agent_id, command, status, result, exit_code, created_at, executed_at FROM commands WHERE id = ?'
  ).bind(cmdId).first();

  if (!cmd) {
    return jsonResponse({ error: '命令不存在' }, 404);
  }

  return jsonResponse({
    id: cmd.id,
    status: cmd.status,
    result: cmd.result || '',
    exit_code: cmd.exit_code !== null ? cmd.exit_code : null,
    command: cmd.command,
    executed_at: cmd.executed_at ? cmd.executed_at + 'Z' : null,
  });
}

/** 获取命令历史（最近 50 条） */
async function getHistory(env, formData) {
  const agentId = formData.get('agent_id') || '';

  const result = await env.DB.prepare(
    `SELECT id, command, status, result, exit_code, created_at, executed_at
     FROM commands WHERE agent_id = ? ORDER BY id DESC LIMIT 50`
  ).bind(agentId).all();

  const history = (result.results || []).map((row) => ({
    id: row.id,
    command: row.command,
    status: row.status,
    result: row.result || '',
    exit_code: row.exit_code !== null ? row.exit_code : null,
    created_at: row.created_at ? row.created_at + 'Z' : '从未',
    executed_at: row.executed_at ? row.executed_at + 'Z' : '从未',
  }));

  return jsonResponse({ history });
}

/** 更新备注 */
async function updateRemark(env, formData) {
  const agentId = formData.get('agent_id') || '';
  const remark = formData.get('remark') || '';

  await env.DB.prepare('UPDATE agents SET remark = ? WHERE agent_id = ?')
    .bind(remark, agentId).run();

  return jsonResponse({ success: true });
}

/** 删除 Agent 及其关联命令 */
async function deleteAgent(env, formData) {
  const agentId = formData.get('agent_id') || '';

  await env.DB.prepare('DELETE FROM commands WHERE agent_id = ?').bind(agentId).run();
  await env.DB.prepare('DELETE FROM agents WHERE agent_id = ?').bind(agentId).run();

  return jsonResponse({ success: true });
}

/** 生成一键植入命令 */
async function getInstallCmd(request) {
  const baseUrl = getBaseUrl(request);
  const installCmd = `curl -sSL '${baseUrl}/api/agent-sh' | bash`;
  return jsonResponse({ install_cmd: installCmd, base_url: baseUrl });
}

/** 生成 API 密钥（用于外部控制接口） */
async function generateApiKey(env) {
  await ensureSettingsTable(env);
  const key = 'rak_' + randomHex(24);
  await setSetting(env, 'api_key', key);
  return jsonResponse({ success: true, api_key: key });
}

/** 获取当前 API 密钥 */
async function getApiKey(env) {
  await ensureSettingsTable(env);
  const key = await getSetting(env, 'api_key');
  return jsonResponse({ api_key: key || '' });
}

export async function onRequestGet(context) {
  return handleRequest(context, 'GET');
}

export async function onRequestPost(context) {
  return handleRequest(context, 'POST');
}
