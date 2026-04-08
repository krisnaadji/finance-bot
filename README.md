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
 ┌──────────────────────────────┐
 │  Fonnte  ──or──  Meta API   │
 └──────────────────────────────┘
      │  webhook POST /webhook
      ▼
 Bot Backend (This Repo)
 ┌──────────────────────────────────────────┐
 │  webhook.ts  →  router.ts               │
 │       │                                 │
 │       ├─ /setup      → setup.ts         │
 │       ├─ /dashboard  → sends URL        │
 │       ├─ /rekap      → getSummary.ts    │
 │       ├─ pending?    → confirmDelete.ts │
 │       ├─ reply?      → editTxn/delete   │
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
 accounts · transactions · categories · members
```

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
  webhook.ts                # Webhook verify (GET) + receive (POST)
  router.ts                 # Message routing logic
  ai/
    gemini.ts               # Gemini API call + prompt
    types.ts                # AIResponse, AIPayload types
    prompts.ts              # buildPrompt() function
  handlers/
    createTxn.ts            # Record single transaction
    createMultiple.ts       # Record multiple transactions at once
    editTxn.ts              # Edit via WhatsApp reply
    deleteTxn.ts            # Delete with confirmation
    confirmDelete.ts        # Handle yes/no confirmation
    getSummary.ts           # Monthly summary + dashboard link
    getCategories.ts        # List categories
    addCategory.ts          # Add custom category
    setup.ts                # /setup CODE account linking
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
WA_VERIFY_TOKEN=my-finance-bot-secret
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
    │     (e.g. "Tabungan")          │
    │  2. Generate link code         │
    │     (e.g. TABUNGAN-X7K2)       │
    │                                │
    │                3. User sends:  │
    │                /setup TABUNGAN-X7K2
    │                                │
    │           4. Bot links chat ───┘
    │              to account
    │
    └── 5. Transactions appear in dashboard
```

**To switch accounts:** generate a new code from a different account and send `/setup NEW-CODE`. This overwrites the existing link.

**To unlink:** not yet implemented. Workaround: send `/setup` with a code from a new blank account.

---

## Supported Commands

| Message               | Action                                    |
|-----------------------|-------------------------------------------|
| `/setup CODE`         | Link WhatsApp chat to a dashboard account |
| `/help`               | Show help with all commands               |
| `/dashboard`          | Get the dashboard URL                     |
| `/rekap`              | Monthly summary with income/expense       |
| `/kategori`           | List all available categories             |
| `makan siang 35k`     | Record Rp35.000 expense                   |
| `gaji masuk 5jt`      | Record Rp5.000.000 income                 |
| `makan 35k, kopi 15k` | Record multiple transactions at once      |
| Reply to bot message  | Edit or delete that transaction           |

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

**To edit one from a multi-transaction reply:**

```
"2 kopi jadi 20k"         → edits item #2, amount = Rp20.000
"yang kopi ganti tgl 12"  → edits item #2 by name, changes date
```

---

## Known Limitations

| Feature                       | Status       | Notes                                             |
|-------------------------------|--------------|---------------------------------------------------|
| Group account member invites  | ❌ Not built | Workaround: share /setup code with other members  |
| Unlink WhatsApp from account  | ❌ Not built | Workaround: /setup with a code from another account |
| Edit/delete account from bot  | ❌ Not built | Use dashboard Accounts page instead               |
| Edit/delete category from bot | ❌ Not built | Use dashboard Categories page instead             |