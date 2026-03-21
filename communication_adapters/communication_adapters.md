# Messaging Adapters — Scope of Work

## Background

The AI Agent system currently exposes two transport endpoints on the Orchestrator:

| Endpoint | Protocol | Payload |
|---|---|---|
| `GET /ws` | WebSocket (bidirectional, persistent) | `UserMessage` ↔ `AgentResponse` JSON |
| `POST /webhook` | HTTP POST (request/response) | `UserMessage` → `AgentResponse` JSON |

The **Messaging Adapters** component bridges external chat platforms to these endpoints. Each adapter translates platform-specific events into `UserMessage` payloads, forwards them to the Orchestrator, and converts `AgentResponse` back into platform-native messages.

Per `ai_agent_design.md`, the component is **TypeScript** and lives in `communication_adapters/`.

---

## Orchestrator Wire Format (existing)

```jsonc
// Inbound — UserMessage
{
  "session_id": "optional-uuid",  // omit to create a new session
  "message": "user text",
  "model": "optional-model-override"
}

// Outbound — AgentResponse
{
  "session_id": "uuid",
  "content": "agent reply (Markdown)",
  "model_used": "...",
  "input_tokens": 0,
  "output_tokens": 0
}
```

---

## Proposed Architecture

```
communication_adapters/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example
├── src/
│   ├── index.ts              # entrypoint — loads config, starts enabled adapters
│   ├── config.ts             # env-based configuration (zod schema)
│   ├── core/
│   │   ├── orchestrator-client.ts   # WebSocket client to Orchestrator /ws
│   │   ├── session-map.ts           # platform-user → orchestrator session_id mapping
│   │   ├── message-formatter.ts     # Markdown → platform-native conversion
│   │   └── types.ts                 # shared types (UserMessage, AgentResponse)
│   ├── adapters/
│   │   ├── telegram/
│   │   │   ├── index.ts             # Telegram adapter lifecycle
│   │   │   ├── bot.ts               # telegraf bot setup + event handlers
│   │   │   └── formatter.ts         # Markdown → Telegram MarkdownV2
│   │   └── slack/
│   │       ├── index.ts             # Slack adapter lifecycle
│   │       ├── app.ts               # Slack Bolt app setup + event handlers
│   │       └── formatter.ts         # Markdown → Slack mrkdwn (Block Kit)
│   └── utils/
│       ├── logger.ts                # structured logging (pino)
│       └── health.ts                # lightweight health endpoint
└── tests/
    ├── core/
    │   ├── orchestrator-client.test.ts
    │   ├── session-map.test.ts
    │   └── message-formatter.test.ts
    ├── adapters/
    │   ├── telegram.test.ts
    │   └── slack.test.ts
    └── fixtures/
```

---

## Shared Core (`src/core/`)

### Orchestrator Client (`orchestrator-client.ts`)

Manages a persistent WebSocket connection to the Orchestrator.

| Concern | Detail |
|---|---|
| **Connection** | Connect to `ws://<ORCH_HOST>:<ORCH_PORT>/ws` with auto-reconnect (exponential backoff) |
| **Auth** | Send `Authorization: Bearer <token>` header on upgrade if `ORCH_AUTH_TOKEN` is set |
| **Send / Receive** | `sendMessage(msg: UserMessage): Promise<AgentResponse>` — correlates responses by `session_id` |
| **Heartbeat** | Periodic ping/pong to detect dead connections |

### Session Map (`session-map.ts`)

Maps `(platform, platformUserId, channelId)` → `orchestratorSessionId`.

- **New conversations**: Omit `session_id` in the first request; Orchestrator creates one and returns it in `AgentResponse`. Store the mapping.
- **Existing conversations**: Include stored `session_id` in subsequent messages.
- **Session expiry**: TTL-based eviction (configurable, default 30 min idle). After expiry, next message starts a fresh session.
- **Storage**: In-memory `Map` is sufficient for v1; interface allows swapping to Redis later.

### Message Formatter (`message-formatter.ts`)

The Orchestrator responds in Markdown. Each platform needs its own dialect:

| Platform | Target Format | Key Transforms |
|---|---|---|
| Telegram | MarkdownV2 | Escape special chars (`_`, `*`, `[`, etc.), convert fenced code blocks |
| Slack | `mrkdwn` + Block Kit | Convert `#` headings → `*bold*`, fenced code → ` ``` ` blocks, list handling |

The base formatter splits long messages to respect platform limits (Telegram: 4096 chars, Slack: 3000 chars per block).

---

## Telegram Adapter (`src/adapters/telegram/`)

### Dependencies
- [`telegraf`](https://github.com/telegraf/telegraf) v4 — Telegram Bot framework for Node.js

### Bot Setup (`bot.ts`)

| Item | Detail |
|---|---|
| **Token** | `TELEGRAM_BOT_TOKEN` env var |
| **Polling vs Webhook** | Support both; default to long-polling for dev, webhook mode for prod (`TELEGRAM_WEBHOOK_URL`) |
| **Commands** | `/start` — greeting + new session; `/reset` — clear session mapping |
| **Private chats** | On `text` event → build `UserMessage`, send via orchestrator client, reply with formatted response |
| **Group chats** | **Mention/reply-only**: ignore messages unless the bot is @mentioned or the message is a direct reply to one of the bot's messages. Strip the `@bot_username` prefix before forwarding. |
| **Error handling** | Catch Telegram API errors (rate limits, message too long), log + retry with truncated message |

### Formatter (`formatter.ts`)

Convert Markdown to [Telegram MarkdownV2](https://core.telegram.org/bots/api#markdownv2-style):
- Escape reserved characters: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`
- Preserve code blocks and inline code
- Split messages > 4096 chars at paragraph boundaries

### Session Strategy

`(telegram, chatId)` → `sessionId`. Each Telegram chat (private or group) gets one session.

---

## Slack Adapter (`src/adapters/slack/`)

### Dependencies
- [`@slack/bolt`](https://github.com/slackapi/bolt-js) v4 — Slack's official framework

### App Setup (`app.ts`)

| Item | Detail |
|---|---|
| **Tokens** | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` env vars. Optionally `SLACK_APP_TOKEN` for Socket Mode. |
| **Transport** | Socket Mode for dev (no public URL needed); HTTP for prod (Slack sends events to a webhook) |
| **Event subscriptions** | `message` (direct messages), `app_mention` (in channels — bot responds when @mentioned) |
| **Message handler** | On event → extract text (strip bot mention prefix), build `UserMessage`, call orchestrator, reply in thread |
| **Thread support** | If the original message is in a thread, reply in the same thread (`thread_ts`). Top-level messages start new threads. |
| **Error handling** | Catch Slack API errors, handle rate limits (`retry-after`), acknowledge events within 3 seconds |

### Formatter (`formatter.ts`)

Convert Markdown to [Slack `mrkdwn`](https://api.slack.com/reference/surfaces/formatting#basics):
- `**bold**` → `*bold*`
- `_italic_` → `_italic_`
- `` `code` `` → `` `code` ``
- Fenced code blocks → Slack triple-backtick blocks
- `# Heading` → `*Heading*\n`
- Links `[text](url)` → `<url|text>`
- Split into multiple Block Kit `section` blocks if > 3000 chars

### Session Strategy

`(slack, teamId, channelId, threadTs?)` → `sessionId`. Each Slack thread gets its own session. Top-level messages start a new session/thread.

---

## Configuration (`src/config.ts`)

All configuration via environment variables, validated with `zod` at startup:

```
# Core
ORCHESTRATOR_URL=ws://localhost:8080/ws
ORCH_AUTH_TOKEN=                     # optional
SESSION_IDLE_TTL_MINUTES=30
LOG_LEVEL=info

# Telegram (omit to disable)
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_URL=                # omit for long-polling

# Slack (omit to disable)
SLACK_ENABLED=false
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APP_TOKEN=                     # for Socket Mode
```

Each adapter only starts if its `*_ENABLED` flag is `true`.

---

## Docker Integration

### Dockerfile

Multi-stage build: `node:22-alpine` build stage → `node:22-alpine` runtime.

### docker-compose.yml addition

```yaml
communication-adapters:
  build:
    context: communication_adapters
    dockerfile: Dockerfile
  environment:
    ORCHESTRATOR_URL: ws://orchestrator:8080/ws
    ORCH_AUTH_TOKEN: ${ORCH_AUTH_TOKEN:-}
    TELEGRAM_ENABLED: ${TELEGRAM_ENABLED:-false}
    TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
    SLACK_ENABLED: ${SLACK_ENABLED:-false}
    SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN:-}
    SLACK_SIGNING_SECRET: ${SLACK_SIGNING_SECRET:-}
    SLACK_APP_TOKEN: ${SLACK_APP_TOKEN:-}
  depends_on:
    orchestrator:
      condition: service_healthy
```

---

## Phased Delivery

| Phase | Scope | Delivers |
|---|---|---|
| **P0 — Skeleton** | Project scaffold, config, orchestrator client, session map, health endpoint | Runnable process that connects to Orchestrator |
| **P1 — Telegram** | Telegram bot, formatter, long-polling mode | End-to-end Telegram ↔ Agent conversations |
| **P2 — Slack** | Slack Bolt app, formatter, Socket Mode | End-to-end Slack ↔ Agent conversations |
| **P3 — Production hardening** | Webhook modes for both, Docker, reconnect logic, structured logging | Deployable containers |
| **P4 — Polish** | Group/channel support, `/reset` commands, message edit handling | Full-featured adapters |

---

## Verification Plan

### Automated Tests

Unit tests with `vitest`:

```bash
cd communication_adapters
npm test
```

| Test file | Coverage |
|---|---|
| `orchestrator-client.test.ts` | WebSocket connect, send/receive, reconnect, auth header |
| `session-map.test.ts` | Create, retrieve, TTL expiry, different platform keys |
| `message-formatter.test.ts` | Markdown → MarkdownV2 and mrkdwn edge cases |
| `telegram.test.ts` | `/start`, `/reset`, text message, group mention/reply filtering |
| `slack.test.ts` | DM, `app_mention`, thread reply, event acknowledgment |

Mocked dependencies: orchestrator WebSocket (use `ws` server in-process), Telegram/Slack SDKs.

### Manual Verification

> [!IMPORTANT]
> Telegram and Slack bots require real platform credentials. Manual testing requires the user to:
> 1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and provide the token
> 2. Create a Slack app at [api.slack.com](https://api.slack.com/apps), enable Socket Mode, and provide the tokens

**Telegram manual test:**
1. Set `TELEGRAM_ENABLED=true` and `TELEGRAM_BOT_TOKEN=<token>` in `.env`
2. Start the adapter: `npm run dev`
3. Open a private chat with the bot — verify a reply comes back
4. In a group chat, send a message without mentioning the bot — verify it is **ignored**
5. @mention the bot in the group — verify it replies
6. Reply to one of the bot's messages — verify it responds
7. Send `/reset`, then another message — verify a new session starts

**Slack manual test:**
1. Set `SLACK_ENABLED=true` and provide Slack tokens in `.env`
2. Start the adapter: `npm run dev`
3. DM the bot in Slack — verify a reply
4. @mention the bot in a channel — verify it replies in a thread
