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
import { isInstalled } from '../_lib/db.js';

export async function onRequestPost({ request, env }) {
  if (!await isInstalled(env)) {
    return textResponse('ERROR:系统未安装\n');
  }

  const formData = await request.formData();
  const agentId = formData.get('agent_id') || '';
  const hostname = formData.get('hostname') || '';
  const ip = formData.get('ip') || getClientIp(request);

  if (!agentId) {
    return textResponse('ERROR:缺少agent_id\n');
  }

  // 校验 Agent 是否存在
  const agent = await env.DB.prepare('SELECT id FROM agents WHERE agent_id = ?').bind(agentId).first();
  if (!agent) {
    return textResponse('ERROR:agent不存在\n');
  }

  // 更新心跳与主机信息
  await env.DB.prepare(
    `UPDATE agents
     SET status = 1, last_seen = datetime('now'),
         hostname = CASE WHEN ? = '' THEN hostname ELSE ? END,
         ip_address = CASE WHEN ? = '' THEN ip_address ELSE ? END
     WHERE agent_id = ?`
  ).bind(hostname, hostname, ip, ip, agentId).run();

  // 流式响应
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      // 连接确认
      controller.enqueue(encoder.encode(`OK ${agentId}\n`));

      const deadline = Date.now() + 12000; // 单次连接最长 12 秒
      const pollInterval = 1000;            // 探测间隔 1 秒
      const beatEvery = 5000;               // 每 5 秒发一次心跳
      let lastBeat = Date.now();

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

        // 更新 last_seen
        await env.DB.prepare(
          "UPDATE agents SET last_seen = datetime('now') WHERE agent_id = ?"
        ).bind(agentId).run();

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
