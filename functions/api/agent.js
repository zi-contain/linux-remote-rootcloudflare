/**
 * Agent 通信 API（纯文本协议）
 *
 * 与部署在被控端的 bash 客户端通信。
 * 响应均为纯文本，不使用 JSON，不加 CSRF（机器客户端）。
 *
 * 操作（action 参数）：
 *   register   注册（首次安装后调用，以设备 UUID 作为 Agent ID）
 *   checkin    心跳/拉取命令（长轮询，最多 ~10s）
 *   result     上报命令执行结果
 */

import { textResponse, getClientIp, b64encode, b64decode, randomHex } from '../_lib/helpers.js';
import { isInstalled, ensureAgentTokenColumn } from '../_lib/db.js';
import { constantTimeEqual } from '../_lib/auth.js';

/** 恒定时间验证 Agent 令牌 */
async function verifyAgentToken(env, agentId, token) {
  if (!token) return false;
  const agent = await env.DB.prepare(
    'SELECT token FROM agents WHERE agent_id = ?'
  ).bind(agentId).first();

  if (!agent) return false;

  // 兼容旧 Agent（无令牌）：允许首次连接，自动补发令牌
  if (!agent.token) return null;

  return constantTimeEqual(token, agent.token);
}

/** 统一入口 */
async function handleRequest(context) {
  const { request, env } = context;

  if (!await isInstalled(env)) {
    return textResponse('ERROR:系统未安装');
  }

  // 确保 token 列存在（兼容旧部署）
  await ensureAgentTokenColumn(env);

  const formData = await request.formData();
  const action = formData.get('action') || '';

  switch (action) {
    case 'register':
      return register(env, formData, request);

    case 'checkin':
      return checkin(env, formData, request);

    case 'result':
      return result(env, formData);

    default:
      return textResponse('ERROR:未知操作');
  }
}

/** 注册：以设备 UUID 作为 Agent ID，同设备去重复用 */
async function register(env, formData, request) {
  const hostname = formData.get('hostname') || '';
  const osInfo = formData.get('os_info') || '';
  let deviceUuid = (formData.get('device_uuid') || '').trim();
  const ip = getClientIp(request);

  // 设备 UUID 缺失或异常时回退为随机 ID
  if (!deviceUuid || deviceUuid.length > 64) {
    deviceUuid = randomHex(16);
  }

  // 生成 Agent 令牌
  const agentToken = randomHex(32);

  // 查重：同设备 UUID 已注册过则复用原记录
  const existing = await env.DB.prepare(
    'SELECT agent_id, token FROM agents WHERE agent_id = ?'
  ).bind(deviceUuid).first();

  if (existing) {
    // 已存在：刷新在线状态与主机信息
    // 若已有令牌则返回旧令牌，否则生成新令牌
    const tokenToReturn = existing.token || agentToken;
    if (!existing.token) {
      await env.DB.prepare(
        'UPDATE agents SET status = 1, last_seen = datetime(\'now\'), token = ? WHERE agent_id = ?'
      ).bind(tokenToReturn, deviceUuid).run();
    } else {
      await env.DB.prepare(
        `UPDATE agents
         SET status = 1, last_seen = datetime('now'),
             hostname = CASE WHEN ? = '' THEN hostname ELSE ? END,
             ip_address = CASE WHEN ? = '' THEN ip_address ELSE ? END,
             os_info = CASE WHEN ? = '' THEN os_info ELSE ? END
         WHERE agent_id = ?`
      ).bind(hostname, hostname, ip, ip, osInfo, osInfo, deviceUuid).run();
    }
    return textResponse('AGENT_ID:' + existing.agent_id + '\nTOKEN:' + tokenToReturn);
  }

  // 首次注册
  await env.DB.prepare(
    `INSERT INTO agents (agent_id, hostname, ip_address, os_info, token, status, last_seen)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
  ).bind(deviceUuid, hostname, ip, osInfo, agentToken).run();
  return textResponse('AGENT_ID:' + deviceUuid + '\nTOKEN:' + agentToken);
}

/** 心跳/拉取命令（长轮询，最多 ~10s） */
async function checkin(env, formData, request) {
  const agentId = formData.get('agent_id') || '';
  const hostname = formData.get('hostname') || '';
  const token = formData.get('token') || '';
  // 始终使用服务端观测到的连接 IP（CF cf-connecting-ip），不信任 Agent 自报 IP
  const ip = getClientIp(request);

  if (!agentId) {
    return textResponse('ERROR:缺少agent_id');
  }

  // 验证 Agent 令牌
  const tokenValid = await verifyAgentToken(env, agentId, token);
  if (tokenValid === false) {
    return textResponse('ERROR:认证失败');
  }

  // 校验 Agent 是否存在
  const agent = await env.DB.prepare('SELECT id FROM agents WHERE agent_id = ?').bind(agentId).first();
  if (!agent) {
    return textResponse('ERROR:agent不存在');
  }

  // 更新心跳
  await env.DB.prepare(
    `UPDATE agents
     SET status = 1, last_seen = datetime('now'),
         hostname = CASE WHEN ? = '' THEN hostname ELSE ? END,
         ip_address = CASE WHEN ? = '' THEN ip_address ELSE ? END
     WHERE agent_id = ?`
  ).bind(hostname, hostname, ip, ip, agentId).run();

  // 长轮询：最多等待 10 秒
  const longPoll = 10; // 秒
  const deadline = Date.now() + longPoll * 1000;
  let commands = [];

  while (Date.now() < deadline) {
    const result = await env.DB.prepare(
      `SELECT id, command FROM commands
       WHERE agent_id = ? AND status = 'pending'
       ORDER BY id ASC LIMIT 10`
    ).bind(agentId).all();

    commands = result.results || [];

    if (commands.length > 0) {
      break; // 有命令，立即返回
    }

    // 等待 1 秒后重试
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (commands.length === 0) {
    return textResponse('NO_COMMANDS');
  }

  // 输出命令并标记为 executing
  let output = 'COMMANDS:\n';
  for (const cmd of commands) {
    await env.DB.prepare(
      "UPDATE commands SET status = 'executing', executed_at = datetime('now') WHERE id = ?"
    ).bind(cmd.id).run();
    output += cmd.id + '\t' + b64encode(cmd.command) + '\n';
  }

  return textResponse(output);
}

/** 上报命令执行结果 */
async function result(env, formData) {
  const agentId = formData.get('agent_id') || '';
  const cmdId = formData.get('cmd_id') || '';
  const resultText = formData.get('result') || '';
  const exitCode = parseInt(formData.get('exit_code') || '0', 10);
  const token = formData.get('token') || '';

  if (!agentId || !cmdId) {
    return textResponse('ERROR:参数缺失');
  }

  // 验证 Agent 令牌
  const tokenValid = await verifyAgentToken(env, agentId, token);
  if (tokenValid === false) {
    return textResponse('ERROR:认证失败');
  }

  // 校验命令归属该 Agent
  const cmd = await env.DB.prepare(
    'SELECT id FROM commands WHERE id = ? AND agent_id = ?'
  ).bind(cmdId, agentId).first();

  if (!cmd) {
    return textResponse('ERROR:命令不存在');
  }

  // 写回执行结果
  await env.DB.prepare(
    "UPDATE commands SET status = 'completed', result = ?, exit_code = ?, executed_at = datetime('now') WHERE id = ?"
  ).bind(resultText, exitCode, cmdId).run();

  return textResponse('OK');
}

export async function onRequestPost(context) {
  return handleRequest(context);
}
