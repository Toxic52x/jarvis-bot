import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./lib/logger";

// ─── Role names ──────────────────────────────────────────────────────────────

export const HR_ROLE_NAME = "HR";
export const ADVISOR_ROLE_NAME = "Advisor";
export const ROYALTY_ROLE_NAME = "Royalty";

// ─── Embed colours ───────────────────────────────────────────────────────────

export const FIRE_RED = 0xb91c1c;
export const FIRE_ORANGE = 0xf97316;

// ─── Channel IDs ─────────────────────────────────────────────────────────────
// Configurable via environment; the defaults are the values this deployment has
// always used, so an existing install keeps working with no env changes.

export const ROYAL_GUARD_CHANNEL_ID =
  process.env.DISCORD_ROYAL_GUARD_CHANNEL_ID?.trim() || "1539490573193449533";
export const NORMAL_GUARD_CHANNEL_ID =
  process.env.DISCORD_NORMAL_GUARD_CHANNEL_ID?.trim() || "1528554465060327474";
export const GUARD_RSVP_TRACKER_CHANNEL_ID =
  process.env.DISCORD_GUARD_RSVP_TRACKER_CHANNEL_ID?.trim() ||
  "1528555314998149231";

// ─── Overwatch Mode constants ─────────────────────────────────────────────────

export const OVERWATCH_PING_THRESHOLD = 5; // mentions in one message that counts as "ping abuse"
export const OVERWATCH_VIOLATIONS_BEFORE_MUTE = 3; // strikes before auto-mute
export const OVERWATCH_MUTE_DURATION_MIN = 15;
export const OVERWATCH_WARNING_LIFESPAN_MS = 15_000; // how long the public warning stays before self-deleting

// ─── AI quota constants ───────────────────────────────────────────────────────

export const GEMINI_DAILY_LIMIT = 100_000;

// Per-minute token usage tracker — Google AI Studio enforces a TPM (tokens-per-minute)
// limit that varies by tier and model. Set GOOGLE_TPM_LIMIT in your environment to
// your account's real TPM limit for gemini-2.0-flash; this fallback is only a guess.
export const GOOGLE_TPM_LIMIT = Number(process.env.GOOGLE_TPM_LIMIT) || 12_000;

// ─── Timing constants ─────────────────────────────────────────────────────────

export const PRESENCE_POLL_INTERVAL_MS = 60_000;
export const GUARD_REQUEST_LIFESPAN_MS = 24 * 60 * 60 * 1000;

// ─── Sleep / wake phrases ─────────────────────────────────────────────────────
// "jarvis go to sleep" / "jarvis good night" takes Jarvis fully offline: presence
// goes invisible, avatar swaps to the offline image, status rotation pauses, and
// every message (including the usual wake word) is ignored until "jarvis wake up".

export const JARVIS_SLEEP_PATTERN =
  /^jarvis[,]?\s+(?:go to sleep|good\s*night)[.!]?$/i;
export const JARVIS_WAKE_UP_PATTERN = /^jarvis[,]?\s+wake up[.!]?$/i;

// ─── Discord limits ───────────────────────────────────────────────────────────

export const DISCORD_MESSAGE_LIMIT = 2000;

// ─── Persistent data directory ────────────────────────────────────────────────
// IMPORTANT: this must NOT live under dist/ — esbuild regenerates dist/
// on every `pnpm run build`, wiping any files written there between runs.
// process.cwd() (the api-server package root) survives rebuilds/restarts.

export const DATA_DIR =
  process.env.JARVIS_DATA_DIR?.trim() || join(process.cwd(), "data");

try {
  mkdirSync(DATA_DIR, { recursive: true });
  logger.info({ DATA_DIR }, "Data directory ready");
} catch (err) {
  logger.error(
    { err, DATA_DIR },
    "Failed to create data directory — persistence will not work",
  );
}

// ─── Rank model ───────────────────────────────────────────────────────────────

export type JarvisRank =
  | "owner"
  | "second"
  | "royalty"
  | "advisor"
  | "hr"
  | "none";

export const RANK_ORDER: Record<JarvisRank, number> = {
  owner: 5,
  second: 4,
  royalty: 3,
  advisor: 2,
  hr: 1,
  none: 0,
};

export function getConfiguredIds(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}
