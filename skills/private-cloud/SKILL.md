---
name: private-cloud
description: 私有云服务部署指南，基于 Mac mini + Tailscale + Nextcloud + Stalwart。包含远程访问、文件同步、日历联系人、邮件系统等完整解决方案。触发词：私有云、nextcloud、tailscale、远程访问、家庭服务器、nas。
---

# 私有云服务

基于 Mac mini 的完整私有云解决方案，提供文件同步、日历联系人、邮件系统等功能。

## 当前部署状态

✅ **已成功部署** (2026-03-03)

| 服务 | 状态 | 访问地址 |
|------|------|----------|
| Nextcloud | ✅ 运行中 | `https://franks-mac-mini.taile3ecbd.ts.net/` |
| Stalwart Mail | ✅ 运行中 | `mail.lilibtc.com` |
| Tailscale | ✅ 已连接 | `100.77.166.19` |
| ddns-go | ✅ 运行中 | `mail.lilibtc.com` |

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Mac mini (Home)                             │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │  Nextcloud  │  │  Stalwart   │  │  ddns-go    │  │  Tailscale│  │
│  │  (Web UI)   │  │  (Mail)     │  │  (DDNS)     │  │  (VPN)    │  │
│  │  :8081      │  │  :143/:587  │  │  :9876      │  │  :41641   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘  │
│         │                │                │                │        │
│         └────────────────┴────────────────┴────────────────┘        │
│                                    │                                 │
│                          Tailscale Serve (HTTPS)                     │
│                          franks-mac-mini.taile3ecbd.ts.net           │
└─────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
              ┌─────▼─────┐                    ┌─────▼─────┐
              │  Android  │                    │  远程设备  │
              │  (DAVx⁵)  │                    │  (Browser)│
              └───────────┘                    └───────────┘
```

## 服务清单

### 1. Nextcloud (文件同步 + 日历 + 联系人)

| 配置项 | 值 |
|--------|-----|
| 内部地址 | `http://127.0.0.1:8081` |
| 外部地址 | `https://franks-mac-mini.taile3ecbd.ts.net/` |
| 版本 | 33.0.0.16 |
| 用户名 | `frank` |
| 密码 | `Frank@2026` |
| 数据目录 | `/Users/mac/nextcloud/data` |

#### 启动 Nextcloud

```bash
cd ~/nextcloud
/opt/homebrew/opt/php@8.2/bin/php -d memory_limit=512M -S 0.0.0.0:8081 -t .
```

#### 已安装应用

- ✅ Files (文件管理)
- ✅ Calendar (日历) - 6.2.1
- ✅ Contacts (联系人) - 8.4.0
- ✅ Mail (邮件) - 已配置 lili@lilibtc.com

### 2. Stalwart Mail Server (邮件系统)

详细配置见 [../local-mail-server/SKILL.md](../local-mail-server/SKILL.md)

| 配置项 | 值 |
|--------|-----|
| IMAP | `localhost:143` (STARTTLS) |
| SMTP | `localhost:587` (STARTTLS) |
| Web UI | `http://localhost:8080` |
| 中继 | Brevo (300封/天免费) |
| 主邮箱 | `lili@lilibtc.com` |

### 3. Tailscale (VPN 远程访问)

| 配置项 | 值 |
|--------|-----|
| Tailscale IP | `100.77.166.19` |
| 主机名 | `franks-mac-mini` |
| MagicDNS | `franks-mac-mini.taile3ecbd.ts.net` |
| HTTPS 代理 | Tailscale Serve (:443 → :8081) |

#### 配置 Tailscale Serve (HTTPS)

```bash
tailscale serve https:443 {
  proxy / http://127.0.0.1:8081
}
```

### 4. ddns-go (动态 DNS)

| 配置项 | 值 |
|--------|-----|
| Web UI | `http://localhost:9876` |
| 域名 | `mail.lilibtc.com` |
| DNS 服务商 | Cloudflare |
| 配置文件 | `~/.ddns_go_config.yaml` |

## Android 客户端配置

### DAVx⁵ (日历/联系人同步)

| 配置项 | 值 |
|--------|-----|
| 服务器地址 | `https://franks-mac-mini.taile3ecbd.ts.net/remote.php/dav/` |
| 用户名 | `frank` |
| 密码 | `Frank@2026` |

**注意**: 
- 使用 HTTPS 地址
- 不要加端口号
- 地址末尾加 `/`

### K-9 Mail / FairEmail (邮件客户端)

| 配置项 | IMAP | SMTP |
|--------|------|------|
| 服务器 | Tailscale IP | Tailscale IP |
| 端口 | 143 | 587 |
| 加密 | STARTTLS | STARTTLS |
| 用户名 | `lili` | `lili` |
| 密码 | `Lili@2026` | `Lili@2026` |

## 远程访问方案

### 方案 A: Tailscale VPN (推荐)

优点：安全、无需公网 IP、自动穿透 NAT

1. 在所有设备上安装 Tailscale
2. 登录同一个 Tailscale 账户
3. 通过 MagicDNS 地址访问

### 方案 B: Cloudflare Tunnel (可选)

用于暴露服务给非 Tailscale 用户：

```bash
cloudflared tunnel --url http://localhost:8081
```

## 开机自启动配置

### 使用 launchd (macOS)

创建 `~/Library/LaunchAgents/com.user.private-cloud.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.private-cloud</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/mac/clawd/skills/private-cloud/scripts/start-all.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### 启动脚本示例

```bash
#!/bin/bash
# ~/clawd/skills/private-cloud/scripts/start-all.sh

# 启动 Nextcloud
cd ~/nextcloud
/opt/homebrew/opt/php@8.2/bin/php -d memory_limit=512M -S 0.0.0.0:8081 -t . &

# 启动 Stalwart
cd ~/clawd/skills/local-mail-server
./scripts/start-mail-server.sh start

# 启动 ddns-go
/opt/homebrew/bin/ddns-go &
```

## 常用命令

```bash
# 检查所有服务状态
tailscale status
ps aux | grep -E "php|stalwart|ddns"

# 启动 Nextcloud
cd ~/nextcloud && /opt/homebrew/opt/php@8.2/bin/php -d memory_limit=512M -S 0.0.0.0:8081 -t .

# 启动邮件服务
cd ~/clawd/skills/local-mail-server && ./scripts/start-mail-server.sh start

# 查看 Tailscale 连接
tailscale status

# 查看 ddns-go 状态
curl http://localhost:9876
```

## 故障排除

### Nextcloud 无法访问

1. 检查 PHP 进程是否运行
2. 检查 Tailscale 连接状态
3. 确认 Tailscale Serve 配置正确

### DAVx⁵ 同步失败

1. 确认 Tailscale VPN 已连接
2. 检查 URL 格式（要有 `/remote.php/dav/`）
3. 确认用户名密码正确

### 邮件无法发送

1. 检查 Stalwart 服务状态
2. 确认 Brevo 中继配置正确
3. 查看 Stalwart 日志

### Tailscale 连接问题

```bash
# 重新认证
tailscale login

# 检查状态
tailscale status

# 重启 Tailscale
sudo tailscaled restart
```

## 备份策略

### 需要备份的目录

| 目录 | 内容 | 频率 |
|------|------|------|
| `~/nextcloud/data/` | Nextcloud 用户数据 | 每日 |
| `~/clawd/skills/local-mail-server/data/` | 邮件数据 | 每日 |
| `~/.ddns_go_config.yaml` | DDNS 配置 | 变更时 |
| `~/clawd/skills/local-mail-server/config/` | Stalwart 配置 | 变更时 |

### 备份脚本示例

```bash
#!/bin/bash
# ~/clawd/skills/private-cloud/scripts/backup.sh

BACKUP_DIR="/Volumes/Backup/private-cloud"
DATE=$(date +%Y-%m-%d)

# 备份 Nextcloud 数据
rsync -av ~/nextcloud/data/ $BACKUP_DIR/nextcloud-$DATE/

# 备份邮件数据
rsync -av ~/clawd/skills/local-mail-server/data/ $BACKUP_DIR/mail-$DATE/

# 备份配置
cp ~/.ddns_go_config.yaml $BACKUP_DIR/
cp -r ~/clawd/skills/local-mail-server/config/ $BACKUP_DIR/stalwart-config/
```

## 安全建议

1. **强密码**: 所有服务使用强密码
2. **两步验证**: Nextcloud 启用 TOTP
3. **定期更新**: 保持所有组件最新版本
4. **备份加密**: 备份文件加密存储
5. **网络隔离**: 敏感服务仅绑定 localhost
6. **监控日志**: 定期检查异常访问

## 扩展功能

### 添加新服务

1. **Home Assistant** - 智能家居控制
2. **Jellyfin** - 媒体服务器
3. **Gitea** - Git 代码托管
4. **Vaultwarden** - 密码管理

### 性能优化

1. 使用 PHP-FPM 替代内置服务器
2. 配置 Redis 缓存
3. 使用 Nginx 反向代理

## 相关技能文档

- [local-mail-server](../local-mail-server/SKILL.md) - 邮件服务器详细配置
- [smart-wifi-switch](../smart-wifi-switch/SKILL.md) - 智能网络切换

## 自动化功能

### 邮件 → 日历同步

每天自动从 `lili@lilibtc.com` 邮箱提取重要事件并同步到 Nextcloud 日历。

**支持的邮件类型：**
| 类型 | 关键词 | 日历颜色 |
|------|--------|----------|
| ✈️ 航班 | 航班、机票、flight | 橙色 |
| 🏨 酒店 | 酒店、预订、hotel | 绿色 |
| 📅 会议 | 会议、邀请、zoom、teams | 蓝色 |
| 📋 预约 | 预约、挂号、appointment | 紫色 |
| 💳 账单 | 账单、缴费、bill、due | 红色 |
| 📦 快递 | 快递、包裹、delivery | 橙黄色 |
| 🧳 旅行 | 行程、旅游、itinerary | 青色 |

**定时任务：**
- Cron ID: `5ed51c25-aa0a-4f0f-a8ab-3f67e652a656`
- 执行时间: 每天 09:00 (Asia/Shanghai)
- 脚本: `scripts/mail-calendar-sync.mjs`

**手动运行：**
```bash
cd ~/clawd/skills/private-cloud/scripts

# 正式运行
node mail-calendar-sync.mjs --days=7

# 预览模式（不写入日历）
node mail-calendar-sync.mjs --dry-run --days=7
```

**配置文件：** `config/mail-credentials.json`

---

### Android 联系人同步经验

**DAVx⁵ 配置要点：**

1. **服务器地址格式**：
   ```
   https://franks-mac-mini.taile3ecbd.ts.net/remote.php/dav/
   ```
   ⚠️ 注意：
   - 使用 HTTPS（Tailscale Serve 代理）
   - 不要加端口号
   - 地址末尾必须有 `/`

2. **认证信息**：
   | 字段 | 值 |
   |------|-----|
   | 用户名 | `frank` |
   | 密码 | `Frank@2026` |

3. **同步成功标志**：
   - DAVx⁵ 显示 "已连接"
   - 可以看到日历和通讯录选项
   - 同步后联系人出现在 Nextcloud Contacts 应用中

4. **常见问题**：
   - **SSL 错误**：确保 Tailscale Serve 正常运行
   - **认证失败**：检查密码是否正确，尝试在浏览器登录 Nextcloud 验证
   - **同步不完整**：检查 DAVx⁵ 的同步设置，确认选择了正确的通讯录

---

## 更新日志

- **2026-03-05**: 添加邮件日历同步脚本和 Android 联系人同步经验
- **2026-03-03**: 创建私有云技能文档，整合 Nextcloud + Stalwart + Tailscale 配置经验
