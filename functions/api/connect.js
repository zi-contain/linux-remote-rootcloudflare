/**
 * Agent 流式连接端点（双向实时通信）
 *
 * 取代长轮询 checkin：Agent 保持一条长连接（最长 ~12s），
 * 服务端在连接内持续探测待执行命令，一旦发现立即逐行推送。
 *
 * CF Workers 通过 ReadableStream 实现流式响应，
 * 轮询 D1 每 1 秒一次，最多 12 秒（12 次 D1 查询，远低于 subrequest 限制）。
 *
 * 纯文本行协议（每行一条指令，\n 结尾）：
 *   OK <agent_id>          连接确认
 *   CMD <cmd_id> <base64>  下发命令（可连续多条）
 *   PING                   心跳保活（约每 5s）
 *   END                    服务端即将关闭连接，Agent 应重连
 *   ERROR:<信息>           错误
 */

import { textResponse, getClientIp, b64encode } from '../_lib/helpers.js';
import { isInstalled, ensureAgentTokenColumn } from '../_lib/db.js';
import { constantTimeEqual } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!await isInstalled(env)) {
    return textResponse('ERROR:系统未安装\n');
  }

  // 确保 token 列存在（兼容旧部署）
  await ensureAgentTokenColumn(env);

  const formData = await request.formData();
  const agentId = formData.get('agent_id') || '';
  const hostname = formData.get('hostname') || '';
  // 始终使用服务端观测到的连接 IP（CF cf-connecting-ip），不信任 Agent 自报 IP
  const ip = getClientIp(request);
  const token = formData.get('token') || '';

  if (!agentId) {
    return textResponse('ERROR:缺少agent_id\n');
  }

  // 校验 Agent 是否存在并验证令牌
  const agent = await env.DB.prepare('SELECT id, token FROM agents WHERE agent_id = ?').bind(agentId).first();
  if (!agent) {
    return textResponse('ERROR:agent不存在\n');
  }

  // 验证令牌（兼容旧 Agent：无令牌时允许连接）
  if (agent.token) {
    if (!token || !constantTimeEqual(token, agent.token)) {
      return textResponse('ERROR:认证失败\n');
    }
  }

  // 更新心跳与主机信息
  await env.DB.prepare(
    `UPDATE agents
     SET status = 1, last_seen = datetime('now'),
         hostname = CASE WHEN ? = '' THEN hostname ELSE ? END,
         ip_address = CASE WHEN ? = '' THEN ip_address ELSE ? END
     WHERE agent_id = ?`
  ).bind(hostname, hostname, ip, ip, agentId).run();

  // 概率清理旧命令记录（约每 20 次连接执行一次，减少 D1 writes 消耗）
  // 保留最近 7 天的命令记录，自动删除更早的
  if (Math.random() < 0.05) {
    await env.DB.prepare(
      `DELETE FROM commands WHERE created_at < datetime('now', '-7 days')`
    ).run();
  }

  // 流式响应
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      // 连接确认
      controller.enqueue(encoder.encode(`OK ${agentId}\n`));

      const deadline = Date.now() + 20000; // 单次连接最长 20 秒（平衡延迟与 D1 消耗）
      const pollInterval = 250;             // 探测间隔 0.25 秒（命令下发延迟 ≤250ms）
      const beatEvery = 8000;               // 每 8 秒发一次心跳
      let lastBeat = Date.now();
      // last_seen 已在连接初始时更新，25 秒后重连会再次更新，循环内无需重复写入

      while (Date.now() < deadline && !cancelled) {
        // 探测待执行命令
        const result = await env.DB.prepare(
          `SELECT id, command FROM commands
           WHERE agent_id = ? AND status = 'pending'
           ORDER BY id ASC LIMIT 10`
        ).bind(agentId).all();

        const commands = result.results || [];
        if (commands.length > 0) {
          for (const cmd of commands) {
            await env.DB.prepare(
              "UPDATE commands SET status = 'executing', executed_at = datetime('now') WHERE id = ?"
            ).bind(cmd.id).run();
            controller.enqueue(encoder.encode(`CMD ${cmd.id} ${b64encode(cmd.command)}\n`));
          }
        }

        // 心跳保活
        const now = Date.now();
        if (now - lastBeat >= beatEvery) {
          controller.enqueue(encoder.encode('PING\n'));
          lastBeat = now;
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      // 连接生命周期结束
      try {
        controller.enqueue(encoder.encode('END\n'));
        controller.close();
      } catch {
        // controller 已关闭
      }
    },

    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
    },
  });
}
