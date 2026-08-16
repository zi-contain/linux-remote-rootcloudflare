/**
 * 命令结果 SSE（Server-Sent Events）端点
 *
 * 浏览器通过 EventSource 订阅某条命令的结果。服务端在结果就绪时
 * 即时推送，取代前端固定间隔轮询。
 *
 * CF Workers 通过 ReadableStream 实现 SSE 流式响应，
 * 轮询 D1 每 1 秒一次，最多 15 秒。
 *
 * 协议：
 *   - 连接建立：发送注释心跳 `: connected`
 *   - 结果就绪：默认 data 事件，负载为命令结果 JSON
 *   - 等待超时：event: timeout
 *   - 服务端错误：event: fail
 */

import { jsonResponse } from '../_lib/helpers.js';
import { checkAuth } from '../_lib/auth.js';
import { isInstalled } from '../_lib/db.js';

export async function onRequestGet({ request, env }) {
  // 登录校验
  const auth = await checkAuth(request, env);
  if (!auth.authenticated) {
    return sseFailResponse('未登录', 401);
  }

  if (!await isInstalled(env)) {
    return sseFailResponse('系统未安装', 500);
  }

  const url = new URL(request.url);
  const cmdId = parseInt(url.searchParams.get('cmd_id') || '0', 10);
  if (cmdId <= 0) {
    return sseFailResponse('参数缺失', 400);
  }

  // SSE 流式响应
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (text) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // controller 已关闭
        }
      };

      // 连接建立提示
      enqueue(': connected\n\n');

      const deadline = Date.now() + 15000; // 最多等待 15 秒
      const pollInterval = 1000;            // 探测间隔 1 秒
      let beatCount = 0;
      let resolved = false;

      while (Date.now() < deadline && !cancelled) {
        const cmd = await env.DB.prepare(
          'SELECT status, result, exit_code, command FROM commands WHERE id = ?'
        ).bind(cmdId).first();

        if (!cmd) {
          enqueue('event: fail\ndata: 命令不存在\n\n');
          resolved = true;
          break;
        }

        if (cmd.status === 'completed' || cmd.status === 'failed') {
          const payload = JSON.stringify({
            id: cmdId,
            status: cmd.status,
            result: cmd.result || '',
            exit_code: cmd.exit_code !== null ? cmd.exit_code : null,
            command: cmd.command,
          });
          enqueue(`data: ${payload}\n\n`);
          resolved = true;
          break;
        }

        // 心跳注释：每 ~5 秒发一次
        beatCount++;
        if (beatCount % 5 === 0) {
          enqueue(': beat\n\n');
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      // 等待超时
      if (!resolved) {
        enqueue(`event: timeout\ndata: ${JSON.stringify({ id: cmdId })}\n\n`);
      }

      try {
        controller.close();
      } catch {
        // 已关闭
      }
    },

    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
    },
  });
}

/** SSE 错误响应 */
function sseFailResponse(message, code) {
  return new Response(`event: fail\ndata: ${message}\n\n`, {
    status: code,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}
