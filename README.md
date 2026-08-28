# tg-voice-summarizer

Telegram bot that listens to voice messages, transcribes them with OpenAI
Whisper, classifies each one into a user-defined "kind" of voice message, and
posts back a tailored summary using a per-kind prompt.

The whole backend lives in [Convex](https://convex.dev) — there is no server
to run, no Redis, no scheduler. Convex hosts the HTTP webhook, the database,
the actions, and a cron that self-heals the Telegram webhook registration.

The Telegram side uses [grammY](https://grammy.dev)'s `Api` client.

## What you get

- A Telegram bot that processes voice messages from groups it is added to.
- An in-Telegram admin UI: **only the user whose ID you set** as
  `ADMIN_TELEGRAM_ID` can run admin commands.
- An end-to-end pipeline: download → Whisper transcription → GPT classifier →
  per-type GPT summary → reply in chat with `[type] <summary>`.
- A self-registering webhook (Convex cron + manual command).
- Reply-based summarization: reply to **any** voice (even old ones) with
  `/summarize` and the bot will fetch and process it.
- Forwarded-voice support: forward a voice message to the bot in a private
  chat and it will summarize it for you.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create the Convex deployment (already done if you cloned this repo with a
   pre-existing `.env.local`):

   ```sh
   npx convex dev --once --configure new --project tg-voice-summarizer
   ```

3. Copy the env template and fill it in:

   ```sh
   cp .env.local.example .env.local
   $EDITOR .env.local
   ```

   Required values:

   | Variable | Where to get it |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
   | `ADMIN_TELEGRAM_ID` | Your numeric Telegram ID. Use [@userinfobot](https://t.me/userinfobot), or run the bot once and DM it `/whoami`. |
   | `OPENAI_API_KEY` | <https://platform.openai.com/api-keys> |

   Optional:

   | Variable | Default | Meaning |
   |---|---|---|
   | `OPENROUTER_API_KEY` | (unset) | Only needed if you point a stage at OpenRouter via `/setmodel`. Transcription always uses OpenAI. |
   | `ALLOWED_CHAT_IDS` | (all chats) | Comma-separated list of group/chat IDs the bot will process. If empty, the bot processes voices from any group it is in. |

4. Run the one-shot setup:

   ```sh
   npm run setup
   ```

   This pushes your env vars into the Convex deployment, deploys the
   functions, and asks Convex to register the webhook with Telegram.

5. (Optional, for groups) In `@BotFather` → your bot → **Bot Settings** →
   **Group Privacy** → **Disable**. Without this, the bot only sees commands
   addressed to it directly. Then add the bot to your group.

6. DM the bot `/start` and you should get the help screen.

To deploy to production instead of the dev deployment:

```sh
npm run setup:prod
```

## Commands

Group commands (any member):

```
/settings        chat settings panel (ephemeral — visible only to you)
/reaction <emo>  change the on-demand trigger reaction (plain or premium emoji)
/summary [args]  summarize a slice of the chat history
/search, /ask    semantic search / grounded Q&A over the chat history
/modal           pick the summarizer model (alias for a /settings submenu)
/quiet           toggle on-demand mode (alias for a /settings switch)
```

Admin commands (private chat with the bot or groups):

```
/start, /help    show help
/whoami          print your Telegram user ID and the chat ID
/summarize       reply to a voice/audio message to (re)summarize it
/defaults        show/set default summary mode+context+detail for the chat
/debug [on|off]  toggle debug mode (adds models/timings to the quote)
/importdump      import a Telegram JSON export into the search index
/indexstats      DB / vector-index coverage stats
```

Unknown commands and plain (non-command) text from the owner are
intentionally silent — the bot never says "I don't understand".

### Chat settings (/settings)

The `/settings` panel is sent ephemerally (only the invoker sees it) and
uses Bot API 9.4/10.3 styled buttons. It controls, per chat:

- **Режим ответа** — `Сразу в чат` (loading placeholder → summary, the
  classic flow) or `По требованию` (nothing is posted; the bot marks a
  processed voice with the trigger reaction, and a member putting the same
  reaction on the voice receives the transcription as an ephemeral message
  only they can see). On-demand mode needs the bot to be a chat admin and
  the trigger reaction to be enabled in the chat.
- **Сообщение о загрузке** — when disabled (instant mode only), the bot
  skips the placeholder: it puts the trigger reaction on the voice while
  processing and posts the finished summary directly.
- **Войсы от имени канала** — channel posts auto-forwarded into the linked
  discussion chat and voices sent "as the channel" are always processed
  instantly with a visible placeholder, regardless of the other settings
  (on by default).
- **Реакция-триггер** — defaults to 👀; presets in the panel, arbitrary
  (including premium/custom) emoji via `/reaction`.
- **Модель / стиль / контекст / детальность** — per-chat summarizer model
  and default summary settings.

Mentioning the bot in a reply to any voice always posts a public
transcription of that voice, in every mode; in on-demand mode the bot also
deletes the mention message to keep the chat clean.

### How a voice reply looks

The bot reacts to a voice message in three phases inside a *single* reply
message (no chat clutter):

1. Instantly posts `Обрабатываю голосовое…` as a reply to the voice.
2. Edits that placeholder while it works (`Расшифровываю…`,
   `Определяю тип…`).
3. Streams the summary into the same message via Bot API 9.3+
   `sendMessageDraft` (smooth native streaming, like ChatGPT).
4. Finalizes with the formatted HTML summary plus a collapsed expandable
   blockquote that contains the full transcript.

In debug mode (`/debug on`) the blockquote also lists the detected type,
which model handled each stage, and per-stage timings.

### Changing models per stage

The pipeline has three stages, each driven by a separately-configurable
model:

| Stage | Default | Notes |
|---|---|---|
| `transcribe` | `openai / whisper-1` | OpenAI only (OpenRouter has no audio endpoint). |
| `classify` | `openai / gpt-4o-mini` | JSON-mode classifier that picks one of your types. |
| `summarize` | `openai / gpt-4o-mini` | Runs your type's summary prompt. |

Change them from inside Telegram:

```
/setmodel transcribe whisper-1
/setmodel classify openrouter anthropic/claude-3.5-haiku
/setmodel summarize openai gpt-4o
```

Any stage pointed at `openrouter` requires `OPENROUTER_API_KEY` to be set in
`.env.local` and re-pushed with `npm run setup`.

## How a voice gets processed

1. Telegram sends an `Update` to `https://<your-deployment>.convex.site/telegram`.
2. The HTTP action verifies the secret header and schedules an internal
   action with the raw update body.
3. The action either dispatches an admin command or, for voices, inserts a
   `voiceMessages` row and schedules `processing.processVoiceMessage`.
4. The processing pipeline:
   - calls Telegram `getFile` + downloads the audio,
   - sends it to Whisper for transcription,
   - asks `gpt-4o-mini` (in JSON mode) to pick one of your `voiceTypes`,
   - calls `gpt-4o-mini` again with that type's `summaryPrompt`,
   - posts the summary back as a Telegram reply.

If a step fails, the row's `status` becomes `error` and a short message is
sent to the admin.

## Voice-message kinds

Out of the box there are no types defined. The bot then falls back to a
generic "default" summarizer. To add a real type, DM the bot:

```
/addtype
```

The wizard will ask for, in order:

1. **Name** — short label, e.g. `Idea`, `Task`, `MeetingNotes`.
2. **Description** — what this kind of voice message represents.
3. **Detection hints** — what the classifier should look for.
4. **Summary prompt** — the instruction the model will follow when
   summarizing voices of this kind. You can be very specific here, e.g.:

   > "Format as a checklist of action items. For each item include who is
   > responsible (if mentioned) and the deadline. End with a one-line
   > 'open questions' section if anything is unresolved."

You can edit a single field later via `/edittype <id> → <field>`.

## Files

```
convex/
  schema.ts         — voiceTypes, voiceMessages, adminState, botConfig tables
  http.ts           — /telegram webhook endpoint and /setup smoke endpoint
  bot.ts            — update dispatcher + admin command flow
  processing.ts     — Whisper → classify → summarize → reply pipeline
  voiceTypes.ts     — CRUD for voice-message types
  voiceMessages.ts  — CRUD for processed messages
  adminState.ts     — wizard-state storage for the admin
  botConfig.ts      — remembers last registered webhook URL/secret
  telegram.ts       — grammY-based Telegram API client
  openai.ts         — Whisper + Chat Completions client
  setup.ts          — registerWebhook + ensureWebhook (idempotent)
  crons.ts          — hourly self-heal of the Telegram webhook
scripts/
  setup.mjs         — `npm run setup` — pushes env, deploys, registers webhook
```

## Re-running setup

`npm run setup` is idempotent. Run it any time you change something in
`.env.local`. The Telegram webhook registration only re-calls `setWebhook`
when the URL or secret actually changed.
