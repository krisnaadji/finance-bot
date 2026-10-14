# 🤖 Finance Bot — Backend

WhatsApp bot that records transactions in personal or shared finance accounts using natural language. Built with TypeScript on Cloudflare Workers, with Groq and Gemini adapters.

```
User sends: "makan siang 35k"
Bot replies: "💸 Tercatat! Makan Siang · -Rp35.000 · Kebutuhan Pokok · 📅 14 Apr 2026"
```

---

## Architecture

The Worker verifies the webhook before dispatching messages through `src/router.ts`. Commands handle setup, reporting, categories, and language preferences. Natural-language financial commands pass through the configured AI adapter and shared runtime validation before any write.

Delete confirmation uses `src/handlers/deleteTxn.ts` and a database RPC. Each prompt is bound to its account, chat, requester, request UUID, and delivered provider message ID. After requesting deletion, send plain `ya/tidak` or `yes/no` in the same chat; quoting the confirmation is optional. Only the requester can confirm or cancel their pending deletion, within its 60-second database-checked lifetime. An explicitly quoted unrelated prompt is rejected. Plain yes/no messages never create financial transactions.

> See [Database Schema](https://github.com/krisnaadji/finance-dashboard/blob/main/README-database.md) for full schema, table definitions, and ER diagram.

---

## Tech Stack

| Layer      | Tech                     | Notes                          |
|------------|--------------------------|--------------------------------|
| Runtime    | Cloudflare Workers       | `src/worker.ts` (Hono)         |
| Web server | Hono                     | Webhook receiver                |
| AI         | Groq or Gemini          | Validated transaction classification |
| WhatsApp   | Fonnte or Meta Cloud API | Switchable via `GATEWAY` env   |
| Database   | Supabase (PostgreSQL)    | Service role key, bypasses RLS |
| Dev tools  | Wrangler                 | Local dev via `wrangler dev`   |
| Testing    | Vitest 3                 | Isolated application tests and opt-in native PostgreSQL tests |
| Linting    | ESLint v9 + Prettier     | `eslint.config.js` (CommonJS)  |

---

## Project Structure

```
src/
  worker.ts                 # Hono app: /health, GET+POST /webhook (verify, waitUntil dispatch)
  router.ts                 # Message routing, multi-transaction handling
  ai/
    index.ts                # Provider dispatch and command validation
    groq.ts                 # Groq adapter
    validation.ts           # Runtime financial command validation
    gemini.ts               # Gemini API call + prompt
    types.ts                # AIResponse, AIPayload types
    prompts.ts              # buildPrompt() function
  handlers/
    createTxn.ts            # Record single transaction + attribution
    createMultiple.ts       # Record multiple transactions (sequential insert)
    editTxn.ts              # Edit via WhatsApp reply
    deleteTxn.ts            # Requester-bound prompt and RPC confirmation
    transactionData.ts      # Scoped context, checked writes and receipts
    getSummary.ts           # Monthly summary + dashboard link
    getCategories.ts        # List categories
    addCategory.ts          # Add custom category
    setup.ts                # /setup CODE — link account + store wa_phone
    chitchat.ts             # General conversation
    index.ts                # Re-exports all handlers
  services/
    supabase.ts             # Supabase client (service role)
    whatsapp.ts             # Send message via Fonnte/Meta
  i18n/
    bot.ts                  # Indonesian/English bot messages
  utils/
    lang.ts                 # Language detection
    format.ts               # formatIDR, formatDate
    logger.ts               # PII-safe structured logger (LOG_LEVEL aware)
    webhookAuth.ts          # Meta HMAC + Fonnte token verification

tests/
  router.test.ts            # Defensive-behavior tests for routeMessage
  helpers/
    mocks.ts                # Supabase Proxy + fixtures

vitest.config.ts            # Test runner config
tsconfig.test.json          # Test-only tsconfig (skipLibCheck)
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill it in. Both `.env` and `.dev.vars` are
git-ignored; no real value belongs in any tracked file, `wrangler.jsonc`
included. The Worker reads `.dev.vars` locally and Wrangler secrets in
production — see Deployment below.

```env
# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...           # service_role key — bypasses RLS

# WhatsApp Gateway (choose one)
GATEWAY=fonnte                         # or: meta

# Fonnte (if GATEWAY=fonnte)
FONNTE_TOKEN=your-fonnte-token

# Meta Cloud API (if GATEWAY=meta)
WA_PHONE_NUMBER_ID=1120944724425818   # Phone Number ID (NOT WABA ID)
WA_ACCESS_TOKEN=EAAxx...              # System User permanent token
WA_VERIFY_TOKEN=your-verify-token  # arbitrary, must match Meta webhook config
WA_APP_SECRET=xxxx                    # REQUIRED — HMAC signs inbound POSTs

# Fonnte (if GATEWAY=fonnte)
# Configure Fonnte to send a custom `X-Fonnte-Token` header with this value.
# Bot rejects POSTs if unset while GATEWAY=fonnte.
FONNTE_WEBHOOK_TOKEN=your-fonnte-webhook-token

# AI provider — "groq" (default) or "gemini"
AI_PROVIDER=groq
AI_API_KEY=your-provider-api-key
# Optional. Defaults per provider: groq=openai/gpt-oss-120b, gemini=gemini-2.5-flash-lite
AI_MODEL=

# Dashboard URL (for /dashboard command and /summary footer)
DASHBOARD_URL=https://your-app.vercel.app

# Logging — optional. debug | info | warn | error.
# Defaults: `info` in production, `debug` otherwise.
# Production logs are PII-safe (phones masked, message text summarized).
# LOG_LEVEL=info
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment

`wrangler dev` reads local secrets and vars from a `.dev.vars` file at the repo root (git-ignored). Start from `.env.example` and use credentials for isolated local services. Do not copy production credentials into `.dev.vars`.

```bash
cp .env.example .dev.vars
# Fill in isolated local service values
```

### 3. Run locally

```bash
# Start the Worker locally
npm run dev

# In another terminal — expose to internet for WhatsApp webhook
npx ngrok http 8787
```

### 4. Configure webhook

Set the ngrok URL as your webhook in Fonnte or Meta Developer Console:

```
https://xxxx.ngrok-free.app/webhook
```

### 5. Test the bot

Send `/help` to your bot's WhatsApp number. Then try:

```
makan siang 35k
gaji masuk 5jt
kemarin bayar listrik 150rb
makan 35k, kopi 15k, parkir 5k
```

---

## Scripts

```bash
npm run dev             # Start the Worker locally (wrangler dev)
npm run deploy          # Deploy to Cloudflare Workers (wrangler deploy)
npm run build           # Type-check (tsc --noEmit)
npm run lint            # ESLint check
npm run lint:fix        # ESLint auto-fix
npm run format          # Prettier format
npm test                # Run Vitest suite once (no real API calls)
npm run test:watch      # Vitest in watch mode
npm run test:typecheck  # Type-check tests via tsconfig.test.json
```

> **Note:** tests mock Supabase, the AI provider, and WhatsApp — no quota is burned. For true integration runs against a real provider, use a separate project/account and set `AI_API_KEY`.

---

## Deployment

### Cloudflare Workers

The bot runs as a Cloudflare Worker (`src/worker.ts`, configured in
`wrangler.jsonc`). No server to keep warm — Workers run on demand.

1. `npx wrangler login` (once per machine)
2. Set every configuration value as a secret. `wrangler.jsonc` deliberately has
   no `vars` block, so no real value is ever written to a tracked file. Use
   `.env.example` as the checklist of what is needed.

   The fastest way is a bulk upload from a local, git-ignored file — the same
   `.dev.vars` used for local development works, since it is already in
   `KEY=value` format:

   ```bash
   npx wrangler secret bulk .dev.vars
   ```

   `secret bulk` accepts a `KEY=VALUE` file directly (or JSON), up to 100 secrets
   per command.

   Or set them one at a time:

   ```bash
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_KEY
   npx wrangler secret put WA_PHONE_NUMBER_ID
   npx wrangler secret put WA_ACCESS_TOKEN
   npx wrangler secret put WA_APP_SECRET
   npx wrangler secret put WA_VERIFY_TOKEN
   npx wrangler secret put AI_API_KEY
   npx wrangler secret put GATEWAY
   npx wrangler secret put AI_PROVIDER
   npx wrangler secret put DASHBOARD_URL
   ```

   `AI_MODEL` and `LOG_LEVEL` are optional — the code falls back to a per-provider
   default model and to `info` level. `FONNTE_TOKEN` and `FONNTE_WEBHOOK_TOKEN`
   are only needed when `GATEWAY=fonnte`.

   Secrets survive `wrangler deploy`; a `vars` block would not. Anything listed
   under `vars` is re-pushed on every deploy, so a blank entry there would
   overwrite a good value with an empty one. That is why there is no such block.

   The trade-off: secrets are write-only, so you cannot read a value back from
   the dashboard — only overwrite it. `.env.example` is the record of what
   exists.

3. `npm run deploy`
4. Point the Meta (or Fonnte) webhook at `https://<worker>.<subdomain>.workers.dev/webhook`.

For local development, `wrangler dev` reads the same variable names from a
`.dev.vars` file at the repo root (git-ignored) instead of `wrangler secret`.

---

## How WhatsApp Linking Works

```
Dashboard                        WhatsApp
    │                                │
    │  1. Create account             │
    │     (e.g. "Keluarga")          │
    │  2. Generate link code         │
    │     (e.g. KELUARGA-X7K2)       │
    │                                │
    │                3. User sends:  │
    │                /setup KELUARGA-X7K2
    │                                │
    │           4. Bot links chat ───┘
    │              to account +
    │              stores wa_phone
    │              as member record
    │
    └── 5. Transactions appear in dashboard
             with "by [name]" attribution
```

**Group accounts:** add the bot to a WhatsApp group, then send `/setup CODE` from the group. Each group member who sends `/setup` gets their own member record — their transactions are attributed to them individually.

**To switch accounts:** generate a new code from a different account and send `/setup NEW-CODE`.

---

## Supported Commands

| Message               | Action                                         |
|-----------------------|------------------------------------------------|
| `/setup CODE`         | Link WhatsApp chat to a dashboard account      |
| `/help`               | Show help with examples and all commands       |
| `/dashboard`          | Get the dashboard URL                          |
| `/rekap`              | Monthly summary with income/expense totals     |
| `/kategori`           | List all available categories                  |
| `/language id\|en`    | Switch bot reply language                      |
| `makan siang 35k`     | Record Rp35.000 expense                        |
| `gaji masuk 5jt`      | Record Rp5.000.000 income                      |
| `makan 35k, kopi 15k` | Record multiple transactions at once           |
| Reply to bot message  | Edit or delete that transaction                |

**Amount formats:** `35k` = Rp35.000 · `5jt` = Rp5.000.000 · `150rb` = Rp150.000

---

## Multiple Transactions in One Message

```
makan 35k, kopi 15k, bayar parkir 5k
→ Records 3 expense transactions for today

kemarin makan 40k, hari ini beli pulsa 10k
→ Records 2 transactions with different dates
```

Bot replies with an itemised summary:

```
✅ 3 transaksi tercatat!

💸 Makan — -Rp35.000
💸 Kopi — -Rp15.000
💸 Parkir — -Rp5.000

🏦 Total: -Rp55.000
```

**To edit or delete one item, reply to the bot's summary message:**

```
"2 kopi jadi 20k"         → edits item #2, amount = Rp20.000
"yang kopi ganti tgl 12"  → edits by name, changes date
"hapus no 2"              → deletes item #2
```

---

## Transaction Attribution

When a transaction is recorded via WhatsApp, the bot looks up the sender's `wa_phone` in the `members` table and stores their `display_name` on the transaction as `recorded_by_name`. This is shown on the dashboard for group accounts.

Name resolution priority:
1. `members.display_name` (set by user on dashboard Accounts page)
2. `msg.rawFrom` (phone number fallback)

---

## Key Implementation Notes

**Webhook intake**: the handler verifies each webhook, persists normalized messages in `bot_inbox`, then acknowledges and queues the database IDs. Provider message IDs and a content fingerprint detect replays and conflicting identities.

**Multi-transaction receipts**: each committed message stores an immutable ordered mapping in `bot_batch_items`. The receipt item number remains stable after its transaction is deleted, so a later reply cannot target a different item.

**Gemini action fallback** — when replying to a multi-transaction message, the router accepts both `EDIT_FROM_MULTIPLE`/`DELETE_FROM_MULTIPLE` and `EDIT_TRANSACTION`/`DELETE_TRANSACTION` as valid actions since Gemini is inconsistent with action naming.

**Webhook auth** — every inbound POST is verified before any processing:
- `GATEWAY=meta` → `X-Hub-Signature-256` HMAC-SHA256 of the raw body, compared with `crypto.timingSafeEqual`.
- `GATEWAY=fonnte` → `X-Fonnte-Token` header compared with `FONNTE_WEBHOOK_TOKEN`.
The raw body is read via `c.req.text()` (never `c.req.json()`) before verification, so HMAC hashes the exact bytes Meta signed. Requests that fail verification get `401` with no further side effects.

**PII-safe logging** — `src/utils/logger.ts` redacts phone numbers (keeps country code + last 2 digits), summarizes message text by length instead of content, and strips sensitive keys from error objects. `LOG_LEVEL` env var gates verbosity (`info` in production, `debug` otherwise).

---

## Known Limitations

| Feature                       | Status       | Notes                                               |
|-------------------------------|--------------|-----------------------------------------------------|
| Unlink WhatsApp from account  | ❌ Not built | Workaround: /setup with a code from another account |
| Edit/delete account from bot  | ❌ Not built | Use dashboard Accounts page instead                 |
| Edit/delete category from bot | ❌ Not built | Use dashboard Categories page instead               |
| Receipt / bill photo parsing  | ❌ Not built | Planned — Gemini Vision can handle this             |

## Financial input and offline checks

Financial writes accept positive amounts up to `9999999999999.99`, with at most two nonzero decimal places. Storage input is a canonical decimal string. API/model values must use plain decimal notation without currency separators or exponents; malformed values are rejected instead of rounded or defaulted to zero.

Business dates use real calendar days in `YYYY-MM-DD` format, from 2000 through 2100. Invalid dates such as `2026-02-30` are rejected.

Run `npm test -- tests/financialValidation.test.ts` for money/date boundaries. Run `npm test`, `npm run build`, `npm run test:typecheck`, and `npm run lint` for integration checks. These commands do not authorize production database changes or deployment.

## Phase 1 security rollout

Dashboard and bot financial edits write only supplied fields and require the original financial snapshot to still match. A concurrent edit produces a conflict instead of overwriting another user's correction.

Numeric JSON amounts retain their original token through `JSON.parse` reviver source context before decimal validation. The runtime must support that feature; it was exercised on Node 24.14.1 and the local Worker engine. Unsupported numeric decoding fails closed. Decimal-string inputs do not require source context.

Keep `DELETE_CONFIRMATIONS_ENABLED=false` until the catalog inspection, both migrations in `supabase/migrations`, and the disposable Supabase/Auth/PostgREST plus actual gateway confirmation checks have passed. Migration files are not authorization to apply them to production.

The Phase 1 PostgreSQL suite requires an initially empty disposable database named with the `finance_phase1_test` prefix. Run it separately from Phase 2 because the database guards require different prefixes:

```bash
npm exec vitest -- run --config vitest.integration.config.ts tests/integration/deleteConfirmation.db.test.ts
```

The suite covers RPC authorization, atomic confirmation consumption, concurrent requests, and expiry after lock waits. It does not prove Supabase RPC exposure or provider reply IDs.

Account, batch, and invitation changes use database transactions with persisted retry outcomes. Bilingual categories and image parsing remain later phases.

`/language` looks up the member by account and WhatsApp sender, then updates the existing row or inserts a new preference. Production has no unique constraint on that pair, so the command cannot use a composite-key upsert. Updating the preference preserves the member ID, linked user, role, and display name. Phase 2 serializes first-time member creation through the account lock.

## Durable recording contracts

The Phase 2 SQL operations key intake by gateway and provider message ID, serialize claims per chat, and require the current lease fence for command persistence and commit. Each financial mutation commits its outcome and immutable reply snapshot in the same database transaction. A repeated identity returns its stored outcome and cannot recreate a transaction deleted later.

Receipt item numbers live in `bot_batch_items`. Deletion clears the transaction reference without changing the original number. Historical mappings in `bot_legacy_receipt_items` require verified original ordinals; a remaining row alone does not establish that a historical receipt originally contained one item.

Edits compare their frozen original financial fields before changing a row and preserve attribution. Description-only edits may retain an inactive historical category. Setup and language commands serialize membership changes through the account lock and do not require a unique account/WhatsApp-phone constraint.

The Phase 2 PostgreSQL suites accept only a loopback URL whose database name begins with `finance_phase2_test`. Set `FINANCE_TEST_DATABASE_URL` explicitly to an initially empty synthetic database. Select Phase 2 tests separately from the Phase 1 suite:

```bash
npm exec vitest -- run --config vitest.integration.config.ts \
  tests/integration/atomicRouting.db.test.ts \
  tests/integration/accountOperations.db.test.ts \
  tests/integration/botCommit.db.test.ts \
  tests/integration/export.db.test.ts \
  tests/integration/fixtureSafety.db.test.ts \
  tests/integration/intake.db.test.ts \
  tests/integration/processing.db.test.ts \
  tests/integration/reporting.db.test.ts
```

These checks use synthetic accounts and no provider credentials. They do not authorize deployment, live bot messages, or production migrations.

WhatsApp send results use provider-specific codes, not HTTP status alone. Meta's documented error-code reference is <https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes/>. Fonnte's send API and response examples are at <https://docs.fonnte.com/api-send-message/>. The adapter retries only listed provider rejections that document non-acceptance; unknown responses and transport failures remain uncertain. A retry delay is accepted only from a valid `Retry-After` value between 1 and 3,600 seconds.

Use `npm run recover:delivery -- <action> <outbound-uuid> [argument]`. Actions are `show`, `resume`, `bind-id <provider-message-id>`, `resend-uncertain --acknowledge-duplicate-risk`, and `resolve rejected|discard`. Supply credentials directly to the operator process. The tool does not load `.env`; uncertain sends stay held unless an operator binds a known provider ID or explicitly accepts duplicate-send risk.

Verified webhooks persist normalized messages before acknowledging, then enqueue their database IDs. Queue consumers process one message at a time; the minute scheduler re-enqueues due inbox work, dispatches due outbound replies, and removes expired export snapshots. The Wrangler config declares `financebot-intake` and the cron binding. This does not create the remote queue or deploy the Worker; provision and production rollout remain separate authorized steps.

Each dashboard export captures matching rows, category labels, exact amounts, and order for 15 minutes. The dashboard reads pages of at most 500 rows and returns a CSV only after validating every row. Description and category cells are escaped against spreadsheet formula execution. Exports above 99,999 rows or 32 MiB are rejected.

Exact money values cross SQL and API boundaries as decimal strings. Dashboard summary fields `income`, `expense`, and `net`, category totals, monthly totals, and budget spending use strings. Business dates use `YYYY-MM-DD` calendar values in the `2000-01-01` through `2100-12-31` range; they are not parsed as UTC timestamps.