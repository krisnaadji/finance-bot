# 🤖 Finance Bot — Backend

WhatsApp bot that records personal finance transactions using natural language. Built with Node.js + TypeScript, powered by Gemini AI.

```
User sends: "makan siang 35k"
Bot replies: "💸 Tercatat! Makan Siang · -Rp35.000 · Kebutuhan Pokok · 📅 14 Apr 2026"
```

---

## Architecture

```
WhatsApp (User)
      │
      ▼
 Gateway Layer
 ┌────────────────────────────┐
 │  Fonnte  ──or──  Meta API  │
 └────────────────────────────┘
      │  webhook POST /webhook
      ▼
 Bot Backend (This Repo)
 ┌──────────────────────────────────────────┐
 │  webhook.ts  →  router.ts               │
 │       │                                 │
 │       ├─ /setup      → setup.ts         │
 │       ├─ /dashboard  → sends URL        │
 │       ├─ /rekap      → getSummary.ts    │
 │       ├─ /kategori   → getCategories.ts │
 │       ├─ /language   → sets lang pref   │
 │       ├─ /help       → helpText         │
 │       ├─ pending?    → confirmDelete.ts │
 │       ├─ reply?      → editTxn/delete   │
 │       │    └─ multi? → EDIT/DELETE      │
 │       │               _FROM_MULTIPLE    │
 │       └─ new msg     → callGemini()     │
 │                            │            │
 │                       AI classifies     │
 │                            │            │
 │         ┌──────────────────┤            │
 │         ▼                  ▼            │
 │   createTxn           getSummary        │
 │   createMultiple      getCategories     │
 │   editTxn             addCategory       │
 │   deleteTxn           chitchat          │
 └──────────────────────────────────────────┘
      │
      ▼
 Supabase (PostgreSQL)
 accounts · transactions · categories · members · invite_tokens
```

> See [Database Schema](https://github.com/krisnaadji/finance-dashboard/blob/main/README-database.md) for full schema, table definitions, and ER diagram.

---

## Tech Stack

| Layer      | Tech                     | Notes                          |
|------------|--------------------------|--------------------------------|
| Runtime    | Node.js 20 + TypeScript  | Compiled to `dist/`            |
| Web server | Express 5                | Webhook receiver               |
| AI         | Gemini 2.5 Flash Lite    | Transaction classification     |
| WhatsApp   | Fonnte or Meta Cloud API | Switchable via `GATEWAY` env   |
| Database   | Supabase (PostgreSQL)    | Service role key, bypasses RLS |
| Dev tools  | nodemon + ts-node        | Hot reload in dev              |
| Linting    | ESLint v9 + Prettier     | `eslint.config.js` (CommonJS)  |

---

## Project Structure

```
src/
  index.ts                  # Express app, /health endpoint
  webhook.ts                # Webhook verify + receive (200 first, deduplication)
  router.ts                 # Message routing, multi-transaction handling
  ai/
    gemini.ts               # Gemini API call + prompt
    types.ts                # AIResponse, AIPayload types
    prompts.ts              # buildPrompt() function
  handlers/
    createTxn.ts            # Record single transaction + attribution
    createMultiple.ts       # Record multiple transactions (sequential insert)
    editTxn.ts              # Edit via WhatsApp reply
    deleteTxn.ts            # Delete with confirmation
    confirmDelete.ts        # Handle yes/no confirmation
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
```

---

## Environment Variables

Create `.env` in the project root:

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
WA_VERIFY_TOKEN=your-verify-token
WA_APP_SECRET=xxxx

# AI
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.5-flash-lite

# Dashboard URL (for /dashboard command and /summary footer)
DASHBOARD_URL=https://your-app.vercel.app

PORT=3001
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment

```bash
cp .env.example .env
# Fill in all values
```

### 3. Run locally

```bash
# Start the bot
npm run dev

# In another terminal — expose to internet for WhatsApp webhook
npx ngrok http 3001
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
npm run dev        # Start with hot reload (nodemon + ts-node)
npm run build      # Compile TypeScript to dist/
npm run start      # Run compiled output (production)
npm run lint       # ESLint check
npm run lint:fix   # ESLint auto-fix
npm run format     # Prettier format
```

---

## Deployment

### Render (free, recommended)

1. Push to GitHub
2. New Web Service → connect repo
3. Root Directory: `bot-backend` (if monorepo)
4. Build command: `npm install --legacy-peer-deps && npm run build`
5. Start command: `npm run start`
6. Add all env vars in Render dashboard
7. Add `.npmrc` with `legacy-peer-deps=true` to avoid peer dep errors

**Keep warm:** Set up a cron job at [cron-job.org](https://cron-job.org) to ping `GET /health` every 5 minutes — Render free tier sleeps after 15 minutes of inactivity.

> **Note:** Render free tier in Singapore may have intermittent disruptions. Check [status.render.com](https://status.render.com) if you experience persistent 521 errors.

### Fly.io (free, no cold start)

```bash
fly launch          # choose region: sin (Singapore) or nrt (Tokyo)
fly secrets set SUPABASE_URL=... GEMINI_API_KEY=... # set all env vars
fly deploy
```

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

**Webhook deduplication** — `res.sendStatus(200)` is called immediately before any processing so Meta never retries. Each message is also checked against `wa_user_message_id` to skip already-processed messages.

**Multi-transaction ordering** — transactions in a `CREATE_MULTIPLE` batch are inserted sequentially (not bulk) to guarantee distinct `created_at` timestamps. This ensures `.order('created_at')` always returns them in the original message order when looking up by `wa_bot_message_id`.

**Gemini action fallback** — when replying to a multi-transaction message, the router accepts both `EDIT_FROM_MULTIPLE`/`DELETE_FROM_MULTIPLE` and `EDIT_TRANSACTION`/`DELETE_TRANSACTION` as valid actions since Gemini is inconsistent with action naming.

---

## Known Limitations

| Feature                       | Status       | Notes                                               |
|-------------------------------|--------------|-----------------------------------------------------|
| Unlink WhatsApp from account  | ❌ Not built | Workaround: /setup with a code from another account |
| Edit/delete account from bot  | ❌ Not built | Use dashboard Accounts page instead                 |
| Edit/delete category from bot | ❌ Not built | Use dashboard Categories page instead               |
| Receipt / bill photo parsing  | ❌ Not built | Planned — Gemini Vision can handle this             |