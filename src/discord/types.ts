import type OpenAI from "openai";

// ─── AI chat ─────────────────────────────────────────────────────────────────

/** Conversation history entry (proper OpenAI message params). */
export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
