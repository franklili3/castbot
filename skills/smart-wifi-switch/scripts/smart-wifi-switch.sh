#!/bin/bash
# Smart WiFi Switch - 智能WiFi切换脚本（单网卡双SSID版 + ClashX Pro代理支持）
# 根据目标网站自动选择WiFi网络或使用代理

set -e

# 配置文件路径
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="${SKILL_DIR}/data"
GFW_LIST_URL="https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt"
GFW_LIST="${CONFIG_DIR}/gfwlist.txt"
CUSTOM_LIST="${CONFIG_DIR}/custom-gfwlist.txt"
MERGED_LIST="${CONFIG_DIR}/merged-gfwlist.txt"
FOREIGN_LIST="${CONFIG_DIR}/foreign-wifi-list.txt"  # 新增：必须切换WiFi的域名
STATE_FILE="${CONFIG_DIR}/current-wifi.state"
LOG_FILE="${CONFIG_DIR}/wifi-switch.log"

# ClashX Pro 代理配置
PROXY_HTTP="http://127.0.0.1:7890"
PROXY_SOCKS="socks5://127.0.0.1:7891"
PROXY_TIMEOUT=5

# 环境变量配置（可通过 .env 或环境设置）
# WIFI_IF - WiFi网卡接口名（如 en1）
# WIFI_DOMESTIC_SSID - 国内WiFi SSID
# WIFI_FOREIGN_SSID - 国外WiFi SSID
# WIFI_PREFER_FOREIGN - 是否优先使用国外WiFi（默认 false）
# USE_PROXY_FIRST - 对于GFW域名是否优先使用代理（默认 true）

# 加载环境变量
if [[ -f "${SKILL_DIR}/.env" ]]; then
    source "${SKILL_DIR}/.env"
fi

# 默认值
WIFI_IF="${WIFI_IF:-en1}"
USE_PROXY_FIRST="${USE_PROXY_FIRST:-true}"

# 初始化
init() {
    mkdir -p "${CONFIG_DIR}"
    touch "${LOG_FILE}"
    touch "${STATE_FILE}"
    touch "${CUSTOM_LIST}"
    touch "${FOREIGN_LIST}"
}

# 日志函数
log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp=$(date "+%Y-%m-%d %H:%M:%S")
    echo "[${timestamp}] [${level}] ${msg}" >> "${LOG_FILE}"
    case "${level}" in
        ERROR) echo "❌ ${msg}" >&2 ;;
        WARN)  echo "⚠️  ${msg}" >&2 ;;
        INFO)  echo "ℹ️  ${msg}" ;;
        DEBUG) [[ "${DEBUG}" == "true" ]] && echo "🔍 ${msg}" ;;
    esac
}

# 获取当前连接的 SSID
get_current_ssid() {
    # macOS 15+ 移除了 airport 命令，使用 networksetup 替代
    local ssid=$(/usr/sbin/networksetup -getairportnetwork "${WIFI_IF}" 2>/dev/null | sed 's/Current Wi-Fi Network: //')
    echo "${ssid}"
}

# 检查代理是否可用
check_proxy() {
    if curl -s -x "${PROXY_HTTP}" --connect-timeout ${PROXY_TIMEOUT} -I "https://www.google.com" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

# 通过代理检测网站是否可访问
check_website_via_proxy() {
    local domain="$1"
    
    # 提取域名（去除协议和路径）
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||")
    
    # 尝试通过 HTTP 代理访问
    if curl -s -x "${PROXY_HTTP}" --connect-timeout ${PROXY_TIMEOUT} --max-time 10 -I "https://${domain}" >/dev/null 2>&1; then
        return 0
    fi
    
    # 尝试通过 SOCKS 代理访问
    if curl -s -x "${PROXY_SOCKS}" --connect-timeout ${PROXY_TIMEOUT} --max-time 10 -I "https://${domain}" >/dev/null 2>&1; then
        return 0
    fi
    
    return 1
}

# 检测网站是否可访问（直连）
check_website_direct() {
    local domain="$1"
    local timeout="${2:-5}"
    
    # 提取域名（去除协议和路径）
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||")
    
    # 尝试 DNS 解析
    if ! nslookup -timeout=${timeout} "${domain}" >/dev/null 2>&1; then
        log DEBUG "DNS 解析失败: ${domain}"
        return 1
    fi
    
    # 尝试 HTTP 连接
    if ! curl -s --connect-timeout ${timeout} --max-time ${timeout} -I "http://${domain}" >/dev/null 2>&1; then
        log DEBUG "HTTP 连接失败: ${domain}"
        return 1
    fi
    
    return 0
}

# 下载GFWList
download_gfwlist() {
    log INFO "下载 GFWList..."
    
    local tmp_file=$(mktemp)
    
    # 尝试通过代理下载
    if check_proxy; then
        log INFO "使用代理下载 GFWList"
        if curl -s -x "${PROXY_HTTP}" --connect-timeout 15 -sS "${GFW_LIST_URL}" -o "${tmp_file}" 2>&1; then
            : # 成功
        else
            rm -f "${tmp_file}"
            log WARN "代理下载失败，尝试直连"
            curl --connect-timeout 15 -sS "${GFW_LIST_URL}" -o "${tmp_file}" 2>&1 || true
        fi
    else
        curl --connect-timeout 15 -sS "${GFW_LIST_URL}" -o "${tmp_file}" 2>&1 || true
    fi
    
    if [[ -s "${tmp_file}" ]]; then
        # 解码 Base64
        if base64 -d "${tmp_file}" > "${GFW_LIST}.raw" 2>/dev/null; then
            # 转换为域名列表
            process_gfwlist "${GFW_LIST}.raw" "${GFW_LIST}"
            rm -f "${tmp_file}" "${GFW_LIST}.raw"
            log INFO "GFWList 更新成功，共 $(wc -l < "${GFW_LIST}" | tr -d " ") 个域名"
            return 0
        else
            log ERROR "GFWList 解码失败"
            rm -f "${tmp_file}" "${GFW_LIST}.raw"
            return 1
        fi
    else
        log WARN "GFWList 下载失败，使用本地缓存"
        rm -f "${tmp_file}"
        [[ -f "${GFW_LIST}" ]] && return 0
        return 1
    fi
}

# 处理 GFWList 原始数据
process_gfwlist() {
    local input="$1"
    local output="$2"
    
    # 提取域名（处理各种格式）
    grep -oE "([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}" "${input}" | \
        sort -u > "${output}"
}

# 添加自定义域名到列表
add_custom_domain() {
    local domain="$1"
    local list="${2:-${CUSTOM_LIST}}"
    
    if [[ -z "${domain}" ]]; then
        log ERROR "请提供域名"
        return 1
    fi
    
    # 标准化域名
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||" | tr "[:upper:]" "[:lower:]")
    
    # 检查是否已存在
    if grep -qxF "${domain}" "${list}" 2>/dev/null; then
        log INFO "域名 ${domain} 已在列表中"
        return 0
    fi
    
    # 添加到列表
    mkdir -p "${CONFIG_DIR}"
    echo "${domain}" >> "${list}"
    sort -u "${list}" -o "${list}"
    
    log INFO "已添加域名: ${domain} -> ${list}"
    
    # 更新合并列表
    merge_lists
}

# 添加到必须切换WiFi的列表
add_foreign_wifi_domain() {
    local domain="$1"
    add_custom_domain "${domain}" "${FOREIGN_LIST}"
}

# 删除自定义域名
remove_custom_domain() {
    local domain="$1"
    
    if [[ -z "${domain}" ]]; then
        log ERROR "请提供域名"
        return 1
    fi
    
    domain=$(echo "${domain}" | tr "[:upper:]" "[:lower:]")
    
    for list in "${CUSTOM_LIST}" "${FOREIGN_LIST}"; do
        if [[ -f "${list}" ]]; then
            grep -vxF "${domain}" "${list}" > "${list}.tmp" 2>/dev/null || true
            mv "${list}.tmp" "${list}"
        fi
    done
    
    log INFO "已删除域名: ${domain}"
    merge_lists
}

# 列出所有域名
list_custom_domains() {
    echo "自定义 GFW 域名列表:"
    if [[ -f "${CUSTOM_LIST}" && -s "${CUSTOM_LIST}" ]]; then
        cat -n "${CUSTOM_LIST}"
    else
        echo "  (空)"
    fi
    
    echo ""
    echo "必须切换 WiFi 的域名列表 (foreign-wifi-list):"
    if [[ -f "${FOREIGN_LIST}" && -s "${FOREIGN_LIST}" ]]; then
        cat -n "${FOREIGN_LIST}"
    else
        echo "  (空)"
    fi
}

# 合并列表
merge_lists() {
    log INFO "合并域名列表..."
    
    cat "${GFW_LIST}" "${CUSTOM_LIST}" "${FOREIGN_LIST}" 2>/dev/null | sort -u > "${MERGED_LIST}"
    
    log INFO "合并完成，共 $(wc -l < "${MERGED_LIST}" | tr -d " ") 个域名"
}

# 检查域名是否在GFW列表中
is_gfw_domain() {
    local domain="$1"
    
    # 标准化域名
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||" | tr "[:upper:]" "[:lower:]")
    
    # 提取根域名（用于匹配）
    local parts=$(echo "${domain}" | tr "." "\n" | wc -l | tr -d " ")
    local root_domain
    if [[ ${parts} -ge 2 ]]; then
        root_domain=$(echo "${domain}" | awk -F. "{print \$(NF-1)\".\"\$NF}")
    else
        root_domain="${domain}"
    fi
    
    # 在合并列表中搜索（支持子域名匹配）
    local escaped_domain=$(echo "${domain}" | sed "s/\./\\\\./g")
    local escaped_root=$(echo "${root_domain}" | sed "s/\./\\\\./g")
    
    if grep -qE "(^|\.)(${escaped_domain}|${escaped_root})$" "${MERGED_LIST}" 2>/dev/null; then
        return 0
    fi
    
    return 1
}

# 检查域名是否在必须切换WiFi的列表中
is_foreign_wifi_domain() {
    local domain="$1"
    
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||" | tr "[:upper:]" "[:lower:]")
    
    if grep -qxF "${domain}" "${FOREIGN_LIST}" 2>/dev/null; then
        return 0
    fi
    
    return 1
}

# 获取当前应该使用的WiFi类型
get_target_wifi_type() {
    local target="$1"
    
    # 如果没有指定目标，检查默认偏好
    if [[ -z "${target}" ]]; then
        if [[ "${WIFI_PREFER_FOREIGN}" == "true" ]]; then
            echo "foreign"
        else
            echo "domestic"
        fi
        return
    fi
    
    # 判断是否需要翻墙
    if is_gfw_domain "${target}"; then
        echo "foreign"
    else
        echo "domestic"
    fi
}

# 连接到指定WiFi SSID (使用 Peekaboo)
connect_wifi() {
    local type="$1"  # domestic 或 foreign
    local ssid
    
    if [[ "${type}" == "foreign" ]]; then
        ssid="${WIFI_FOREIGN_SSID}"
    else
        ssid="${WIFI_DOMESTIC_SSID}"
    fi
    
    if [[ -z "${ssid}" ]]; then
        log ERROR "未配置 ${type} WiFi SSID，请检查 .env 文件"
        return 1
    fi
    
    local current_ssid=$(get_current_ssid)
    
    # 如果已经连接到目标网络
    if [[ "${current_ssid}" == "${ssid}" ]]; then
        log INFO "已连接到 ${type} WiFi (${ssid})，无需切换"
        return 0
    fi
    
    log INFO "切换到 ${type} WiFi (${ssid})..."

    # 使用 Peekaboo 进行 WiFi 切换
    local peekaboo_script="${SCRIPT_DIR}/wifi-peekaboo.sh"
    
    if [[ -x "${peekaboo_script}" ]]; then
        "${peekaboo_script}" "${ssid}"
        local result=$?
        if [[ ${result} -eq 0 ]]; then
            echo "${ssid}" > "${STATE_FILE}"
            log INFO "✅ 已成功切换到 ${ssid}"
            return 0
        else
            log ERROR "❌ 切换失败"
            return 1
        fi
    else
        log ERROR "未找到 wifi-peekaboo.sh 脚本"
        return 1
    fi
}

# 自动检测并切换（核心逻辑：代理优先，失败则切换WiFi）
auto_switch() {
    local domain="$1"
    local current_ssid=$(get_current_ssid)
    
    if [[ -z "${domain}" ]]; then
        log ERROR "请提供目标域名"
        return 1
    fi
    
    # 标准化域名
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||" | tr "[:upper:]" "[:lower:]")
    
    log INFO "检测网站: ${domain}"
    
    # 1. 如果已经在国外 WiFi 网络，直接返回成功
    if [[ "${current_ssid}" == "${WIFI_FOREIGN_SSID}" ]]; then
        log INFO "✅ 当前已是国外 WiFi (${WIFI_FOREIGN_SSID})，直接访问"
        return 0
    fi
    
    # 2. 检查是否在必须切换 WiFi 的列表中（如 binance.com）
    if is_foreign_wifi_domain "${domain}"; then
        log INFO "域名在必须切换WiFi列表中，切换到 ${WIFI_FOREIGN_SSID}"
        connect_wifi "foreign"
        return 0
    fi
    
    # 3. 如果不在 GFW 列表中，尝试直连
    if ! is_gfw_domain "${domain}"; then
        log INFO "域名不在 GFW 列表中，尝试直连..."
        if check_website_direct "${domain}"; then
            log INFO "✅ 直连成功，继续使用国内网络"
            return 0
        else
            log WARN "直连失败，可能需要代理"
            # 继续尝试代理
        fi
    fi
    
    # 4. 域名在 GFW 列表中，或直连失败
    # 优先尝试通过 ClashX Pro 代理访问
    if [[ "${USE_PROXY_FIRST}" == "true" ]]; then
        log INFO "尝试通过 ClashX Pro 代理访问..."
        
        if check_proxy; then
            if check_website_via_proxy "${domain}"; then
                log INFO "✅ 代理访问成功，无需切换 WiFi（通过 ClashX Pro 访问）"
                # 设置代理环境变量提示
                echo "提示: 设置环境变量使用代理: export https_proxy=${PROXY_HTTP} http_proxy=${PROXY_HTTP}"
                return 0
            else
                log WARN "代理访问失败"
            fi
        else
            log WARN "ClashX Pro 代理不可用"
        fi
    fi
    
    # 5. 代理失败，添加到必须切换WiFi的列表，并切换网络
    log WARN "❌ 无法通过代理访问 ${domain}"
    log INFO "添加到必须切换WiFi列表: ${domain}"
    add_foreign_wifi_domain "${domain}" 2>/dev/null || true
    
    # 添加到自定义 GFW 列表（如果还没有）
    if ! is_gfw_domain "${domain}"; then
        add_custom_domain "${domain}" 2>/dev/null || true
    fi
    
    # 6. 切换到国外 WiFi
    log INFO "切换到国外 WiFi (${WIFI_FOREIGN_SSID})..."
    connect_wifi "foreign"
    return 0
}

# 智能切换 - 根据目标自动选择
smart_switch() {
    local target="$1"
    
    if [[ -z "${target}" ]]; then
        log ERROR "请提供目标域名"
        return 1
    fi
    
    local target_type=$(get_target_wifi_type "${target}")
    local current_ssid=$(get_current_ssid)
    
    log INFO "目标: ${target} -> ${target_type} 网络"
    
    if [[ "${target_type}" == "foreign" ]]; then
        if [[ "${current_ssid}" != "${WIFI_FOREIGN_SSID}" ]]; then
            # 优先尝试代理
            if [[ "${USE_PROXY_FIRST}" == "true" ]] && check_proxy && check_website_via_proxy "${target}"; then
                log INFO "✅ 可通过代理访问，无需切换 WiFi"
                return 0
            fi
            connect_wifi "foreign"
        else
            log INFO "当前已是国外网络，无需切换"
        fi
    else
        if [[ "${current_ssid}" != "${WIFI_DOMESTIC_SSID}" ]]; then
            connect_wifi "domestic"
        else
            log INFO "当前已是国内网络，无需切换"
        fi
    fi
}

# 手动测试域名
test_domain() {
    local domain="$1"
    
    if [[ -z "${domain}" ]]; then
        log ERROR "请提供测试域名"
        return 1
    fi
    
    echo "═══════════════════════════════════════"
    echo "测试域名: ${domain}"
    echo "═══════════════════════════════════════"
    
    # 标准化
    domain=$(echo "${domain}" | sed "s|^[^/]*//||" | sed "s|/.*$||" | sed "s|:.*$||" | tr "[:upper:]" "[:lower:]")
    
    # 检查列表状态
    echo ""
    echo "📋 列表状态:"
    if is_foreign_wifi_domain "${domain}"; then
        echo "   ✅ 在必须切换WiFi列表中 → 必须切换到 ${WIFI_FOREIGN_SSID}"
    elif is_gfw_domain "${domain}"; then
        echo "   ✅ 在 GFW 列表中 → 优先使用代理，失败则切换WiFi"
    else
        echo "   ❌ 不在 GFW 列表中 → 使用国内网络"
    fi
    
    # 测试直连
    echo ""
    echo "🌐 直连测试:"
    if check_website_direct "${domain}" 3; then
        echo "   ✅ 直连成功"
    else
        echo "   ❌ 直连失败"
    fi
    
    # 测试代理
    echo ""
    echo "🚀 代理测试:"
    if check_proxy; then
        echo "   ClashX Pro 代理可用"
        if check_website_via_proxy "${domain}"; then
            echo "   ✅ 代理访问成功"
        else
            echo "   ❌ 代理访问失败"
        fi
    else
        echo "   ❌ ClashX Pro 代理不可用"
    fi
    
    echo ""
    echo "═══════════════════════════════════════"
}

# 显示状态
status() {
    echo "═══════════════════════════════════════"
    echo "       智能 WiFi 切换状态"
    echo "═══════════════════════════════════════"
    echo ""
    echo "📡 网卡配置:"
    echo "   接口: ${WIFI_IF}"
    echo "   国内 SSID: ${WIFI_DOMESTIC_SSID:-未配置}"
    echo "   国外 SSID: ${WIFI_FOREIGN_SSID:-未配置}"
    echo ""
    echo "📶 当前状态:"
    echo "   当前 SSID: $(get_current_ssid)"
    echo ""
    echo "🚀 代理状态:"
    if check_proxy; then
        echo "   ClashX Pro: ✅ 可用"
        echo "   HTTP: ${PROXY_HTTP}"
        echo "   SOCKS: ${PROXY_SOCKS}"
    else
        echo "   ClashX Pro: ❌ 不可用"
    fi
    echo ""
    echo "📊 列表统计:"
    echo "   GFWList: $(wc -l < "${GFW_LIST}" 2>/dev/null | tr -d " ") 个域名"
    echo "   自定义GFW: $(wc -l < "${CUSTOM_LIST}" 2>/dev/null | tr -d " ") 个域名"
    echo "   必须切换WiFi: $(wc -l < "${FOREIGN_LIST}" 2>/dev/null | tr -d " ") 个域名"
    echo "   合并后: $(wc -l < "${MERGED_LIST}" 2>/dev/null | tr -d " ") 个域名"
    echo ""
    echo "═══════════════════════════════════════"
}

# 定期更新任务
update_lists() {
    log INFO "定期更新 GFWList..."
    download_gfwlist
    merge_lists
}

# 显示帮助
show_help() {
    echo "智能 WiFi 切换工具（代理优先版）"
    echo ""
    echo "用法:"
    echo "    smart-wifi-switch.sh <命令> [参数]"
    echo ""
    echo "命令:"
    echo "    init                初始化配置目录"
    echo "    update              更新 GFWList"
    echo "    add <域名>          添加自定义域名到 GFW 列表"
    echo "    add-foreign <域名>  添加到必须切换WiFi列表"
    echo "    remove <域名>       从所有列表删除域名"
    echo "    list                列出所有自定义域名"
    echo "    merge               合并所有列表"
    echo "    test <域名>         测试域名（直连/代理/列表状态）"
    echo "    check <域名>        检测网站是否可访问"
    echo "    auto <域名>         自动检测并切换（推荐！）"
    echo "    switch <domestic|foreign>   手动切换到指定网络"
    echo "    smart <域名>        智能切换（根据域名自动选择）"
    echo "    status              显示当前状态"
    echo "    help                显示帮助信息"
    echo ""
    echo "工作流程 (auto 命令):"
    echo "    1. 如果已在国外WiFi → 直接访问"
    echo "    2. 如果在必须切换WiFi列表 → 切换到国外WiFi"
    echo "    3. 如果不在GFW列表 → 尝试直连"
    echo "    4. 如果在GFW列表 → 优先使用ClashX Pro代理"
    echo "    5. 代理失败 → 添加到必须切换WiFi列表 → 切换WiFi"
    echo ""
    echo "环境变量（在 .env 文件中配置）:"
    echo "    WIFI_IF             WiFi 网卡接口 (默认: en1)"
    echo "    WIFI_DOMESTIC_SSID  国内 WiFi SSID"
    echo "    WIFI_FOREIGN_SSID   国外 WiFi SSID"
    echo "    USE_PROXY_FIRST     对GFW域名优先使用代理 (默认: true)"
    echo "    DEBUG               启用调试日志 (设为 true)"
    echo ""
    echo "示例:"
    echo "    # 初始化"
    echo "    ./smart-wifi-switch.sh init"
    echo "    ./smart-wifi-switch.sh update"
    echo ""
    echo "    # 自动检测（推荐）"
    echo "    ./smart-wifi-switch.sh auto binance.com"
    echo ""
    echo "    # 添加必须切换WiFi的域名"
    echo "    ./smart-wifi-switch.sh add-foreign binance.com"
    echo ""
    echo "    # 测试域名"
    echo "    ./smart-wifi-switch.sh test google.com"
}

# 主入口
main() {
    init
    
    case "${1:-help}" in
        init)
            init
            log INFO "初始化完成"
            ;;
        update)
            update_lists
            ;;
        add)
            add_custom_domain "$2"
            ;;
        add-foreign)
            add_foreign_wifi_domain "$2"
            ;;
        remove)
            remove_custom_domain "$2"
            ;;
        list)
            list_custom_domains
            ;;
        merge)
            merge_lists
            ;;
        test)
            test_domain "$2"
            ;;
        check)
            if check_website_direct "$2"; then
                log INFO "网站可访问"
            else
                log WARN "网站不可访问"
            fi
            ;;
        auto)
            auto_switch "$2"
            ;;
        switch)
            connect_wifi "$2"
            ;;
        smart)
            smart_switch "$2"
            ;;
        status)
            status
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log ERROR "未知命令: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
