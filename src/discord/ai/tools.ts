import type OpenAI from "openai";
import { RANK_ORDER, type JarvisRank } from "../../config";
import { escapeRegex } from "../../features/knowledge/service";
import { meritToolDefs } from "../../features/merit/aiTools";
import { LEGACY_TOOL_MIN_RANK, TOOL_MIN_RANK } from "../permissions";
import { logger } from "../../lib/logger";

// Re-exported for the many call sites that historically imported it from here.
export { findMember } from "./tools/shared";

// Tool definitions for Gemini function calling. Each domain feature owns
// both its schema definitions and its handlers (see features/merit/aiTools.ts),
// so adding a new tool domain touches exactly this one line plus its own file.
export const DISCORD_TOOLS = [
  ...meritToolDefs,
] satisfies OpenAI.Chat.ChatCompletionTool[];

// Always-available core (cheap, frequently used, no rank gate)
export const CORE_TOOL_NAMES = new Set(["get_merits"]);

// Keyword -> tool names. Add entries as needed; keep them short and specific.
export const TOOL_KEYWORDS: Record<string, string[]> = {
  merit: [
    "award_merit",
    "remove_merit",
    "get_merits",
    "get_merit_history",
    "reset_merit_data",
  ],
  bonus: ["award_merit"],
};

export type MessageToolSelection = {
  tools: OpenAI.Chat.ChatCompletionTool[];
  // True when the message matched a real TOOL_KEYWORDS entry (e.g. "merit"),
  // as opposed to only the always-on CORE_TOOL_NAMES. A keyword match is a
  // strong signal of real intent — the chat handler uses this to force a
  // tool call rather than let the model optionally skip calling one and just
  // narrate a plausible-sounding "done" in plain text instead.
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
