import type { Message, TextChannel } from "discord.js";
import type OpenAI from "openai";
import { writeGenericAuditLog } from "../../auditLog";
import { reactionWatches } from "../../moderation/overwatch";
import { findAnyChannel, findMember, type ToolHandler } from "./shared";

export const messageToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "create_poll",
      description: "Posts a native Discord poll with up to 10 answer options.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "2-10 answer options.",
          },
          channel_name: { type: "string" },
          duration_hours: {
            type: "number",
            description: "How long the poll stays open, default 24, max 768.",
          },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description:
        "Send a message to a specific channel in the server. Only use this when the user explicitly refers to a channel (e.g. 'send to the announcements channel'). Do not use it just because a name matches a channel.",
      parameters: {
        type: "object",
        properties: {
          channel_name: {
            type: "string",
            description: "Name of the channel to send the message to.",
          },
          content: { type: "string", description: "The message to send." },
        },
        required: ["channel_name", "content"],
      },
    },
  },

  // ── Messages ─────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "pin_last_message",
      description:
        "Pins the most recent message in a channel, optionally filtered to one author.",
      parameters: {
        type: "object",
        properties: {
          channel_name: {
            type: "string",
            description: "Leave empty for the current channel.",
          },
          username: {
            type: "string",
            description:
              "Optional — only pin the latest message from this member.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unpin_last_message",
      description: "Unpins the most recently pinned message in a channel.",
      parameters: {
        type: "object",
        properties: { channel_name: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "react_to_last_message",
      description:
        "Adds an emoji reaction to the most recent message in a channel.",
      parameters: {
        type: "object",
        properties: {
          emoji: {
            type: "string",
            description: "A unicode emoji, e.g. '✅' or '🔥'.",
          },
          channel_name: { type: "string" },
        },
        required: ["emoji"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dm_user",
      description: "Sends a direct message to a member on the user's behalf.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string" },
          message: { type: "string" },
        },
        required: ["username", "message"],
      },
    },
  },

  // ── Audit log ────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "query_audit_log",
      description:
        "Retrieves the most recent Discord server audit log entries.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "1-25, default 10." },
        },
        required: [],
      },
    },
  },

  // ── Reaction watching ────────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "watch_message_reactions",
      description:
        "Watches a message and DMs the requester once it accumulates a target number of a specific emoji reaction. Defaults to the most recent message in the given (or current) channel if no message ID is given.",
      parameters: {
        type: "object",
        properties: {
          emoji: {
            type: "string",
            description: "Emoji to watch for, e.g. '✅' or '🔥'.",
          },
          threshold: {
            type: "number",
            description: "Reaction count needed to trigger the notification.",
          },
          channel_name: {
            type: "string",
            description: "Leave empty for the current channel.",
          },
          message_id: {
            type: "string",
            description:
              "Optional message ID/link. Defaults to the latest message.",
          },
        },
        required: ["emoji", "threshold"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_reaction_watches",
      description: "Lists all active reaction watches in this server.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cancel_reaction_watch",
      description:
        "Cancels a reaction watch by message ID, or the most recently created one if omitted.",
      parameters: {
        type: "object",
        properties: { message_id: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_message",
      description:
        "Deletes a single specific message. Defaults to the most recent message in the channel (optionally filtered to one author) if no message ID/link is given. Advisor and above only.",
      parameters: {
        type: "object",
        properties: {
          channel_name: {
            type: "string",
            description: "Leave empty for the current channel.",
          },
          message_id: {
            type: "string",
            description:
              "Optional message ID or link. Defaults to the latest message.",
          },
          username: {
            type: "string",
            description:
              "Optional — only match the latest message if it's from this member. Ignored if message_id is given.",
          },
        },
        required: [],
      },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

export const messageToolHandlers: Record<string, ToolHandler> = {
  create_poll: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("send" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const options = Array.isArray(args.options)
      ? (args.options as string[]).slice(0, 10)
      : [];
    if (options.length < 2)
      return "A poll needs at least 2 answer options, Sir.";
    const durationHours = Math.min(
      768,
      Math.max(1, Number(args.duration_hours) || 24),
    );
    await target.send({
      poll: {
        question: { text: String(args.question ?? "Poll") },
        answers: options.map((text) => ({ text })),
        duration: durationHours,
        allowMultiselect: false,
      },
    } as never);
    return `Poll posted in #${target.name}, Sir.`;
  },

  send_message: async ({ args, guild }) => {
    const ch = guild.channels.cache.find(
      (c) =>
        c.isTextBased() &&
        c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
    ) as TextChannel | undefined;
    if (!ch)
      return `I could not find a channel named "${args.channel_name}", Sir.`;
    await ch.send(String(args.content));
    return `Message sent to #${ch.name}, Sir.`;
  },

  pin_last_message: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const recent = await target.messages.fetch({ limit: 20 });
    const usernameFilter = args.username
      ? String(args.username).toLowerCase()
      : null;
    const toPin = usernameFilter
      ? recent.find(
          (m) =>
            m.author.username.toLowerCase().includes(usernameFilter) ||
            m.author.tag.toLowerCase().includes(usernameFilter),
        )
      : recent.first();
    if (!toPin) return "I could not find a matching message to pin, Sir.";
    const pinnedOk = await toPin.pin().catch(() => null);
    return pinnedOk
      ? `Pinned a message from ${toPin.author.tag} in #${target.name}, Sir.`
      : `❌ I was unable to pin that message in #${target.name}, Sir — check my Manage Messages permission (or whether the pin limit has been reached).`;
  },

  unpin_last_message: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const pinned = await target.messages.fetchPinned();
    const latest = pinned.first();
    if (!latest) return `There are no pinned messages in #${target.name}, Sir.`;
    const unpinnedOk = await latest.unpin().catch(() => null);
    return unpinnedOk
      ? `Unpinned the most recent pin in #${target.name}, Sir.`
      : `❌ I was unable to unpin that message in #${target.name}, Sir — check my Manage Messages permission.`;
  },

  react_to_last_message: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const recent = await target.messages.fetch({ limit: 1 });
    const last = recent.first();
    if (!last) return `There are no messages in #${target.name}, Sir.`;
    const reacted = await last
      .react(String(args.emoji ?? "👍"))
      .catch(() => null);
    return reacted
      ? `Reacted to the latest message in #${target.name}, Sir.`
      : `❌ I was unable to react to that message in #${target.name}, Sir — the emoji may be unavailable to me, or I lack the Add Reactions permission.`;
  },

  dm_user: async ({ args, guild }) => {
    const target = await findMember(guild, String(args.username ?? ""));
    if ("error" in target) return target.error;
    try {
      await target.send(String(args.message ?? ""));
      return `Message sent to ${target.user.tag} via DM, Sir.`;
    } catch {
      return `I was unable to DM ${target.user.tag}, Sir — they likely have DMs disabled.`;
    }
  },

  query_audit_log: async ({ args, guild }) => {
    const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
    const logs = await guild.fetchAuditLogs({ limit }).catch(() => null);
    if (!logs || logs.entries.size === 0)
      return "No audit log entries found, Sir.";
    return `Recent audit log entries, Sir:\n${[...logs.entries.values()]
      .map(
        (e) =>
          `• ${e.actionType} by ${e.executor?.tag ?? "unknown"} — target: ${e.targetId ?? "n/a"}${e.reason ? ` — "${e.reason}"` : ""}`,
      )
      .join("\n")
      .slice(0, 1800)}`;
  },

  watch_message_reactions: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;

    const emoji = String(args.emoji ?? "").trim();
    if (!emoji) return "I need an emoji to watch for, Sir.";
    const rawThreshold = Number(args.threshold);
    if (!Number.isFinite(rawThreshold) || rawThreshold < 1)
      return "I need a valid target reaction count, Sir.";
    const threshold = Math.floor(rawThreshold);

    let targetMessage: Message | undefined;
    const msgIdArg = args.message_id
      ? String(args.message_id).match(/\d+/)?.[0]
      : undefined;
    if (msgIdArg) {
      targetMessage = await target.messages
        .fetch(msgIdArg)
        .catch(() => undefined);
      if (!targetMessage)
        return `I could not find a message with ID "${msgIdArg}" in #${target.name}, Sir.`;
    } else {
      targetMessage = (await target.messages.fetch({ limit: 1 })).first();
      if (!targetMessage)
        return `There are no messages in #${target.name} to watch, Sir.`;
    }

    const key = `${targetMessage.id}:${emoji}`;
    reactionWatches.set(key, {
      guildId: guild.id,
      channelId: target.id,
      messageId: targetMessage.id,
      emoji,
      threshold,
      requesterId: message.author.id,
      createdAt: Date.now(),
    });

    const currentCount = targetMessage.reactions.cache.get(emoji)?.count ?? 0;
    return `Watching that message in #${target.name} for **${threshold}** ${emoji} reactions, Sir. (Currently at ${currentCount}.) I'll DM you the moment it hits the target.`;
  },

  list_reaction_watches: async ({ guild }) => {
    const entries = [...reactionWatches.entries()].filter(
      ([, w]) => w.guildId === guild.id,
    );
    if (entries.length === 0)
      return "No active reaction watches in this server, Sir.";
    return `Active reaction watches, Sir:\n${entries
      .map(
        ([, w]) =>
          `• [${w.messageId}] ${w.emoji} → ${w.threshold} in <#${w.channelId}> (requested by <@${w.requesterId}>)`,
      )
      .join("\n")}`;
  },

  cancel_reaction_watch: async ({ args, guild }) => {
    const msgIdArg = args.message_id
      ? String(args.message_id).match(/\d+/)?.[0]
      : undefined;
    const guildEntries = [...reactionWatches.entries()].filter(
      ([, w]) => w.guildId === guild.id,
    );
    const toCancel = msgIdArg
      ? guildEntries.filter(([, w]) => w.messageId === msgIdArg)
      : guildEntries
          .sort((a, b) => b[1].createdAt - a[1].createdAt)
          .slice(0, 1);
    if (toCancel.length === 0)
      return "I could not find a matching reaction watch to cancel, Sir.";
    for (const [key] of toCancel) reactionWatches.delete(key);
    return `Cancelled ${toCancel.length} reaction watch${toCancel.length === 1 ? "" : "es"}, Sir.`;
  },

  delete_message: async ({ args, message, guild }) => {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;

    let toDelete: Message | undefined;
    const msgIdArg = args.message_id
      ? String(args.message_id).match(/\d+/)?.[0]
      : undefined;

    if (msgIdArg) {
      toDelete = await target.messages.fetch(msgIdArg).catch(() => undefined);
      if (!toDelete)
        return `I could not find a message with ID "${msgIdArg}" in #${target.name}, Sir.`;
    } else {
      const recent = await target.messages.fetch({ limit: 20 });
      const usernameFilter = args.username
        ? String(args.username).toLowerCase()
        : null;
      toDelete = usernameFilter
        ? recent.find(
            (m) =>
              m.author.username.toLowerCase().includes(usernameFilter) ||
              m.author.tag.toLowerCase().includes(usernameFilter),
          )
        : recent.first();
      if (!toDelete)
        return "I could not find a matching message to delete, Sir.";
    }

    const authorTag = toDelete.author.tag;
    const snippet = toDelete.content
      ? toDelete.content.slice(0, 80)
      : "_(no text — embed/attachment)_";
    await toDelete.delete().catch(() => null);

    await writeGenericAuditLog(
      message.client,
      "JARVIS // MESSAGE DELETED (conversational)",
      [
        { name: "AUTHOR", value: authorTag },
        { name: "CHANNEL", value: `#${target.name}` },
        { name: "CONTENT", value: snippet },
      ],
      message.author.tag,
    );

    return `Deleted a message from ${authorTag} in #${target.name}, Sir.`;
  },
};
