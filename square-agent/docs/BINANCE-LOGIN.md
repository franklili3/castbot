# 币安广场 OpenAPI Key 配置

> **v0.3.0 起**，square-agent 不再依赖浏览器/AppleScript 自动化。所有发帖通过币安广场 OpenAPI 完成，纯 HTTP，跨平台（Linux / Windows(WSL) / macOS）。

## 获取 Key

1. 访问币安广场创作者中心: <https://www.binance.com/zh-CN/square/creator-center/home>
2. 点击「创建 API」
3. 复制保存 Key（仅显示一次）

Key 只保存在你的本地机器，服务器不存储、不下发。

## 配置方式

### 方式一：环境变量

```bash
export BINANCE_SQUARE_OPENAPI_KEY=your_key_here
```

适合临时测试或在 CI 中使用。

### 方式二：配置文件（推荐）

```bash
echo "your_key" > ~/.square-agent/binance-api-key
```

或通过 CLI（如已安装 square-agent）：

```bash
square-agent config:set --binance-api-key YOUR_KEY
```

Agent 读取顺序：`process.env.BINANCE_SQUARE_OPENAPI_KEY` → `~/.square-agent/binance-api-key`

## 验证

```bash
square-agent health
```

或直接启动 agent，无 Key 时会立即报错退出并提示配置方法。

## 发布能力

| 类型 | 支持 | 说明 |
|------|------|------|
| 纯文本帖 | ✅ | `contentType=1` |
| 长文 | ✅ | `contentType=2`，带 `title` |
| 图片（最多 4 张） | ✅ | presigned URL → S3 PUT |
| 投票 | ❌ | 降级为普通文本帖（选项写在正文中） |

## 故障排查

- **`未配置币安广场 OpenAPI Key`**：按上方「配置方式」设置后重启 agent。
- **`10004`**：频率限制，agent 会自动退避重试（最多 5 次）。
- **HTTP 504**：服务端超时但帖子通常已发出，agent 视为成功。
