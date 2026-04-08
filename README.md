# 🤖 Finance Bot — Backend

WhatsApp bot that records personal finance transactions using natural language. Built with Node.js + TypeScript, powered by Gemini AI.

```
User sends: "makan siang 35k"
Bot replies: "💸 Tercatat! Makan Siang · -Rp35.000 · Kebutuhan Pokok · 📅 7 Apr 2026"
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
 ┌─────────────────────────────────────────┐
 │  webhook.ts  →  router.ts              │
 │       │                                │
 │       ├─ /setup   → handlers/setup.ts  │
 │       ├─ pending? → confirmDelete.ts   │
 │       ├─ reply?   → editTxn/deleteTxn  │
 │       └─ new msg  → callGemini()       │
 │                         │              │
 │                    AI classifies       │
 │                         │              │
 │         ┌───────────────┤              │
 │         ▼               ▼              │
 │   createTxn        getSummary          │
 │   editTxn          getCategories       │
 │   deleteTxn        addCategory         │
 │   chitchat                             │
 └─────────────────────────────────────────┘
      │
      ▼
 Supabase (PostgreSQL)
 accounts · transactions · categories · members
```

---

## Tech Stack

| Layer | Tech | Notes |
|---|---|---|
| Runtime | Node.js 20 + TypeScript | Compiled to `dist/` |
| Web server | Express 5 | Webhook receiver |
| AI | Gemini 2.5 Flash Lite | Transaction classification |
| WhatsApp | Fonnte or Meta Cloud API | Switchable via `GATEWAY` env |
| Database | Supabase (PostgreSQL) | Service role key, bypasses RLS |
| Dev tools | nodemon + ts-node | Hot reload in dev |
| Linting | ESLint v9 + Prettier | `eslint.config.js` (CommonJS) |

---

## Project Structure

```
src/
  index.ts              # Express app, /health endpoint
  webhook.ts            # Webhook verify (GET) + receive (POST)
  router.ts             # Message routing logic
  ai/
    gemini.ts           # Gemini API call + prompt
    types.ts            # AIResponse type
    prompts.ts          # Prompt templates
  handlers/
    createTxn.ts        # Record new transaction
    editTxn.ts          # Edit via WhatsApp reply
    deleteTxn.ts        # Delete with confirmation
    getSummary.ts       # Monthly summary
    getCategories.ts    # List categories
    addCategory.ts      # Add custom category
    setup.ts            # /setup CODE account linking
    chitchat.ts         # General conversation
  services/
    supabase.ts         # Supabase client (service role)
    whatsapp.ts         # Send message via Fonnte/Meta
  i18n/
    bot.ts              # Indonesian/English bot messages
  utils/
    lang.ts             # Language detection
    format.ts           # formatIDR, formatDate
```

---

## Environment Variables

Create `.env` in the project root:

```env
# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...          # service_role key — bypasses RLS

# WhatsApp Gateway (choose one)
GATEWAY=fonnte                        # or: meta

# Fonnte (if GATEWAY=fonnte)
FONNTE_TOKEN=your-fonnte-token

# Meta Cloud API (if GATEWAY=meta)
WA_PHONE_NUMBER_ID=1120944724425818  # Phone Number ID (NOT WABA ID)
WA_ACCESS_TOKEN=EAAxx...             # System User permanent token
WA_VERIFY_TOKEN=my-finance-bot-secret
WA_APP_SECRET=xxxx

# AI
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.5-flash-lite

# Dashboard URL (for /setup links in bot messages)
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
```

---

## Scripts

```bash
npm run dev       # Start with hot reload (nodemon + ts-node)
npm run build     # Compile TypeScript to dist/
npm run start     # Run compiled output (production)
npm run lint      # ESLint check
npm run lint:fix  # ESLint auto-fix
npm run format    # Prettier format
```

---

## Deployment

### Render (free, recommended)

1. Push to GitHub
2. New Web Service → connect repo
3. Root Directory: `bot-backend` (if monorepo)
4. Build: `npm install --legacy-peer-deps && npm run build`
5. Start: `npm run start`
6. Add all env vars
7. Add `.npmrc` with `legacy-peer-deps=true` to avoid build errors

**Keep warm:** Set up a cron job at [cron-job.org](https://cron-job.org) to ping `GET /health` every 10 minutes.

### Fly.io (free, no cold start)

```bash
fly launch          # region: sin (Singapore)
fly secrets set SUPABASE_URL=... GEMINI_API_KEY=... # etc
fly deploy
```

---

## How WhatsApp Linking Works

```
Dashboard                    WhatsApp
    │                            │
    │  1. Create account         │
    │  2. Generate code          │
    │     (e.g. TABUNGAN-X7K2)  │
    │                            │
    │              3. User sends:│
    │              /setup TABUNGAN-X7K2
    │                            │
    │         4. Bot links chat ─┘
    │            to account
    │
    └── 5. Transactions now appear in dashboard
```

---

## Supported Commands

| Message | Action |
|---|---|
| `/setup CODE` | Link WhatsApp chat to dashboard account |
| `/help` | Show help message |
| `makan siang 35k` | Record Rp35.000 expense |
| `gaji masuk 5jt` | Record Rp5.000.000 income |
| `rekap bulan ini` | Monthly summary |
| `kategori apa aja` | List all categories |
| Reply to bot message | Edit or delete that transaction |

**Amount formats:** `35k` = 35.000 · `5jt` = 5.000.000 · `150rb` = 150.000