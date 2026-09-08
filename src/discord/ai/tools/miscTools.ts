import { EmbedBuilder } from "discord.js";
import { appendFileSync } from "node:fs";
import type OpenAI from "openai";
import {
  FIRE_RED,
  GEMINI_DAILY_LIMIT,
  GOOGLE_TPM_LIMIT,
  RANK_ORDER,
  ROYAL_GUARD_CHANNEL_ID,
} from "../../../config";
import { db, remindersTable } from "../../../lib/db";
import { jarvisAccessIds, saveJarvisAccess } from "../../accessList";
import { writeGenericAuditLog } from "../../auditLog";
import { postGuardRequest } from "../../guard";
import {
  KNOWLEDGE_FILE_PATH,
  cachedKnowledge,
  loadKnowledge,
} from "../../knowledge";
import {
  dailyTokensUsed,
  minuteTokensUsed,
  minuteWindowStart,
} from "../geminiClient";
import {
  GUIDE_TIER_ORDER,
  buildCommandGuide,
  buildFullCapabilityGuide,
  type CommandGuideTier,
} from "../systemPrompt";
import { findMember, type ToolHandler } from "./shared";

export const miscToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "get_token_usage",
      description:
        "Returns how many Gemini API tokens have been used today and how many remain out of the daily limit.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_server_status",
      description:
        "Returns current member counts: total members, online members, and optionally how many members hold a specific role.",
      parameters: {
        type: "object",
        properties: {
          role_name: {
            type: "string",
            description:
              "Optional. If provided, also counts how many members hold this specific role (e.g. 'HR', 'Advisor').",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_reminder",
      description:
        "Sets a reminder that Jarvis will deliver to the user via DM after the specified number of minutes.",
      parameters: {
        type: "object",
        properties: {
          minutes_from_now: {
            type: "number",
            description: "How many minutes from now to send the reminder.",
          },
          message: {
            type: "string",
            description: "What to remind the user about.",
          },
        },
        required: ["minutes_from_now", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grant_jarvis_access",
      description:
        "Grants a user standing, persistent access to converse with Jarvis (same as Owner/Fire Lord access). Persists across restarts until revoked. Owner/Fire Lord only.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username, display name, or user ID to grant standing Jarvis access to.",
          },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "revoke_jarvis_access",
      description:
        "Revokes a previously granted user's standing access to converse with Jarvis. Owner/Fire Lord only.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username, display name, or user ID to revoke standing Jarvis access from.",
          },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_jarvis_access_status",
      description:
        "Reports how many users currently hold granted standing access to converse with Jarvis, and lists who they are.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_command_guide",
      description:
        "Returns a full guide listing every slash command available at a given access tier (Member, HR, or Advisor) and what each command does. Use this when asked things like 'what commands do members have access to', 'what can HR do', or 'give me the Advisor command list'.",
      parameters: {
        type: "object",
        properties: {
          tier: {
            type: "string",
            enum: ["member", "hr", "advisor"],
            description:
              "Which access tier to report on. 'member' = base commands everyone has, 'hr' = HR-and-above commands (includes member), 'advisor' = Advisor-and-above commands (includes member + hr).",
          },
        },
        required: ["tier"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_full_capabilities",
      description:
        "Returns a complete list of everything Jarvis can do — every slash command AND every conversational tool — for a given access tier. Use for broad questions like 'what can you do'.",
      parameters: {
        type: "object",
        properties: {
          tier: {
            type: "string",
            enum: ["member", "hr", "advisor", "royalty", "owner"],
            description: "Tier to report on, cumulative down through member.",
          },
        },
        required: ["tier"],
      },
    },
  },

  // ── Members ──────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "get_member_info",
      description:
        "Reports a Discord member's join date, account creation date, and roles.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
    },
  },

  // ── Fire Nation admin tools brought over from slash-only commands ──────────
  {
    type: "function" as const,
    function: {
      name: "royal_guard_alert",
      description:
        "Notifies the Royal Guard channel that a royal is currently in-game and needs escort. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "request_guards",
      description:
        "Posts a guard request with a live RSVP list for an HR exam. HR and above only.",
      parameters: {
        type: "object",
        properties: { when: { type: "string" }, location: { type: "string" } },
        required: ["when", "location"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reload_knowledge_base",
      description:
        "Reloads the Fire Nation knowledge file from disk without restarting Jarvis. HR and above only.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_knowledge_entry",
      description:
        "Appends a new entry to the Fire Nation knowledge base. HR and above only.",
      parameters: {
        type: "object",
        properties: { entry: { type: "string" } },
        required: ["entry"],
      },
    },
  },

  // ── Nicknames & bot server list ─────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "search_nicknames",
      description:
        "Searches this server's members by nickname/display name. Provide a query to filter, or omit it to list everyone who currently has a nickname set.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional. Partial nickname to search for. Leave empty to list all members with a nickname set.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_servers",
      description:
        "Reports how many Discord servers Jarvis is currently active in, and lists each one by name. Use this for questions like 'how many servers are you in' or 'what servers are you in'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

// Shared by get_token_usage / get_server_status — the original executor
// handled both names in one block ("tools that don't need reason") and
// branched on the tool name.
const usageStatusHandler: ToolHandler = async ({ name, args, guild }) => {
  if (name === "get_server_status") {
    const allMembers = await guild.members.fetch();
    const totalMembers = allMembers.filter((m) => !m.user.bot).size;
    const onlineMembers = allMembers.filter(
      (m) =>
        !m.user.bot && m.presence?.status && m.presence.status !== "offline",
    ).size;

    let roleLine = "";
    const roleName = args.role_name ? String(args.role_name).trim() : "";
    if (roleName) {
      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleName.toLowerCase(),
      );
      if (role) {
        const roleMembers = allMembers.filter((m) =>
          m.roles.cache.has(role.id),
        );
        const roleOnline = roleMembers.filter(
          (m) => m.presence?.status && m.presence.status !== "offline",
        ).size;
        roleLine = ` Of those holding the "${role.name}" role: ${roleMembers.size} total, ${roleOnline} currently online.`;
      } else {
        roleLine = ` No role named "${roleName}" was found.`;
      }
    }

    return `${onlineMembers} of ${totalMembers} personnel currently online.${roleLine}`;
  }

  // Only reached when name === "get_token_usage"
  const dailyRemaining = Math.max(0, GEMINI_DAILY_LIMIT - dailyTokensUsed);
  const dailyPct = Math.min(
    100,
    (dailyTokensUsed / GEMINI_DAILY_LIMIT) * 100,
  ).toFixed(1);

  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilDailyReset = midnight.getTime() - now.getTime();
  const hoursUntilReset = Math.floor(msUntilDailyReset / 3_600_000);
  const minsUntilReset = Math.floor((msUntilDailyReset % 3_600_000) / 60_000);

  const nowMs = Date.now();
  const currentMinuteUsed =
    nowMs - minuteWindowStart >= 60_000 ? 0 : minuteTokensUsed;
  const minuteRemaining = Math.max(0, GOOGLE_TPM_LIMIT - currentMinuteUsed);
  const minutePct = Math.min(
    100,
    (currentMinuteUsed / GOOGLE_TPM_LIMIT) * 100,
  ).toFixed(1);
  const secsUntilMinuteReset = Math.max(
    0,
    Math.ceil((60_000 - (nowMs - minuteWindowStart)) / 1000),
  );

  return (
    `Daily: ${dailyTokensUsed.toLocaleString()} / ${GEMINI_DAILY_LIMIT.toLocaleString()} tokens used (${dailyPct}%), ${dailyRemaining.toLocaleString()} remaining — resets in ${hoursUntilReset}h ${minsUntilReset}m.\n` +
    `Per-minute: ${currentMinuteUsed.toLocaleString()} / ${GOOGLE_TPM_LIMIT.toLocaleString()} tokens used this minute (${minutePct}%), ${minuteRemaining.toLocaleString()} remaining — resets in ${secsUntilMinuteReset}s.`
  );
};

// ── Jarvis standing-access grant/revoke ────────────────────────────────────
// Shared by grant_jarvis_access / revoke_jarvis_access — the original executor
// handled both names in one block behind a single Owner/Fire Lord gate and a
// shared target lookup, then branched on the tool name.
const jarvisAccessHandler: ToolHandler = async ({
  name,
  args,
  message,
  guild,
  actorRank,
}) => {
  if (actorRank !== "owner" && actorRank !== "second") {
    return "Only the Owner or Fire Lord may modify Jarvis access, Sir.";
  }
  const usernameArg = String(args.username ?? "").trim();
  if (!usernameArg) return "I need a user to target, Sir.";
  const targetMember = await findMember(guild, usernameArg);
  if ("error" in targetMember) return targetMember.error;

  if (name === "grant_jarvis_access") {
    jarvisAccessIds.add(targetMember.id);
    saveJarvisAccess();
    await writeGenericAuditLog(
      message.client,
      "JARVIS // STANDING ACCESS GRANTED",
      [
        { name: "TARGET", value: `${targetMember.user.tag} (${targetMember.id})` },
        { name: "TOTAL WITH ACCESS", value: String(jarvisAccessIds.size), inline: true },
      ],
      message.author.tag,
    );
    return `${targetMember.user.tag} now has standing access to speak with me, Sir — this persists until revoked. (${jarvisAccessIds.size} total with granted access.)`;
  }
  const had = jarvisAccessIds.delete(targetMember.id);
  saveJarvisAccess();
  if (had) {
    await writeGenericAuditLog(
      message.client,
      "JARVIS // STANDING ACCESS REVOKED",
      [
        { name: "TARGET", value: `${targetMember.user.tag} (${targetMember.id})` },
        { name: "REMAINING WITH ACCESS", value: String(jarvisAccessIds.size), inline: true },
      ],
      message.author.tag,
    );
  }
  return had
    ? `${targetMember.user.tag}'s access has been revoked, Sir. (${jarvisAccessIds.size} remaining with granted access.)`
    : `${targetMember.user.tag} did not have standing access to begin with, Sir.`;
};

export const miscToolHandlers: Record<string, ToolHandler> = {
  get_token_usage: usageStatusHandler,

  get_server_status: usageStatusHandler,

  set_reminder: async ({ args, message }) => {
    const minutes = Number(args.minutes_from_now);
    if (!minutes || minutes <= 0)
      return "I need a valid time for the reminder, Sir.";
    const reminderMsg = String(args.message ?? "").trim();
    if (!reminderMsg) return "I need something to remind you about, Sir.";
    const dueAt = new Date(Date.now() + minutes * 60_000);
    await db
      .insert(remindersTable)
      .values({ userId: message.author.id, message: reminderMsg, dueAt });
    const timeStr = dueAt.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    const label =
      minutes < 60
        ? `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`
        : `${(minutes / 60).toFixed(1).replace(/\.0$/, "")} hour${minutes === 60 ? "" : "s"}`;
    return `Understood, Sir. I will remind you about "${reminderMsg}" in ${label} (at ${timeStr} ET).`;
  },

  grant_jarvis_access: jarvisAccessHandler,

  revoke_jarvis_access: jarvisAccessHandler,

  get_jarvis_access_status: async ({ guild }) => {
    if (jarvisAccessIds.size === 0)
      return "No one currently holds granted access, Sir — only the Owner and Fire Lord may speak with me by default.";
    const names = [...jarvisAccessIds].map((id) => {
      const m = guild.members.cache.get(id);
      return m ? m.user.tag : `Unknown User (${id})`;
    });
    return `${jarvisAccessIds.size} member${jarvisAccessIds.size === 1 ? "" : "s"} currently hold${jarvisAccessIds.size === 1 ? "s" : ""} granted access, Sir: ${names.join(", ")}`;
  },

  get_command_guide: async ({ args }) => {
    const tierArg = String(args.tier ?? "member").toLowerCase();
    if (tierArg !== "member" && tierArg !== "hr" && tierArg !== "advisor") {
      return "I need a valid tier — Member, HR, or Advisor, Sir.";
    }
    return buildCommandGuide(tierArg as CommandGuideTier);
  },

  get_full_capabilities: async ({ args }) => {
    const tierArg = String(
      args.tier ?? "member",
    ).toLowerCase() as CommandGuideTier;
    if (!GUIDE_TIER_ORDER.includes(tierArg)) return "I need a valid tier, Sir.";
    return buildFullCapabilityGuide(tierArg);
  },

  get_member_info: async ({ args, guild }) => {
    const target = await findMember(guild, String(args.username ?? ""));
    if ("error" in target) return target.error;
    const roles = target.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => r.name);
    return (
      `**${target.user.tag}**, Sir:\n` +
      `• Joined server: <t:${Math.floor((target.joinedTimestamp ?? 0) / 1000)}:D>\n` +
      `• Account created: <t:${Math.floor(target.user.createdTimestamp / 1000)}:D>\n` +
      `• Roles: ${roles.length > 0 ? roles.join(", ") : "None"}`
    );
  },

  royal_guard_alert: async ({ args, message, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const ch = await message.client.channels
      .fetch(ROYAL_GUARD_CHANNEL_ID)
      .catch(() => null);
    if (!ch || !ch.isTextBased() || !("send" in ch))
      return "Could not reach the Royal Guard channel, Sir.";
    const embed = new EmbedBuilder()
      .setTitle("🛡️ ROYAL GUARD ALERT")
      .setDescription("A Royal is currently in game and requires escort.")
      .setColor(FIRE_RED)
      .addFields(
        { name: "ROYAL", value: message.author.tag },
        ...(args.location
          ? [{ name: "LOCATION", value: String(args.location) }]
          : []),
      )
      .setTimestamp();
    await ch.send({ content: "@everyone", embeds: [embed] });
    return "Royal Guard has been notified, Sir.";
  },

  request_guards: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const result = await postGuardRequest(
      message.client,
      guild,
      { id: message.author.id, tag: message.author.tag },
      String(args.when ?? "TBD"),
      String(args.location ?? "TBD"),
    );
    return result.ok
      ? "Guard request posted, Sir. I'll DM you privately as people confirm — no one else can see who's RSVP'd."
      : `Could not post the guard request: ${result.error}`;
  },

  reload_knowledge_base: async ({ actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const before = cachedKnowledge.length;
    loadKnowledge();
    return cachedKnowledge.length > 0
      ? `Knowledge base reloaded, Sir. (${before} → ${cachedKnowledge.length} characters)`
      : "Knowledge base reload failed, Sir — the file could not be read.";
  },

  add_knowledge_entry: async ({ args, message, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const entry = String(args.entry ?? "").trim();
    if (!entry) return "I need something to add, Sir.";
    const timestamp = new Date().toISOString();
    appendFileSync(
      KNOWLEDGE_FILE_PATH,
      `\n[Added ${timestamp} by ${message.author.tag}] ${entry}\n`,
      "utf-8",
    );
    loadKnowledge();
    return `Knowledge base updated, Sir. (${cachedKnowledge.length} characters total)`;
  },

  search_nicknames: async ({ args, guild }) => {
    const allMembers = await guild.members.fetch();
    const query = args.query ? String(args.query).trim().toLowerCase() : "";
    const withNicknames = allMembers.filter(
      (m) =>
        !!m.nickname && (!query || m.nickname!.toLowerCase().includes(query)),
    );
    if (withNicknames.size === 0) {
      return query
        ? `No members found with a nickname matching "${query}", Sir.`
        : "No members currently have a nickname set, Sir.";
    }
    const lines = [...withNicknames.values()]
      .slice(0, 50)
      .map((m) => `• ${m.user.tag} — "${m.nickname}"`);
    const extra =
      withNicknames.size > 50
        ? `\n…and ${withNicknames.size - 50} more not shown`
        : "";
    const label = query ? `matching "${query}"` : "with a nickname set";
    return `Members ${label} (${withNicknames.size}), Sir:\n${lines.join("\n")}${extra}`;
  },

  list_servers: async ({ message }) => {
    const guilds = [...message.client.guilds.cache.values()];
    const lines = guilds
      .map((g) => `• ${g.name} (${g.memberCount ?? "?"} members)`)
      .join("\n");
    return `I am currently active in **${guilds.length}** server${guilds.length === 1 ? "" : "s"}, Sir:\n${lines}`;
  },
};
