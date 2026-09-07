import { ChannelType, type TextChannel } from "discord.js";
import { sql as drizzleSql } from "drizzle-orm";
import type OpenAI from "openai";
import { RANK_ORDER, getConfiguredIds } from "../../../config";
import { db, memberActivityTable } from "../../../lib/db";
import { writeGenericAuditLog } from "../../auditLog";
import {
  buildOverwatchDetailReport,
  overwatchActiveGuilds,
  overwatchViolations,
} from "../../moderation/overwatch";
import { isProtectedOwner } from "../../permissions";
import {
  setProtocolSilent,
  setStatusRotationPaused,
  triggerStatusRotation,
} from "../../presence";
import { findAnyChannel, findMember, type ToolHandler } from "./shared";

export const moderationToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "ping_everyone",
      description:
        "Send an @everyone ping in the current channel or a specified channel with an optional message.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Optional message to include with the ping.",
          },
          channel_name: {
            type: "string",
            description:
              "Name of the channel to ping in. Leave empty for the current channel.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "kick_member",
      description: "Kick a member from the server.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username, display name, or user ID of the member to kick.",
          },
          reason: { type: "string", description: "Reason for the kick." },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ban_member",
      description: "Ban a member from the server.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username, display name, or user ID of the member to ban.",
          },
          reason: { type: "string", description: "Reason for the ban." },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mute_member",
      description:
        "Timeout (mute) a member in the server for a specified duration.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username, display name, or user ID of the member to mute.",
          },
          duration_minutes: {
            type: "number",
            description: "How long to mute them in minutes.",
          },
          reason: { type: "string", description: "Reason for the mute." },
        },
        required: ["username", "duration_minutes"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unmute_member",
      description:
        "Remove a timeout from a member, restoring their ability to speak.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username, display name, or user ID of the member to unmute.",
          },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "assign_role",
      description: "Assign a role to a member.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Username, display name, or user ID of the member.",
          },
          role_name: {
            type: "string",
            description: "Name of the role to assign.",
          },
        },
        required: ["username", "role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_role",
      description: "Remove a role from a member.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Username, display name, or user ID of the member.",
          },
          role_name: {
            type: "string",
            description: "Name of the role to remove.",
          },
        },
        required: ["username", "role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_nickname",
      description: "Change a member's server nickname.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Username, display name, or user ID of the member.",
          },
          nickname: {
            type: "string",
            description: "The new nickname to set. Leave empty to reset.",
          },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "activate_protocol_silent",
      description:
        "Activates Protocol Silent — locks down every text channel in the server so no one can send messages.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "deactivate_protocol_silent",
      description:
        "Deactivates Protocol Silent — restores send permissions to all text channels.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lock_channel",
      description:
        "Locks a specific channel so members cannot send messages in it. Only invoke when the user explicitly says 'channel' or is clearly referring to a channel, not a person.",
      parameters: {
        type: "object",
        properties: {
          channel_name: {
            type: "string",
            description: "Name of the channel to lock.",
          },
        },
        required: ["channel_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unlock_channel",
      description:
        "Unlocks a specific channel so members can send messages in it again. Only invoke when the user explicitly says 'channel' or is clearly referring to a channel, not a person.",
      parameters: {
        type: "object",
        properties: {
          channel_name: {
            type: "string",
            description: "Name of the channel to unlock.",
          },
        },
        required: ["channel_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "activate_overwatch_mode",
      description:
        "Activates Overwatch Mode — silent automod monitoring for filtered language, invite links, and ping abuse in this server. Violating messages are deleted and the sender warned automatically, with full detail logged silently to the owner channel.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "deactivate_overwatch_mode",
      description:
        "Deactivates Overwatch Mode for this server. Automated monitoring stops.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_overwatch_status",
      description:
        "Reports whether Overwatch Mode is currently active in this server, and how many tracked violations have accrued since activation.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_overwatch_detail",
      description:
        "Returns a full, per-user breakdown of Overwatch Mode violations in this server: what each user said or did, how many times, and what punishment (warning or mute) was applied each time. Use this when asked to 'go into detail', 'give the full log', 'break it down', or similar. Can optionally be scoped to one member.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Optional. If provided, only show the log for this specific member.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "purge_messages",
      description:
        "Bulk-deletes the most recent N messages (max 100, Discord only allows deleting messages under 14 days old) from a channel. Advisor and above only.",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of messages to delete, 1-100.",
          },
          channel_name: {
            type: "string",
            description: "Leave empty for the current channel.",
          },
        },
        required: ["count"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "move_voice_member",
      description:
        "Moves a member currently in a voice channel to a different voice channel.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string" },
          channel_name: { type: "string" },
        },
        required: ["username", "channel_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "server_mute_member",
      description:
        "Server voice-mutes or unmutes a member (distinct from a timeout).",
      parameters: {
        type: "object",
        properties: { username: { type: "string" }, mute: { type: "boolean" } },
        required: ["username", "mute"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "server_deafen_member",
      description: "Server voice-deafens or undeafens a member.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string" },
          deafen: { type: "boolean" },
        },
        required: ["username", "deafen"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unban_member",
      description:
        "Removes a ban for a user by username or ID. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { username_or_id: { type: "string" } },
        required: ["username_or_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_bans",
      description: "Lists currently banned users in this server.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "softban_member",
      description:
        "Bans then immediately unbans a member, purging their recent messages without a permanent ban. Advisor and above only.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string" },
          reason: { type: "string" },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "global_ban",
      description:
        "Bans a user from every server Jarvis is currently in. Royalty and above only.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string" },
          reason: { type: "string" },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "acknowledge_breach",
      description:
        "Acknowledges a detected security breach, clears the alarm state, and restores the audit log channel's permissions. Owner/Fire Lord only.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "inactive_purge",
      description:
        "Lists members inactive for X+ days. Advisor and above only. Only pass confirmed:true and actually kick if the user has explicitly asked you to kick them after seeing the list — otherwise just report the list.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number" },
          confirmed: {
            type: "boolean",
            description:
              "Set true only after the user explicitly confirms kicking.",
          },
        },
        required: ["days"],
      },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

// Shared by server_mute_member / server_deafen_member — the original executor
// handled both names in one block and branched on the tool name.
const serverVoiceStateHandler: ToolHandler = async ({
  name,
  args,
  guild,
}) => {
  const target = await findMember(guild, String(args.username ?? ""));
  if (!target)
    return `I could not locate a member matching "${args.username}", Sir.`;
  if (name === "server_mute_member") {
    const muted = await target.voice
      .setMute(Boolean(args.mute))
      .catch(() => null);
    return muted
      ? `${target.user.tag} has been ${args.mute ? "server-muted" : "unmuted"}, Sir.`
      : `❌ I was unable to ${args.mute ? "server-mute" : "unmute"} ${target.user.tag}, Sir — they may not be in a voice channel, or I lack the Mute Members permission.`;
  }
  const deafened = await target.voice
    .setDeaf(Boolean(args.deafen))
    .catch(() => null);
  return deafened
    ? `${target.user.tag} has been ${args.deafen ? "server-deafened" : "undeafened"}, Sir.`
    : `❌ I was unable to ${args.deafen ? "server-deafen" : "undeafen"} ${target.user.tag}, Sir — they may not be in a voice channel, or I lack the Deafen Members permission.`;
};

export const moderationToolHandlers: Record<string, ToolHandler> = {
  ping_everyone: async ({ args, message, guild }) => {
    const content = `@everyone${args.message ? ` ${args.message}` : ""}`;
    if (args.channel_name) {
      const ch = guild.channels.cache.find(
        (c) =>
          c.isTextBased() &&
          c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
      ) as TextChannel | undefined;
      if (!ch)
        return `I could not find a channel named "${args.channel_name}", Sir.`;
      await ch.send({ content, allowedMentions: { parse: ["everyone"] } });
      return `@everyone ping sent to #${ch.name}, Sir.`;
    }
    const ch = message.channel as TextChannel;
    await ch.send({ content, allowedMentions: { parse: ["everyone"] } });
    return "@everyone ping sent, Sir.";
  },

  kick_member: async ({ args, message, guild, actorRank, ownerIds, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (isProtectedOwner(actorRank, target.id, ownerIds))
      return "I cannot perform that action on the Owner, Sir.";
    await target.kick(reason);
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MEMBER KICKED (conversational)",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        {
          name: "REASON",
          value: String(args.reason ?? "No reason provided."),
        },
      ],
      message.author.tag,
    );
    return `${target.user.tag} has been removed from the server, Sir.`;
  },

  ban_member: async ({ args, message, guild, actorRank, ownerIds, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (isProtectedOwner(actorRank, target.id, ownerIds))
      return "I cannot perform that action on the Owner, Sir.";
    await target.ban({ reason, deleteMessageSeconds: 0 });
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MEMBER BANNED (conversational)",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        {
          name: "REASON",
          value: String(args.reason ?? "No reason provided."),
        },
      ],
      message.author.tag,
    );
    return `${target.user.tag} has been permanently banned, Sir.`;
  },

  mute_member: async ({ args, message, guild, actorRank, ownerIds, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (isProtectedOwner(actorRank, target.id, ownerIds))
      return "I cannot perform that action on the Owner, Sir.";
    const durationMs = Number(args.duration_minutes) * 60 * 1000;
    const until = new Date(Date.now() + durationMs);
    await target.disableCommunicationUntil(until, reason);
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MEMBER MUTED (conversational)",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        { name: "DURATION", value: `${args.duration_minutes} minute(s)` },
        {
          name: "REASON",
          value: String(args.reason ?? "No reason provided."),
        },
      ],
      message.author.tag,
    );
    return `${target.user.tag} has been muted for ${args.duration_minutes} minute${Number(args.duration_minutes) === 1 ? "" : "s"}, Sir.`;
  },

  unmute_member: async ({ args, guild, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    await target.disableCommunicationUntil(null, reason);
    return `${target.user.tag}'s timeout has been lifted, Sir.`;
  },

  assign_role: async ({ args, message, guild, actorRank, ownerIds, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (isProtectedOwner(actorRank, target.id, ownerIds))
      return "I cannot perform that action on the Owner, Sir.";
    const role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === String(args.role_name).toLowerCase(),
    );
    if (!role)
      return `I could not find a role named "${args.role_name}", Sir.`;
    await target.roles.add(role, reason);
    await writeGenericAuditLog(
      message.client,
      "JARVIS // ROLE ASSIGNED (conversational)",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        { name: "ROLE", value: role.name },
      ],
      message.author.tag,
    );
    return `The "${role.name}" role has been assigned to ${target.user.tag}, Sir.`;
  },

  remove_role: async ({ args, message, guild, actorRank, ownerIds, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (isProtectedOwner(actorRank, target.id, ownerIds))
      return "I cannot perform that action on the Owner, Sir.";
    const role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === String(args.role_name).toLowerCase(),
    );
    if (!role)
      return `I could not find a role named "${args.role_name}", Sir.`;
    await target.roles.remove(role, reason);
    await writeGenericAuditLog(
      message.client,
      "JARVIS // ROLE REMOVED (conversational)",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        { name: "ROLE", value: role.name },
      ],
      message.author.tag,
    );
    return `The "${role.name}" role has been removed from ${target.user.tag}, Sir.`;
  },

  set_nickname: async ({ args, guild, reason }) => {
    const target = await findMember(guild, String(args.username));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const nick = args.nickname ? String(args.nickname) : null;
    await target.setNickname(nick, reason);
    return nick
      ? `${target.user.tag}'s nickname has been set to "${nick}", Sir.`
      : `${target.user.tag}'s nickname has been reset, Sir.`;
  },

  activate_protocol_silent: async ({ message, guild }) => {
    const everyoneRole = guild.roles.everyone;
    const channels = guild.channels.cache.filter(
      (c) =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement,
    ) as Map<string, TextChannel>;
    let count = 0;
    for (const [, ch] of channels) {
      try {
        await ch.permissionOverwrites.edit(everyoneRole, {
          SendMessages: false,
        });
        count++;
      } catch {
        /* skip channels bot can't edit */
      }
    }
    setProtocolSilent(true, guild.id);
    setStatusRotationPaused(true);
    message.client.user.setActivity("🔒 Protocol Silent — Server Locked");
    return `Protocol Silent activated, Sir. ${count} channel${count === 1 ? "" : "s"} locked.`;
  },

  deactivate_protocol_silent: async ({ guild }) => {
    const everyoneRole = guild.roles.everyone;
    const channels = guild.channels.cache.filter(
      (c) =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement,
    ) as Map<string, TextChannel>;
    let count = 0;
    for (const [, ch] of channels) {
      try {
        await ch.permissionOverwrites.edit(everyoneRole, {
          SendMessages: null,
        });
        count++;
      } catch {
        /* skip */
      }
    }
    setProtocolSilent(false, null);
    setStatusRotationPaused(false);
    triggerStatusRotation();
    return `Protocol Silent deactivated, Sir. ${count} channel${count === 1 ? "" : "s"} restored.`;
  },

  lock_channel: async ({ args, guild }) => {
    const target = guild.channels.cache.find(
      (c) =>
        (c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement) &&
        c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
    ) as TextChannel | undefined;
    if (!target)
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
    });
    return `#${target.name} has been locked, Sir.`;
  },

  unlock_channel: async ({ args, guild }) => {
    const target = guild.channels.cache.find(
      (c) =>
        (c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement) &&
        c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
    ) as TextChannel | undefined;
    if (!target)
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: null,
    });
    return `#${target.name} has been unlocked, Sir.`;
  },

  activate_overwatch_mode: async ({ guild }) => {
    overwatchActiveGuilds.add(guild.id);
    return "Overwatch Mode engaged, Sir. I will monitor silently and act on filtered language, invite links, and ping abuse without further prompting.";
  },

  deactivate_overwatch_mode: async ({ guild }) => {
    overwatchActiveGuilds.delete(guild.id);
    return "Overwatch Mode disengaged, Sir. Automated monitoring is off.";
  },

  get_overwatch_status: async ({ guild }) => {
    const active = overwatchActiveGuilds.has(guild.id);
    const totalViolations = [...overwatchViolations.entries()]
      .filter(([k]) => k.startsWith(`${guild.id}:`))
      .reduce((sum, [, v]) => sum + v, 0);
    return active
      ? `Overwatch Mode is currently **ON**, Sir. ${totalViolations} tracked violation${totalViolations === 1 ? "" : "s"} across monitored members since activation.`
      : "Overwatch Mode is currently **OFF**, Sir.";
  },

  get_overwatch_detail: async ({ args, guild }) => {
    const usernameFilter = args.username
      ? String(args.username).trim()
      : undefined;
    return buildOverwatchDetailReport(guild, usernameFilter);
  },

  purge_messages: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const rawCount = Number(args.count);
    if (!Number.isFinite(rawCount) || rawCount < 1)
      return "I need a valid number of messages to delete, Sir.";
    const count = Math.min(100, Math.floor(rawCount));
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("bulkDelete" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const deleted = await target.bulkDelete(count, true).catch(() => null);
    return deleted
      ? `Deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"} from #${target.name}, Sir. (Messages older than 14 days can't be bulk-deleted by Discord's API.)`
      : "❌ Failed to purge messages, Sir — check my Manage Messages permission.";
  },

  move_voice_member: async ({ args, guild }) => {
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (!target.voice.channel)
      return `${target.user.tag} is not currently in a voice channel, Sir.`;
    const destination = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!destination || destination.type !== ChannelType.GuildVoice)
      return `I could not find a voice channel named "${args.channel_name}", Sir.`;
    await target.voice.setChannel(destination.id);
    return `Moved ${target.user.tag} to #${destination.name}, Sir.`;
  },

  server_mute_member: serverVoiceStateHandler,

  server_deafen_member: serverVoiceStateHandler,

  unban_member: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const idOrName = String(args.username_or_id ?? "");
    const bans = await guild.bans.fetch().catch(() => null);
    const ban = bans?.find(
      (b) =>
        b.user.id === idOrName ||
        b.user.username.toLowerCase() === idOrName.toLowerCase() ||
        b.user.tag.toLowerCase() === idOrName.toLowerCase(),
    );
    if (!ban) return `I could not find a ban matching "${idOrName}", Sir.`;
    await guild.bans.remove(
      ban.user.id,
      `Unbanned conversationally by ${message.author.tag}`,
    );
    return `${ban.user.tag} has been unbanned, Sir.`;
  },

  list_bans: async ({ guild }) => {
    const bans = await guild.bans.fetch().catch(() => null);
    if (!bans || bans.size === 0)
      return "There are no active bans in this server, Sir.";
    return `Currently banned, Sir:\n${[...bans.values()]
      .slice(0, 30)
      .map((b) => `• ${b.user.tag} (${b.user.id})`)
      .join("\n")}`;
  },

  softban_member: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const reasonText = `[Jarvis Softban — requested by ${message.author.tag}]${args.reason ? ` ${args.reason}` : ""}`;
    await guild.bans.create(target.id, {
      reason: reasonText,
      deleteMessageSeconds: 7 * 86400,
    });
    await guild.bans.remove(target.id, "Softban cleanup").catch(() => null);
    return `${target.user.tag} has been softbanned — recent messages purged, Sir.`;
  },

  global_ban: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const ownerIdsForGlobal = getConfiguredIds("DISCORD_OWNER_USER_IDS");
    if (isProtectedOwner(actorRank, target.id, ownerIdsForGlobal))
      return "Fire Lord cannot run global actions that affect the Owner, Sir.";
    const reasonText = `[Jarvis Global Ban] ${args.reason ?? "No reason provided."} — by ${message.author.tag}`;
    let success = 0,
      skipped = 0,
      failed = 0;
    for (const g of message.client.guilds.cache.values()) {
      try {
        await g.bans.create(target.id, {
          reason: reasonText,
          deleteMessageSeconds: 0,
        });
        success++;
      } catch (e: unknown) {
        const code = (e as { code?: number }).code;
        if (code === 10007 || code === 10013) skipped++;
        else failed++;
      }
    }
    await writeGenericAuditLog(
      message.client,
      "JARVIS // GLOBAL BAN EXECUTED",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        {
          name: "RESULTS",
          value: `✅ Banned: ${success} | ⏭️ Not found: ${skipped} | ❌ Failed: ${failed}`,
        },
      ],
      message.author.tag,
    );
    return `Global ban complete, Sir — ${success} banned, ${skipped} not found, ${failed} failed.`;
  },

  acknowledge_breach: async ({ message, guild, actorRank }) => {
    if (actorRank !== "owner" && actorRank !== "second")
      return "Access Denied — only the Owner or Fire Lord can silence alarms, Sir.";
    const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
    if (!logChannelId)
      return "❌ I cannot lift the lockdown, Sir — no owner log channel is configured (DISCORD_OWNER_LOG_CHANNEL_ID).";
    const ch = await message.client.channels
      .fetch(logChannelId)
      .catch(() => null);
    if (!ch || !("permissionOverwrites" in ch))
      return "❌ I cannot lift the lockdown, Sir — the configured owner log channel could not be reached.";
    const restored = await (ch as TextChannel).permissionOverwrites
      .edit(guild.roles.everyone, { ViewChannel: null, SendMessages: null })
      .catch(() => null);
    if (restored === null)
      return "❌ I could not restore the channel permissions, Sir — check my Manage Roles/Manage Channels permission there.";
    return `🟢 Lockdown lifted, Sir — breach acknowledged and the channel has been restored.`;
  },

  inactive_purge: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const days = Math.max(1, Number(args.days) || 30);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const allMembers = await guild.members.fetch();
    const nonBotIds = [...allMembers.values()]
      .filter((m) => !m.user.bot)
      .map((m) => m.id);
    const activeRecords = await db
      .select({ userId: memberActivityTable.userId })
      .from(memberActivityTable)
      .where(
        drizzleSql`${memberActivityTable.guildId} = ${guild.id} AND ${memberActivityTable.lastSeenAt} >= ${cutoff}`,
      );
    const activeIds = new Set(activeRecords.map((r) => r.userId));
    const inactiveMembers = nonBotIds
      .filter((id) => !activeIds.has(id))
      .map((id) => allMembers.get(id)!)
      .filter(Boolean);

    if (inactiveMembers.length === 0)
      return `No members found with ${days}+ days of inactivity, Sir.`;

    if (args.confirmed !== true) {
      return `Found **${inactiveMembers.length}** member${inactiveMembers.length === 1 ? "" : "s"} inactive for ${days}+ days, Sir:\n${inactiveMembers
        .slice(0, 30)
        .map((m) => `• ${m.user.tag}`)
        .join("\n")}\n\nSay the word if you'd like me to kick them.`;
    }

    let kicked = 0;
    for (const m of inactiveMembers) {
      try {
        await m.kick(`Inactivity purge — ${days}d — by ${message.author.tag}`);
        kicked++;
      } catch {
        /* skip */
      }
    }
    return `✅ Kicked **${kicked}** inactive member${kicked === 1 ? "" : "s"}, Sir.`;
  },
};
