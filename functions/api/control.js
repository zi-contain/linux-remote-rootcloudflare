/**
 * 外部控制 API（JSON 协议）
 *
 * 供外部程序通过 API 密钥控制 Agent，区别于管理端的 Cookie 认证。
 * 认证方式：Authorization: Bearer <api_key>
 * API 密钥存储在 D1 settings 表中，通过 getSetting(env, 'api_key') 获取。
 *
 * 操作（action 参数，GET 走 query、POST 走表单字段）：
 *   list_agents    获取所有 Agent 列表
 *   send_command   下发命令（需 agent_id、command）
 *   get_result     获取单条命令结果（需 cmd_id）
 *   get_history    获取命令历史（可选 agent_id 过滤）
 *   get_agent      获取单个 Agent 信息（需 agent_id）
 */

import { jsonResponse, getBaseUrl, b64encode } from '../_lib/helpers.js';
import { isInstalled, markOfflineAgents, getSetting, ensureSettingsTable } from '../_lib/db.js';

/** 从 Authorization 头解析 Bearer 令牌 */
function getBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

/** 统一入口：认证 + 根据 action 分发 */
async function handleRequest(context, method) {
  const { request, env } = context;

  // 确保 settings 表存在（兼容旧部署，以便读取 api_key）
  await ensureSettingsTable(env);

  // 检查系统是否已安装
  if (!(await isInstalled(env))) {
    return jsonResponse({ error: '系统未安装' }, 500);
  }

  // API 密钥认证：从 settings 读取密钥并与 Bearer 令牌比对
  const apiKey = await getSetting(env, 'api_key');
  const token = getBearerToken(request);
  if (!apiKey || !token || apiKey !== token) {
    return jsonResponse({ error: '无效的API密钥' }, 401);
  }

  // 解析 action 与参数：POST 读 formData，GET 读 query
  let action, formData;
  if (method === 'POST') {
    formData = await request.formData();
    action = formData.get('action') || '';
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
    case 'list_agents':
      return listAgents(env);

    case 'send_command':
      return sendCommand(env, formData);

    case 'get_result':
      return getResult(env, formData);

    case 'get_history':
      return getHistory(env, formData);

    case 'get_agent':
      return getAgent(env, formData);

    default:
      return jsonResponse({ error: '未知操作' }, 400);
  }
}

/** 获取所有 Agent 列表 */
async function listAgents(env) {
  // 先将超过 90 秒未心跳的 Agent 置为离线
  await markOfflineAgents(env);

  const result = await env.DB.prepare(
    `SELECT agent_id, hostname, ip_address, os_info, remark, status, last_seen, created_at
     FROM agents ORDER BY status DESC, last_seen DESC`
  ).all();

  // 字段与管理端 admin.js 保持一致，datetime 字段追加 'Z' 表示 UTC
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

  // datetime 字段追加 'Z' 表示 UTC
  return jsonResponse({
    id: cmd.id,
    agent_id: cmd.agent_id,
    command: cmd.command,
    status: cmd.status,
    result: cmd.result || '',
    exit_code: cmd.exit_code !== null ? cmd.exit_code : null,
    created_at: cmd.created_at ? cmd.created_at + 'Z' : null,
    executed_at: cmd.executed_at ? cmd.executed_at + 'Z' : null,
  });
}

/** 获取命令历史（最近 50 条，可按 agent_id 过滤） */
async function getHistory(env, formData) {
  const agentId = formData.get('agent_id') || '';

  let result;
  if (agentId) {
    // 指定 Agent：过滤其命令历史
    result = await env.DB.prepare(
      `SELECT id, command, status, result, exit_code, created_at, executed_at
       FROM commands WHERE agent_id = ? ORDER BY id DESC LIMIT 50`
    ).bind(agentId).all();
  } else {
    // 未指定 Agent：返回全部命令历史
    result = await env.DB.prepare(
      `SELECT id, command, status, result, exit_code, created_at, executed_at
       FROM commands ORDER BY id DESC LIMIT 50`
    ).all();
  }

  // datetime 字段追加 'Z' 表示 UTC
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

/** 获取单个 Agent 信息 */
async function getAgent(env, formData) {
  const agentId = (formData.get('agent_id') || '').trim();
  if (!agentId) {
    return jsonResponse({ error: '参数不能为空' }, 400);
  }

  const row = await env.DB.prepare(
    'SELECT agent_id, hostname, ip_address, os_info, remark, status, last_seen, created_at FROM agents WHERE agent_id = ?'
  ).bind(agentId).first();

  if (!row) {
    return jsonResponse({ error: 'Agent不存在' }, 404);
  }

  // 字段与 list_agents 保持一致，datetime 字段追加 'Z' 表示 UTC
  return jsonResponse({
    agent_id: row.agent_id,
    hostname: row.hostname || '',
    ip_address: row.ip_address || '',
    os_info: row.os_info || '',
    remark: row.remark || '',
    status: row.status,
    status_text: row.status === 1 ? '在线' : '离线',
    last_seen: row.last_seen ? row.last_seen + 'Z' : '从未',
    created_at: row.created_at ? row.created_at + 'Z' : '从未',
  });
}

export async function onRequestGet(context) {
  return handleRequest(context, 'GET');
}

export async function onRequestPost(context) {
  return handleRequest(context, 'POST');
}
