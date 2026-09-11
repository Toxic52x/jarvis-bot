import type { Message } from "discord.js";
import { handleAiChat } from "../ai/chat";

/**
 * Top-level MessageCreate dispatcher: every non-bot guild message is handed
 * to the Jarvis conversational handler, which itself gates on standing
 * access (Owner/Fire Lord/granted access) before doing anything further.
 */
export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !message.member) return;
  await handleAiChat(message);
}
