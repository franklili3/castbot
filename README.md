# @castbot

> **Castbot 币安广场自动发布工具** - 自动同步内容到 Binance Square，提升个人品牌影响力

## 🎯 功能特点

- ✅ **自动发布** - 自动将内容发布到币安广场（Binance Square）
- 🤖 **智能生成** - AI 驱动的内容生成系统
- 📊 **数据分析** - 追踪浏览量、点赞、评论数据
- 🎨 **模板系统** - 多种内容模板可选
- 🔒 **安全可靠** - 本地运行，数据安全
- 🚀 **简单易用** - 一键安装，命令行操作

## 📦 安装

```bash
npm install -g @castbot
```

**要求**：Node.js >= 18

## 🚀 快速开始

### 1. 登录

```bash
castbot login --key YOUR_BINANCE_COOKIE
```

### 2. 启动发布器

```bash
castbot start
```

### 3. 查看状态

```bash
castbot status
```

## 📖 详细使用

### 命令列表

```bash
# 登录币安广场
castbot login --key YOUR_KEY

# 启动自动发布
castbot start

# 查看发布状态
castbot status

# 查看数据统计
castbot stats

# 查看版本
castbot --version
```

### 配置文件

配置文件位于：`~/.square-agent/config.json`

```json
{
  "frequency": 100,
  "style": "balanced",
  "contentTypes": "short",
  "enabledTemplates": [
    "☀️ 每日早报",
    "🌙 晚间复盘",
    "📈 盘面分析"
  ]
}
```

## 🔧 配置说明

### 频率设置（frequency）
- `100` - 正常频率
- `200` - 高频模式
- `50` - 低频模式

### 内容风格（style）
- `conservative` - 保守风格
- `balanced` - 平衡风格
- `aggressive` - 激进风格

### 内容长度（contentTypes）
- `short` - 短内容（< 200字）
- `medium` - 中等长度（200-500字）
- `long` - 长内容（> 500字）

## 📊 数据追踪

工具会自动追踪以下数据：

- 每日发帖数
- 总浏览量
- 总点赞数
- 总评论数
- 粉丝增长

数据保存在：`~/.square-agent/square-agent.db`

## 🛠️ 故障排除

### 问题：无法发布到币安广场

**解决方案**：
1. 检查网络连接
2. 确认币安 Cookie 是否过期
3. 重新运行 `castbot login --key YOUR_KEY`

### 问题：数据库错误

**解决方案**：
```bash
# 重置数据库
rm ~/.square-agent/square-agent.db
castbot start
```

### 问题：权限错误

**解决方案**：
```bash
# 检查币安广场发布权限
# 确保账号没有被限制发布
```

## 🔐 安全说明

- 所有数据存储在本地
- 不会上传任何内容到第三方服务器
- 币安 Cookie 仅用于与币安 API 通信
- 建议定期更新 Cookie

## 🌟 关于 Castbot

### 联系方式

- **币安广场**：[@castbot](https://www.binance.com/zh/square)
- **官网**：[castbot.io](https://castbot.io)
- **Telegram Bot**：[@castbotbot](https://t.me/castbotbot)

### 服务

本工具由 Castbot 团队开发和维护，专注于币安生态内容创作和分发。

## 📝 开源

本项目在 GitHub 上开源：

**开发仓库**：[franklili3/square-agent](https://github.com/franklili3/square-agent)

欢迎贡献代码、报告问题或提出建议！

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙏 鸣谢

感谢所有使用本工具的用户和贡献者！

---

**Made with ❤️ by Castbot Team**

*如有问题，请通过 [GitHub Issues](https://github.com/franklili3/square-agent/issues) 联系我们*
