# Market Desk Engine

Production-grade scaffold for an automated market analyst engine. The system collects structured market facts first, classifies catalysts with deterministic rules, scores confidence, writes analyst commentary from structured evidence only, runs compliance review, and exposes the result through a Fastify API, Telegram command surface, BullMQ scheduler, and Next.js admin dashboard.

This first implementation intentionally uses mock providers. Live data providers can be added behind the provider interfaces without changing the API, dashboard, Telegram commands, or analysis pipeline.

## Stack

- TypeScript, Node.js, pnpm workspaces
- Fastify API
- Next.js admin dashboard
- PostgreSQL with Prisma ORM
- Redis and BullMQ scheduler structure
- OpenAI API writing interface with mock fallback
- Telegram Bot API integration
- Zod validation
- Vitest tests
- ESLint and Prettier
- Docker Compose for local Postgres and Redis

## Monorepo Layout

```text
market-desk-engine/
  apps/
    api/
    dashboard/
  packages/
    core/
    data-providers/
    analysis-engine/
    compliance/
    telegram/
    db/
    shared/
  prisma/
```

## Local Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

If `pnpm` is not on your PATH, use `npx pnpm@10.12.1 <command>` or install pnpm globally with `npm install -g pnpm@10.12.1`.

API: `http://localhost:4000`  
Dashboard: `http://localhost:3000`

## Core Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev:telegram-test -- /why NVDA
pnpm dev:telegram-test -- /forex EURUSD
pnpm dev:telegram-test -- /commodity GOLD
pnpm dev:telegram-test -- /riskcheck "This is a must buy"
```

## Production Runbook

### 1. Local setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

API: `http://localhost:4000`  
Dashboard: `http://localhost:3000`

For local dashboard development, authentication is disabled unless `DASHBOARD_BASIC_AUTH_USER` and `DASHBOARD_BASIC_AUTH_PASSWORD` are set.

#### Windows pnpm troubleshooting

If `corepack enable` fails on Windows with:

```text
EPERM: operation not permitted, open 'C:\Program Files\nodejs\pnpm'
```

that is a Windows permissions issue. Corepack is trying to create pnpm shims inside `C:\Program Files\nodejs`, which usually requires administrator rights.

You can avoid Corepack completely:

```bash
npx pnpm@10.12.1 install
npx pnpm@10.12.1 dev
npx pnpm@10.12.1 lint
npx pnpm@10.12.1 typecheck
npx pnpm@10.12.1 test
npx pnpm@10.12.1 build
```

Or install pnpm globally once:

```bash
npm install -g pnpm@10.12.1
pnpm install
pnpm dev
```

### 2. Telegram bot setup

1. Create a bot with BotFather and save the token as `TELEGRAM_BOT_TOKEN`.
2. Create one public channel for approved commentary and one private admin chat.
3. Add the bot to both destinations.
4. Set:

```bash
TELEGRAM_PUBLIC_CHANNEL_ID=
TELEGRAM_ADMIN_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
```

The public channel receives only approved or auto-approved posts. The private admin chat receives drafts, warnings, and inline approval controls.

### 3. Database setup

Local development:

```bash
pnpm db:migrate
pnpm db:seed
```

Production:

```bash
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed:watchlist
```

`db:migrate:deploy` applies committed Prisma migrations without creating a new migration. Use `PRODUCTION_WATCHLIST` to seed a production-specific watchlist:

```bash
PRODUCTION_WATCHLIST=AAPL,NVDA,TSLA,EURUSD,GOLD,OIL pnpm db:seed:watchlist
```

### 4. Redis setup

Redis is required for BullMQ scheduler jobs. Local Redis is included in `docker-compose.yml`; production Redis is included in `docker-compose.prod.example.yml` and represented in `render.yaml.example`.

Set:

```bash
REDIS_URL=redis://...
ENABLE_SCHEDULER=true
MARKET_TIMEZONE=Africa/Lagos
```

### 5. Gemini and OpenAI API setup

Gemini is the recommended default writer. Create an API key in Google AI Studio, then set:

```bash
AI_PROVIDER=gemini
AI_FALLBACK_PROVIDER=template
GEMINI_API_KEY=
GEMINI_MODEL_PRIMARY=gemini-2.5-flash
GEMINI_MAX_INPUT_TOKENS_PER_REQUEST=6000
GEMINI_MAX_OUTPUT_TOKENS_PER_REQUEST=700
MAX_AI_GENERATIONS_PER_DAY=40
```

The writer receives only structured facts from the backend: price action, volume, macro/sector context, news summaries, filings, source list, catalyst classification, confidence score, and compliance risk level. Gemini does not browse the web by default; market/news data must come from backend providers.

Template fallback stays enabled with:

```bash
AI_FALLBACK_PROVIDER=template
```

If `GEMINI_API_KEY` is missing, Gemini errors, or Gemini rate-limits, the system writes from the deterministic template fallback. Gemini free-tier accounts can hit rate limits quickly, so keep `MAX_AI_GENERATIONS_PER_DAY` conservative until production quota is confirmed.

OpenAI remains available for compatibility:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
```

### 6. Market data provider setup

Choose primary and backup providers per category:

```bash
MARKET_DATA_PRIMARY_PROVIDER=fmp
MARKET_DATA_BACKUP_PROVIDER=alpha_vantage
NEWS_PRIMARY_PROVIDER=finnhub
NEWS_BACKUP_PROVIDER=fmp
MACRO_PRIMARY_PROVIDER=finnhub
MACRO_BACKUP_PROVIDER=alpha_vantage
FILINGS_PRIMARY_PROVIDER=sec
EARNINGS_PRIMARY_PROVIDER=fmp
EARNINGS_BACKUP_PROVIDER=finnhub
SECTOR_PRIMARY_PROVIDER=fmp
```

Set the matching keys:

```bash
FMP_API_KEY=
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
SEC_USER_AGENT=MarketDeskEngine/0.1 ops@example.com
```

Verify provider health:

```bash
curl http://localhost:4000/health/providers
```

### 7. Running schedulers

Schedulers start with the API when both are true:

```bash
ENABLE_SCHEDULER=true
REDIS_URL=redis://...
```

Check the schedule:

```bash
curl -H "Authorization: Bearer $VIEWER_API_TOKEN" https://api.example.com/scheduler/status
```

### 8. Deploying API

Docker:

```bash
docker build -f apps/api/Dockerfile -t market-desk-api .
docker run --env-file .env -p 4000:4000 market-desk-api
```

Compose:

```bash
docker compose -f docker-compose.prod.example.yml up -d --build
```

Render:

- Use `render.yaml.example` as the blueprint starting point.
- Set all secrets in Render environment variables.
- Keep `API_AUTH_REQUIRED=true`.

Railway:

- Use `railway.api.example.json` for the API service.
- Add PostgreSQL and Redis services.
- Set `DATABASE_URL`, `REDIS_URL`, and all secrets in Railway variables.

### 9. Deploying dashboard

Docker:

```bash
docker build -f apps/dashboard/Dockerfile -t market-desk-dashboard .
docker run --env-file .env -p 3000:3000 market-desk-dashboard
```

Required production dashboard settings:

```bash
API_BASE_URL=https://api.example.com
DASHBOARD_API_TOKEN=$VIEWER_OR_ANALYST_OR_ADMIN_TOKEN
DASHBOARD_BASIC_AUTH_USER=
DASHBOARD_BASIC_AUTH_PASSWORD=
DASHBOARD_DEFAULT_ROLE=viewer
```

The dashboard proxies API calls through `apps/dashboard/app/api/market-desk/[...path]/route.ts`, so `DASHBOARD_API_TOKEN` stays server-side.

### 10. Setting Telegram webhook

Set:

```bash
API_PUBLIC_URL=https://api.example.com
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
```

Then run:

```bash
pnpm telegram:webhook
```

The script calls Telegram `setWebhook`, enables `message` and `callback_query` updates, and prints `getWebhookInfo`.

### 11. Troubleshooting

- `401 Missing or invalid API token`: set `ADMIN_API_TOKEN`, `ANALYST_API_TOKEN`, or `VIEWER_API_TOKEN`, then send `Authorization: Bearer <token>`.
- `403 Insufficient role`: use `admin` for approve and disable-asset actions; use `analyst` or higher for draft actions.
- Telegram posts do not appear: confirm the bot is added to the target channel/chat and `TELEGRAM_PUBLIC_CHANNEL_ID` or `TELEGRAM_ADMIN_CHAT_ID` is correct.
- Webhook not firing: run `pnpm telegram:webhook` and inspect the printed `webhookInfo`.
- Scheduler not running: confirm `ENABLE_SCHEDULER=true` and `REDIS_URL` is reachable.
- Provider output stale: inspect `GET /health/providers`; stale live data forces cautious no-confirmed-catalyst language.
- Prisma deploy fails: verify `DATABASE_URL`, run `pnpm db:generate`, then `pnpm db:migrate:deploy`.

### Production environment checklist

```bash
NODE_ENV=production
PORT=4000
API_PUBLIC_URL=
API_BASE_URL=
CORS_ORIGIN=
DATABASE_URL=
REDIS_URL=
ENABLE_SCHEDULER=true
API_AUTH_REQUIRED=true
ADMIN_API_TOKEN=
ANALYST_API_TOKEN=
VIEWER_API_TOKEN=
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW=1 minute
LOG_LEVEL=info
ERROR_TRACKING_DSN=
OPENAI_API_KEY=
OPENAI_MODEL=
AI_PROVIDER=gemini
AI_FALLBACK_PROVIDER=template
GEMINI_API_KEY=
GEMINI_MODEL_PRIMARY=gemini-2.5-flash
GEMINI_MAX_INPUT_TOKENS_PER_REQUEST=6000
GEMINI_MAX_OUTPUT_TOKENS_PER_REQUEST=700
MAX_AI_GENERATIONS_PER_DAY=40
MAX_AUTO_POSTS_PER_DAY=20
TELEGRAM_BOT_TOKEN=
TELEGRAM_PUBLIC_CHANNEL_ID=
TELEGRAM_ADMIN_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
PUBLISHING_MODE=approval_required
DASHBOARD_BASIC_AUTH_USER=
DASHBOARD_BASIC_AUTH_PASSWORD=
DASHBOARD_API_TOKEN=
FMP_API_KEY=
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
SEC_USER_AGENT=
```

## API Routes

- `GET /health`
- `GET /health/providers`
- `GET /why/:symbol`
- `GET /forex/:pair`
- `GET /commodity/:asset`
- `GET /movers`
- `GET /dashboard`
- `GET /scheduler/status`
- `POST /riskcheck`
- `POST /webhooks/telegram`

## Telegram Commands

- `/market`
- `/why SYMBOL`
- `/forex EURUSD`
- `/commodity GOLD`
- `/movers`
- `/research SYMBOL`
- `/post SYMBOL`
- `/riskcheck TEXT`
- `/status`

`/post` now creates a publishing draft and runs the automatic posting rules before anything reaches a public channel. Public Telegram delivery requires `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_PUBLIC_CHANNEL_ID` or `TELEGRAM_DEFAULT_CHAT_ID`. Private admin drafts and warnings go to `TELEGRAM_ADMIN_CHAT_ID` when configured. Without Telegram config, sends return mock results for local testing.

## Publishing Controls

Publishing supports two modes:

```bash
PUBLISHING_MODE=approval_required
# or
PUBLISHING_MODE=auto_post
```

Automatic posting rules:

- Confidence `>=85` with no compliance flags can auto-post in `auto_post` mode.
- Confidence `65-84` can auto-post only when the draft uses cautious language.
- Confidence `45-64` is saved as a draft for approval.
- Confidence `<45` is blocked unless the draft is explicitly framed with `no_confirmed_catalyst`.
- Any high-risk compliance flag requires approval.
- Any missing or stale source warning requires approval unless the draft states there is no confirmed catalyst from available live sources.
- `approval_required` mode forces every generated post into the admin review queue.

Public Telegram channels only receive approved or auto-approved posts. The private admin chat receives review drafts, blocked-post warnings, stale-source warnings, and inline buttons for `Approve`, `Reject`, `Regenerate`, `Shorten`, and `Add context`.

The dashboard exposes the same operational controls:

- approve post
- reject post
- regenerate
- make sharper
- make shorter
- add macro context
- add source summary
- disable asset for today

Publishing API routes:

- `GET /publishing/drafts`
- `POST /publishing/drafts`
- `POST /publishing/drafts/:id/actions`

## AI Writer

Gemini is the recommended default writer:

```bash
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL_PRIMARY=gemini-2.5-flash
AI_FALLBACK_PROVIDER=template
```

Get a Gemini API key from Google AI Studio, store it only in environment variables, and do not expose it in browser code. If the key is absent or Gemini fails, rate-limits, or exceeds `MAX_AI_GENERATIONS_PER_DAY`, the engine falls back to deterministic template writing.

OpenAI support is still available by setting `AI_PROVIDER=openai` and `OPENAI_API_KEY`.

The writer receives structured snapshots, catalyst candidates, confidence scoring, and source IDs. It is not allowed to invent facts. Public modes are passed through compliance and must end with:

```text
Market commentary only.
```

Supported analyst writing modes:

- `public_telegram`
- `x_short`
- `private_research`
- `macro_reaction`
- `earnings_reaction`
- `no_confirmed_catalyst`
- `commodity_reaction`
- `forex_reaction`
- `equity_mover_reaction`

Prompt definitions, input/output schemas, and the style validator live in `packages/analysis-engine/src/prompts`.

Telegram `/status` and the dashboard AI status card show the active AI provider, model, fallback provider, daily AI call count, and fallback count.

## Provider Integration Next Steps

Live adapters now live in `packages/data-providers/src/live.ts`. Supported adapter ids:

- `fmp` for quotes, company news, macro calendar, earnings calendar, and sector/index context.
- `finnhub` for equity/FX quotes, company news, macro calendar, and earnings calendar.
- `alpha_vantage` for equity/FX/commodity quotes, news sentiment, DXY proxy, and Treasury-yield macro context.
- `sec` for SEC EDGAR company filings. No API key is used, but `SEC_USER_AGENT` must identify your app/contact.

Provider priority is configured per data category:

```bash
MARKET_DATA_PRIMARY_PROVIDER=fmp
MARKET_DATA_BACKUP_PROVIDER=alpha_vantage
NEWS_PRIMARY_PROVIDER=finnhub
NEWS_BACKUP_PROVIDER=fmp
MACRO_PRIMARY_PROVIDER=finnhub
MACRO_BACKUP_PROVIDER=alpha_vantage
FILINGS_PRIMARY_PROVIDER=sec
EARNINGS_PRIMARY_PROVIDER=fmp
EARNINGS_BACKUP_PROVIDER=finnhub
SECTOR_PRIMARY_PROVIDER=fmp
```

Required keys depend on the adapters you enable:

```bash
FMP_API_KEY=
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
SEC_USER_AGENT=MarketDeskEngine/0.1 contact@example.com
```

Mock fallback is automatic only in `development` and `test`. In production, configure live providers or set `ALLOW_MOCK_PROVIDER_FALLBACK=true` deliberately for a controlled dry run.

Check provider status:

```bash
curl http://localhost:4000/health/providers
```

Each provider health row includes:

- last successful request
- failed request count
- rate limit status
- stale data warning

If configured live sources are missing or stale, catalyst classification is forced into the cautious path and public commentary includes:

```text
There is no clean confirmed catalyst from available live sources at the time of writing.
```

Next live-data hardening steps:

1. Add provider-specific fixture tests for the exact subscription tier used in production.
2. Persist provider health and raw source payload metadata in PostgreSQL.
3. Add cache/TTL policy in Redis per endpoint to reduce rate-limit pressure.
4. Add alerting when primary and backup providers both degrade.

## Quality Gates

The scaffold includes tests for:

- Catalyst classification
- Confidence scoring
- Compliance filtering and rewriting
- `/why SYMBOL` integration route with mock providers

Run all checks before deploying:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
