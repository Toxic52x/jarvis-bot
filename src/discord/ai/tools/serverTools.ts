import { ChannelType, type TextChannel } from "discord.js";
import type OpenAI from "openai";
import { RANK_ORDER } from "../../../config";
import { findAnyChannel, findRole, type ToolHandler } from "./shared";

export const serverToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "set_avatar",
      description:
        "Changes the bot's own profile picture to the image at the given URL.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Direct URL to the image (png, jpg, gif).",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_username",
      description: "Changes the bot's own username.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "The new username for the bot.",
          },
        },
        required: ["username"],
      },
    },
  },

  // ── Roles ────────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_role",
      description:
        "Creates a new Discord role with no elevated permissions. Use this for HR/Advisor/Royalty as well as any arbitrary custom role name.",
      parameters: {
        type: "object",
        properties: {
          role_name: { type: "string" },
          color: {
            type: "string",
            description: "Optional hex color like '#f97316'.",
          },
          hoist: {
            type: "boolean",
            description:
              "Optional — display role members separately in the member list.",
          },
          mentionable: { type: "boolean" },
        },
        required: ["role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_role",
      description: "Deletes a role by name. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { role_name: { type: "string" } },
        required: ["role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_role",
      description:
        "Edits an existing role's color, hoist, or mentionable settings. Royalty and above only.",
      parameters: {
        type: "object",
        properties: {
          role_name: { type: "string" },
          color: {
            type: "string",
            description: "Optional hex color like '#f97316'.",
          },
          hoist: { type: "boolean" },
          mentionable: { type: "boolean" },
          new_name: {
            type: "string",
            description: "Optional — rename the role.",
          },
        },
        required: ["role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_roles",
      description: "Lists every role in the server with member counts.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // ── Channels ─────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_channel",
      description:
        "Creates a new text or voice channel, optionally inside a category.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          channel_type: { type: "string", enum: ["text", "voice"] },
          category_name: {
            type: "string",
            description: "Optional existing category to place it in.",
          },
        },
        required: ["name", "channel_type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_channel",
      description: "Deletes a channel by name. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { channel_name: { type: "string" } },
        required: ["channel_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_category",
      description: "Creates a new channel category.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rename_channel",
      description: "Renames an existing channel.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          new_name: { type: "string" },
        },
        required: ["channel_name", "new_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_channel_topic",
      description: "Sets a text channel's topic.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          topic: { type: "string" },
        },
        required: ["channel_name", "topic"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_slowmode",
      description:
        "Sets slowmode (rate limit per user) on a text channel, in seconds. 0 disables it.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          seconds: { type: "number" },
        },
        required: ["channel_name", "seconds"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_channel_nsfw",
      description: "Toggles a text channel's age-restricted (NSFW) flag.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          nsfw: { type: "boolean" },
        },
        required: ["channel_name", "nsfw"],
      },
    },
  },

  // ── Threads ──────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_thread",
      description:
        "Creates a new thread in a text channel, optionally with a starting message.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          thread_name: { type: "string" },
          message: {
            type: "string",
            description: "Optional first message to post in the thread.",
          },
        },
        required: ["channel_name", "thread_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "archive_thread",
      description: "Archives a thread by name.",
      parameters: {
        type: "object",
        properties: { thread_name: { type: "string" } },
        required: ["thread_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lock_thread",
      description:
        "Locks a thread by name so only moderators can unarchive/reply.",
      parameters: {
        type: "object",
        properties: { thread_name: { type: "string" } },
        required: ["thread_name"],
      },
    },
  },

  // ── Voice ────────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_stage_channel",
      description: "Creates a new stage channel, optionally inside a category.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          category_name: { type: "string" },
        },
        required: ["name"],
      },
    },
  },

  // ── Server settings ──────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "rename_server",
      description: "Renames the server. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_server_icon",
      description:
        "Sets the server icon from an image URL. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_afk_channel",
      description:
        "Sets the server's AFK voice channel and timeout. Royalty and above only.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          timeout_minutes: {
            type: "number",
            description: "One of 1, 5, 15, 30, 60.",
          },
        },
        required: ["channel_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_system_channel",
      description:
        "Sets which text channel receives join/boost system messages. Royalty and above only.",
      parameters: {
        type: "object",
        properties: { channel_name: { type: "string" } },
        required: ["channel_name"],
      },
    },
  },

  // ── Invites ──────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_invite",
      description: "Creates an invite link for a channel.",
      parameters: {
        type: "object",
        properties: {
          channel_name: {
            type: "string",
            description: "Leave empty for the current channel.",
          },
          max_uses: { type: "number", description: "0 for unlimited." },
          expires_hours: { type: "number", description: "0 for never." },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_invites",
      description: "Lists all active invite links for the server.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "revoke_invite",
      description: "Revokes an invite by its code.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
  },

  // ── Emoji ────────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_emoji",
      description: "Uploads a new custom server emoji from an image URL.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, url: { type: "string" } },
        required: ["name", "url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_emoji",
      description: "Deletes a custom server emoji by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },

  // ── Webhooks ─────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_webhook",
      description: "Creates a webhook in a text channel and returns its URL.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string" },
          name: { type: "string" },
        },
        required: ["channel_name", "name"],
      },
    },
  },

  // ── Scheduled events ─────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "create_scheduled_event",
      description:
        "Creates a server scheduled event (external or tied to a voice/stage channel).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          minutes_from_now: {
            type: "number",
            description: "When the event starts.",
          },
          duration_minutes: { type: "number", description: "Default 60." },
          description: { type: "string" },
          channel_name: {
            type: "string",
            description: "Optional voice/stage channel to tie the event to.",
          },
          location: {
            type: "string",
            description:
              "Optional, used if no channel_name is given (external event).",
          },
        },
        required: ["name", "minutes_from_now"],
      },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

// Shared by archive_thread / lock_thread — the original executor handled both
// names in one block and branched on the tool name.
const threadStateHandler: ToolHandler = async ({ name, args, guild }) => {
  const threadName = String(args.thread_name ?? "").toLowerCase();
  const allThreads = await guild.channels.fetchActiveThreads().catch(() => null);
  const thread = allThreads?.threads.find(
    (t) => t.name.toLowerCase() === threadName,
  );
  if (!thread)
    return `I could not find an active thread named "${args.thread_name}", Sir.`;
  if (name === "lock_thread") {
    await thread.setLocked(true).catch(() => null);
    await thread.setArchived(true).catch(() => null);
    return `Locked and archived the "${thread.name}" thread, Sir.`;
  }
  await thread.setArchived(true).catch(() => null);
  return `Archived the "${thread.name}" thread, Sir.`;
};

export const serverToolHandlers: Record<string, ToolHandler> = {
  set_avatar: async ({ args, message }) => {
    const url = String(args.url ?? "");
    if (!url) return "No image URL provided, Sir.";
    try {
      await message.client.user.setAvatar(url);
      return "Avatar updated, Sir.";
    } catch {
      return "I was unable to update my avatar, Sir. Discord may be rate-limiting avatar changes — try again in a few minutes.";
    }
  },

  set_username: async ({ args, message }) => {
    const username = String(args.username ?? "").trim();
    if (!username) return "No username provided, Sir.";
    try {
      await message.client.user.setUsername(username);
      return `Username updated to "${username}", Sir.`;
    } catch {
      return "I was unable to update my username, Sir. Discord rate-limits username changes — please wait a while before trying again.";
    }
  },

  create_role: async ({ args, message, guild }) => {
    const roleName = String(args.role_name ?? "").trim();
    if (!roleName) return "I need a role name, Sir.";
    const existing = findRole(guild, roleName);
    if (existing) return `The "${existing.name}" role already exists, Sir.`;
    const role = await guild.roles.create({
      name: roleName,
      color: args.color ? (String(args.color) as `#${string}`) : undefined,
      hoist: typeof args.hoist === "boolean" ? args.hoist : undefined,
      mentionable:
        typeof args.mentionable === "boolean" ? args.mentionable : undefined,
      permissions: [],
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created the "${role.name}" role with no elevated permissions, Sir.`;
  },

  delete_role: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const role = findRole(guild, String(args.role_name ?? ""));
    if (!role) return `I could not find a role named "${args.role_name}", Sir.`;
    const roleName = role.name;
    await role.delete(`Deleted conversationally by ${message.author.tag}`);
    return `The "${roleName}" role has been deleted, Sir.`;
  },

  edit_role: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const role = findRole(guild, String(args.role_name ?? ""));
    if (!role) return `I could not find a role named "${args.role_name}", Sir.`;
    await role.edit({
      name: args.new_name ? String(args.new_name) : undefined,
      color: args.color ? (String(args.color) as `#${string}`) : undefined,
      hoist: typeof args.hoist === "boolean" ? args.hoist : undefined,
      mentionable:
        typeof args.mentionable === "boolean" ? args.mentionable : undefined,
      reason: `Edited conversationally by ${message.author.tag}`,
    });
    return `The "${role.name}" role has been updated, Sir.`;
  },

  list_roles: async ({ guild }) => {
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.name !== "@everyone")
      .sort((a, b) => b.position - a.position);
    if (roles.length === 0) return "No custom roles exist in this server, Sir.";
    return `Roles in this server, Sir:\n${roles
      .map(
        (r) =>
          `• ${r.name} — ${r.members.size} member${r.members.size === 1 ? "" : "s"}`,
      )
      .join("\n")
      .slice(0, 1800)}`;
  },

  create_channel: async ({ args, message, guild }) => {
    const catName = args.category_name ? String(args.category_name) : "";
    const parent = catName
      ? guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name.toLowerCase() === catName.toLowerCase(),
        )
      : undefined;
    const type =
      args.channel_type === "voice"
        ? ChannelType.GuildVoice
        : ChannelType.GuildText;
    const created = await guild.channels.create({
      name: String(args.name ?? "new-channel"),
      type,
      parent: parent?.id,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created ${args.channel_type === "voice" ? "voice channel" : "channel"} "${created.name}", Sir.`;
  },

  delete_channel: async ({ args, message, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!target)
      return `I could not find a channel named "${args.channel_name}", Sir.`;
    const channelName = target.name;
    await target
      .delete(`Deleted conversationally by ${message.author.tag}`)
      .catch(() => null);
    return `The "${channelName}" channel has been deleted, Sir.`;
  },

  create_category: async ({ args, message, guild }) => {
    const created = await guild.channels.create({
      name: String(args.name ?? "New Category"),
      type: ChannelType.GuildCategory,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created the "${created.name}" category, Sir.`;
  },

  rename_channel: async ({ args, guild }) => {
    const target = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!target || !("setName" in target))
      return `I could not find a channel named "${args.channel_name}", Sir.`;
    const oldName = target.name;
    await (target as TextChannel).setName(String(args.new_name ?? oldName));
    return `Renamed #${oldName} to #${args.new_name}, Sir.`;
  },

  set_channel_topic: async ({ args, guild }) => {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("setTopic" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.setTopic(String(args.topic ?? ""));
    return `Updated the topic for #${target.name}, Sir.`;
  },

  set_slowmode: async ({ args, guild }) => {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("setRateLimitPerUser" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const seconds = Math.max(0, Math.min(21600, Number(args.seconds) || 0));
    await target.setRateLimitPerUser(seconds);
    return seconds > 0
      ? `Slowmode set to ${seconds}s in #${target.name}, Sir.`
      : `Slowmode disabled in #${target.name}, Sir.`;
  },

  set_channel_nsfw: async ({ args, guild }) => {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("setNSFW" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.setNSFW(Boolean(args.nsfw));
    return `#${target.name} is now marked ${args.nsfw ? "age-restricted" : "safe for all audiences"}, Sir.`;
  },

  create_thread: async ({ args, message, guild }) => {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("threads" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const thread = await target.threads.create({
      name: String(args.thread_name ?? "New Thread"),
      reason: `Created conversationally by ${message.author.tag}`,
    });
    if (args.message) await thread.send(String(args.message)).catch(() => null);
    return `Created thread "${thread.name}" in #${target.name}, Sir.`;
  },

  archive_thread: threadStateHandler,

  lock_thread: threadStateHandler,

  create_stage_channel: async ({ args, message, guild }) => {
    const catName = args.category_name ? String(args.category_name) : "";
    const parent = catName
      ? guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name.toLowerCase() === catName.toLowerCase(),
        )
      : undefined;
    const created = await guild.channels.create({
      name: String(args.name ?? "Stage"),
      type: ChannelType.GuildStageVoice,
      parent: parent?.id,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created stage channel "${created.name}", Sir.`;
  },

  rename_server: async ({ args, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    await guild.setName(String(args.name ?? guild.name));
    return `Server renamed to "${args.name}", Sir.`;
  },

  set_server_icon: async ({ args, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    await guild.setIcon(String(args.url ?? "")).catch(() => null);
    return "Server icon updated, Sir.";
  },

  set_afk_channel: async ({ args, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!target || target.type !== ChannelType.GuildVoice)
      return `I could not find a voice channel named "${args.channel_name}", Sir.`;
    await guild.setAFKChannel(target.id);
    if (args.timeout_minutes)
      await guild.setAFKTimeout(
        (Number(args.timeout_minutes) * 60) as 60 | 300 | 900 | 1800 | 3600,
      );
    return `AFK channel set to #${target.name}, Sir.`;
  },

  set_system_channel: async ({ args, guild, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target)
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await guild.setSystemChannel(target.id);
    return `System messages channel set to #${target.name}, Sir.`;
  },

  create_invite: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("createInvite" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const maxUses = Number(args.max_uses) || 0;
    const expiresHours = Number(args.expires_hours) || 0;
    const invite = await target.createInvite({
      maxUses,
      maxAge: expiresHours > 0 ? expiresHours * 3600 : 0,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Invite created, Sir: https://discord.gg/${invite.code}`;
  },

  list_invites: async ({ guild }) => {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites || invites.size === 0)
      return "There are no active invites, Sir.";
    return `Active invites, Sir:\n${[...invites.values()]
      .slice(0, 20)
      .map(
        (i) =>
          `• ${i.code} — #${i.channel?.name ?? "unknown"} — ${i.uses ?? 0} uses`,
      )
      .join("\n")}`;
  },

  revoke_invite: async ({ args, message, guild }) => {
    const invites = await guild.invites.fetch().catch(() => null);
    const invite = invites?.find((i) => i.code === String(args.code ?? ""));
    if (!invite)
      return `I could not find an invite with code "${args.code}", Sir.`;
    await invite.delete(`Revoked conversationally by ${message.author.tag}`);
    return `Invite ${args.code} has been revoked, Sir.`;
  },

  create_emoji: async ({ args, message, guild }) => {
    const created = await guild.emojis
      .create({
        name: String(args.name ?? "emoji"),
        attachment: String(args.url ?? ""),
        reason: `Created conversationally by ${message.author.tag}`,
      })
      .catch(() => null);
    return created
      ? `Created emoji "${created.name}", Sir.`
      : "❌ Failed to create the emoji, Sir — check the image URL and format.";
  },

  delete_emoji: async ({ args, message, guild }) => {
    const emojiName = String(args.name ?? "").toLowerCase();
    const emoji = guild.emojis.cache.find(
      (e) => e.name?.toLowerCase() === emojiName,
    );
    if (!emoji) return `I could not find an emoji named "${args.name}", Sir.`;
    await emoji.delete(`Deleted conversationally by ${message.author.tag}`);
    return `Emoji "${args.name}" has been deleted, Sir.`;
  },

  create_webhook: async ({ args, message, guild }) => {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("createWebhook" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const webhook = await target.createWebhook({
      name: String(args.name ?? "Jarvis Webhook"),
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Webhook created in #${target.name}, Sir: ${webhook.url}`;
  },

  create_scheduled_event: async ({ args, message, guild }) => {
    const startAt = new Date(
      Date.now() + Number(args.minutes_from_now) * 60_000,
    );
    const durationMin = Number(args.duration_minutes) || 60;
    const endAt = new Date(startAt.getTime() + durationMin * 60_000);
    const channelName = args.channel_name ? String(args.channel_name) : "";
    const targetChannel = channelName
      ? findAnyChannel(guild, channelName)
      : undefined;

    // Stage → 1, Voice → 2, no channel at all → 3 (External). Anything else
    // (a text channel, a category…) cannot host a scheduled event.
    let entityType: 1 | 2 | 3 = 3;
    if (targetChannel) {
      if (targetChannel.type === ChannelType.GuildStageVoice) entityType = 1;
      else if (targetChannel.type === ChannelType.GuildVoice) entityType = 2;
      else
        return "That's not a voice or stage channel, Sir — scheduled events need one of those.";
    }

    const created = await guild.scheduledEvents
      .create({
        name: String(args.name ?? "Fire Nation Event"),
        scheduledStartTime: startAt,
        scheduledEndTime: endAt,
        privacyLevel: 2, // GuildOnly
        entityType,
        channel: targetChannel?.id,
        entityMetadata: targetChannel
          ? undefined
          : { location: String(args.location ?? "TBD") },
        description: args.description ? String(args.description) : undefined,
        reason: `Created conversationally by ${message.author.tag}`,
      })
      .catch(() => null);
    return created
      ? `Scheduled event "${created.name}" created, starting <t:${Math.floor(startAt.getTime() / 1000)}:R>, Sir.`
      : "❌ Failed to create the scheduled event, Sir.";
  },
};
