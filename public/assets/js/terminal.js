/**
 * 远程终端脚本（CF Pages 版）
 * 负责命令发送、结果轮询、历史记录、快捷键与连接状态维护。
 *
 * 与原 PHP 版的差异：
 * - API 端点改为 /api/admin
 * - SSE 端点改为 /api/stream
 * - AGENT_ID / HOSTNAME 从 URL 查询参数获取（替代 PHP 注入）
 * - 页面加载时先获取认证状态
 */
(function (global) {
    'use strict';

    /* ---------- 从 URL 获取 Agent ID 与主机名 ---------- */
    const urlParams = new URLSearchParams(window.location.search);
    const AGENT_ID = urlParams.get('agent_id') || '';
    const HOSTNAME = urlParams.get('hostname') || 'host';

    // 缺少 agent_id 时返回控制台
    if (!AGENT_ID) {
        window.location.href = '/dashboard.html';
        return;
    }

    /* ---------- 常量与状态 ---------- */
    const API = '/api/admin';          // 后端接口入口
    const STREAM = '/api/stream';      // 命令结果 SSE 端点
    let cmdHistory = [];                  // 本地命令历史
    let historyIndex = -1;                // 历史浏览游标
    let waitingForResult = false;         // 是否正在等待命令结果
    let currentCmdId = null;              // 当前轮询的命令 ID
    let currentWaitLine = null;           // 当前"正在执行"提示行
    let statusTimer = null;               // 连接状态轮询定时器
    let autoScroll = true;                // 是否自动跟随滚动

    /* ---------- DOM 引用 ---------- */
    const output = App.$('#terminalOutput');
    const input  = App.$('#terminalInput');
    const win    = App.$('#terminalWindow');
    const promptEl = App.$('#terminalPrompt');

    /* ---------- 提示符 ---------- */
    function promptText() {
        return 'root@' + HOSTNAME + ':~#';
    }

    /* ---------- 本地历史持久化 ---------- */
    function historyKey() {
        return 'term_history_' + AGENT_ID;
    }

    function loadHistoryStore() {
        try {
            const raw = localStorage.getItem(historyKey());
            cmdHistory = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(cmdHistory)) cmdHistory = [];
        } catch (e) {
            cmdHistory = [];
        }
        historyIndex = cmdHistory.length;
    }

    function saveHistoryStore() {
        try {
            if (cmdHistory.length > 100) {
                cmdHistory = cmdHistory.slice(-100);
            }
            localStorage.setItem(historyKey(), JSON.stringify(cmdHistory));
        } catch (e) {
            /* 存储不可用时静默忽略 */
        }
    }

    /* ---------- 输出辅助 ---------- */
    function addLine(html, cls) {
        const line = document.createElement('div');
        line.className = 'terminal-line' + (cls ? ' ' + cls : '');
        line.innerHTML = html;
        output.appendChild(line);
        if (autoScroll) {
            win.scrollTop = win.scrollHeight;
        }
        return line;
    }

    function addCommandLine(cmd) {
        addLine(
            '<span class="terminal-prompt-inline">' + App.escHtml(promptText()) + '</span> ' +
            '<span class="terminal-cmd">' + App.escHtml(cmd) + '</span>'
        );
    }

    function addOutput(text) {
        addLine('<pre>' + App.escHtml(text) + '</pre>', 'terminal-result');
    }

    function restoreInput() {
        waitingForResult = false;
        currentCmdId = null;
        input.disabled = false;
        input.focus();
    }

    /* ---------- 命令发送与轮询 ---------- */
    async function sendCommand(cmd) {
        cmd = (cmd || '').trim();
        if (!cmd || waitingForResult) return;

        if (cmd === 'clear' || cmd === 'cls') {
            clearTerminal();
            input.value = '';
            return;
        }

        cmdHistory.push(cmd);
        historyIndex = cmdHistory.length;
        saveHistoryStore();

        addCommandLine(cmd);

        currentWaitLine = addLine(
            '<span class="terminal-waiting">正在执行' +
            '<span class="typing-dots"><span class="typing-dot"></span>' +
            '<span class="typing-dot"></span><span class="typing-dot"></span></span>' +
            '</span>'
        );

        waitingForResult = true;
        input.disabled = true;
        input.value = '';

        try {
            const data = await App.apiPost(API, {
                action: 'send_command',
                agent_id: AGENT_ID,
                command: cmd
            });

            if (data.error) {
                if (currentWaitLine) {
                    currentWaitLine.className = 'terminal-line terminal-error';
                    currentWaitLine.innerHTML = '<i class="bi bi-exclamation-triangle"></i> ' + App.escHtml(data.error);
                    currentWaitLine = null;
                }
                restoreInput();
                return;
            }

            currentCmdId = data.command_id;
            pollResult(currentCmdId);
        } catch (err) {
            if (currentWaitLine) {
                currentWaitLine.className = 'terminal-line terminal-error';
                currentWaitLine.innerHTML = '<i class="bi bi-exclamation-triangle"></i> 请求失败：' + App.escHtml(String(err));
                currentWaitLine = null;
            }
            restoreInput();
        }
    }

    /**
     * 订阅命令执行结果（SSE 实时推送）
     * 服务端在结果就绪时即时推送。SSE 连接最长 15s，超时后 EventSource 自动重连。
     */
    function pollResult(cmdId) {
        const maxWait = 120000;
        let resolved = false;
        let evtSource = null;

        function finish() {
            if (resolved) return;
            resolved = true;
            if (evtSource) { evtSource.close(); evtSource = null; }
        }

        function applyResult(data) {
            finish();
            if (currentWaitLine) { currentWaitLine.remove(); currentWaitLine = null; }
            if (data && data.result) {
                addOutput(data.result);
            } else {
                addLine('<span class="terminal-info">(无输出)</span>');
            }
            if (data && data.exit_code !== null && data.exit_code !== undefined && Number(data.exit_code) !== 0) {
                addLine('<span class="terminal-exit-code">[退出码: ' + App.escHtml(data.exit_code) + ']</span>');
            }
            addLine('&nbsp;');
            restoreInput();
            updateConnStatus(true);
        }

        function applyTimeout() {
            finish();
            if (currentWaitLine) {
                currentWaitLine.className = 'terminal-line terminal-error';
                currentWaitLine.innerHTML = '<i class="bi bi-exclamation-triangle"></i> 命令执行超时（可能主机离线）';
                currentWaitLine = null;
            }
            restoreInput();
        }

        const masterTimer = setTimeout(function () {
            if (!resolved) applyTimeout();
        }, maxWait);

        try {
            evtSource = new EventSource(STREAM + '?cmd_id=' + encodeURIComponent(cmdId));
        } catch (e) {
            clearTimeout(masterTimer);
            applyTimeout();
            return;
        }

        evtSource.onmessage = function (e) {
            clearTimeout(masterTimer);
            try {
                applyResult(JSON.parse(e.data));
            } catch (err) {
                applyResult(null);
            }
        };

        evtSource.addEventListener('timeout', function () {
            clearTimeout(masterTimer);
            applyTimeout();
        });

        evtSource.addEventListener('fail', function () {
            clearTimeout(masterTimer);
            applyTimeout();
        });

        evtSource.onerror = function () {
            /* 依赖 masterTimer 超时收尾，保持自愈重连 */
        };
    }

    /* ---------- 连接状态 ---------- */
    async function updateConnStatus(forceOnline) {
        const dot = App.$('#connDot');
        const text = App.$('#connText');

        if (forceOnline) {
            if (dot) { dot.classList.remove('offline'); dot.classList.add('online'); }
            if (text) text.textContent = '在线';
            return;
        }

        try {
            const data = await App.apiGet(API, { action: 'get_agents' });
            let agents = data.agents || data.data || data;
            if (!Array.isArray(agents)) agents = [];

            const found = agents.find(a => a && a.agent_id === AGENT_ID);
            if (found) {
                const online = Number(found.status) === 1 || found.status === 'online';
                if (dot) {
                    dot.classList.toggle('online', online);
                    dot.classList.toggle('offline', !online);
                }
                if (text) text.textContent = online ? '在线' : '离线';

                // 更新系统监控条
                updateSysMonitor(found.sys_info || {});
            } else {
                if (dot) { dot.classList.remove('online'); dot.classList.add('offline'); }
                if (text) text.textContent = '未找到';
            }
        } catch (e) {
            // 查询失败时保持当前状态
        }
    }

    /* ---------- 更新系统监控条 ---------- */
    function updateSysMonitor(si) {
        if (!si) si = {};

        // CPU
        const cpuPct = si.cpu_load || 0;
        const cpuEl = App.$('#sysCpu');
        const cpuBar = App.$('#sysCpuBar');
        if (cpuEl) cpuEl.innerHTML = cpuPct + '<span class="unit">%</span>';
        if (cpuBar) {
            cpuBar.style.width = cpuPct + '%';
            cpuBar.className = 'sys-mini-bar-fill ' + barColorClass(cpuPct);
        }

        // 内存
        const memPct = si.mem_total > 0 ? Math.round((si.mem_used / si.mem_total) * 100) : 0;
        const memEl = App.$('#sysMem');
        const memBar = App.$('#sysMemBar');
        if (memEl) memEl.innerHTML = (si.mem_used || 0) + '<span class="unit">/' + (si.mem_total || 0) + 'MB</span>';
        if (memBar) {
            memBar.style.width = memPct + '%';
            memBar.className = 'sys-mini-bar-fill ' + barColorClass(memPct);
        }

        // 磁盘
        const diskPct = si.disk_total > 0 ? Math.round((si.disk_used / si.disk_total) * 100) : 0;
        const diskEl = App.$('#sysDisk');
        const diskBar = App.$('#sysDiskBar');
        if (diskEl) diskEl.innerHTML = (si.disk_used || 0) + '<span class="unit">/' + (si.disk_total || 0) + 'GB</span>';
        if (diskBar) {
            diskBar.style.width = diskPct + '%';
            diskBar.className = 'sys-mini-bar-fill ' + barColorClass(diskPct);
        }

        // 系统
        const osEl = App.$('#sysOs');
        if (osEl) {
            const osText = si.os || '-';
            osEl.textContent = osText.length > 20 ? osText.slice(0, 20) + '…' : osText;
        }

        // 运行时间
        const upEl = App.$('#sysUptime');
        if (upEl) upEl.textContent = fmtUptime(si.uptime || 0);
    }

    function barColorClass(pct) {
        return pct < 60 ? 'low' : pct < 85 ? 'mid' : 'high';
    }

    function fmtUptime(s) {
        s = parseInt(s) || 0;
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (d > 0) return d + '天' + h + '时';
        if (h > 0) return h + '时' + m + '分';
        return m + '分';
    }

    /* ---------- 历史记录弹窗 ---------- */
    async function loadHistory() {
        const modalEl = App.$('#historyModal');
        const listEl = App.$('#historyList');

        if (modalEl) {
            bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }

        if (listEl) {
            listEl.innerHTML = '<div class="text-center text-muted py-4"><span class="spinner-ring"></span> 加载中...</div>';
        }

        try {
            const data = await App.apiGet(API, { action: 'get_history', agent_id: AGENT_ID });
            let items = data.history || data.data || data;
            if (!Array.isArray(items)) items = [];

            if (items.length === 0) {
                if (listEl) {
                    listEl.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>暂无历史记录</p></div>';
                }
                return;
            }

            if (listEl) {
                listEl.innerHTML = items.map(function (it) {
                    const status = it.status || 'completed';
                    const exitTxt = (it.exit_code !== null && it.exit_code !== undefined && Number(it.exit_code) !== 0)
                        ? ' <span class="terminal-exit-code">[退出码:' + App.escHtml(it.exit_code) + ']</span>'
                        : '';
                    const resultRaw = it.result ? String(it.result) : '(无输出)';
                    const resultTxt = App.escHtml(resultRaw.length > 500 ? resultRaw.slice(0, 500) + '…' : resultRaw);
                    return '<div class="history-item">' +
                        '<div class="history-cmd">' +
                        '<span class="history-status status-' + App.escHtml(status) + '"></span>' +
                        '<code>$ ' + App.escHtml(it.command || '') + '</code>' +
                        exitTxt +
                        '<span class="history-time">' + App.formatTime(it.created_at) + '</span>' +
                        '</div>' +
                        '<div class="history-result">' + resultTxt + '</div>' +
                        '</div>';
                }).join('');
            }
        } catch (e) {
            if (listEl) {
                listEl.innerHTML = '<div class="empty-state"><i class="bi bi-x-octagon"></i><p>加载失败</p></div>';
            }
        }
    }

    /* ---------- 工具操作 ---------- */
    function clearTerminal() {
        output.innerHTML = '<div class="terminal-line">&nbsp;</div>';
        autoScroll = true;
        win.scrollTop = win.scrollHeight;
    }

    function copyAllOutput() {
        const text = output.innerText || output.textContent || '';
        App.copyToClipboard(text, '已复制输出');
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }

    function quickCmd(cmd) {
        input.value = cmd;
        sendCommand(cmd);
    }

    /* ---------- 事件绑定 ---------- */
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendCommand(this.value);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                this.value = cmdHistory[historyIndex] || '';
                requestAnimationFrame(() => this.setSelectionRange(this.value.length, this.value.length));
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex < cmdHistory.length - 1) {
                historyIndex++;
                this.value = cmdHistory[historyIndex] || '';
            } else {
                historyIndex = cmdHistory.length;
                this.value = '';
            }
        } else if (e.key === 'Tab') {
            e.preventDefault();
        } else if (e.key === 'c' && e.ctrlKey) {
            e.preventDefault();
            this.value = '';
            addLine('<span class="terminal-prompt-inline">' + App.escHtml(promptText()) + '</span>');
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
            e.preventDefault();
            clearTerminal();
        }
    });

    win.addEventListener('click', function () {
        if (!input.disabled) input.focus();
    });

    win.addEventListener('scroll', function () {
        const atBottom = win.scrollTop + win.clientHeight >= win.scrollHeight - 4;
        autoScroll = atBottom;
    });

    /* ---------- 暴露给 onclick 调用 ---------- */
    global.sendCommand = sendCommand;
    global.loadHistory = loadHistory;
    global.clearTerminal = clearTerminal;
    global.copyAllOutput = copyAllOutput;
    global.toggleFullscreen = toggleFullscreen;
    global.quickCmd = quickCmd;

    /* ---------- 初始化 ---------- */
    async function init() {
        // 先获取认证状态
        const auth = await App.fetchAuth();
        if (!auth.authenticated) {
            window.location.href = '/';
            return;
        }

        // 设置 CSRF 令牌到 meta 标签
        let meta = document.querySelector('meta[name="csrf-token"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'csrf-token';
            document.head.appendChild(meta);
        }
        meta.setAttribute('content', auth.csrf_token || '');

        // 设置页面标题与提示符中的主机名
        document.title = '终端 - ' + HOSTNAME + ' - 远控管理系统';
        if (promptEl) promptEl.textContent = 'root@' + HOSTNAME + ':~#';

        // 填充终端头部信息
        const titleEl = document.querySelector('.terminal-title span');
        if (titleEl) titleEl.textContent = HOSTNAME;

        const agentShortEl = document.querySelectorAll('.terminal-info')[3];
        if (agentShortEl) {
            const shortId = AGENT_ID.length > 16 ? AGENT_ID.slice(0, 16) + '…' : AGENT_ID;
            agentShortEl.textContent = '        Agent ID: ' + shortId;
        }

        const hostInfoEl = document.querySelectorAll('.terminal-info')[2];
        if (hostInfoEl) {
            hostInfoEl.textContent = '        目标主机: ' + HOSTNAME;
        }

        loadHistoryStore();
        updateConnStatus();
        statusTimer = setInterval(() => updateConnStatus(false), 30000); // 30 秒刷新（降低 D1 读取）
        input.focus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
