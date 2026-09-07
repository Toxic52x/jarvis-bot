import type { ChatMessage } from "../types";

// Active sessions: userId → conversation history (proper OpenAI message params)
export const activeSessions = new Map<string, ChatMessage[]>();

// Per-user exchange counter — caps how many back-and-forth turns a session allows
export const sessionExchangeCounts = new Map<string, number>();
export const MAX_SESSION_EXCHANGES = Infinity;

// ─── Per-user in-flight guard ─────────────────────────────────────────────────
// Two messages from the same user arriving while the first is still being
// processed used to interleave pushes into the same history array, corrupting
// the tool_calls / tool-response pairing sent to the AI API.

const usersCurrentlyProcessing = new Set<string>();

export function isUserProcessing(userId: string): boolean {
  return usersCurrentlyProcessing.has(userId);
}

export function beginUserProcessing(userId: string): void {
  usersCurrentlyProcessing.add(userId);
}

export function endUserProcessing(userId: string): void {
  usersCurrentlyProcessing.delete(userId);
}

// ─── Dismissal detection ──────────────────────────────────────────────────────

export function isDismissal(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /thank(s|\s+you)/.test(t) ||
    /that'?ll\s+be\s+all/.test(t) ||
    /that'?s\s+all/.test(t) ||
    /good\s*bye/.test(t) ||
    /dismiss(ed)?/.test(t) ||
    /you'?re?\s+(free|dismissed)/.test(t) ||
    /\ball\s+good\b/.test(t)
  );
}

/**
 * Trims history to the cap without ever leaving a dangling 'tool' message
 * whose paired assistant(tool_calls) entry got spliced off. A tool-call turn
 * is 3 messages (user, assistant-with-tool_calls, tool-result); a plain
 * reply turn is 2 (user, assistant). Cutting a fixed 4 can slice mid-turn.
 */
export function trimHistory(history: ChatMessage[]): void {
  while (history.length > 20) {
    const second = history[1] as { role?: string; tool_calls?: unknown } | undefined;
    const cut = second?.role === "assistant" && second.tool_calls ? 3 : 2;
    history.splice(0, cut);
  }
}
