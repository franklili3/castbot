# lilibtc-bot

> 币安广场（Binance Square）自动发帖客户端发布器，配套 [Lilibtc Bot](https://lilibtc.com) 服务端使用。

[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 这是什么

`lilibtc-bot` 是一个运行在**你自己电脑上**的命令行工具：它从 Lilibtc 服务端领取已生成/审核的内容，通过币安广场 OpenAPI 自动发布到你的币安广场账号，支持文本、图片与长文，并自带本地网页管理面板。

## 为什么开源

**这个发布器会接触你的币安 OpenAPI key——你有权审计每一行代码。**

- 你的币安 key 和 Lilibtc API key **只存在你本机** `~/.lilibtc-bot/` 目录（权限 600），不上传任何服务器
- 发布逻辑全在本机运行，你可以断网、停止、卸载，随时掌控
- 本仓库代码即发布器实际运行的代码，无混淆、无遥测后门

## 3 步上手

### ① 领取 API key

在 Telegram 打开 [@lilibtcbot](https://t.me/lilibtcbot)，按提示获取你的 API key（`bsq_` 或 `sk-` 开头）。

### ② 安装

**一键安装（推荐）**：

```bash
# macOS / Linux
curl -sL https://api.lilibtc.com/install.sh | bash
```

```powershell
# Windows —— 必须在 PowerShell 中运行（无需 WSL）
irm https://api.lilibtc.com/install.ps1 | iex
```

**或通过 npm**（大陆网络建议先切镜像加速：`npm config set registry https://registry.npmmirror.com`）：

```bash
npm install -g lilibtc-bot
```

**备用**：本仓库的 [install.sh](install.sh)（npm 失败时回退 GitHub/server 源）。

### ③ 登录 + 配置币安 key + 启动

```bash
# 登录（key 来自 TG bot）
lilibtc-bot login --key YOUR_API_KEY

# 配置币安广场发帖 OpenAPI key（仅存本机）
lilibtc-bot set-binance-key YOUR_BINANCE_KEY
# 或: echo "YOUR_KEY" > ~/.lilibtc-bot/binance-api-key
# 获取地址: https://www.binance.com/zh-CN/square/creator-center/home → 创建 API

# 启动（同时会打开本地管理面板 http://127.0.0.1:8421）
lilibtc-bot start
```

后台运行用 `lilibtc-bot start --daemon`，停止用 `lilibtc-bot stop`。

## 系统要求

- Node.js ≥ 18（Linux / macOS / Windows 均可；**Windows 需在 PowerShell 中运行**，无需 WSL）
- 大陆网络：工具需要访问 binance.com 与 GitHub（更新源）。如有代理，配置方式：
  ```bash
  HTTPS_PROXY=http://127.0.0.1:7897 lilibtc-bot start
  ```
  或在本地面板设置里直接填代理地址（运行时热生效）。也可用 `lilibtc-bot setting proxy http://127.0.0.1:7897`。

## 常见问题

**Q: 我的 key 存在哪里？**
A: 全部在本机 `~/.lilibtc-bot/`（config.json、binance-api-key，权限 600）。服务端只保存你的账号绑定关系，不保存币安 key。

**Q: 怎么停止发帖？**
A: `lilibtc-bot stop`（停止代理进程），或 `uninstall.sh` / `npm uninstall -g lilibtc-bot` 完全卸载。

**Q: 怎么更新？**
A: `lilibtc-bot update`（默认从 npm registry 拉取，大陆可设 `LILIBTC_NPM_REGISTRY=https://registry.npmmirror.com` 加速；有代理可 `update --github`），或直接 `npm update -g lilibtc-bot`。代理运行中更新会自动按原模式重启。

**Q: 支持哪些内容格式？**
A: 文本 + 图片（最多 4 张）+ 长文，内容由 Lilibtc 服务端生成并审核后下发。

## 更多

- 完整功能与数据看板：[https://lilibtc.com](https://lilibtc.com)
- 直接开聊 / 领 key：[@lilibtcbot](https://t.me/lilibtcbot)

## License

[MIT](LICENSE)
