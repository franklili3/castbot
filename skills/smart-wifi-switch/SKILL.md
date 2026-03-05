---
name: smart-wifi-switch
description: 智能 WiFi 切换工具，根据目标网站自动在两个 SSID 之间切换或使用 ClashX Pro 代理。支持：(1) GFWList 自动更新，(2) 自定义域名列表管理，(3) 代理优先策略，(4) 访问失败自动检测并添加到列表，(5) 开机自动启动。触发词：wifi切换、翻墙网络、SSID切换、GFWList、ClashX代理。
---

# 智能 WiFi 切换（代理优先版）

单网卡智能切换工具，根据访问的网站自动选择国内WiFi、国外WiFi或使用 ClashX Pro 代理。

## 核心功能

1. **GFWList 自动更新** - 从 GitHub 下载并定期更新
2. **自定义域名列表** - 手动添加发现的国外网站
3. **代理优先策略** - GFW 域名优先使用 ClashX Pro 代理
4. **必须切换WiFi列表** - 代理也无法访问的域名（如 binance.com）
5. **智能切换** - 根据域名自动选择最佳网络
6. **自动检测** - 访问失败时自动添加到列表并切换网络

## 工作流程 (auto 命令)

```
访问目标域名
    │
    ├─→ 已在国外WiFi? ─────────────────────→ 直接访问 ✅
    │
    ├─→ 在必须切换WiFi列表? ───────────────→ 切换到国外WiFi 🔄
    │
    ├─→ 不在GFW列表? ─→ 尝试直连 ─→ 成功? ─→ 继续使用国内WiFi ✅
    │                              │
    │                              └→ 失败 ─┐
    │                                       │
    │                                       ↓
    └─→ 在GFW列表中 ←───────────────────────┘
            │
            └─→ 尝试ClashX Pro代理 ─→ 成功? ─→ 使用代理访问 ✅
                    │
                    └→ 失败? ─→ 添加到必须切换WiFi列表
                                      │
                                      └→ 切换到国外WiFi 🔄
```

## 快速开始

### 1. 配置环境变量

```bash
cd ~/clawd/skills/smart-wifi-switch
cp .env.example .env
# 编辑 .env 设置你的网卡接口和两个 SSID
```

配置项：
- `WIFI_IF` - WiFi 网卡接口（如 en1）
- `WIFI_DOMESTIC_SSID` - 国内 WiFi 名称
- `WIFI_FOREIGN_SSID` - 国外 WiFi 名称
- `USE_PROXY_FIRST` - 对GFW域名优先使用代理（默认 true）

### 2. 初始化和首次更新

```bash
./scripts/smart-wifi-switch.sh init
./scripts/smart-wifi-switch.sh update   # 下载 GFWList
```

### 3. 安装开机启动

```bash
./scripts/install-launchd.sh
```

## 常用命令

```bash
# 查看状态（包含代理状态）
./scripts/smart-wifi-switch.sh status

# 自动检测并切换（推荐！智能选择代理或WiFi）
./scripts/smart-wifi-switch.sh auto binance.com

# 添加必须切换WiFi的域名（代理也无法访问的）
./scripts/smart-wifi-switch.sh add-foreign binance.com

# 添加普通GFW域名（会优先尝试代理）
./scripts/smart-wifi-switch.sh add youtube.com

# 测试域名（显示直连/代理/列表状态）
./scripts/smart-wifi-switch.sh test google.com

# 手动切换
./scripts/smart-wifi-switch.sh switch domestic  # 切换到国内网络
./scripts/smart-wifi-switch.sh switch foreign   # 切换到国外网络

# 智能切换（根据域名自动选择，不检测连通性）
./scripts/smart-wifi-switch.sh smart youtube.com

# 域名管理
./scripts/smart-wifi-switch.sh list               # 列出所有自定义域名
./scripts/smart-wifi-switch.sh remove youtube.com # 从列表删除

# 更新列表
./scripts/smart-wifi-switch.sh update   # 更新 GFWList
./scripts/smart-wifi-switch.sh merge    # 合并列表
```

## 文件结构

```
smart-wifi-switch/
├── SKILL.md              # 本文件
├── .env                  # 环境变量配置（需创建）
├── .env.example          # 配置示例
├── scripts/
│   ├── smart-wifi-switch.sh        # 主脚本
│   ├── install-launchd.sh          # 安装开机启动
│   └── update-gfwlist-cron.sh      # 安装定期更新
└── data/                           # 自动创建
    ├── gfwlist.txt                 # 下载的 GFWList
    ├── custom-gfwlist.txt          # 自定义 GFW 域名列表
    ├── foreign-wifi-list.txt       # 必须切换WiFi的域名列表
    ├── merged-gfwlist.txt          # 合并后的完整列表
    ├── current-wifi.state          # 当前网络状态
    └── wifi-switch.log             # 日志文件
```

## 三个域名列表说明

| 列表 | 文件 | 说明 | 处理方式 |
|------|------|------|----------|
| GFWList | gfwlist.txt | 自动下载的官方列表 | 优先使用代理 |
| 自定义GFW | custom-gfwlist.txt | 手动添加/自动检测 | 优先使用代理 |
| 必须切换WiFi | foreign-wifi-list.txt | 代理也无法访问 | 直接切换WiFi |

## ClashX Pro 代理配置

脚本默认使用 ClashX Pro 的本地代理端口：
- HTTP 代理: `http://127.0.0.1:7890`
- SOCKS 代理: `socks5://127.0.0.1:7891`

确保 ClashX Pro 已启动并开启系统代理。

## 典型使用场景

### freqtrade 访问 binance.com

```bash
# 方法1: 自动检测（首次会添加到必须切换WiFi列表）
./scripts/smart-wifi-switch.sh auto binance.com

# 方法2: 直接添加到必须切换WiFi列表
./scripts/smart-wifi-switch.sh add-foreign binance.com
```

### 访问普通 GFW 网站（如 google.com）

```bash
# 会优先使用 ClashX Pro 代理
./scripts/smart-wifi-switch.sh auto google.com
```

## 开机自动运行

### 方式一：LaunchAgent（推荐）

```bash
./scripts/install-launchd.sh
```

### 方式二：Cron 定期更新

```bash
./scripts/update-gfwlist-cron.sh
```

## 注意事项

- 首次使用请先运行 `init` 和 `update`
- ClashX Pro 必须开启系统代理才能使用
- 切换 SSID 需要几秒钟时间
- 日志文件位于 `data/wifi-switch.log`

## 故障排除

```bash
# 查看网卡接口
/usr/sbin/networksetup -listallhardwareports

# 查看当前连接的 WiFi
/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I

# 测试代理是否可用
curl -x http://127.0.0.1:7890 -I https://www.google.com

# 查看日志
tail -f data/wifi-switch.log
```

## 更新日志

- **2026-03-05**: 添加 ClashX Pro 代理优先策略，新增 foreign-wifi-list 列表
- **2026-02-25**: 初始版本，支持 GFWList 和智能切换
