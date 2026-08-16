/**
 * D1 数据库辅助函数
 *
 * 封装常用查询模式，统一错误处理。
 * D1 使用 SQLite 语法，与 MySQL 有以下差异：
 * - datetime('now') 替代 NOW()
 * - datetime('now', '-60 seconds') 替代 NOW() - INTERVAL 60 SECOND
 * - AUTOINCREMENT 替代 AUTO_INCREMENT
 * - IFNULL 替代 IFNULL（相同）
 */

/** 检查系统是否已安装（users 表中是否有管理员） */
export async function isInstalled(env) {
  try {
    const result = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
    return result && result.count > 0;
  } catch {
    // 表不存在说明未安装
    return false;
  }
}

/** 将超过 60 秒未心跳的 Agent 标记为离线 */
export async function markOfflineAgents(env) {
  await env.DB.prepare(
    "UPDATE agents SET status = 0 WHERE last_seen IS NOT NULL AND last_seen < datetime('now', '-60 seconds') AND status = 1"
  ).run();
}
