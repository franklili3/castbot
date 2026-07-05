<div align="center">

# SquareAgent

### Crypto Social Media Automation with Built-in Compliance

Schedule, generate, filter, and publish crypto content across Binance Square, X/Twitter, and Telegram — with financial compliance built in.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

</div>

---

## 🤔 Why SquareAgent?

If you've tried [Postiz](https://github.com/gitroomhq/postiz-app) for general social media management, SquareAgent is its crypto-native counterpart — purpose-built for traders, KOLs, and crypto projects.

**The problem**: Crypto content creators face a unique chain of pain points:

```
7×24 market watching → no time to write → content quality drops
→ traffic declines → compliance risks → account banned → revenue collapses
```

**The solution**: An automation framework that handles the entire pipeline:

```
News/RSS → AI Scoring → Content Generation → Compliance Filter → Multi-Platform Publishing
```

## ✨ Features

### 🤖 AI Content Engine
- News-triggered content generation (bring your own LLM — GLM, GPT, Claude, etc.)
- Multi-template system: breaking news, price alerts, deep analysis
- Bilingual output: Chinese primary + English key takeaway
- Configurable tone, length, and style per template

### 🛡️ Financial Compliance Layer
This is what makes SquareAgent different from every other social media scheduler:

- **Banned words library** — 3-tier system (block / warn / soft) covering crypto-specific violations across languages
- **Auto-replacement** — Dangerous phrases like "guaranteed return" → "likely to perform"
- **Risk disclaimer injection** — Every post with market opinions gets automatic DYOR disclaimers
- **Jurisdiction routing** — Different content rules for CN / GLOBAL audiences

### 📡 Multi-Platform Connectors
Unified interface, new platforms in minutes:

| Platform | Text | Image | Video | Poll | Delete | Stats |
|---|---|---|---|---|---|---|
| Binance Square | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| X / Twitter | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Telegram Channel | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |

```javascript
import { getConnector } from 'square-agent/src/connectors/registry.mjs';

const binance = getConnector('binance');
await binance.publish('BTC just hit $70K! 🚀', {
  images: ['https://example.com/chart.png']
});
```

Add your own platform:

```javascript
import { BaseConnector } from 'square-agent/src/connectors/base.mjs';

class DiscordConnector extends BaseConnector {
  constructor() {
    super();
    this.name = 'Discord';
    this.platform = 'discord';
  }

  async publish(content, options) {
    // Your API call here
    return { success: true, postId: '123' };
  }
}
```

### ⏱️ Smart Scheduler
- **Randomized intervals** (3–15 min) to avoid bot detection
- **Title similarity dedup** — Jaccard similarity check blocks near-duplicate posts within 24h
- **Daily quota management** — Configurable limit with real-time tracking
- **Content hash dedup** — 5-minute window prevents identical posts from race conditions

### 📋 Approval Workflow
Three modes for different team setups:

| Mode | Flow | Use Case |
|---|---|---|
| `auto` | Generate → Publish | Solo creator, speed-first |
| `review` | Generate → TG Button Confirm → Publish | Small team, human oversight |
| `multi-step` | Generate → Compliance → Editor → Publish | Regulated entities |

### 🏥 Health Monitor
- Real-time success rate tracking
- Consecutive failure alerts (3 = warning, 5 = critical)
- Per-hour breakdown
- Human-readable health reports via CLI or API

### 🔌 Ecosystem Integration

**CLI**:
```bash
square-cli publish --text "BTC pump!" --platform binance,x
square-cli generate --topic "ETF flows analysis"
square-cli health
square-cli pending
```

**MCP Server** (for AI agents — OpenClaw, Claude, etc.):
```json
{
  "tools": ["publish_post", "generate_content", "get_stats", "check_health", "list_pending"]
}
```

Connect to n8n / Make.com / custom workflows as a standard MCP server.

### 🐳 Docker Ready
```bash
cp .env.example .env  # Fill in API keys
docker-compose up -d  # That's it
```

## 🚀 Quick Start

### Prerequisites
- Node.js 22+
- An LLM API key (we use [GLM](https://open.bigmodel.cn/), but any OpenAI-compatible API works)
- Platform API keys (Binance Square / X / Telegram — at least one)

### Option A: Docker (Recommended)

```bash
git clone https://github.com/yourname/square-agent.git
cd square-agent
cp .env.example .env
# Edit .env with your API keys
docker-compose up -d
```

### Option B: Manual

```bash
git clone https://github.com/yourname/square-agent.git
cd square-agent
npm install

# Configure
cp news-pipeline/config.example.mjs news-pipeline/config.mjs
# Edit config.mjs with your API keys

# Run the news pipeline (collects & scores news)
node news-pipeline/pipeline.mjs --watch

# In another terminal, run the publisher
node src/cli.mjs pending  # Check what's queued
```

### Option C: Use as a Library

```bash
npm install square-agent
```

```javascript
import { getConnector } from 'square-agent/src/connectors/registry.mjs';
import { complianceFilter } from 'square-agent/src/compliance/index.mjs';

// Filter content for compliance
const result = complianceFilter('This token will 10x guaranteed!');
console.log(result.passed); // false
console.log(result.actions); // ['🚫 拒绝发布：包含绝对禁止词 guaranteed']

// Publish to Binance Square
const binance = getConnector('binance');
await binance.publish('BTC analysis content here...');
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     SquareAgent                          │
│                                                          │
│  ┌──────────┐   ┌──────────┐   ┌───────────────────┐   │
│  │  RSS /   │──▶│  AI      │──▶│  Compliance       │   │
│  │  News    │   │  Scoring │   │  Filter Layer     │   │
│  │  Monitor │   │  (LLM)   │   │  (banned words,   │   │
│  │          │   │          │   │   disclaimers,    │   │
│  └──────────┘   └──────────┘   │   jurisdiction)   │   │
│                                └────────┬──────────┘   │
│                                         │               │
│  ┌──────────────────┐          ┌────────▼──────────┐   │
│  │  Approval Flow   │◀────────│  Content Engine    │   │
│  │  (auto/review/   │          │  (templates,       │   │
│  │   multi-step)    │          │   bilingual)       │   │
│  └────────┬─────────┘          └────────────────────┘   │
│           │                                              │
│  ┌────────▼─────────┐          ┌────────────────────┐   │
│  │  Smart Scheduler │─────────▶│  Connector Hub     │   │
│  │  (randomized,    │          │                    │   │
│  │   dedup, quota)  │          │  ┌─────┐ ┌───┐    │   │
│  └──────────────────┘          │  │Binance│ │ X │    │   │
│                                │  └─────┘ └───┘    │   │
│  ┌──────────────────┐          │  ┌─────────────┐  │   │
│  │  Health Monitor  │          │  │ Telegram    │  │   │
│  │  (alerts, stats) │          │  └─────────────┘  │   │
│  └──────────────────┘          └────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Ecosystem: CLI • MCP Server • Docker            │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
square-agent/
├── src/
│   ├── connectors/           # Platform connectors
│   │   ├── base.mjs          # Unified interface
│   │   ├── binance-square.mjs
│   │   ├── x-twitter.mjs
│   │   ├── telegram-channel.mjs
│   │   └── registry.mjs      # Manager + multi-publish
│   ├── compliance/           # Financial compliance
│   │   ├── index.mjs         # Entry point
│   │   ├── banned-words.mjs  # 3-tier word library
│   │   ├── risk-disclaimer.mjs
│   │   └── jurisdiction.mjs  # CN / GLOBAL routing
│   ├── scheduler.mjs         # Smart publishing scheduler
│   ├── approval-flow.mjs     # Multi-role approval state machine
│   ├── health-monitor.mjs    # Account health tracking
│   ├── cli.mjs               # Command-line tool
│   └── mcp-server.mjs        # MCP Server for AI agents
├── prompts/                  # Open-source LLM prompts
│   ├── scoring.mjs           # News scoring prompt
│   ├── generation.mjs        # Content generation prompt
│   └── templates.mjs         # Content templates
├── news-pipeline/            # RSS → Score → Generate pipeline
├── examples/                 # Usage examples
├── docs/                     # Documentation
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

## 🔧 Configuration

| Variable | Required | Description |
|---|---|---|
| `GLM_API_KEY` | Yes | LLM API key (GLM / OpenAI-compatible) |
| `BINANCE_SQUARE_OPENAPI_KEY` | Binance | Binance Square API key |
| `X_OAUTH_TOKEN` | X (optional) | X/Twitter OAuth token |
| `TELEGRAM_BOT_TOKEN` | Telegram (optional) | Telegram Bot API token |
| `TELEGRAM_CHANNEL_ID` | Telegram (optional) | Target channel ID |
| `DAILY_LIMIT` | No | Max posts per day (default: 100) |

## 🤝 Contributing

Contributions welcome! Especially:

- **New Connectors** — Reddit, Discord, Medium, Mirror, Farcaster
- **Compliance rules** — Additional jurisdictions (US, EU, HK, SG)
- **LLM prompts** — Better scoring accuracy, more content styles
- **Translations** — Interface i18n

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Adding a new Connector

1. Create `src/connectors/your-platform.mjs`
2. Extend `BaseConnector`
3. Implement `publish()` (minimum), optionally `delete()`, `getStats()`, `checkHealth()`
4. Register in `registry.mjs`
5. Open a PR!

## 📊 Comparison with Postiz

| Feature | Postiz | SquareAgent |
|---|---|---|
| Target audience | General social media | Crypto traders / KOLs |
| Compliance filter | ❌ | ✅ Built-in |
| Crypto data pipeline | ❌ | ✅ RSS → Score → Generate |
| Binance Square | ❌ | ✅ |
| Telegram Channel | ❌ | ✅ |
| X / Twitter | ✅ | ✅ |
| AI content generation | ✅ (generic) | ✅ (crypto-tuned) |
| Multi-platform scheduling | ✅ | ✅ |
| Approval workflow | Basic | 3-mode state machine |
| MCP Server | ✅ | ✅ |
| Docker deploy | ✅ | ✅ |
| License | AGPL-3.0 | AGPL-3.0 |

## ⚠️ Disclaimer

SquareAgent is an automation framework, **not financial advice software**. 

- All content generated by the AI is for informational purposes only
- Always review content before publishing in regulated jurisdictions
- The compliance filter helps reduce risk but does not guarantee legal compliance
- Cryptocurrency content may be restricted in your jurisdiction — check local laws
- The authors are not responsible for any account suspensions, legal issues, or financial losses

## 📄 License

[AGPL-3.0](LICENSE) — Free for self-hosting. Commercial SaaS offerings require a commercial license.

## 🙋 Community

- 🐛 [Bug Reports](https://github.com/yourname/square-agent/issues)
- 💬 [Discussions](https://github.com/yourname/square-agent/discussions)
- 🐦 [Twitter](https://twitter.com/yourhandle)

---

<div align="center">

**⭐ Star this repo if it helps you!**

Built with ❤️ by crypto traders, for crypto traders.

</div>
