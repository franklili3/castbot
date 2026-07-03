# SquareAgent — Crypto Social Media Automation

[中文文档](README_CN.md) | English

Schedule, generate, and publish crypto content across Binance Square, X/Twitter, and Telegram.

## ⚠️ Disclaimer

This software does **NOT** include content safety filters, rate limiting, or compliance checks.
Users are solely responsible for compliance with platform terms and local laws.
**Use at your own risk.**

## Features

- **Multi-platform publishing** — Binance Square, X/Twitter, Telegram Channels
- **RSS news aggregation** — Fetch crypto news from multiple sources
- **LLM content generation** — Turn raw news into engaging social media posts
- **MCP Server** — Expose tools to AI agents (Claude, OpenClaw, etc.)
- **CLI** — Quick publish, generate, and health check
- **Zero dependencies** — Pure Node.js (>= 18), uses native `fetch`
- **Docker-ready** — One command deployment

## Quick Start

```bash
# 1. Clone
git clone https://github.com/your-username/square-agent.git
cd square-agent

# 2. Configure
cp .env.example .env
# Edit .env with your API keys

# 3. Run pipeline (RSS → LLM → publish)
npm start

# Or run individual components:
node news-pipeline/news-monitor.mjs    # RSS collector
node news-pipeline/pipeline.mjs --watch # Full pipeline
node src/cli.mjs publish --text "Hello" # Quick publish
node src/mcp-server.mjs                 # MCP server
```

## Docker

```bash
cp .env.example .env
# Edit .env
docker compose up -d
```

## Architecture

```
RSS Sources ──→ news-monitor.mjs ──→ news-queue.json
                                              │
                                    pipeline.mjs
                                              │
                                    news-generator.mjs (LLM)
                                              │
                                    registry.mjs ──→ Binance Square
                                                  ──→ X/Twitter
                                                  ──→ Telegram
```

See [docs/architecture.md](docs/architecture.md) for details.

## Connectors

### Binance Square
- Text + image posts via official OpenAPI
- Set `BINANCE_SQUARE_API_KEY` in `.env`

### X/Twitter
- Text posts via X API v2
- Set `X_OAUTH_TOKEN` in `.env`

### Telegram Channel
- Text + image posts via Bot API
- Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` in `.env`

### Custom Connectors
Extend `BaseConnector` and implement `publish()`:
```javascript
import { BaseConnector } from 'square-agent/connectors/base';

class MyConnector extends BaseConnector {
  async publish(content, options = {}) {
    // Your logic
    return { success: true, postId: '123' };
  }
}
```

## MCP Integration

SquareAgent ships with an MCP (Model Context Protocol) server:

```json
{
  "mcpServers": {
    "square-agent": {
      "command": "node",
      "args": ["/path/to/square-agent/src/mcp-server.mjs"]
    }
  }
}
```

Available tools: `publish_post`, `generate_content`, `check_health`.

## Configuration

Copy `news-pipeline/config.example.mjs` to `news-pipeline/config.mjs` and customize:

- RSS sources
- Keywords filter
- LLM endpoint
- Publish platforms

## Optional Xquik Source Context

SquareAgent can also use recent X/Twitter conversations as source context before
generation. The `examples/xquik-source-context.mjs` script fetches tweet search
results from Xquik and writes a local JSON file that can be reviewed or folded
into prompts.

```bash
XQUIK_API_KEY=your_key \
XQUIK_TWEET_QUERY="bitcoin OR crypto OR web3" \
node examples/xquik-source-context.mjs
```

The script calls `GET https://xquik.com/api/v1/x/tweets/search` with the
`X-API-Key` header and saves normalized rows to `data/xquik-sources.json`.
Keep this as upstream evidence for drafting and review; keep SquareAgent's
configured connectors responsible for publishing.

## License

MIT — See [LICENSE](LICENSE)
