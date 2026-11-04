# Notes Inbox — developer guide

Everything you need to set up, run, deploy and continue work on this project. If you only read one section, read **[Setup checklist](#1-setup-checklist-what-you-need-to-do)**.

Contents: [1 Setup checklist](#1-setup-checklist-what-you-need-to-do) · [2 Credentials & env vars](#2-credentials--environment-variables) · [3 Telegram setup](#3-telegram-setup-step-by-step) · [4 Run locally](#4-running-locally) · [5 Code map](#5-code-map) · [6 Behaviour reference](#6-behaviour-reference) · [7 WhatsApp import](#7-importing-your-whatsapp-self-chat) · [8 Hosting](#8-hosting-and-deployment) · [9 Backups](#9-backups--data) · [10 Search tuning](#10-search-tuning) · [11 Decisions](#11-decisions) · [12 Blockers & workarounds](#12-blockers--workarounds) · [13 Known issues](#13-known-issues) · [14 Progress](#14-progress)

---

## 1. Setup checklist (what you need to do)

The code is finished and tested without Telegram. Three things are left that only you can do:

1. **Create the bot and get its token** (2 min) → [§3.1](#31-create-the-bot-with-botfather)
2. **Find your numeric Telegram user ID** (1 min) → [§3.2](#32-find-your-telegram-user-id)
3. **Pick a host and deploy** → [§8](#8-hosting-and-deployment). Or just run it on your laptop first: `npm start` works anywhere with Node 20+.

Minimum local run:

```bash
git clone https://github.com/SarthakJain29/Notes-Inbox-app && cd Notes-Inbox-app
npm install
cp .env.example .env        # then fill in the values (see §2)
npm run build && npm start  # real Telegram bot (long polling)
```

No Telegram yet? `npm run simulate` runs the exact same pipeline in your terminal ([§4](#4-running-locally)).

---

## 2. Credentials & environment variables

Copy `.env.example` to `.env` (git-ignored). **Never commit real keys.** All variables are read in `src/config.ts` and validated at startup with readable errors. Empty values count as unset.

| Variable | Required? | What / where to get it |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | For the real bot | From **@BotFather** after `/newbot` ([§3.1](#31-create-the-bot-with-botfather)). Looks like `123456789:AAH...`. |
| `ALLOWED_TELEGRAM_USER_ID` | For the real bot | Your numeric Telegram ID ([§3.2](#32-find-your-telegram-user-id)). **The bot ignores every other user.** |
| `GEMINI_API_KEY` | Optional (recommended) | Free key from <https://aistudio.google.com/apikey>. Used for classification **and** embeddings (semantic search). |
| `GROQ_API_KEY` | Optional (recommended) | Free key from <https://console.groq.com/keys>. Used for **voice-note transcription** (Whisper) and as an alternative classifier. |
| `LLM_PROVIDER` | No (`auto`) | `auto` = Gemini if its key is set, else Groq, else mock. Force with `gemini`, `groq` or `mock`. |
| `GEMINI_MODEL` | No | Comma-separated fallback list, tried in order. Default `gemini-flash-lite-latest,gemini-flash-latest`. |
| `GEMINI_EMBEDDING_MODEL` | No | Default `gemini-embedding-001` (768-dim). |
| `GROQ_MODEL` | No | Comma-separated fallback list. Default `openai/gpt-oss-120b,openai/gpt-oss-20b`. |
| `GROQ_WHISPER_MODEL` | No | Default `whisper-large-v3-turbo`. |
| `TIMEZONE` | **Set this** | IANA name, e.g. `Europe/London`, `Asia/Kolkata`, `America/New_York`. Drives "tomorrow at 5pm", due dates and the digest time. Default `UTC` (so set it, or your digest fires at the wrong hour). |
| `DIGEST_HOUR` | No (`8`) | Hour 0–23, in `TIMEZONE`, when the morning digest is sent. |
| `DATABASE_PATH` | No (`./data/notes.db`) | SQLite file. Put it on a persistent disk when hosting ([§8](#8-hosting-and-deployment)). |
| `BOT_MODE` | No (`polling`) | `polling` or `webhook` ([§8.1](#81-polling-vs-webhook)). |
| `WEBHOOK_URL` | Webhook mode | Public https base URL of your deployment, e.g. `https://notes-inbox.onrender.com`. |
| `WEBHOOK_SECRET` | Webhook mode | Random string, 8+ chars of `A-Z a-z 0-9 _ -`. Generate: `openssl rand -hex 24`. Used in the URL path **and** as Telegram's secret-token header. |
| `PORT` | No (`3000`) | HTTP port for `/healthz` and the webhook. Most hosts set this for you. |

**Mock mode:** with no `GEMINI_API_KEY`/`GROQ_API_KEY` everything still works. Notes are filed by a rule-based classifier (`src/ai/heuristic.ts`) and search uses an offline hashed bag-of-words vector. It is decent for demos and tests, but far less smart than the real models. If an AI call fails at runtime the note is still saved using the same fallback and flagged `(filed offline)`; `/reprocess` upgrades those later.

---

## 3. Telegram setup, step by step

### 3.1 Create the bot with BotFather

1. In Telegram, search for **@BotFather** (the verified one with the blue tick) and open it.
2. Send `/newbot`.
3. Choose a **display name** (anything, e.g. `Notes Inbox`).
4. Choose a **username** — must be globally unique and end in `bot` (e.g. `sarthak_notes_inbox_bot`).
5. BotFather replies with the **HTTP API token** (`123456789:AAH...`). Put it in `.env` as `TELEGRAM_BOT_TOKEN`. Treat it like a password. If it leaks, send `/revoke` to BotFather to rotate it.
6. Optional polish: `/setuserpic`, `/setdescription`, `/setabouttext`. The command menu (`/tasks`, `/search`, …) is registered automatically at startup.
7. Optional privacy hardening: `/setjoingroups` → *Disable* so nobody can add the bot to groups.

### 3.2 Find your Telegram user ID

The bot only answers **one numeric user ID** (not your @username, which can change).

- Easiest: message **@userinfobot** (or **@getidsbot**); it replies with `Id: 123456789`.
- Or: after you have started the bot with a wrong/empty ID, send it any message and watch the log, which prints `ignored update from unauthorised user 123456789`.

Put the number in `.env` as `ALLOWED_TELEGRAM_USER_ID`.

### 3.3 First run

1. `npm run build && npm start` (or `npm run dev` for auto-reload).
2. Open your bot in Telegram, press **Start**, then send `buy milk, eggs`. You should get a filed card with buttons.
3. Try `/help`, `/tasks`, `/search milk`.

Troubleshooting:
- *Bot never replies*: check the log. `ignored update from unauthorised user N` → wrong `ALLOWED_TELEGRAM_USER_ID`. `Telegram rejected TELEGRAM_BOT_TOKEN` → re-copy the token (no quotes/spaces).
- *Two instances running* → Telegram returns `409 Conflict: terminated by other getUpdates request`. Only run one instance per token (polling), and don't run polling locally while a deployed webhook is registered (starting polling clears the webhook).
- *Voice notes say "need a GROQ_API_KEY"* → set `GROQ_API_KEY`.

---

## 4. Running locally

```bash
npm install
npm run simulate                 # chat with the bot in your terminal (in-memory DB)
npm run simulate -- --persist    # same, but uses DATABASE_PATH
npm run dev                      # real Telegram bot with auto-reload
npm test                         # ~170 tests
npm run check                    # typecheck + lint + tests (what CI runs)
```

The **simulator** (`src/cli/simulate.ts`) calls the same `InboxBot` the Telegram adapter uses, so classification, search, buttons and the scheduler behave identically. Extra meta commands: `:click N` presses the Nth button of the last reply, `:tick` runs the reminder/digest scheduler once, `:quit`.

```
You: call the dentist tomorrow at 5pm
Bot: ✅ Saved #1 · Task
     Reschedule dentist
     ⏰ Due Thu 5 Nov 17:00
     [1] ✅ Done  [2] 🗂 Re-file  [3] 🗑 Delete
You: :click 1
```

With no API keys it runs in mock mode, so you can try it with zero setup. Add `GEMINI_API_KEY` to `.env` to see the real AI.

---

## 5. Code map

```
src/
  index.ts            entrypoint: Telegram bot + HTTP (/healthz, webhook) + scheduler
  app.ts              wires store + AI providers + service + bot brain (used by every entrypoint)
  config.ts           env parsing/validation (zod)
  types.ts            Note, NoteType, Classification
  core/
    bot.ts            InboxBot: text/commands/button presses -> Reply[]  (transport-neutral)
    service.ts        NotesService: capture, search, mutations, digest data, reindex/reprocess
    format.ts         message/button rendering (Telegram HTML)
    reply.ts          Reply type + html helpers
  ai/
    capture.ts        "Title: body", #tags, "idea:" prefix parsing (deterministic)
    prompt.ts         LLM prompts (single + batch)
    parse.ts          tolerant JSON extraction + validation -> Classification
    heuristic.ts      offline classifier + date extraction (mock mode / fallback)
    classifier.ts     LLMClassifier: LLM first, heuristic fallback, user overrides
  llm/
    types.ts          LLMProvider / EmbeddingProvider / TranscriptionProvider interfaces
    gemini.ts groq.ts mock.ts   provider implementations (plain fetch, no SDKs)
    http.ts           fetch + retry/backoff + model fallback chain
    index.ts          provider selection from config
  db/
    store.ts          NoteStore interface (async, user-scoped)
    sqlite.ts         better-sqlite3 implementation + migrations
  telegram/bot.ts     grammY adapter: allowlist guard, text/voice/callbacks, chunking
  scheduler.ts        reminders + morning digest (minute tick, state in DB)
  import/
    whatsapp.ts       export (.txt) parser
    run.ts            batched, idempotent bulk import
  cli/                simulate.ts, import-whatsapp.ts, export.ts
tests/                vitest (incl. a fake Telegram Bot API server)
samples/              example WhatsApp exports (iOS + Android layouts)
docs/                 README images; docs/mockups/ re-renders them (needs Playwright)
```

Adding a new LLM vendor = one class implementing `LLMProvider` (and optionally `EmbeddingProvider`) + a line in `src/llm/index.ts`.

---

## 6. Behaviour reference

**Capture** — any non-command text. Pre-parse (`src/ai/capture.ts`):
- `Title: content` sets your own title (first line, ≤ 6 words, colon followed by a space). A sentence that happens to start like `Saw a great talk: …` will therefore be treated as title + body. Not what you want? Rephrase, or put the sentence first.
- `#tags` are lifted out and always kept.
- `idea:` / `todo:` / `task:` / `buy:` / `shopping:` / `meeting:` / `link:` / `journal:` force the type. `note:` / `note to self:` are dropped without forcing anything.

**AI output per note** (`type, title, tags, items, due, context`): types are `task, shopping, meeting, idea, reference, journal, other`. Lists are split into `items`; `due` is resolved relative to the current time in `TIMEZONE`; `context` is the one-line "why I saved this".

**Reminders & digest** — if a due date has a **time** ("at 5pm"), you get a reminder message at that time with Done / +1h / Tomorrow buttons. **Date-only** due dates are not pinged individually; they appear in the morning digest (overdue → today → next 3 days → undated tasks → shopping count). The digest is sent once per day at `DIGEST_HOUR`, with up to 6h of catch-up if the app was down. It is skipped when you have nothing at all. Reminders older than 24h (long downtime) are silently retired and show as overdue in the digest instead.

**Commands**: `/tasks /shopping /ideas /meetings /links /journal /recent /search <q> /show <id> /done <id> /delete <id> /type <id> <type> /digest /reprocess /reindex /export /help`. Delete is a soft delete with an Undo button; deleted notes are excluded from lists and search but stay in the DB.

**Security** — a grammY middleware (`src/telegram/bot.ts`) drops every update whose `from.id` is not `ALLOWED_TELEGRAM_USER_ID` before any handler runs, including button presses. Nothing is stored or answered for strangers (tested with a fake Bot API). All DB queries are scoped by `user_id` as well, so the multi-user path is already isolated.

---

## 7. Importing your WhatsApp self-chat

1. WhatsApp → open your self-chat → ⋮ (Android) / contact name (iOS) → **More → Export chat → Without media**. Save/email the `.txt` to your computer.
2. Dry run first (classifies but writes nothing):

   ```bash
   npm run import:whatsapp -- path/to/chat.txt --dry-run
   ```
3. Real import (uses your `.env`, so set `ALLOWED_TELEGRAM_USER_ID`, `TIMEZONE`, `GEMINI_API_KEY`, and point `DATABASE_PATH` at the same DB the bot uses):

   ```bash
   npm run import:whatsapp -- path/to/chat.txt
   ```

Options: `--author "Name"` (required if the chat has several senders), `--date-order dmy|mdy|ymd|auto`, `--batch 8` (notes per AI call), `--delay-ms 2000` (free-tier pacing), `--done-older-than 90` (import tasks older than N days as done), `--limit N`, `--user <id>`.

What it does: parses iOS and Android layouts (12/24h clocks, multi-line messages, narrow no-break spaces), drops system lines, media placeholders and deleted messages, **auto-detects day-first vs month-first dates** (and tells you when every date was ambiguous and it had to guess; override with `--date-order`), classifies in batches (one LLM call per 8 notes), keeps the **original timestamps**, embeds in bulk, and is **idempotent** (a hash of timestamp+text means re-running skips what's already imported). Due dates that are already in the past are dropped but preserved in the context line ("originally due …"), so a year of old tasks does not flood your overdue list. Imported notes appear in `/recent`, `/tasks`, `/search` like any other.

If the database lives on a remote host, run the import **on that host** (or import locally and copy the SQLite file up; stop the bot while copying).

---

## 8. Hosting and deployment

### 8.1 Polling vs webhook

| | Long polling (`BOT_MODE=polling`, default) | Webhook (`BOT_MODE=webhook`) |
|---|---|---|
| How | The bot repeatedly asks Telegram "anything new?" | Telegram POSTs each message to your public HTTPS URL |
| Needs a public URL | **No** (works on a laptop, Pi, any VM) | Yes, HTTPS |
| Needs to run 24/7 | Yes | The *process* can sleep; Telegram wakes it on a message |
| Good for | VMs, home server, Fly, anything always-on | Hosts that sleep idle apps (Render free) |
| Setup | nothing | set `WEBHOOK_URL` + `WEBHOOK_SECRET`; the app registers the webhook itself at startup |

**Important:** reminders and the morning digest are fired by an in-process timer. If the host puts the app to sleep, they don't fire until something wakes it. For a reliable digest, use an always-on host (polling) or ping `/healthz` every ~10 min with a free monitor (UptimeRobot, cron-job.org) on a sleeping host.

**Persistence matters more than anything else.** Notes live in a SQLite file (`DATABASE_PATH`). Free web-app tiers commonly have an **ephemeral disk**, wiped on every deploy/restart, which would silently erase your notes. Choose a host with a persistent disk, or use `/export` regularly ([§9](#9-backups--data)).

### 8.2 Options (I could not verify current free-tier terms offline — check each site's pricing page before choosing)

| Option | Persistent disk | Always on | Notes |
|---|---|---|---|
| **Oracle Cloud "Always Free" VM** or **Google Cloud e2-micro** | Yes | Yes | Best truly-free fit: a tiny Linux VM. Use polling. A bit more setup (§8.5). |
| **Home machine / Raspberry Pi** | Yes | If you leave it on | Zero cost, polling, no public URL needed. |
| **Fly.io** | Yes (volume) | Yes | Volumes/machines may cost a few $/month or use trial credit; `fly.toml` included. |
| **Railway** | Yes (volume) | Yes | Trial credit then paid; add a volume mounted at `/data`. |
| **Render (free web service)** | **No** (ephemeral) | Sleeps after ~15 min idle | `render.yaml` included. Webhook mode wakes it. **Do not rely on it for the DB** without a paid disk. |

All of them can use the included `Dockerfile` (it stores the DB in `/data`; mount a volume there). The Docker image has not been built in this repo's sandbox (no Docker daemon) — see [§12](#12-blockers--workarounds).

### 8.3 Render (webhook mode)

1. Push the repo to GitHub, then Render → **New → Blueprint**, select the repo (uses `render.yaml`).
2. Fill the prompted secrets: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`, `GEMINI_API_KEY`, `GROQ_API_KEY`, and `WEBHOOK_URL` (= your service URL `https://<name>.onrender.com`; you can edit it after the first deploy once you know the URL). `WEBHOOK_SECRET` is auto-generated. Also set `TIMEZONE`.
3. Deploy. The log should say `Webhook registered.`
4. Add an UptimeRobot monitor on `https://<name>.onrender.com/healthz` (every 5 min) so the app stays awake for reminders/digest.
5. Remember the ephemeral disk: attach a paid Render Disk at `/data` (set `DATABASE_PATH=/data/notes.db`) or accept that notes reset on redeploys, and use `/export`.

### 8.4 Fly.io (polling, with a volume)

```bash
fly launch --no-deploy --copy-config      # accept the existing fly.toml; rename the app inside it first
fly volumes create notes_data --size 1
fly secrets set TELEGRAM_BOT_TOKEN=... ALLOWED_TELEGRAM_USER_ID=... GEMINI_API_KEY=... GROQ_API_KEY=... TIMEZONE=Europe/London
fly deploy
```

### 8.5 A plain Linux VM (Oracle/GCP free tier, Pi, home server)

```bash
# Node 20+ installed
git clone https://github.com/SarthakJain29/Notes-Inbox-app && cd Notes-Inbox-app
npm ci && npm run build
cp .env.example .env && nano .env         # fill in values; BOT_MODE=polling
```

Run it forever with systemd (`/etc/systemd/system/notes-inbox.service`):

```ini
[Unit]
Description=Notes Inbox bot
After=network-online.target

[Service]
WorkingDirectory=/home/YOU/Notes-Inbox-app
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=YOU

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now notes-inbox && journalctl -u notes-inbox -f
```

Update later with `git pull && npm ci && npm run build && sudo systemctl restart notes-inbox`.

### 8.6 Free-tier API limits (as of writing; check the providers)

Gemini and Groq free tiers are rate-limited per minute/day. The app retries 429/5xx with backoff, walks the model fallback list (Gemini Flash models sometimes return `503 high demand`; flash-lite is the first choice for that reason), and **never loses a note**: on total failure the note is saved with the offline classifier. For big imports use `--delay-ms` and a smaller `--batch`.

---

## 9. Backups & data

- `/export` in the bot sends all notes as JSON; `npm run export` writes the same to a file. (Embeddings are excluded; `/reindex` rebuilds them.)
- The SQLite file is the source of truth. Backup = copy `DATABASE_PATH` (and `-wal`/`-shm` if present, ideally while the bot is stopped or via `sqlite3 notes.db ".backup copy.db"`).
- There is **no JSON restore command yet** (listed in Next). The DB file copy is the restore path.
- Schema changes are versioned via `PRAGMA user_version` migrations in `src/db/sqlite.ts`.

---

## 10. Search tuning

`/search` embeds your query (Gemini, `RETRIEVAL_QUERY`) and compares it with every stored note vector by cosine similarity, plus a small bonus for exact (stemmed) keyword overlap. Raw similarity alone is misleading — I measured `gemini-embedding-001` at roughly **0.68–0.85 for relevant notes and 0.48–0.61 for unrelated ones** — so each embedder carries a calibrated `search` profile (`minScore`, `margin`, `minLift`; see `src/llm/gemini.ts`): a note must clear the floor, the best hit must stand out from the median, and only hits within `margin` of the best are returned. Calibrated on a handful of notes, so if search feels too strict/loose with a large collection, adjust those three numbers. The scan is in-memory over all notes (fine for tens of thousands; the `NoteStore` interface is where a vector index would go later).

If you change embedding model/provider, vectors from the old one are ignored (they're tagged with the model id); run `/reindex` to re-embed. Keyword matches still work in the meantime.

---

## 11. Decisions

Made unattended; revisit freely.

1. **Branch**: the task said to work on `claude/v1`, while the session harness named a different default branch; I followed the explicit task instruction and used `claude/v1`. Nothing was pushed to `main`.
2. **Plain `fetch` instead of vendor SDKs** for Gemini/Groq: fewer dependencies, trivial to mock in tests, and each provider is ~60 lines.
3. **SQLite (better-sqlite3)**: zero-config, free, one file. The `NoteStore` interface is async and user-scoped so Postgres/libSQL (Turso, Neon) can replace it without touching callers. Chosen over Prisma/Drizzle to avoid a build/codegen step for a single table; trade-off is hand-written SQL.
4. **Embeddings stored as Float32 BLOBs in the same row**, with the embedding model id recorded per note. Search is a linear in-memory scan.
5. **Gemini for embeddings + classification; Groq for Whisper (+ optional classification)**. Groq has no embeddings API; Gemini's free tier does.
6. **Model fallback lists instead of a single model id.** During development `gemini-2.5-flash` was rejected for this key ("no longer available to new users") and Gemini Flash returned 503s under load, so defaults are the `-latest` aliases (`gemini-flash-lite-latest` first) with fallbacks. Groq's old default `llama-3.3-70b-versatile` wasn't in the account's model list; the default is `openai/gpt-oss-120b,openai/gpt-oss-20b`.
7. **Heuristic fallback, never reject a note.** Any LLM failure → rule-based classification, flagged `processed_by = heuristic`, upgradable with `/reprocess`.
8. **Transport-neutral brain** (`InboxBot` → `Reply` objects with HTML + abstract buttons). Telegram and the CLI are thin adapters, which is also what a future web/mobile app would reuse.
9. **One due field.** A due date with a time triggers a reminder; a date-only due appears in the digest. Avoids a separate "remind" concept the model could hallucinate.
10. **Reminders/digest run in-process** on a 60s tick with state in the DB (no cron service, no extra dependency). Documented caveat for sleeping hosts.
11. **`TIMEZONE` env var (default UTC)** — your timezone is unknown; due-date resolution and the digest hour depend on it.
12. **Title/type prefix parsing**: known prefixes (`idea:`, `todo:` …) set the type; other `Short phrase:` prefixes become a title (≤ 6 words). Accepts occasional false positives in exchange for the explicit syntax you asked for.
13. **Soft delete** with Undo; deleted notes are excluded everywhere but retained.
14. **WhatsApp import drops past due dates** (kept in context text) rather than flooding "overdue", and defaults to **dd/mm** only when every date in the file is ambiguous (reported loudly).
15. **Always starts an HTTP server** (`/healthz`) even in polling mode, so PaaS health checks and uptime pingers work.
16. **ESM + TypeScript (NodeNext), vitest, ESLint flat config**, no Prettier (kept the toolchain small).
17. **MIT license** added as a placeholder (copyright line is generic); change it if you prefer otherwise.
18. **Telegram HTML parse mode** with escaping of all user content (Markdown escaping is more fragile); plain-text retry if Telegram still rejects a message.

---

## 12. Blockers & workarounds

| # | What failed / was unavailable | What I tried | Status / what you need to do |
|---|---|---|---|
| 1 | **No Telegram bot token or user ID** in the sandbox | Built the adapter on grammY and tested it end-to-end against a **local fake Telegram Bot API server** (`tests/telegram.test.ts`: filing, buttons, auth allowlist, voice-without-key, export). Confirmed from the sandbox that the real `api.telegram.org` is reachable (a fake token got a proper `401`). | **Needs you**: create the bot, set the two env vars ([§3](#3-telegram-setup-step-by-step)). Real long polling and webhook registration have **never been exercised against live Telegram**. Expect to report any surprises. |
| 2 | **Docker daemon not available** (`/var/run/docker.sock` missing) | Could not `docker build`. As a proxy I verified that `npm ci --omit=dev` + the compiled `dist/` starts correctly in a clean directory (creates the DB, falls back to mock mode, validates config). | **Dockerfile, `render.yaml`, `fly.toml` are unbuilt/untested.** First deploy may need small tweaks. |
| 3 | **Real voice transcription** can't be verified without audio | Verified the Groq Whisper endpoint accepts my multipart request (auth, model, file field) using a synthetic WAV; unit-tested request shaping. | Telegram voice download → Whisper → note has not run with real speech/real Telegram. Send yourself a voice note after setup. |
| 4 | **`gemini-2.5-flash` rejected** for this key (HTTP 404, "no longer available to new users"); newer Flash models returned **503 high demand** | Listed models via the API, switched defaults to `-latest` aliases and added comma-separated model fallback. Verified flash-lite generation and `gemini-embedding-001` batch embedding live. | Resolved in code. If Google retires aliases, set `GEMINI_MODEL`. |
| 5 | **Groq default model** (`llama-3.3-70b-versatile`) absent from the account's model list | Listed models; default is now `openai/gpt-oss-120b,openai/gpt-oss-20b`. Verified live afterwards with `LLM_PROVIDER=groq npm run simulate` (classification worked). | Set `GROQ_MODEL` if needed; test with `LLM_PROVIDER=groq npm run simulate`. |
| 6 | **Webhook mode** untested with real Telegram | Code path + secret-token verification written per grammY docs; HTTP server and config validation run locally. | Needs a public HTTPS URL; test on first deploy. |
| 7 | **`npm audit`** reports moderate advisories (minimatch via ESLint/typescript-eslint) | They are dev-only, not shipped in the production install. | Ignored; revisit when upgrading ESLint. |
| 8 | **Live API keys were present in the sandbox environment** | Used them only for development verification (model discovery, a few classification/embedding calls, search calibration). Nothing is written to files or commits; `.env` is git-ignored. | Consider rotating those keys if the sandbox is shared. |

---

## 13. Known issues

- Search relevance thresholds are calibrated on a small sample ([§10](#10-search-tuning)); vague one-word queries can still return a loosely related note.
- The offline classifier is English-only and keyword based; with real AI keys this only matters during outages.
- `Title: body` prefix rule can misfire on natural sentences that contain a colon early.
- Free hosts with sleeping/ephemeral dockers can lose reminders/digests/data ([§8](#8-hosting-and-deployment)).
- Long messages are chunked at 4000 chars; extremely long single lines are hard-split.
- Edited Telegram messages are not re-processed; forwarded messages are filed as plain text without sender info.
- Photos/files/locations are not supported (text and voice only).
- The shopping list is per-note (check off whole notes with the button); per-item toggling exists in the service (`toggleItem`) but has no UI yet.
- No JSON restore command yet.

---

## 14. Progress

### Done
- [x] Project scaffold: Node 22 + TypeScript (ESM), vitest, ESLint, CI workflow
- [x] Config/env validation; mock-mode fallbacks for every external service
- [x] LLM abstraction: Gemini, Groq, mock; retry/backoff and model fallback chain
- [x] Classification: prompt, tolerant JSON parsing, validation, offline heuristic fallback, `/reprocess`
- [x] Capture parsing (`title: content`, `#tags`, `idea:` prefixes)
- [x] SQLite store with migrations, user scoping, embeddings alongside notes
- [x] Semantic search (Gemini embeddings, calibrated thresholds, keyword bonus, reindex)
- [x] Bot commands: `/tasks /shopping /ideas /meetings /links /journal /recent /search /show /done /delete /type /digest /reprocess /reindex /export`
- [x] Inline buttons: done/reopen, re-file picker, delete + undo, snooze
- [x] Reminders and morning digest scheduler
- [x] Voice notes via Groq Whisper (adapter + provider; see blocker 3)
- [x] Telegram adapter with strict single-user allowlist; polling + webhook modes; `/healthz`
- [x] WhatsApp export parser + idempotent bulk importer CLI (iOS/Android, date-order detection); verified live against Gemini with the sample exports (original dates kept, bulk-embedded, re-run imports 0)
- [x] CLI simulator running the same pipeline
- [x] ~170 tests (classification parsing, capture parsing, heuristics, importer, store, service, scheduler, providers, Telegram adapter with fake Bot API)
- [x] Dockerfile, `render.yaml`, `fly.toml`, GitHub Actions CI
- [x] README with mockups + Mermaid architecture; this guide

### In progress
- Nothing. Pull request `claude/v1` → `main` is open for review (not merged).

### Next (suggested)
1. Run against real Telegram; fix whatever the first live session reveals (blockers 1, 3, 6).
2. Build and test the Docker image; choose a host with persistent storage ([§8](#8-hosting-and-deployment)).
3. JSON restore command (`npm run restore`), scheduled auto-backup to a private file/Gist.
4. Per-item checklist toggling in `/shopping` (inline buttons per item).
5. Natural-language filters in search ("tasks from last week", "ideas tagged work"): have the LLM translate to filters + semantic query.
6. Weekly review message ("what you captured, what's stale").
7. Postgres/Turso store implementation for hosts without persistent disks; vector index (sqlite-vec / pgvector) when notes reach six figures.
8. Web/mobile client reusing `InboxBot`/`NotesService` behind an HTTP API + real auth (see README roadmap).
