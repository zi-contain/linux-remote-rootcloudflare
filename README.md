# 远控管理系统 - Cloudflare Pages 版

基于 Cloudflare Pages + D1 数据库的 Linux 远程管理工具，支持一键植入、开机自启、进程保活、远程终端。

从 PHP + MySQL 版本迁移而来，功能完全一致，架构改为无服务器（Serverless）。

> 本工具仅供服务器管理员管理自己的服务器使用，请勿用于任何违法用途。使用者需遵守当地法律法规。

## 与原版对比

| 维度 | 原版 (PHP) | CF Pages 版 |
|------|-----------|-------------|
| 后端运行时 | PHP-FPM | Cloudflare Workers (Pages Functions) |
| 数据库 | MySQL | Cloudflare D1 (SQLite) |
| 前端 | PHP 动态渲染 | 静态 HTML + JS |
| 认证 | PHP Session | JWT (HMAC-SHA256, httpOnly Cookie) |
| 密码哈希 | bcrypt (password_hash) | PBKDF2-SHA256 (Web Crypto API) |
| Agent 流式连接 | 55s 长连接, 0.3s 轮询 | 12s 长连接, 1s 轮询 (适配 Workers 限制) |
| 浏览器结果推送 | SSE, 115s | SSE, 15s (自动重连) |
| 部署成本 | 需要 VPS + PHP + MySQL | 免费 (CF Pages 免费额度) |

## 目录结构

```
remote-admin-cf/
├── public/                      # 静态文件（CF Pages 构建输出目录）
│   ├── index.html               # 登录页
│   ├── dashboard.html           # 控制台
│   ├── terminal.html            # 远程终端
│   ├── install.html             # 安装向导
│   ├── _redirects               # CF Pages 重定向规则
│   └── assets/
│       ├── css/
│       │   ├── style.css        # 全局设计系统
│       │   └── terminal.css     # 终端专用样式
│       └── js/
│           ├── app.js           # 公共脚本（API 封装 / Toast / CSRF）
│           ├── dashboard.js     # 控制台逻辑
│           └── terminal.js      # 终端逻辑
├── functions/                   # CF Pages Functions (API)
│   ├── _lib/                    # 共享模块（_ 前缀不作为路由）
│   │   ├── helpers.js           # 响应 / URL / base64 / 时间工具
│   │   ├── auth.js              # JWT 令牌 / 密码哈希 / CSRF / Cookie
│   │   ├── db.js                # D1 查询辅助
│   │   └── agent-template.js    # 被控端 bash 脚本模板
│   └── api/
│       ├── auth.js              # 登录 / 登出 / 认证检查
│       ├── install.js           # 安装向导 API
│       ├── admin.js             # 管理后台 JSON API
│       ├── agent.js             # 客户端通信 API（注册 / 签到 / 结果）
│       ├── connect.js           # Agent 流式连接端点
│       ├── stream.js            # 命令结果 SSE 端点
│       └── agent-sh.js          # 被控端脚本生成器
├── schema.sql                   # D1 数据库建表脚本
├── wrangler.toml                # Cloudflare 配置
├── package.json
└── README.md
```

---

## 部署指南

### 前置要求

- 安装 [Node.js](https://nodejs.org/) 18+
- 注册 [Cloudflare](https://dash.cloudflare.com/) 账号
- 安装 Wrangler CLI：`npm install -g wrangler`
- 登录 Cloudflare：`wrangler login`

### 第一步：创建 D1 数据库

```bash
# 创建数据库
wrangler d1 create remote-admin-db
```

执行后会输出类似：
```
✅ Successfully created DB 'remote-admin-db'
[[d1_databases]]
binding = "DB"
database_name = "remote-admin-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**复制 `database_id`**，填入 `wrangler.toml` 中的 `database_id` 字段。

### 第二步：初始化数据库表

```bash
# 在远程 D1 上执行建表脚本
wrangler d1 execute remote-admin-db --remote --file=schema.sql
```

如果是本地开发，用 `--local` 替代 `--remote`：
```bash
wrangler d1 execute remote-admin-db --local --file=schema.sql
```

### 第三步：设置 JWT 密钥

**生产环境**（推荐用 secret，不会暴露在代码中）：
```bash
wrangler pages secret put JWT_SECRET
# 输入一个至少 32 位的随机字符串，例如：
# openssl rand -hex 32
```

**或**直接修改 `wrangler.toml` 中的 `JWT_SECRET`（不推荐用于生产）。

### 第四步：本地测试（可选）

```bash
# 本地开发模式
npx wrangler pages dev public --d1 DB=remote-admin-db

# 浏览器打开 http://localhost:8788
# 首次访问会跳转到安装页面，设置管理员账号密码
```

### 第五步：部署到 Cloudflare Pages

```bash
# 部署
npx wrangler pages deploy public
```

部署成功后会输出你的网站地址，例如：
```
✅ Deployment complete! Take a peek over at https://remote-admin-xxx.pages.dev
```

### 第六步：初始化系统

1. 浏览器打开你的 Pages 地址（如 `https://remote-admin-xxx.pages.dev`）
2. 首次访问会自动跳转到 **安装页面**
3. 设置管理员用户名和密码
4. 点击「开始安装」
5. 安装成功后前往登录页登录

### 第七步：植入客户端

在后台控制台复制「一键植入命令」，在目标 Linux 机器上以 root 执行：

```bash
curl -sSL 'https://你的域名/api/agent-sh' | bash
```

脚本会自动安装 Agent、注册设备、配置开机自启与进程保活。

---

## 绑定自定义域名（可选）

1. 进入 Cloudflare Dashboard → Pages → 你的项目
2. 点击「Custom domains」→「Set up a custom domain」
3. 输入你的域名并按提示配置 DNS
4. 部署完成后通过自定义域名访问

绑定自定义域名后，植入命令中的地址会自动更新为你的域名。

---

## 本地开发

### 目录结构要求

确保 `functions/` 目录与 `public/` 目录在项目根目录下平级：
```
remote-admin-cf/
├── public/       ← 静态文件
├── functions/    ← API 函数
├── schema.sql
└── wrangler.toml
```

### 启动本地开发服务器

```bash
# 安装依赖
npm install

# 启动本地开发（自动热重载）
npx wrangler pages dev public --d1 DB=remote-admin-db
```

首次启动需要初始化本地 D1：
```bash
wrangler d1 execute remote-admin-db --local --file=schema.sql
```

本地开发服务器地址：`http://localhost:8788`

---

## 功能列表

| 功能 | 说明 |
|------|------|
| 一键植入 | curl 管道执行，自动安装并注册 |
| 设备 UUID 身份 | 以设备 UUID 作为 Agent ID，同机器身份唯一稳定 |
| 安装查重 | 检测到已有安装则清理残留进程后重装 |
| 脚本加密 | 被控端脚本经 base64 混淆输出 |
| 流式命令推送 | Agent 保持长连接，服务端实时推送命令（~1s 延迟） |
| 结果 SSE 推送 | 浏览器用 EventSource 订阅命令结果，零轮询延迟 |
| 开机自启 | systemd / cron+nohup 双模式 |
| 进程保活 | systemd Restart=always + 脚本自重启循环 |
| 自动适配域名 | 服务端地址由访问域名自动推导 |
| 远程终端 | 类终端 UI、本地+服务端历史、上下键浏览、快捷命令 |
| 主机管理 | 在线状态、搜索筛选、备注、删除 |
| 命令历史 | 记录最近 50 条命令及结果 |
| 安全防护 | JWT 认证、CSRF 校验、登录限流、httpOnly Cookie |

## 通信协议

### Agent ↔ 服务端

Agent 优先使用**流式连接**（`/api/connect`）实时接收命令；无 curl 时回退到长轮询（`/api/agent` checkin）。

**流式连接**（`/api/connect`，POST）：

| 行格式 | 含义 |
|--------|------|
| `OK <agent_id>` | 连接确认 |
| `CMD <cmd_id> <base64>` | 下发命令（可连续多条） |
| `PING` | 心跳保活（约每 5s） |
| `END` | 服务端生命周期结束（~12s），Agent 应重连 |
| `ERROR:<信息>` | 错误 |

> CF Workers 版将流式连接生命周期从 55s 缩短至 12s（适配 Workers 执行限制），
> Agent 收到 END 后自动重连，命令下发延迟约 1s。

### 浏览器 ↔ 服务端

浏览器通过 `EventSource` 连接 `/api/stream?cmd_id=<id>`，服务端轮询 D1，
命令状态变 `completed` 即时推送。SSE 连接最长 15s，超时后 EventSource 自动重连。

## 安全建议

1. 生产环境务必通过 `wrangler pages secret put JWT_SECRET` 设置强随机密钥
2. 使用 HTTPS（CF Pages 默认启用）
3. 定期检查后台主机列表
4. 修改默认管理员密码
5. 如需限制访问来源，可在 Cloudflare Dashboard 配置 WAF 规则

## Agent 管理

在目标机器上可执行以下操作：

```bash
# 查看状态
/usr/local/share/.sys-cache/.sys-helper --status

# 卸载
/usr/local/share/.sys-cache/.sys-helper --uninstall
```

## 从原 PHP 版迁移

如果已有 PHP 版本的 Agent 已部署在被控机器上：

1. 部署 CF Pages 版本
2. 在被控机器上重新执行新的植入命令（会自动清理旧安装）：
   ```bash
   curl -sSL 'https://你的新域名/api/agent-sh' | bash
   ```
3. 旧的主机记录可在后台手动删除

> Agent 以设备 UUID 作为身份，重新植入后会在新服务端注册为同一 Agent ID。
> 但由于数据库独立，原 PHP 版的命令历史不会迁移过来。
