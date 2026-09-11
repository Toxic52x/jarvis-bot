import type { Message } from "discord.js";
import {
  RANK_ORDER,
  getConfiguredIds,
  type JarvisRank,
} from "../../config";
import { meritToolHandlers } from "../../features/merit/aiTools";
import { TOOL_MIN_RANK, LEGACY_TOOL_MIN_RANK } from "../permissions";
import type { ToolHandler } from "./tools/shared";

// Flat dispatch table assembled from each feature's own AI tool handlers.
// A new feature with AI tools adds one spread here.
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  ...meritToolHandlers,
};

// Execute a tool call returned by the AI

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  message: Message,
  actorRank: JarvisRank,
): Promise<string> {
  const guild = message.guild;
  if (!guild) return "I am unable to perform server actions here, Sir.";

  const centralMinRank = TOOL_MIN_RANK[name];
  if (centralMinRank && RANK_ORDER[actorRank] < RANK_ORDER[centralMinRank]) {
    return `Access Denied — ${centralMinRank.charAt(0).toUpperCase() + centralMinRank.slice(1)} and above only, Sir.`;
  }

  const legacyMinRank = LEGACY_TOOL_MIN_RANK[name];
  if (legacyMinRank && RANK_ORDER[actorRank] < RANK_ORDER[legacyMinRank]) {
    return `Access Denied — ${legacyMinRank.charAt(0).toUpperCase() + legacyMinRank.slice(1)} and above only, Sir.`;
  }

  const handler = TOOL_HANDLERS[name];
  if (!handler) return "I do not recognise that directive, Sir.";

  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  const reason = `[Jarvis — requested by ${message.author.tag}]${args.reason ? ` ${args.reason}` : ""}`;

  return handler({ name, args, message, guild, actorRank, ownerIds, reason });
}
