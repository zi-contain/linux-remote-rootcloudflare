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

/** 将超过 60 秒未心跳的 Agent 标记为离线（适配 20 秒连接周期 + 重连间隙） */
export async function markOfflineAgents(env) {
  await env.DB.prepare(
    "UPDATE agents SET status = 0 WHERE last_seen IS NOT NULL AND last_seen < datetime('now', '-60 seconds') AND status = 1"
  ).run();
}

/** 获取设置值 */
export async function getSetting(env, key) {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return row ? row.value : null;
  } catch {
    return null;
  }
}

/** 设置值 */
export async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
  ).bind(key, value, value).run();
}

/** 确保 settings 表存在（兼容旧部署） */
export async function ensureSettingsTable(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )`
    ).run();
  } catch {
    // 忽略错误（表已存在）
  }
}

/** 确保 agents 表有 token 列（兼容旧部署） */
export async function ensureAgentTokenColumn(env) {
  try {
    await env.DB.prepare('SELECT token FROM agents LIMIT 1').first();
  } catch {
    try {
      await env.DB.prepare('ALTER TABLE agents ADD COLUMN token TEXT').run();
    } catch {
      // 列已存在或其他错误
    }
  }
}

/** 确保 agents 表有系统信息列（兼容旧部署） */
export async function ensureSysInfoColumns(env) {
  const columns = [
    'sys_os TEXT',
    'sys_kernel TEXT',
    'sys_arch TEXT',
    'sys_uptime INTEGER DEFAULT 0',
    'sys_mem_total INTEGER DEFAULT 0',
    'sys_mem_used INTEGER DEFAULT 0',
    'sys_disk_total INTEGER DEFAULT 0',
    'sys_disk_used INTEGER DEFAULT 0',
    'sys_cpu_load INTEGER DEFAULT 0',
    'sys_cpu_cores INTEGER DEFAULT 1',
  ];
  for (const colDef of columns) {
    const colName = colDef.split(' ')[0];
    try {
      await env.DB.prepare(`SELECT ${colName} FROM agents LIMIT 1`).first();
    } catch {
      try {
        await env.DB.prepare(`ALTER TABLE agents ADD COLUMN ${colDef}`).run();
      } catch {
        // 列已存在或其他错误
      }
    }
  }
}
