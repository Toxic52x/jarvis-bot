import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "discord.js";
import OpenAI from "openai";
import { DATA_DIR, getConfiguredIds } from "../../config";
import { logger } from "../../lib/logger";

// ─── OpenAI client ────────────────────────────────────────────────────────────

export const openai = new OpenAI({
  apiKey: process.env.GOOGLE_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
});

// ─── Daily token usage tracker ─────────────────────────────────────────────────
// Persisted to disk (unlike the per-minute counter below) — otherwise every
// bot restart silently zeroes the "daily" total, which is exactly why
// get_token_usage used to report a different, too-low number after every
// redeploy/crash-restart instead of the actual usage so far that day.

const TOKEN_USAGE_FILE_PATH = join(DATA_DIR, "token-usage.json");

export let dailyTokensUsed = 0;
export let tokenResetDate = new Date().toDateString();

export function loadTokenUsage(): void {
  try {
    const raw = readFileSync(TOKEN_USAGE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      dailyTokensUsed?: number;
      tokenResetDate?: string;
    };
    const today = new Date().toDateString();
    if (parsed.tokenResetDate === today && typeof parsed.dailyTokensUsed === "number") {
      dailyTokensUsed = parsed.dailyTokensUsed;
      tokenResetDate = today;
      logger.info({ dailyTokensUsed }, "Daily token usage restored from disk");
    } else {
      // Stored count is from a previous day (or file is malformed) — today
      // starts fresh, same as if no file existed at all.
      dailyTokensUsed = 0;
      tokenResetDate = today;
    }
  } catch {
    logger.info("No token-usage.json found yet — starting today's count at 0");
  }
}

function persistTokenUsage(): void {
  try {
    writeFileSync(
      TOKEN_USAGE_FILE_PATH,
      JSON.stringify({ dailyTokensUsed, tokenResetDate }),
      "utf-8",
    );
  } catch (err) {
    logger.error({ err }, "Failed to persist token-usage.json");
  }
}

export let minuteTokensUsed = 0;
export let minuteWindowStart = Date.now();

export function trackTokens(used: number) {
  const today = new Date().toDateString();
  if (today !== tokenResetDate) {
    dailyTokensUsed = 0;
    tokenResetDate = today;
  }
  dailyTokensUsed += used;
  persistTokenUsage();

  const now = Date.now();
  if (now - minuteWindowStart >= 60_000) {
    minuteTokensUsed = 0;
    minuteWindowStart = now;
  }
  minuteTokensUsed += used;
}

// ─── Token quota reset notification ───────────────────────────────────────────
export let tokenResetScheduled = false;

// ESM exports are read-only bindings for importers, so the chat handler cannot
// assign to `tokenResetScheduled` directly — it goes through these accessors.
export function isTokenResetScheduled(): boolean {
  return tokenResetScheduled;
}

export function setTokenResetScheduled(scheduled: boolean): void {
  tokenResetScheduled = scheduled;
}

export function parseRetryAfterMs(message: string): number {
  // Gemini errors say e.g. "Please try again in 29m34.656s"
  const match = message.match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/);
  if (!match) return 60 * 60 * 1000; // fallback: 1 hour
  const minutes = parseInt(match[1] ?? "0", 10);
  const seconds = parseFloat(match[2] ?? "0");
  return (minutes * 60 + seconds) * 1000;
}

export function isTransientError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 503 || status === 502 || status === 500 || status === 504;
}

export async function createCompletionWithRetry(
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  maxRetries = 3,
): Promise<OpenAI.Chat.ChatCompletion> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === maxRetries) throw error;
      const delayMs = 500 * 2 ** attempt + Math.random() * 250;
      logger.warn(
        { attempt, delayMs, status: (error as { status?: number })?.status },
        "Gemini API transient error — retrying",
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

export async function notifyTokenReset(client: Client): Promise<void> {
  tokenResetScheduled = false;
  const ids = [
    ...getConfiguredIds("DISCORD_OWNER_USER_IDS"),
    ...getConfiguredIds("DISCORD_SECOND_IN_COMMAND_USER_IDS"),
  ];
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      await user.send(
        "Sir, my neural core is back online. Token quota has reset — I am at your service.",
      );
    } catch (err) {
      logger.error({ err, userId: id }, "Failed to send token reset DM");
    }
  }
}
