import type { GuildMember } from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type OpenAI from "openai";
import { RANK_ORDER, getConfiguredIds } from "../../../config";
import { db, meritAwardsTable } from "../../../lib/db";
import { writeGenericAuditLog } from "../../auditLog";
import { exportAndResetMeritData } from "../../merit/resetData";
import { isProtectedOwner } from "../../permissions";
import { findMember, type ToolHandler } from "./shared";

// ── Merit system ──────────────────────────────────────────────────────────
export const meritToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "award_merit",
      description:
        "Awards merits to one or more members. Use type 'bonus' for one or more named members, each receiving the same 0.1-7 amount (Advisor+ only); use 'exam'/'event' (HR+) or 'raid' (Advisor+ only) with a required host — the person who receives the merit for running it — plus any participant usernames.",
      parameters: {
        type: "object",
        properties: {
          merit_type: {
            type: "string",
            enum: ["exam", "event", "raid", "bonus"],
          },
          usernames: {
            type: "array",
            items: { type: "string" },
            description:
              "Usernames/display names/IDs of participants to award. For 'bonus', all listed members receive the same amount. For 'exam'/'event'/'raid', these are additional participants beyond the host; can be empty if only the host is being credited.",
          },
          host: {
            type: "string",
            description:
              "Required for 'exam'/'event'/'raid' — the username/display name/ID of whoever hosted/ran it. They are the one credited with the merit; Jarvis no longer auto-credits whoever is chatting.",
          },
          amount: {
            type: "number",
            description: "Required only for 'bonus' — amount between 0.1 and 7.",
          },
        },
        required: ["merit_type", "usernames"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_merit",
      description:
        "Deducts merits from a member. Advisor and above only. Requires a reason.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string" },
          amount: { type: "number", description: "0.1-7" },
          reason: { type: "string" },
        },
        required: ["username", "amount", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_merits",
      description:
        "Reports a specific member's total merit count, or the top-30 leaderboard if no username is given.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_merit_history",
      description:
        "Returns a member's 10 most recent merit awards with proof links. HR and above only.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reset_merit_data",
      description:
        "Permanently wipes all merit data after exporting a backup to the owner log channel. DESTRUCTIVE. Owner/Fire Lord only. Only call this with confirmed:true after the user has explicitly confirmed in the conversation that they want to proceed — if they haven't confirmed yet, ask them to confirm first instead of calling this tool.",
      parameters: {
        type: "object",
        properties: {
          confirmed: {
            type: "boolean",
            description:
              "Must be true — only set after explicit user confirmation.",
          },
        },
        required: ["confirmed"],
      },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

export const meritToolHandlers: Record<string, ToolHandler> = {
  award_merit: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const meritType = String(args.merit_type ?? "") as
      | "exam"
      | "event"
      | "raid"
      | "bonus";
    const usernames = Array.isArray(args.usernames)
      ? (args.usernames as string[])
      : [];
    if (
      (meritType === "raid" || meritType === "bonus") &&
      RANK_ORDER[actorRank] < RANK_ORDER.advisor
    )
      return "Only Advisors and above can award Raid or Bonus merits, Sir.";

    const ownerIdsForAward = getConfiguredIds("DISCORD_OWNER_USER_IDS");

    if (meritType === "bonus") {
      if (!usernames.length) return "I need at least one member to award, Sir.";
      const amount = Number(args.amount);
      if (!amount || amount < 0.1 || amount > 7)
        return "Bonus amount must be between 0.1 and 7, Sir.";

      const resolvedBonus: GuildMember[] = [];
      const notFoundBonus: string[] = [];
      const ambiguousBonus: string[] = [];
      for (const u of usernames) {
        const m = await findMember(guild, u);
        if ("error" in m) {
          if (m.error.startsWith("I found multiple")) ambiguousBonus.push(m.error);
          else notFoundBonus.push(u);
        } else {
          resolvedBonus.push(m);
        }
      }
      if (ambiguousBonus.length > 0) return ambiguousBonus.join("\n");
      if (resolvedBonus.length === 0)
        return "I could not locate any of the members you named, Sir.";
      if (
        resolvedBonus.some((m) =>
          isProtectedOwner(actorRank, m.id, ownerIdsForAward),
        )
      )
        return "Fire Lord cannot award merits that affect the Owner, Sir.";

      await db.insert(meritAwardsTable).values(
        resolvedBonus.map((m) => ({
          guildId: guild.id,
          memberId: m.id,
          memberTag: m.user.tag,
          amount,
          proofUrl: "Bonus (conversational)",
          awardedById: message.author.id,
          awardedByTag: message.author.tag,
        })),
      );
      await writeGenericAuditLog(
        message.client,
        "JARVIS // MERIT AWARD AUDIT",
        [
          {
            name: "RECIPIENTS",
            value: resolvedBonus
              .map((m) => `• ${m.user.tag} (+${amount})`)
              .join("\n")
              .slice(0, 1024),
          },
          { name: "TYPE", value: "Bonus (conversational)" },
        ],
        message.author.tag,
      );

      const notFoundNote =
        notFoundBonus.length > 0
          ? ` (${notFoundBonus.length} not found: ${notFoundBonus.join(", ")} — skipped)`
          : "";
      return `Recorded **+${amount}** Bonus merit${amount === 1 ? "" : "s"} for **${resolvedBonus.length}** member${resolvedBonus.length === 1 ? "" : "s"}${notFoundNote}, Sir — logged for owners.`;
    }

    // exam / event / raid — host is required and is the one credited
    const hostQuery = String(args.host ?? "").trim();
    if (!hostQuery)
      return "I need a host for that award, Sir — that's who receives the merit.";
    const hostResult = await findMember(guild, hostQuery);
    if ("error" in hostResult) return hostResult.error;
    const hostMember = hostResult;
    if (isProtectedOwner(actorRank, hostMember.id, ownerIdsForAward))
      return "Fire Lord cannot award merits that affect the Owner, Sir.";

    const resolvedMembers: GuildMember[] = [];
    for (const u of usernames) {
      const m = await findMember(guild, u);
      if ("error" in m) {
        if (m.error.startsWith("I found multiple")) return m.error;
      } else {
        resolvedMembers.push(m);
      }
    }
    if (
      resolvedMembers.some((m) =>
        isProtectedOwner(actorRank, m.id, ownerIdsForAward),
      )
    )
      return "Fire Lord cannot award merits that affect the Owner, Sir.";

    const amount = meritType === "raid" ? 3 : 1;
    if (!resolvedMembers.some((m) => m.id === hostMember.id))
      resolvedMembers.push(hostMember);

    await db.transaction(async (tx) => {
      await tx.insert(meritAwardsTable).values(
        resolvedMembers.map((m) => ({
          guildId: guild.id,
          memberId: m.id,
          memberTag: m.user.tag,
          amount,
          proofUrl: `${meritType[0].toUpperCase()}${meritType.slice(1)} (conversational)`,
          awardedById: message.author.id,
          awardedByTag: message.author.tag,
        })),
      );
    });
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MERIT AWARD AUDIT",
      [
        {
          name: "RECIPIENTS",
          value: resolvedMembers
            .map((m) => `• ${m.user.tag} (+${amount})`)
            .join("\n")
            .slice(0, 1024),
        },
        { name: "TYPE", value: meritType },
        { name: "HOST", value: hostMember.user.tag },
      ],
      message.author.tag,
    );
    return `Recorded **+${amount}** ${meritType} merit${amount === 1 ? "" : "s"} for **${resolvedMembers.length}** member${resolvedMembers.length === 1 ? "" : "s"} (Host: ${hostMember.user.tag}), Sir — logged for owners.`;
  },

  remove_merit: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const target = await findMember(guild, String(args.username ?? ""));
    if ("error" in target) return target.error;
    const amount = Number(args.amount);
    if (!amount || amount < 0.1 || amount > 7)
      return "Amount must be between 0.1 and 7, Sir.";
    const reasonText = String(args.reason ?? "").trim();
    if (!reasonText) return "I need a reason for the removal, Sir.";
    const ownerIdsForRemove = getConfiguredIds("DISCORD_OWNER_USER_IDS");
    if (isProtectedOwner(actorRank, target.id, ownerIdsForRemove))
      return "Fire Lord cannot remove merits from the Owner, Sir.";

    await db.insert(meritAwardsTable).values({
      guildId: guild.id,
      memberId: target.id,
      memberTag: target.user.tag,
      amount: -amount,
      proofUrl: reasonText,
      awardedById: message.author.id,
      awardedByTag: message.author.tag,
    });
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MERIT REMOVAL AUDIT",
      [
        { name: "MEMBER", value: `${target.user.tag} (${target.id})` },
        { name: "AMOUNT REMOVED", value: `-${amount}` },
        { name: "REASON", value: reasonText },
      ],
      message.author.tag,
    );
    return `Recorded **-${amount}** merit${amount === 1 ? "" : "s"} for ${target.user.tag}, Sir — logged for owners.`;
  },

  get_merits: async ({ args, guild }) => {
    const usernameArg = args.username ? String(args.username).trim() : "";
    if (usernameArg) {
      const target = await findMember(guild, usernameArg);
      if ("error" in target) return target.error;
      const [result] = await db
        .select({
          total: sql<number>`coalesce(sum(${meritAwardsTable.amount}), 0)`,
        })
        .from(meritAwardsTable)
        .where(
          and(
            eq(meritAwardsTable.guildId, guild.id),
            eq(meritAwardsTable.memberId, target.id),
          ),
        );
      return `${target.user.tag} currently has **${Number(result?.total ?? 0)}** merits, Sir.`;
    }
    const leaderboard = await db
      .select({
        memberTag: sql<string>`(array_agg(${meritAwardsTable.memberTag} order by ${meritAwardsTable.createdAt} desc))[1]`,
        total: sql<number>`sum(${meritAwardsTable.amount})`,
      })
      .from(meritAwardsTable)
      .where(eq(meritAwardsTable.guildId, guild.id))
      .groupBy(meritAwardsTable.memberId)
      .orderBy(desc(sql`sum(${meritAwardsTable.amount})`))
      .limit(10);
    if (leaderboard.length === 0)
      return "No merits have been recorded yet, Sir.";
    return `Top personnel by merit, Sir:\n${leaderboard.map((e, i) => `${i + 1}. ${e.memberTag} — ${Number(e.total)}`).join("\n")}`;
  },

  get_merit_history: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const usernameArg = args.username ? String(args.username).trim() : "";
    let target: GuildMember = message.member!;
    if (usernameArg) {
      const result = await findMember(guild, usernameArg);
      if ("error" in result) return result.error;
      target = result;
    }
    const history = await db
      .select()
      .from(meritAwardsTable)
      .where(
        and(
          eq(meritAwardsTable.guildId, guild.id),
          eq(meritAwardsTable.memberId, target.id),
        ),
      )
      .orderBy(desc(meritAwardsTable.createdAt));
    if (history.length === 0)
      return `No merit history found for ${target.user.tag}, Sir.`;
    return `Full merit history for ${target.user.tag} (${history.length} total), Sir:\n${history.map((a) => `• ${a.amount > 0 ? "+" : ""}${a.amount} — ${a.proofUrl}`).join("\n")}`;
  },

  reset_merit_data: async ({ args, message, guild, actorRank }) => {
    if (actorRank !== "owner" && actorRank !== "second")
      return "Access Denied — only the Owner or Fire Lord can reset system data, Sir.";
    if (args.confirmed !== true)
      return "This permanently wipes all merit data, Sir. Please confirm explicitly before I proceed.";

    const { backupLines } = await exportAndResetMeritData(
      guild.id,
      message.author.tag,
    );
    await writeGenericAuditLog(
      message.client,
      "JARVIS // SYSTEM DATA BACKUP & RESET EXPORT",
      [{ name: "DATA BACKUP AT RESET", value: backupLines.slice(0, 1024) }],
      message.author.tag,
    );
    return "✅ All merit data has been reset, Sir. A full backup was logged to the owner channel first.";
  },
};
