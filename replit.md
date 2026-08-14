# Jarvis Merit Bot

Jarvis is a Discord HR operations bot that records fleet merits, validates proof links, and writes owner-facing audit logs.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — stored through Replit Secrets, never in source or chat
- Optional env: `DISCORD_GUILD_ID`, `DISCORD_HR_ROLE_IDS`, `DISCORD_OWNER_USER_IDS`, `DISCORD_OWNER_LOG_CHANNEL_ID`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot.ts` — Discord client, slash commands, authorization, proof validation, and audit logging
- `lib/db/src/schema/meritAwards.ts` — persistent merit ledger

## Architecture decisions

- Merit awards are append-only ledger entries, so totals and history remain auditable.
- Proof links must be Discord message URLs before an award is written.
- Merit entries are stored per guild and member to keep multiple servers isolated.

## Product

- `/addmerit` awards the same amount to up to 25 members from one HR command.
- `/merits` shows a member total or the top-ten server leaderboard.
- `/merithistory` shows the ten most recent awards and their proof links.
- Every accepted award is posted to the configured owner audit channel.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Set `DISCORD_HR_ROLE_IDS` and `DISCORD_OWNER_LOG_CHANNEL_ID` before using `/addmerit`.
- Discord command names are lowercase, so the command is `/addmerit`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
