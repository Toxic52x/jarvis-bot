import type { Guild, GuildMember } from "discord.js";
import type OpenAI from "openai";
import { RANK_ORDER, type JarvisRank } from "../../config";
import { escapeRegex } from "../knowledge";
import { LEGACY_TOOL_MIN_RANK, TOOL_MIN_RANK } from "../permissions";
import { logger } from "../../lib/logger";

// Tool definitions for Gemini function calling
export const DISCORD_TOOLS = [
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
  // ── Merit system ──────────────────────────────────────────────────────────
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

  // ── Messages ─────────────────────────────────────────────────────────────
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

  // ── Members ──────────────────────────────────────────────────────────────
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

  // ── Fire Nation admin tools brought over from slash-only commands ──────────
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
      name: "lookup_roblox_account",
      description:
        "Investigates a Roblox username for account-age, social-presence, and alt-account red flags. HR and above only.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
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

  // ── Roblox presence tracking (Fire Lord/Owner only) ─────────────────────────
  {
    type: "function" as const,
    function: {
      name: "track_roblox_user",
      description:
        "Adds a Roblox username to be tracked for joins into the currently-watched experience. Fire Lord/Owner only.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Roblox username to track.",
          },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "untrack_roblox_user",
      description: "Stops tracking a Roblox username. Fire Lord/Owner only.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_roblox_experience",
      description:
        "Sets which Roblox experience Jarvis watches for tracked-user joins, given a roblox.com/games/ link. Fire Lord/Owner only.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "A roblox.com/games/<placeId>/... link.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_roblox_tracking_status",
      description:
        "Reports the currently-watched Roblox experience and every tracked user's current in-game status. Fire Lord/Owner only.",
      parameters: { type: "object", properties: {}, required: [] },
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

// Resolve a member by username, display name, or ID
export async function findMember(
  guild: Guild,
  query: string,
): Promise<GuildMember | null> {
  const mention = query.match(/^<@!?(\d+)>$/);
  if (mention) return guild.members.fetch(mention[1]).catch(() => null);
  if (/^\d+$/.test(query)) return guild.members.fetch(query).catch(() => null);
  const results = await guild.members
    .fetch({ query, limit: 10 })
    .catch(() => null);
  if (!results?.size) return null;
  const norm = query.toLowerCase();
  return (
    results.find(
      (m) =>
        m.user.username.toLowerCase() === norm ||
        m.user.globalName?.toLowerCase() === norm ||
        m.displayName.toLowerCase() === norm,
    ) ??
    results.first() ??
    null
  );
}

// Always-available core (cheap, frequently used, no rank gate)
export const CORE_TOOL_NAMES = new Set([
  "get_merits",
  "get_server_status",
  "get_token_usage",
  "get_command_guide",
  "get_full_capabilities",
]);

// Keyword -> tool names. Add entries as needed; keep them short and specific.
export const TOOL_KEYWORDS: Record<string, string[]> = {
  purge: ["purge_messages", "inactive_purge"],
  "clear messages": ["purge_messages"],
  "delete that": ["delete_message"],
  "delete this": ["delete_message"],
  "delete the message": ["delete_message"],
  "delete his message": ["delete_message"],
  "delete her message": ["delete_message"],
  nickname: ["search_nicknames"],
  nicknames: ["search_nicknames"],
  "how many servers": ["list_servers"],
  "what servers": ["list_servers"],
  "server list": ["list_servers"],
  "server count": ["list_servers"],
  merit: [
    "award_merit",
    "remove_merit",
    "get_merits",
    "get_merit_history",
    "reset_merit_data",
  ],
  bonus: ["award_merit"],
  role: [
    "create_role",
    "delete_role",
    "edit_role",
    "list_roles",
    "assign_role",
    "remove_role",
  ],
  channel: [
    "create_channel",
    "delete_channel",
    "rename_channel",
    "set_channel_topic",
    "set_slowmode",
    "set_channel_nsfw",
    "lock_channel",
    "unlock_channel",
  ],
  kick: ["kick_member", "inactive_purge"],
  ban: ["ban_member", "global_ban", "unban_member", "list_bans"],
  mute: ["mute_member", "unmute_member", "server_mute_member"],
  roblox: [
    "lookup_roblox_account",
    "track_roblox_user",
    "untrack_roblox_user",
    "set_roblox_experience",
    "get_roblox_tracking_status",
  ],
  reminder: ["set_reminder"],
  overwatch: [
    "activate_overwatch_mode",
    "deactivate_overwatch_mode",
    "get_overwatch_status",
    "get_overwatch_detail",
  ],
  guard: ["request_guards", "royal_guard_alert"],
  poll: ["create_poll"],
  invite: ["create_invite", "list_invites", "revoke_invite"],
  emoji: ["create_emoji", "delete_emoji"],
  thread: ["create_thread", "archive_thread", "lock_thread"],
  voice: [
    "move_voice_member",
    "server_mute_member",
    "server_deafen_member",
    "create_stage_channel",
  ],
  reaction: [
    "watch_message_reactions",
    "list_reaction_watches",
    "cancel_reaction_watch",
  ],
  access: [
    "grant_jarvis_access",
    "revoke_jarvis_access",
    "get_jarvis_access_status",
  ],
  silent: ["activate_protocol_silent", "deactivate_protocol_silent"],
  knowledge: ["reload_knowledge_base", "add_knowledge_entry"],
  "who's online": ["get_server_status"],
  "how many online": ["get_server_status"],
  "member count": ["get_server_status"],
  "headcount": ["get_server_status"],
  "token": ["get_token_usage"],
  "quota": ["get_token_usage"],
  "commands": ["get_command_guide", "get_full_capabilities"],
  "what can you do": ["get_command_guide", "get_full_capabilities"],
  "capabilities": ["get_full_capabilities"],
};

export function toolsForMessage(
  rank: JarvisRank,
  userText: string,
): OpenAI.Chat.ChatCompletionTool[] {
  const text = userText.toLowerCase();
  const wanted = new Set<string>();

  for (const [kw, names] of Object.entries(TOOL_KEYWORDS)) {
    if (new RegExp(`\\b${escapeRegex(kw)}s?\\b`, "i").test(text)) {
      names.forEach((n) => wanted.add(n));
    }
  }

  logger.info({ tools: [...wanted] }, "Jarvis: tools sent this turn");

  return DISCORD_TOOLS.filter((t) => {
    if (!wanted.has(t.function.name)) return false;
    const min =
      TOOL_MIN_RANK[t.function.name] ?? LEGACY_TOOL_MIN_RANK[t.function.name];
    return !min || RANK_ORDER[rank] >= RANK_ORDER[min];
  });
}

/** Returns only the tools this rank is actually allowed to call, so we stop
 * paying input tokens for ~70 tool schemas on every single message. */

export function toolsForRank(rank: JarvisRank): OpenAI.Chat.ChatCompletionTool[] {
  return DISCORD_TOOLS.filter((t) => {
    const min =
      TOOL_MIN_RANK[t.function.name] ?? LEGACY_TOOL_MIN_RANK[t.function.name];
    return !min || RANK_ORDER[rank] >= RANK_ORDER[min];
  });
}
