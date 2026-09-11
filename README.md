# Jarvis Bot (standalone)

This is your Discord bot extracted from the original pnpm-workspace/Replit
project into a plain Node.js project, so it can run on any generic host
(like bot-hosting.net) with just `npm install`.

## Deploying on bot-hosting.net

The built bot (`dist/`) is committed to this repo, so the host never needs to
run the bundler itself — that step (`esbuild`) is memory-hungry and will OOM
on a small container. `npm install` here only installs runtime dependencies.

1. Upload/unzip this whole folder as your bot's files.
2. Set the **startup file** to `index.js` (default on most panels — it just
   hands off to the pre-built bundle in `dist/index.mjs`).
3. In the panel's **Startup/Environment Variables** section, set every
   variable listed in `.env.example`:
   - `DISCORD_BOT_TOKEN` — your bot's token from the Discord Developer Portal
   - `DATABASE_URL` — a Postgres connection string (see below)
   - `GOOGLE_API_KEY` / `GEMINI_MODEL` — for the AI features (uses Gemini via
     an OpenAI-compatible endpoint)
   - `DISCORD_OWNER_USER_IDS`, `DISCORD_SECOND_IN_COMMAND_USER_IDS`,
     `DISCORD_OWNER_LOG_CHANNEL_ID` — role/permission IDs specific to your server
   - `PORT` — whatever port the panel assigns
4. Start the bot.

### If you edit the bot's code

`dist/` is a snapshot, not generated on the fly. After changing anything in
`src/`, rebuild locally and commit the result:

```bash
npm install    # first time only, installs esbuild etc.
npm run build  # regenerates dist/
git add dist && git commit -m "Rebuild dist"
```

## The database

The bot stores merit awards in Postgres via
Drizzle ORM. bot-hosting.net does not provide a database, so you'll need one
from an external free-tier provider — e.g. [Neon](https://neon.tech) or
[Supabase](https://supabase.com) — and put its connection string in
`DATABASE_URL`. Migrations run automatically on startup.

## Local development

```bash
npm install          # installs deps and builds dist/index.mjs
cp .env.example .env # fill in real values, then load them into your shell
node dist/index.mjs
```
