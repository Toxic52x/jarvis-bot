import type { GuildMember } from "discord.js";
import type OpenAI from "openai";
import { findMember, type ToolHandler } from "../../discord/ai/tools/shared";
import {
  MeritError,
  assertCanAward,
  assertCanManageData,
  assertCanRemove,
  assertCanViewHistory,
  assertNotProtectedOwner,
  assertValidAmount,
  auditAward,
  auditRemoval,
  auditReset,
  fixedMeritAmount,
  getLeaderboard,
  getMemberHistory,
  getMemberTotal,
  meritTypeLabel,
  recordAward,
  recordRemoval,
  resetAllData,
  type MeritType,
} from "./service";

// The conversational (AI chat) equivalent of the /addmerit, /removemerit,
// /merits, /merithistory, and /resetdata slash commands. Every rank check,
// DB write, and audit log call here goes through service.ts — the exact same
// functions the slash-command handlers in commands.ts call — so the rules
// can't drift between the two entry points.

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
        "Reports a specific member's total merit count, or the top-10 leaderboard if no username is given.",
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
    const meritType = String(args.merit_type ?? "") as MeritType;
    const usernames = Array.isArray(args.usernames)
      ? (args.usernames as string[])
      : [];

    try {
      assertCanAward(actorRank, meritType);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }

    if (meritType === "bonus") {
      if (!usernames.length) return "I need at least one member to award, Sir.";
      const amount = Number(args.amount);
      try {
        assertValidAmount(amount);
      } catch (e) {
        return e instanceof MeritError ? `${e.message}, Sir.` : "Invalid amount, Sir.";
      }

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
      try {
        for (const m of resolvedBonus) assertNotProtectedOwner(actorRank, m.id);
      } catch (e) {
        return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
      }

      const recipients = resolvedBonus.map((m) => ({ id: m.id, tag: m.user.tag }));
      await recordAward({
        guildId: guild.id,
        recipients,
        amount,
        proofUrl: "Bonus (conversational)",
        awardedById: message.author.id,
        awardedByTag: message.author.tag,
      });
      await auditAward(message.client, recipients, amount, "Bonus", message.author.tag);

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
    try {
      assertNotProtectedOwner(actorRank, hostMember.id);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }

    const resolvedMembers: GuildMember[] = [];
    for (const u of usernames) {
      const m = await findMember(guild, u);
      if ("error" in m) {
        if (m.error.startsWith("I found multiple")) return m.error;
      } else {
        resolvedMembers.push(m);
      }
    }
    try {
      for (const m of resolvedMembers) assertNotProtectedOwner(actorRank, m.id);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }

    const amount = fixedMeritAmount(meritType as Exclude<MeritType, "bonus">);
    if (!resolvedMembers.some((m) => m.id === hostMember.id))
      resolvedMembers.push(hostMember);

    const recipients = resolvedMembers.map((m) => ({ id: m.id, tag: m.user.tag }));
    await recordAward({
      guildId: guild.id,
      recipients,
      amount,
      proofUrl: `${meritTypeLabel(meritType)} (conversational)`,
      awardedById: message.author.id,
      awardedByTag: message.author.tag,
    });
    await auditAward(
      message.client,
      recipients,
      amount,
      meritType,
      message.author.tag,
    );
    return `Recorded **+${amount}** ${meritType} merit${amount === 1 ? "" : "s"} for **${resolvedMembers.length}** member${resolvedMembers.length === 1 ? "" : "s"} (Host: ${hostMember.user.tag}), Sir — logged for owners.`;
  },

  remove_merit: async ({ args, message, guild, actorRank }) => {
    try {
      assertCanRemove(actorRank);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }
    const target = await findMember(guild, String(args.username ?? ""));
    if ("error" in target) return target.error;
    const amount = Number(args.amount);
    try {
      assertValidAmount(amount);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Invalid amount, Sir.";
    }
    const reasonText = String(args.reason ?? "").trim();
    if (!reasonText) return "I need a reason for the removal, Sir.";
    try {
      assertNotProtectedOwner(actorRank, target.id);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }

    const recipient = { id: target.id, tag: target.user.tag };
    await recordRemoval({
      guildId: guild.id,
      target: recipient,
      amount,
      reason: reasonText,
      awardedById: message.author.id,
      awardedByTag: message.author.tag,
    });
    await auditRemoval(message.client, recipient, amount, reasonText, message.author.tag);
    return `Recorded **-${amount}** merit${amount === 1 ? "" : "s"} for ${target.user.tag}, Sir — logged for owners.`;
  },

  get_merits: async ({ args, guild }) => {
    const usernameArg = args.username ? String(args.username).trim() : "";
    if (usernameArg) {
      const target = await findMember(guild, usernameArg);
      if ("error" in target) return target.error;
      const total = await getMemberTotal(target.id);
      return `${target.user.tag} currently has **${total}** merits, Sir.`;
    }
    const leaderboard = await getLeaderboard(10);
    if (leaderboard.length === 0)
      return "No merits have been recorded yet, Sir.";
    return `Top personnel by merit, Sir:\n${leaderboard.map((e, i) => `${i + 1}. ${e.memberTag} — ${e.total}`).join("\n")}`;
  },

  get_merit_history: async ({ args, message, guild, actorRank }) => {
    try {
      assertCanViewHistory(actorRank);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }
    const usernameArg = args.username ? String(args.username).trim() : "";
    let target: GuildMember = message.member!;
    if (usernameArg) {
      const result = await findMember(guild, usernameArg);
      if ("error" in result) return result.error;
      target = result;
    }
    const history = await getMemberHistory(target.id);
    if (history.length === 0)
      return `No merit history found for ${target.user.tag}, Sir.`;
    return `Full merit history for ${target.user.tag} (${history.length} total), Sir:\n${history.map((a) => `• ${a.amount > 0 ? "+" : ""}${a.amount} — ${a.proofUrl}`).join("\n")}`;
  },

  reset_merit_data: async ({ args, message, guild, actorRank }) => {
    try {
      assertCanManageData(actorRank);
    } catch (e) {
      return e instanceof MeritError ? `${e.message}, Sir.` : "Access Denied, Sir.";
    }
    if (args.confirmed !== true)
      return "This permanently wipes all merit data, Sir. Please confirm explicitly before I proceed.";

    const { entries } = await resetAllData(guild.id);
    await auditReset(message.client, entries, message.author.tag);
    return "✅ All merit data has been reset, Sir. A full backup was logged to the owner channel first.";
  },
};
