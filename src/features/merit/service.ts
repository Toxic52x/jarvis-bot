import { EmbedBuilder } from "discord.js";
import type { Client } from "discord.js";
import { desc, eq, sql } from "drizzle-orm";
import { FIRE_RED, RANK_ORDER, getConfiguredIds, type JarvisRank } from "../../config";
import { db } from "../../lib/db";
import { meritAwardsTable } from "./schema";
import { isProtectedOwner } from "../../discord/permissions";
import { logger } from "../../lib/logger";

/**
 * Merit business logic — the single place rank rules, DB writes, and audit
 * logging live. Both the slash commands (commands.ts) and the AI chat tools
 * (aiTools.ts) call into this file rather than each re-implementing the
 * rules, so a rule only ever needs to change in one place.
 */

export type MeritType = "exam" | "event" | "raid" | "bonus";

export class MeritError extends Error {}

export function meritTypeLabel(type: MeritType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** exam/event = 1, raid = 3. Bonus has no fixed amount — it's user-supplied. */
export function fixedMeritAmount(type: Exclude<MeritType, "bonus">): number {
  return type === "raid" ? 3 : 1;
}

/** Throws if `actorRank` isn't allowed to award this merit type. */
export function assertCanAward(actorRank: JarvisRank, type: MeritType): void {
  if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
    throw new MeritError("Access Denied — HR and above only.");
  if (
    (type === "raid" || type === "bonus") &&
    RANK_ORDER[actorRank] < RANK_ORDER.advisor
  )
    throw new MeritError(
      "Only Advisors and above can award Raid or Bonus merits.",
    );
}

/** Throws if `actorRank` isn't allowed to remove merits. */
export function assertCanRemove(actorRank: JarvisRank): void {
  if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
    throw new MeritError("Access Denied — Advisor and above only.");
}

/** Throws if `actorRank` isn't allowed to view merit history. */
export function assertCanViewHistory(actorRank: JarvisRank): void {
  if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
    throw new MeritError("Access Denied — HR and above only.");
}

/** Throws if `actorRank` isn't the Owner or Fire Lord. */
export function assertCanManageData(actorRank: JarvisRank): void {
  if (actorRank !== "owner" && actorRank !== "second")
    throw new MeritError(
      "Access Denied — only the Owner or Fire Lord can reset system data.",
    );
}

/** The Fire Lord (second-in-command) cannot award/remove merits affecting the Owner. */
export function assertNotProtectedOwner(
  actorRank: JarvisRank,
  targetId: string,
): void {
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  if (isProtectedOwner(actorRank, targetId, ownerIds))
    throw new MeritError(
      "Fire Lord cannot award or remove merits that affect the Owner.",
    );
}

/** Bonus awards and removals both use the same 0.1–7 range. */
export function assertValidAmount(amount: number): void {
  if (!amount || amount < 0.1 || amount > 7)
    throw new MeritError("Amount must be between 0.1 and 7.");
}

export type Recipient = { id: string; tag: string };

export async function recordAward(opts: {
  guildId: string;
  recipients: Recipient[];
  amount: number;
  proofUrl: string;
  awardedById: string;
  awardedByTag: string;
}): Promise<void> {
  logger.info(
    {
      guildId: opts.guildId,
      amount: opts.amount,
      recipients: opts.recipients.length,
      awardedBy: opts.awardedById,
    },
    "Recording merit award",
  );
  await db.insert(meritAwardsTable).values(
    opts.recipients.map((r) => ({
      guildId: opts.guildId,
      memberId: r.id,
      memberTag: r.tag,
      amount: opts.amount,
      proofUrl: opts.proofUrl,
      awardedById: opts.awardedById,
      awardedByTag: opts.awardedByTag,
    })),
  );
}

export async function recordRemoval(opts: {
  guildId: string;
  target: Recipient;
  amount: number;
  reason: string;
  awardedById: string;
  awardedByTag: string;
}): Promise<void> {
  logger.info(
    { guildId: opts.guildId, target: opts.target.id, amount: opts.amount },
    "Recording merit removal",
  );
  await db.insert(meritAwardsTable).values({
    guildId: opts.guildId,
    memberId: opts.target.id,
    memberTag: opts.target.tag,
    amount: -opts.amount,
    proofUrl: opts.reason,
    awardedById: opts.awardedById,
    awardedByTag: opts.awardedByTag,
  });
}

/**
 * Merit is one shared ledger across every server Jarvis is in — not
 * filtered by guildId, by deliberate design (see git history if this looks
 * wrong).
 */
export async function getMemberTotal(memberId: string): Promise<number> {
  const [result] = await db
    .select({
      total: sql<number>`coalesce(sum(${meritAwardsTable.amount}), 0)`,
    })
    .from(meritAwardsTable)
    .where(eq(meritAwardsTable.memberId, memberId));
  return Number(result?.total ?? 0);
}

export type LeaderboardRow = { memberId: string; memberTag: string; total: number };

export async function getLeaderboard(limit?: number): Promise<LeaderboardRow[]> {
  const query = db
    .select({
      memberId: meritAwardsTable.memberId,
      // Grouping by memberId alone (and taking the most recently recorded
      // tag) avoids splitting one person into two leaderboard lines
      // whenever a row's stored tag doesn't match exactly (a Discord
      // username change, or a manually-restored row with a different tag
      // format).
      memberTag: sql<string>`(array_agg(${meritAwardsTable.memberTag} order by ${meritAwardsTable.createdAt} desc))[1]`,
      total: sql<number>`sum(${meritAwardsTable.amount})`,
    })
    .from(meritAwardsTable)
    .groupBy(meritAwardsTable.memberId)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`));
  const rows = limit ? await query.limit(limit) : await query;
  return rows.map((r) => ({ ...r, total: Number(r.total) }));
}

export type MeritHistoryRow = { amount: number; proofUrl: string; createdAt: Date };

export async function getMemberHistory(
  memberId: string,
): Promise<MeritHistoryRow[]> {
  return db
    .select()
    .from(meritAwardsTable)
    .where(eq(meritAwardsTable.memberId, memberId))
    .orderBy(desc(meritAwardsTable.createdAt));
}

/**
 * Deletes every merit record (all servers). Callers are responsible for
 * confirming with the user first — this function does not ask.
 */
export async function resetAllData(
  guildId: string,
): Promise<{ entries: LeaderboardRow[] }> {
  const entries = await getLeaderboard();
  await db.delete(meritAwardsTable);
  logger.info(
    { triggeredFromGuildId: guildId, exported: entries.length },
    "Merit data reset (global — every server's data)",
  );
  return { entries };
}

// ── Audit logging — every merit action is logged here, and only here ──────

async function fetchLogChannel(client: Client) {
  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logChannelId) {
    logger.warn(
      "No DISCORD_OWNER_LOG_CHANNEL_ID configured — action was not logged",
    );
    return null;
  }
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    logger.warn({ logChannelId }, "Owner log channel not found or not writable");
    return null;
  }
  return channel;
}

export async function auditAward(
  client: Client,
  recipients: Recipient[],
  amount: number,
  meritType: string,
  actorTag: string,
): Promise<void> {
  const channel = await fetchLogChannel(client);
  if (!channel) return;

  const memberLines = recipients
    .map((m) => `• ${m.tag} (${m.id}) — **+${amount}**`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // MERIT AWARD AUDIT")
    .setDescription("A merit transaction has been authorized and recorded.")
    .setColor(FIRE_RED)
    .addFields(
      { name: "RECIPIENTS", value: memberLines.slice(0, 1024) },
      {
        name: "MERIT VALUE",
        value: `**+${amount}** merit${amount === 1 ? "" : "s"} per recipient`,
        inline: true,
      },
      { name: "TYPE", value: meritType, inline: true },
      { name: "AUTHORIZED BY", value: actorTag },
    )
    .setFooter({ text: "FIRE NATION • OWNER AUDIT CHANNEL" })
    .setTimestamp();

  await channel
    .send({ embeds: [embed] })
    .catch((e) => logger.error({ err: e }, "Merit award audit log send failed"));

  // Ping @everyone when a Bonus of more than 3 is awarded — flags it for owner review
  if (meritType === "Bonus" && amount > 3) {
    await channel
      .send({
        content: `@everyone — **${actorTag}** has awarded a **+${amount} Bonus**. Owner review requested.`,
        allowedMentions: { parse: ["everyone"] },
      })
      .catch(() => null);
  }
}

export async function auditRemoval(
  client: Client,
  target: Recipient,
  amount: number,
  reason: string,
  actorTag: string,
): Promise<void> {
  const channel = await fetchLogChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // MERIT REMOVAL AUDIT")
    .setDescription("A merit deduction has been authorized and recorded.")
    .setColor(FIRE_RED)
    .addFields(
      { name: "MEMBER", value: `${target.tag} (${target.id})` },
      { name: "AMOUNT REMOVED", value: `**-${amount}**`, inline: true },
      { name: "REASON", value: reason },
      { name: "AUTHORIZED BY", value: actorTag },
    )
    .setFooter({ text: "FIRE NATION • OWNER AUDIT CHANNEL" })
    .setTimestamp();

  await channel
    .send({ embeds: [embed] })
    .catch((e) => logger.error({ err: e }, "Merit removal audit log send failed"));
}

/** Posts the pre-reset backup embed to the owner log channel and returns it (for the caller's own confirmation UI). */
export async function auditReset(
  client: Client,
  entries: LeaderboardRow[],
  executedByTag: string,
): Promise<EmbedBuilder> {
  const richBackupLines =
    entries.length > 0
      ? entries
          .map(
            (e, i) =>
              `\`[ID: ${e.memberId}]\` **#${i + 1}** ${e.memberTag} — **${e.total}** merits`,
          )
          .join("\n")
      : "No data recorded prior to reset.";

  const backupEmbed = new EmbedBuilder()
    .setTitle("JARVIS // SYSTEM DATA BACKUP & RESET EXPORT")
    .setDescription(
      `**DATA BACKUP AT RESET**\n\n${richBackupLines.slice(0, 4000)}`,
    )
    .setColor(FIRE_RED)
    .setFooter({ text: `RESET EXECUTED BY ${executedByTag}` })
    .setTimestamp();

  const channel = await fetchLogChannel(client);
  if (channel) {
    await channel
      .send({ embeds: [backupEmbed] })
      .catch((e) => logger.warn({ err: e }, "Backup send failed"));
  }

  return backupEmbed;
}
