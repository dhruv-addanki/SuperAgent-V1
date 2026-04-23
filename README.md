# WhatsApp Super Agent

WhatsApp Super Agent is a production-minded MVP for a chat-first AI assistant that users talk to on WhatsApp. It connects a real WhatsApp Business phone number to a Node.js + TypeScript backend, uses OpenAI GPT-5.4 through the Responses API, and executes Google Workspace plus Asana tools behind deterministic backend safety gates.

The MVP is intentionally narrow:

- Read Gmail, Google Calendar, and Google Drive.
- Read and manage Asana tasks.
- Accept typed WhatsApp messages and WhatsApp voice memos.
- Create Gmail drafts.
- Create calendar events and Google Docs with explicit approval where required.
- Send Gmail drafts only after the user confirms with `SEND`.
- Keep WhatsApp replies concise and operational.

## Architecture

The service is a single Fastify backend with clear module boundaries:

- Transport: WhatsApp Cloud API webhook verification, inbound parsing, outbound text replies, and delivery status logging.
- Auth: Google OAuth 2.0 and Asana OAuth web-server flows, encrypted token storage, and automatic refresh before API calls.
- Agent orchestration: OpenAI Responses API loop, backend-owned tool execution, short-term history, and lightweight memory.
- Integrations: Gmail, Calendar, Drive, Docs, and Asana task service wrappers.
- Safety: deterministic approval policy, pending action records, audit logs, idempotency checks, and read-only mode.
- Persistence: PostgreSQL via Prisma, Redis for webhook idempotency/rate limiting, and BullMQ for inbound WhatsApp jobs.

The model never calls external APIs directly. It only emits tool calls. The backend validates inputs, enforces policy, executes integrations, logs writes, and returns results.

## File Tree

```text
.
|-- Dockerfile
|-- README.md
|-- docker-compose.yml
|-- eslint.config.js
|-- package.json
|-- pnpm-workspace.yaml
|-- prisma
|   |-- migrations
|   |   `-- 000001_init
|   |       `-- migration.sql
|   |-- schema.prisma
|   `-- seed.ts
|-- src
|   |-- app
|   |   |-- app.ts
|   |   `-- server.ts
|   |-- config
|   |   |-- constants.ts
|   |   |-- env.ts
|   |   `-- logger.ts
|   |-- lib
|   |   |-- crypto.ts
|   |   |-- errors.ts
|   |   |-- openaiClient.ts
|   |   |-- redis.ts
|   |   `-- time.ts
|   |-- modules
|   |   |-- agent
|   |   |-- audit
|   |   |-- db
|   |   |-- google
|   |   |-- memory
|   |   |-- queue
|   |   `-- whatsapp
|   |-- routes
|   |   |-- authGoogle.ts
|   |   |-- health.ts
|   |   `-- whatsappWebhook.ts
|   `-- schemas
|       |-- apiSchemas.ts
|       `-- toolSchemas.ts
|-- tests
|   |-- approvalPolicy.test.ts
|   |-- authGoogle.test.ts
|   |-- responseLoop.test.ts
|   |-- setup.ts
|   |-- toolSchemas.test.ts
|   `-- webhookParser.test.ts
|-- tsconfig.build.json
|-- tsconfig.json
`-- vitest.config.ts
```

## Requirements

- Node.js 20+
- pnpm 8+
- Docker Desktop or compatible Docker runtime
- ngrok for local webhook testing
- Meta developer app with WhatsApp Cloud API enabled
- Google Cloud project with OAuth consent screen and credentials
- OpenAI API key with access to the configured Responses API model

## Local Setup

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm prisma:migrate
pnpm dev
```

The API listens on `http://localhost:3000` by default.

Health check:

```bash
curl http://localhost:3000/health
```

## Environment Variables

Core:

- `NODE_ENV`: `development`, `test`, or `production`.
- `PORT`: Fastify port.
- `DATABASE_URL`: PostgreSQL connection string.
- `REDIS_URL`: Redis connection string.
- `LOG_LEVEL`: pino log level.

OpenAI:

- `OPENAI_API_KEY`: OpenAI API key.
- `OPENAI_MODEL`: Defaults to `gpt-5.4`.
- `OPENAI_TRANSCRIPTION_MODEL`: Speech-to-text model for WhatsApp voice memos, default `gpt-4o-mini-transcribe`.

Public URLs:

- `APP_BASE_URL`: Public base URL for OAuth start/callback links.
- `WEBHOOK_PUBLIC_URL`: Public ngrok or deployed URL for Meta webhook setup.

WhatsApp:

- `WHATSAPP_VERIFY_TOKEN`: Shared token used during Meta webhook verification.
- `WHATSAPP_ACCESS_TOKEN`: WhatsApp Cloud API access token.
- `WHATSAPP_PHONE_NUMBER_ID`: Cloud API phone number ID.
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: WhatsApp Business Account ID.
- `WHATSAPP_APP_SECRET`: Optional app secret for webhook signature verification hardening.
- `WHATSAPP_MAX_AUDIO_BYTES`: Maximum inbound audio size to transcribe, default `25000000`.

Google:

- `GOOGLE_CLIENT_ID`: OAuth client ID.
- `GOOGLE_CLIENT_SECRET`: OAuth client secret.
- `GOOGLE_REDIRECT_URI`: Usually `http://localhost:3000/auth/google/callback` for local dev.

Asana:

- `ASANA_CLIENT_ID`: OAuth client ID.
- `ASANA_CLIENT_SECRET`: OAuth client secret.
- `ASANA_REDIRECT_URI`: Usually `http://localhost:3000/auth/asana/callback` for local dev.

Write control:

- `READ_ONLY_MODE`: Set `true` to disable all write tools.
- `GOOGLE_READ_ONLY_MODE`: Deprecated alias for `READ_ONLY_MODE`.

Security and runtime:

- `ENCRYPTION_KEY`: Key material used by the token encryption abstraction.
- `PENDING_ACTION_TTL_MINUTES`: Pending action expiration, default `30`.
- `MAX_TOOL_ROUNDS`: Maximum OpenAI tool-call rounds, default `3`.
- `RATE_LIMIT_PER_MINUTE`: Redis-backed phone-number rate limit.

## Google OAuth Setup

1. Create or choose a Google Cloud project.
2. Configure the OAuth consent screen.
3. Create OAuth credentials with application type `Web application`.
4. Add the redirect URI from `.env`, for example:

```text
http://localhost:3000/auth/google/callback
```

5. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.env`.

Configured scopes are centralized in `src/config/constants.ts`:

- `openid`
- `email`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/drive.metadata.readonly`
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/documents`

The assistant replies with a Google connect link when the WhatsApp user has not connected an account yet.

## Asana OAuth Setup

1. Create or choose an Asana app in the developer console.
2. Configure OAuth with the redirect URI from `.env`, for example:

```text
http://localhost:3000/auth/asana/callback
```

3. Register these scopes for the app:

- `tasks:read`
- `tasks:write`
- `projects:read`
- `workspaces:read`
- `users:read`

4. Put `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET`, and `ASANA_REDIRECT_URI` in `.env`.

The assistant replies with an Asana connect link when an Asana tool is used without a connected Asana account.

The app currently requests these Asana scopes:

- `attachments:read`
- `attachments:write`
- `attachments:delete`
- `custom_fields:read`
- `custom_fields:write`
- `projects:read`
- `projects:write`
- `projects:delete`
- `stories:read`
- `stories:write`
- `tags:read`
- `tags:write`
- `tasks:read`
- `tasks:write`
- `tasks:delete`
- `teams:read`
- `users:read`
- `workspaces:read`

## WhatsApp Webhook Setup

Local webhook endpoint:

```text
GET  /webhooks/whatsapp
POST /webhooks/whatsapp
```

Start ngrok:

```bash
ngrok http 3000
```

Set:

```env
APP_BASE_URL=https://your-ngrok-domain.ngrok-free.app
WEBHOOK_PUBLIC_URL=https://your-ngrok-domain.ngrok-free.app
GOOGLE_REDIRECT_URI=https://your-ngrok-domain.ngrok-free.app/auth/google/callback
```

In the Meta developer dashboard:

1. Use the WhatsApp Cloud API test number or your configured business phone number.
2. Set callback URL to:

```text
https://your-ngrok-domain.ngrok-free.app/webhooks/whatsapp
```

3. Set verify token to match `WHATSAPP_VERIFY_TOKEN`.
4. Subscribe to the `messages` webhook field.
5. Put `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in `.env`.

The POST route accepts text messages and audio messages from WhatsApp voice memos. Audio is downloaded from WhatsApp, transcribed with OpenAI, and then handled by the same agent pipeline as typed text.

## Agent Tools

Read tools:

- `gmail_search_threads`
- `gmail_read_thread`
- `calendar_list_events`
- `drive_search_files`
- `drive_read_file_metadata`
- `asana_list_workspaces`
- `asana_list_projects`
- `asana_list_users`
- `asana_list_my_tasks`
- `asana_search_tasks`
- `asana_get_task`

Write tools:

- `gmail_create_draft`
- `gmail_send_draft`
- `calendar_create_event`
- `docs_create_document`
- `asana_create_task`
- `asana_update_task`
- `asana_delete_task`

Read-only mode removes write tools from the OpenAI tool list and blocks write execution if called unexpectedly.

## Safety Model

The backend enforces these rules regardless of model output:

- Gmail send requires an existing draft and explicit `SEND`.
- Gmail draft creation is allowed without approval, then a pending send action is created.
- Calendar creation requires explicit `CONFIRM`.
- Google Doc creation is executed immediately only when the current user message clearly asked to create a doc. Otherwise it requires `CONFIRM`.
- `CANCEL` cancels the most recent pending action in the conversation.
- Pending actions expire after `PENDING_ACTION_TTL_MINUTES`.
- All write attempts and executions are recorded in `AuditLog`.
- Webhook message IDs are used for Redis-backed idempotency where available.
- Phone-number rate limiting is Redis-backed.

The assistant should never claim completion unless the backend tool succeeded.

## Example Flow

1. User messages the WhatsApp number.
2. If Google is not connected, the agent replies:

```text
Connect your Google account first: https://...
```

3. User opens the link and completes Google OAuth.
4. User messages:

```text
What's on my calendar tomorrow?
```

5. Agent uses `calendar_list_events` and replies with a concise agenda.
6. User messages:

```text
Draft an email to Brad saying Thursday works
```

7. Agent creates a Gmail draft and replies:

```text
Draft ready. Reply SEND to send it.
```

8. User replies:

```text
SEND
```

9. Backend sends the draft via Gmail. Only after Gmail succeeds, the agent replies:

```text
Sent the draft.
```

## Commands

```bash
pnpm dev              # run local server with tsx watch
pnpm build            # compile TypeScript
pnpm test             # run Vitest tests
pnpm lint             # run ESLint
pnpm format           # format with Prettier
pnpm prisma:generate  # generate Prisma Client
pnpm prisma:migrate   # run local dev migration
pnpm prisma:deploy    # apply migrations in production
```

## Deployment Notes

The service is cloud-ready for Railway, Render, Fly, and Cloud Run:

- Provide managed PostgreSQL and Redis.
- Set all `.env` values as platform secrets.
- Run `pnpm prisma:deploy` before starting the app.
- Expose port `PORT`.
- Configure Meta webhook callback to the deployed `/webhooks/whatsapp` URL.
- Configure Google OAuth redirect URI to the deployed `/auth/google/callback` URL.

## Limitations and Production Hardening

- TODO: Capture raw request bodies and enforce WhatsApp `X-Hub-Signature-256` verification in production.
- TODO: Sign or Redis-store Google OAuth `state` for stronger CSRF protection.
- TODO: Add structured contact resolution for ambiguous people like "Brad" or "Alex".
- TODO: Add webhook dead-letter monitoring for failed BullMQ jobs.
- TODO: Add stricter secret rotation and KMS-backed encryption for production tokens.
- TODO: Add integration tests with mocked Google and WhatsApp HTTP clients.

This MVP deliberately avoids a heavy agent framework. The orchestration code is small, explicit, and designed so policy decisions remain deterministic in backend code.
