/**
 * 远控管理系统 - 公共脚本（CF Pages 版）
 * 提供 HTML 转义、Toast、剪贴板、CSRF 感知的 fetch 封装与时间格式化等通用能力。
 *
 * 与原 PHP 版的差异：
 * - CSRF 令牌从 /api/auth (GET) 获取，而非 PHP 渲染的 meta 标签
 * - API 端点改为 /api/admin、/api/auth 等（无 .php 后缀）
 * - 登录/登出通过 /api/auth (POST/DELETE) 实现
 */
(function (global) {
    'use strict';

    /* ---------- 配置 ---------- */
    const API_BASE = '/api/admin';
    const AUTH_URL = '/api/auth';

    /* ---------- CSRF 令牌（异步获取） ---------- */
    let _csrfToken = '';
    let _username = '';
    let _authChecked = false;

    /** 从服务端获取 CSRF 令牌与登录状态 */
    async function fetchAuth() {
        try {
            const res = await fetch(AUTH_URL, { headers: { 'Accept': 'application/json' } });
            const data = await res.json();
            if (data.authenticated) {
                _csrfToken = data.csrf_token || '';
                _username = data.username || 'admin';
                _authChecked = true;
                return data;
            }
        } catch (e) {
            console.error('获取认证状态失败:', e);
        }
        return { authenticated: false };
    }

    /** 获取已缓存的 CSRF 令牌 */
    function getCsrfToken() {
        return _csrfToken;
    }

    /** 获取已缓存的用户名 */
    function getUsername() {
        return _username;
    }

    /** 兼容旧代码：从 meta 标签读取（如果页面设置了的话） */
    function getCsrfTokenFromMeta() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : _csrfToken;
    }

    /* ---------- API 请求封装 ---------- */

    /**
     * GET 请求（返回 JSON）
     * @param {string} url    完整 API 路径（如 /api/admin）
     * @param {object} [params] 查询参数
     */
    async function apiGet(url, params) {
        if (params) {
            const qs = new URLSearchParams(params).toString();
            if (qs) url += (url.includes('?') ? '&' : '?') + qs;
        }
        const res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
        if (res.status === 401) {
            window.location.href = '/';
            return {};
        }
        return res.json();
    }

    /**
     * POST 请求（自动附带 CSRF token）
     * @param {string} url
     * @param {FormData|object} data
     */
    async function apiPost(url, data) {
        let body;
        const headers = { 'Accept': 'application/json' };
        if (data instanceof FormData) {
            body = data;
        } else {
            body = new FormData();
            Object.keys(data || {}).forEach(k => body.append(k, data[k]));
        }
        if (!body.has('csrf_token')) {
            body.append('csrf_token', getCsrfTokenFromMeta());
        }
        const res = await fetch(url, { method: 'POST', body, headers, credentials: 'same-origin' });
        if (res.status === 401) {
            window.location.href = '/';
            return {};
        }
        return res.json();
    }

    /* ---------- HTML 转义 ---------- */
    function escHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /* ---------- Toast ---------- */
    function showToast(msg, type = 'success') {
        const colors = {
            success: '#34d399',
            error: '#fb5b5b',
            warning: '#fbbf24',
            info: '#4f8cff'
        };
        const icons = {
            success: 'bi-check-circle-fill',
            error: 'bi-x-circle-fill',
            warning: 'bi-exclamation-triangle-fill',
            info: 'bi-info-circle-fill'
        };
        const color = colors[type] || colors.success;

        const toast = document.createElement('div');
        toast.className = 'app-toast';
        toast.style.setProperty('--toast-color', color);
        toast.innerHTML = '<i class="bi ' + (icons[type] || icons.success) + '"></i><span></span>';
        toast.querySelector('span').textContent = msg;

        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2600);
    }

    /* ---------- 剪贴板 ---------- */
    function copyToClipboard(text, label) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text)
                .then(() => showToast(label || '已复制到剪贴板'))
                .catch(() => fallbackCopy(text, label));
        } else {
            fallbackCopy(text, label);
        }
    }

    function fallbackCopy(text, label) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast(label || '已复制到剪贴板');
        } catch (e) {
            showToast('复制失败', 'error');
        }
        document.body.removeChild(ta);
    }

    /* ---------- 时间格式化 ---------- */
    function parseDate(dateStr) {
        if (!dateStr) return null;
        // API 返回 UTC 时间（带 Z 后缀），需正确解析为 ISO 格式
        if (typeof dateStr === 'string' && dateStr.endsWith('Z')) {
            // "2026-08-16 07:25:28Z" → "2026-08-16T07:25:28Z" (ISO 8601 UTC)
            return new Date(dateStr.replace(' ', 'T'));
        }
        // 兼容旧格式（无 Z 后缀，按本地时间解析）
        return new Date(dateStr.replace(/-/g, '/'));
    }

    function formatTime(dateStr) {
        if (!dateStr) return '-';
        const d = parseDate(dateStr);
        if (!d || isNaN(d.getTime())) return dateStr;
        return d.toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }

    function timeAgo(dateStr) {
        if (!dateStr || dateStr === '从未') return '从未';
        const d = parseDate(dateStr);
        if (!d || isNaN(d.getTime())) return dateStr;
        const diff = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diff < 5) return '刚刚';
        if (diff < 60) return diff + ' 秒前';
        if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
        return Math.floor(diff / 86400) + ' 天前';
    }

    /* ---------- 工具 ---------- */
    function debounce(fn, wait) {
        let t;
        return function () {
            const ctx = this, args = arguments;
            clearTimeout(t);
            t = setTimeout(() => fn.apply(ctx, args), wait || 200);
        };
    }

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    /* ---------- 导出 ---------- */
    global.App = {
        csrfToken: getCsrfTokenFromMeta,
        fetchAuth,
        getCsrfToken,
        getUsername,
        apiGet,
        apiPost,
        escHtml,
        showToast,
        copyToClipboard,
        formatTime,
        timeAgo,
        debounce,
        $,
        $all,
        API_BASE,
        AUTH_URL
    };

    // 兼容旧代码的全局别名
    global.escHtml = escHtml;
    global.showToast = showToast;
    global.copyToClipboard = copyToClipboard;
    global.formatTime = formatTime;
    global.timeAgo = timeAgo;
})(window);
