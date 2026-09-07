import type { Message } from "discord.js";
import { DISCORD_MESSAGE_LIMIT } from "../../config";
import {
  JARVIS_SLEEP_PATTERN,
  JARVIS_WAKE_UP_PATTERN,
} from "../../config";
import { jarvisAccessIds } from "../accessList";
import { getJarvisRank } from "../permissions";
import {
  getOfflineAvatarBuffer,
  getOnlineAvatarBuffer,
  isJarvisAsleep,
  isProtocolSilentActive,
  setJarvisAsleep,
  setStatusRotationPaused,
  triggerStatusRotation,
} from "../presence";
import type { ChatMessage } from "../types";
import {
  createCompletionWithRetry,
  isTokenResetScheduled,
  isTransientError,
  notifyTokenReset,
  parseRetryAfterMs,
  setTokenResetScheduled,
  trackTokens,
} from "./geminiClient";
import {
  activeSessions,
  beginUserProcessing,
  endUserProcessing,
  isDismissal,
  isUserProcessing,
  trimHistory,
} from "./session";
import { getSystemPrompt } from "./systemPrompt";
import { executeTool } from "./toolExecutor";
import { toolsForMessage } from "./tools";
import { logger } from "../../lib/logger";

// Deduplication — prevents same message from being processed twice (duplicate Discord events)
export const recentlyProcessed = new Set<string>();

export async function sendChunked(
  message: Message,
  content: string,
): Promise<void> {
  if (content.length <= DISCORD_MESSAGE_LIMIT) {
    await message.reply(content);
    return;
  }
  const lines = content.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (
      (chunk ? chunk.length + 1 + line.length : line.length) >
      DISCORD_MESSAGE_LIMIT
    ) {
      if (chunk) await message.reply(chunk);
      if (line.length > DISCORD_MESSAGE_LIMIT) {
        for (let i = 0; i < line.length; i += DISCORD_MESSAGE_LIMIT) {
          await message.reply(line.slice(i, i + DISCORD_MESSAGE_LIMIT));
        }
        chunk = "";
      } else {
        chunk = line;
      }
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await message.reply(chunk);
}

function buildGreeting(): string {
  // America/New_York handles EST/EDT correctly — a fixed UTC-4 offset used to
  // be off by an hour for roughly four months of the year (EST is UTC-5).
  const hourET =
    Number(
      new Date().toLocaleString("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: "America/New_York",
      }),
    ) % 24; // ICU can format midnight as "24" rather than "0" — normalize it
  const timeGreeting =
    hourET < 5
      ? "Good night"
      : hourET < 12
        ? "Good morning"
        : hourET < 17
          ? "Good afternoon"
          : hourET < 21
            ? "Good evening"
            : "Good night";
  const alertPrefix = isProtocolSilentActive()
    ? "Protocol Silent is active. "
    : "";
  return `${alertPrefix}${timeGreeting}, Sir. How may I assist?`;
}

/**
 * The Jarvis conversational handler. Called by the message-event dispatcher for
 * every non-bot guild message that survived the Overwatch check.
 *
 * A per-user in-flight lock (see ai/session) serialises this: two messages from
 * the same user arriving in quick succession used to interleave their pushes
 * into the same history array, corrupting the tool_calls / tool-result pairing.
 */
export async function handleAiChat(message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !message.member) return;

  // Deduplicate — discard if we already processed this exact message ID
  if (recentlyProcessed.has(message.id)) return;
  recentlyProcessed.add(message.id);
  setTimeout(() => recentlyProcessed.delete(message.id), 30_000);

  const rank = getJarvisRank(message.member);
  // Anyone with granted standing access can converse with Jarvis just like Owner/Fire Lord.
  const hasGrantedAccess = jarvisAccessIds.has(message.author.id);
  if (rank !== "owner" && rank !== "second" && !hasGrantedAccess) return;

  // ── Per-user in-flight guard ────────────────────────────────────────────────
  // Silently drop the second concurrent message rather than replying: the reply
  // would land in the middle of the first message's answer, and the surrounding
  // handler is otherwise entirely silent for messages it declines to process.
  if (isUserProcessing(message.author.id)) {
    logger.info(
      { userId: message.author.id, messageId: message.id },
      "Jarvis: dropped a message — this user's previous message is still being processed",
    );
    return;
  }
  beginUserProcessing(message.author.id);
  try {
    await processAiChat(message, rank);
  } finally {
    endUserProcessing(message.author.id);
  }
}

async function processAiChat(
  message: Message,
  rank: ReturnType<typeof getJarvisRank>,
): Promise<void> {
  const text = message.content.trim();

  // ── Sleep / wake control — checked before anything else, and while asleep
  // Jarvis ignores every message except the wake phrase. ─────────────────────
  if (JARVIS_SLEEP_PATTERN.test(text)) {
    setJarvisAsleep(true);
    activeSessions.delete(message.author.id);
    setStatusRotationPaused(true);
    try {
      message.client.user.setPresence({ status: "invisible" });
      const offline = getOfflineAvatarBuffer();
      if (offline) await message.client.user.setAvatar(offline);
    } catch (e) {
      logger.warn(
        { err: e },
        "Jarvis sleep: failed to fully go offline (presence/avatar)",
      );
    }
    await message.reply(
      'Goodnight, Sir. I\'ll be here when you need me — say "Jarvis, wake up" to bring me back online.',
    );
    return;
  }

  if (isJarvisAsleep()) {
    if (JARVIS_WAKE_UP_PATTERN.test(text)) {
      setJarvisAsleep(false);
      // stay paused only if Protocol Silent is still active
      setStatusRotationPaused(isProtocolSilentActive());
      try {
        message.client.user.setPresence({ status: "online" });
        const online = getOnlineAvatarBuffer();
        if (online) await message.client.user.setAvatar(online);
      } catch (e) {
        logger.warn(
          { err: e },
          "Jarvis wake: failed to restore presence/avatar",
        );
      }
      // No-ops while Protocol Silent keeps the rotation paused.
      triggerStatusRotation();
      await message.reply("Back online, Sir. How may I assist?");
    }
    // While asleep, every other message (including the normal wake word) is ignored.
    return;
  }

  const isWakeWord =
    text.toLowerCase() === "jarvis" ||
    text.toLowerCase() === "jar jar" ||
    text.toLowerCase() === "jarvy";
  const history = activeSessions.get(message.author.id);

  // If the user says the wake word while a session is already open, reset it cleanly
  // instead of passing "Jarvis" to the AI as a conversational message
  if (history !== undefined && isWakeWord) {
    activeSessions.set(message.author.id, []);
    await message.reply(buildGreeting());
    return;
  }

  if (history !== undefined) {
    // Active session — check for dismissal first
    if (isDismissal(text)) {
      activeSessions.delete(message.author.id);
      await message.reply(
        "Of course, Sir. I'll be standing by should you need me.",
      );
      return;
    }

    if ("sendTyping" in message.channel) await message.channel.sendTyping();

    // Everything pushed from here on belongs to this turn. A failure at ANY hop
    // must undo the whole turn: a successful hop pushes two entries (the
    // assistant message carrying tool_calls, then its tool result), so popping
    // a single entry would leave a dangling unpaired tool_calls message that
    // poisons every subsequent request in this session.
    const historyLengthBeforeTurn = history.length;
    history.push({ role: "user", content: text });

    const MAX_TOOL_HOPS = 4; // bounds cost/latency on chained tool use
    const HISTORY_TRUNCATE_TOOLS = new Set([
      "get_full_capabilities",
      "get_command_guide",
      "get_overwatch_detail",
      "search_nicknames",
      "list_servers",
      "get_merit_history",
    ]);

    try {
      let finalReply: string | null = null;
      let lastToolResult: string | null = null;

      for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
        const completion = await createCompletionWithRetry({
          model: process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
          messages: [
            {
              role: "system",
              content: getSystemPrompt(message.author.tag, rank, text),
            },
            ...history,
          ],
          tool_choice: "auto",
          max_tokens: 550,
          tools: toolsForMessage(rank, text),
        });

        if (completion.usage?.total_tokens)
          trackTokens(completion.usage.total_tokens);
        const choice = completion.choices[0];

        const toolCall = choice?.message?.tool_calls?.find(
          (tc) => tc.type === "function",
        );

        if (!toolCall || toolCall.type !== "function") {
          finalReply =
            choice?.message?.content ??
            "I apologize, Sir — I was unable to generate a response.";
          history.push({ role: "assistant", content: finalReply });
          trimHistory(history);
          break;
        }

        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          if (parsed && typeof parsed === "object")
            args = parsed as Record<string, unknown>;
        } catch {
          /* ignore */
        }

        let result: string;
        try {
          result = await executeTool(
            toolCall.function.name,
            args,
            message,
            rank,
          );
        } catch (err) {
          logger.error(
            { err, tool: toolCall.function.name },
            "Tool execution failed",
          );
          result =
            "I encountered a problem executing that directive, Sir. I may lack the required permissions.";
        }
        lastToolResult = result;

        const storedResult = HISTORY_TRUNCATE_TOOLS.has(toolCall.function.name)
          ? result.slice(0, 200) + " …(full reply already sent to the user)"
          : result;

        history.push({
          role: "assistant",
          content: "",
          tool_calls: choice.message.tool_calls,
        } as ChatMessage);
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: storedResult,
        } as ChatMessage);
        trimHistory(history);

        if (hop === MAX_TOOL_HOPS - 1) {
          finalReply = result;
        }
      }

      const reply =
        finalReply ??
        lastToolResult ??
        "I apologize, Sir — I was unable to generate a response.";

      await sendChunked(message, reply);
    } catch (error) {
      logger.error({ err: error }, "Gemini API request failed");
      // Roll the history back to exactly where this turn started, however many
      // hops had already been appended. trimHistory may have spliced entries off
      // the front, so only truncate when the array actually grew.
      if (history.length > historyLengthBeforeTurn) {
        history.length = historyLengthBeforeTurn;
      }

      const isRateLimit =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status: number }).status === 429;
      if (isRateLimit) {
        const errMsg = (error as { message?: string }).message ?? "";
        const retryMs = parseRetryAfterMs(errMsg);
        const resetAt = new Date(Date.now() + retryMs);

        const totalSecs = Math.round(retryMs / 1000);
        const hours = Math.floor(totalSecs / 3600);
        const mins = Math.floor((totalSecs % 3600) / 60);
        const secs = totalSecs % 60;

        const parts: string[] = [];
        if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
        if (mins > 0) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
        if (hours === 0 && secs > 0)
          parts.push(`${secs} second${secs === 1 ? "" : "s"}`);
        const etaStr = parts.length > 0 ? parts.join(" ") : "under a minute";

        const resetClock = resetAt.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/New_York",
        });

        await message.reply(
          `My daily token quota has been exhausted, Sir. It will reset in ${etaStr} (at ${resetClock} ET). I will notify you the moment it does.`,
        );
        if (!isTokenResetScheduled()) {
          setTokenResetScheduled(true);
          logger.info(
            { retryMs },
            "Token quota exhausted — reset notification scheduled",
          );
          setTimeout(() => void notifyTokenReset(message.client), retryMs);
        }
      } else if (isTransientError(error)) {
        await message.reply(
          "My neural core appears to be temporarily overloaded on Google's end, Sir. Please try again in a moment.",
        );
      } else {
        await message.reply(
          "I encountered an error communicating with my neural core, Sir.",
        );
      }
    }
    return;
  }

  // No active session — check for wake word
  if (isWakeWord) {
    activeSessions.set(message.author.id, []);
    await message.reply(buildGreeting());
  }
}
