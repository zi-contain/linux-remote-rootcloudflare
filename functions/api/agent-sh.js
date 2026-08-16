/**
 * 被控端 Agent 脚本生成器
 *
 * 访问 /api/agent-sh 即返回一段 bash 脚本，配合
 * `curl -sSL 'https://你的域名/api/agent-sh' | bash` 一键安装。
 *
 * 脚本内部使用占位符替换注入动态地址，然后 base64 编码包装为自解压 loader。
 * 与原 PHP 版本的差异：不使用 gzip 压缩（Workers 无 gzip 工具），
 * 仅 base64 编码混淆，功能完全一致。
 */

import { AGENT_SCRIPT_TEMPLATE } from '../_lib/agent-template.js';

export async function onRequestGet({ request }) {
  const baseUrl = new URL(request.url).origin;
  const apiUrl = `${baseUrl}/api/agent`;
  const connectUrl = `${baseUrl}/api/connect`;
  const scriptUrl = `${baseUrl}/api/agent-sh`;

  // 注入动态地址（占位符替换）
  let script = AGENT_SCRIPT_TEMPLATE
    .replace(/__API_URL__/g, apiUrl)
    .replace(/__CONNECT_URL__/g, connectUrl)
    .replace(/__SCRIPT_URL__/g, scriptUrl);

  // base64 编码混淆（不使用 gzip，仅 base64）
  const payload = btoa(unescape(encodeURIComponent(script)));

  // 包装为自解压 loader
  // 关键：整个 eval 包裹在子 shell () 中，防止脚本内 exit 杀掉 SSH 登录 shell
  const loader =
    '#!/usr/bin/env bash\n' +
    '# ============================================================\n' +
    '# 远控管理系统 - 被控端 Agent（已加密，请勿手动编辑）\n' +
    '# 由服务端 /api/agent-sh 动态生成并混淆输出\n' +
    '# ============================================================\n' +
    '( eval "$(printf %s ' + payload + ' | base64 -d 2>/dev/null)" )\n';

  return new Response(loader, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
