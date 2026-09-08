import type OpenAI from "openai";
import { RANK_ORDER, type JarvisRank } from "../../config";
import { escapeRegex } from "../knowledge";
import { LEGACY_TOOL_MIN_RANK, TOOL_MIN_RANK } from "../permissions";
import { logger } from "../../lib/logger";
import { meritToolDefs } from "./tools/meritTools";
import { messageToolDefs } from "./tools/messageTools";
import { miscToolDefs } from "./tools/miscTools";
import { moderationToolDefs } from "./tools/moderationTools";
import { robloxToolDefs } from "./tools/robloxTools";
import { serverToolDefs } from "./tools/serverTools";

// Re-exported for the many call sites that historically imported it from here.
export { findMember } from "./tools/shared";

// Tool definitions for Gemini function calling. Each domain file under
// ./tools/ owns both its schema definitions and its handlers, so adding a new
// tool touches exactly one file.
export const DISCORD_TOOLS = [
  ...moderationToolDefs,
  ...meritToolDefs,
  ...robloxToolDefs,
  ...serverToolDefs,
  ...messageToolDefs,
  ...miscToolDefs,
] satisfies OpenAI.Chat.ChatCompletionTool[];

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

export type MessageToolSelection = {
  tools: OpenAI.Chat.ChatCompletionTool[];
  // True when the message matched a real TOOL_KEYWORDS entry (kick, merit,
  // ban, ...), as opposed to only the always-on CORE_TOOL_NAMES. A keyword
  // match is a strong signal of real intent — the chat handler uses this to
  // force a tool call rather than let the model optionally skip calling one
  // and just narrate a plausible-sounding "done" in plain text instead.
  actionRequested: boolean;
};

export function toolsForMessage(
  rank: JarvisRank,
  userText: string,
): MessageToolSelection {
  const text = userText.toLowerCase();
  const wanted = new Set<string>(CORE_TOOL_NAMES);
  let actionRequested = false;

  for (const [kw, names] of Object.entries(TOOL_KEYWORDS)) {
    if (new RegExp(`\\b${escapeRegex(kw)}s?\\b`, "i").test(text)) {
      actionRequested = true;
      names.forEach((n) => wanted.add(n));
    }
  }

  logger.info(
    { tools: [...wanted], actionRequested },
    "Jarvis: tools sent this turn",
  );

  const tools = DISCORD_TOOLS.filter((t) => {
    if (!wanted.has(t.function.name)) return false;
    const min =
      TOOL_MIN_RANK[t.function.name] ?? LEGACY_TOOL_MIN_RANK[t.function.name];
    return !min || RANK_ORDER[rank] >= RANK_ORDER[min];
  });

  return { tools, actionRequested };
}
