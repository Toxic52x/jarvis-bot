import { EmbedBuilder, type Guild, type Message } from "discord.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRE_ORANGE,
  OVERWATCH_MUTE_DURATION_MIN,
  OVERWATCH_PING_THRESHOLD,
  OVERWATCH_VIOLATIONS_BEFORE_MUTE,
  OVERWATCH_WARNING_LIFESPAN_MS,
  RANK_ORDER,
} from "../../config";
import { escapeRegex } from "../knowledge";
import { getJarvisRank } from "../permissions";
import type {
  OverwatchLogEntry,
  OverwatchTrigger,
  ReactionWatch,
} from "../types";
import { logger } from "../../lib/logger";

export const INVITE_LINK_PATTERN =
  /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/i;

export const OVERWATCH_FILTER_FILE_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "overwatch-filters.txt",
);

// ─── Overwatch Mode state ──────────────────────────────────────────────────────

/** Which guild IDs currently have Overwatch Mode switched on. */
export const overwatchActiveGuilds = new Set<string>();

/** Strike counter, keyed `${guildId}:${userId}`. Resets on escalation-mute. */
export const overwatchViolations = new Map<string, number>();

/** Full violation history, keyed `${guildId}:${userId}`. Capped at 50 entries per user. */
export const overwatchLog = new Map<string, OverwatchLogEntry[]>();

/** Active reaction watches, keyed `${messageId}:${emoji}`. In-memory only — cleared on restart. */
export const reactionWatches = new Map<string, ReactionWatch>();

/** Loaded, lower-cased filter terms — one per line in overwatch-filters.txt. */
export let cachedOverwatchFilters: string[] = [];

/**
 * Loads the Overwatch filter wordlist from overwatch-filters.txt, sitting
 * next to fire-nation-knowledge.txt. One term/phrase per line. Lines
 * starting with # are treated as comments and skipped. This file is NOT
 * checked into this patch — populate it yourself with whatever terms your
 * server actually wants flagged. If the file is missing or empty, the
 * language-filter check simply no-ops (invite + ping-abuse checks still run).
 */
export function loadOverwatchFilters(): string[] {
  try {
    const raw = readFileSync(OVERWATCH_FILTER_FILE_PATH, "utf-8");
    cachedOverwatchFilters = raw
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    logger.info(
      { count: cachedOverwatchFilters.length },
      "Overwatch filter list loaded",
    );
  } catch (err) {
    logger.warn(
      { err },
      "Could not read overwatch-filters.txt — language filtering disabled, invite/ping checks still active",
    );
    cachedOverwatchFilters = [];
  }
  return cachedOverwatchFilters;
}

/** Returns the first trigger found in a message, or null if it's clean. */
export function checkOverwatchTrigger(message: Message): OverwatchTrigger | null {
  const content = message.content;
  if (!content) return null;

  if (INVITE_LINK_PATTERN.test(content)) {
    return {
      type: "invite",
      detail: "Posted an unauthorized server invite link",
    };
  }

  const mentionCount =
    message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount >= OVERWATCH_PING_THRESHOLD) {
    return {
      type: "ping_abuse",
      detail: `Mass-pinged ${mentionCount} users/roles in a single message`,
    };
  }
  if (message.mentions.everyone && message.member) {
    if (RANK_ORDER[getJarvisRank(message.member)] < RANK_ORDER.hr) {
      return {
        type: "ping_abuse",
        detail: "Used @everyone/@here without authorization",
      };
    }
  }

  if (cachedOverwatchFilters.length > 0) {
    const lower = content.toLowerCase();
    for (const term of cachedOverwatchFilters) {
      if (new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(lower)) {
        return {
          type: "language",
          detail: "Message contained a filtered term",
        };
      }
    }
  }

  return null;
}

/** Executes the automod response: delete, warn, log, escalate. */
export async function handleOverwatchTrigger(
  message: Message,
  trigger: OverwatchTrigger,
): Promise<void> {
  const guild = message.guild;
  if (!guild || !message.member) return;

  const channel = message.channel;
  if (!("send" in channel)) return; // e.g. PartialGroupDMChannel has no send — bail safely

  // Staff exercising legitimate authority (e.g. Advisor+ pinging for a raid
  // callout) are exempt from ping-abuse only — never from language/invite checks.
  if (
    trigger.type === "ping_abuse" &&
    RANK_ORDER[getJarvisRank(message.member)] >= RANK_ORDER.advisor
  ) {
    return;
  }

  const key = `${guild.id}:${message.author.id}`;
  const violations = (overwatchViolations.get(key) ?? 0) + 1;
  overwatchViolations.set(key, violations);

  const deleted = await message.delete().catch((e: unknown) => {
    logger.warn(
      { err: e, userId: message.author.id },
      "Overwatch: failed to delete triggering message — check Manage Messages permission",
    );
    return null;
  });

  const warnLabel =
    trigger.type === "language"
      ? "language"
      : trigger.type === "invite"
        ? "an invite link"
        : "ping usage";

  const warning = await channel
    .send({
      content: `${message.author} — that message was removed for **${warnLabel}**: ${trigger.detail}. Please don't do that again. (${violations}/${OVERWATCH_VIOLATIONS_BEFORE_MUTE} strikes)`,
    })
    .catch((e: unknown) => {
      logger.warn(
        { err: e, channelId: channel.id },
        "Overwatch: failed to send public warning — check Send Messages permission in that channel",
      );
      return null;
    });

  if (warning && "delete" in warning) {
    setTimeout(
      () => warning.delete().catch(() => null),
      OVERWATCH_WARNING_LIFESPAN_MS,
    );
  }

  let muteOutcome = "Not triggered (under strike threshold)";
  if (violations >= OVERWATCH_VIOLATIONS_BEFORE_MUTE) {
    try {
      const until = new Date(Date.now() + OVERWATCH_MUTE_DURATION_MIN * 60_000);
      await message.member.disableCommunicationUntil(
        until,
        `Overwatch Mode — ${violations} violations`,
      );
      overwatchViolations.set(key, 0);
      muteOutcome = `✅ Muted for ${OVERWATCH_MUTE_DURATION_MIN} minutes`;
      logger.info(
        { userId: message.author.id, guildId: guild.id },
        "Overwatch: escalation mute applied",
      );
    } catch (e) {
      muteOutcome =
        "❌ Mute FAILED — check bot role position / Moderate Members permission";
      logger.warn(
        { err: e, userId: message.author.id },
        "Overwatch escalation mute failed — check bot permissions/role position",
      );
    }
  }

  const logEntries = overwatchLog.get(key) ?? [];
  logEntries.push({
    timestamp: Date.now(),
    type: trigger.type,
    detail: trigger.detail,
    content: message.content.slice(0, 300),
    punishment:
      violations >= OVERWATCH_VIOLATIONS_BEFORE_MUTE
        ? muteOutcome
        : "Warned only",
  });
  if (logEntries.length > 50) logEntries.shift();
  overwatchLog.set(key, logEntries);

  // Log — full record goes to the owner channel, now with explicit
  // failure visibility instead of failing silently.
  const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logId) {
    logger.warn(
      "Overwatch: DISCORD_OWNER_LOG_CHANNEL_ID is not set — trigger was handled but not logged anywhere",
    );
  } else {
    const ch = await message.client.channels
      .fetch(logId)
      .catch((e: unknown) => {
        logger.warn(
          { err: e, logId },
          "Overwatch: could not fetch owner log channel",
        );
        return null;
      });
    if (!ch || !ch.isTextBased() || !("send" in ch)) {
      logger.warn(
        { logId },
        "Overwatch: owner log channel not found or not text-based/writable",
      );
    } else {
      const embed = new EmbedBuilder()
        .setTitle("🕶️ OVERWATCH MODE — TRIGGER LOGGED")
        .setColor(FIRE_ORANGE)
        .addFields(
          {
            name: "USER",
            value: `${message.author.tag} (${message.author.id})`,
            inline: true,
          },
          { name: "CHANNEL", value: `<#${channel.id}>`, inline: true },
          { name: "TYPE", value: trigger.type, inline: true },
          { name: "DETAIL", value: trigger.detail },
          { name: "STRIKE COUNT", value: String(violations), inline: true },
          {
            name: "MESSAGE DELETED",
            value: deleted ? "✅ Yes" : "❌ Failed",
            inline: true,
          },
          {
            name: "WARNING SENT",
            value: warning ? "✅ Yes" : "❌ Failed",
            inline: true,
          },
          { name: "MUTE STATUS", value: muteOutcome },
          {
            name: "ORIGINAL CONTENT",
            value: message.content.slice(0, 1000) || "_(empty)_",
          },
        )
        .setTimestamp();
      await ch
        .send({ embeds: [embed] })
        .catch((e: unknown) =>
          logger.error(
            { err: e, logId },
            "Overwatch: owner log channel send failed",
          ),
        );
    }
  }
}

/** Builds a per-user violation breakdown for "go into detail" requests. Optionally filtered to one member. */
export function buildOverwatchDetailReport(
  guild: Guild,
  usernameFilter?: string,
): string {
  const prefix = `${guild.id}:`;
  let entries = [...overwatchLog.entries()].filter(([k]) =>
    k.startsWith(prefix),
  );

  if (usernameFilter) {
    const norm = usernameFilter.toLowerCase();
    entries = entries.filter(([k]) => {
      const userId = k.slice(prefix.length);
      const member = guild.members.cache.get(userId);
      return (
        member?.user.username.toLowerCase().includes(norm) ||
        member?.user.globalName?.toLowerCase().includes(norm) ||
        member?.displayName.toLowerCase().includes(norm)
      );
    });
  }

  if (entries.length === 0) {
    return usernameFilter
      ? `No logged violations found for anyone matching "${usernameFilter}", Sir.`
      : "No violations have been logged in this server yet, Sir.";
  }

  const lines: string[] = [];
  for (const [key, log] of entries) {
    const userId = key.slice(prefix.length);
    const member = guild.members.cache.get(userId);
    const label = member ? member.user.tag : `Unknown User (${userId})`;
    lines.push(
      `**${label}** — ${log.length} violation${log.length === 1 ? "" : "s"}`,
    );
    for (const e of log.slice(-10)) {
      const rel = `<t:${Math.floor(e.timestamp / 1000)}:R>`;
      const snippet = e.content
        ? `"${e.content.slice(0, 80)}"`
        : "_(no text — e.g. invite link/ping abuse)_";
      lines.push(`　• [${e.type}] ${snippet} — ${e.punishment} — ${rel}`);
    }
    if (log.length > 10)
      lines.push(`　…and ${log.length - 10} earlier violation(s) not shown`);
  }

  let report = lines.join("\n");
  if (report.length > 1800) {
    report =
      report.slice(0, 1800) +
      "\n…(truncated — ask about a specific user for their full history)";
  }
  return report;
}
