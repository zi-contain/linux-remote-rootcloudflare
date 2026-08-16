-- ============================================================
-- 远控管理系统 - D1 数据库 Schema
-- 用于 Cloudflare D1 (SQLite)
-- ============================================================

-- 管理员用户表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- 被控端 Agent 表（agent_id 即设备 UUID，同机器唯一）
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL UNIQUE,
    hostname TEXT,
    ip_address TEXT,
    os_info TEXT,
    remark TEXT,
    status INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- 命令记录表
CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    exit_code INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    executed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_agent ON commands(agent_id);
CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);

-- 登录尝试记录表（用于登录限流）
CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    attempted_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, attempted_at);
