import {
  EmbedBuilder,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { FIRE_RED } from "../../config";
import { db, memberActivityTable } from "../../lib/db";
import { handleAiChat } from "../ai/chat";
import { handleGuardRsvpDm } from "../guard";
import {
  checkOverwatchTrigger,
  handleOverwatchTrigger,
  overwatchActiveGuilds,
  reactionWatches,
} from "../moderation/overwatch";
import { logger } from "../../lib/logger";

// ─── Member-activity write throttle ───────────────────────────────────────────
// The activity upsert used to fire on literally every non-bot guild message,
// which meant one write per message purely to keep a "last seen" timestamp that
// /inactivepurge only ever reads at day granularity. This map remembers when we
// last actually wrote a row for `${guildId}:${userId}` so we can skip the round
// trip for the next hour of that member's chatter.
//
// Note the entry is stamped only when a write really happens — deliberately not
// on every skipped message. Restamping on skips would turn the throttle into a
// debounce, and a continuously-chatty member's row would then never be refreshed
// again, making /inactivepurge eventually flag the most active people in the
// server. Written this way the row is refreshed at most once per hour and at
// least once per hour of activity, which is what the purge query needs.
const lastActivityWrite = new Map<string, number>();
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 60 * 1000;

/** Records member activity for /inactivepurge. Fire-and-forget, never awaited. */
function trackMemberActivity(message: Message): void {
  if (message.author.bot || !message.guildId) return;

  const key = `${message.guildId}:${message.author.id}`;
  const lastWrite = lastActivityWrite.get(key);
  if (lastWrite !== undefined && Date.now() - lastWrite < ACTIVITY_WRITE_INTERVAL_MS) {
    return;
  }
  lastActivityWrite.set(key, Date.now());

  const userTag = message.author.tag ?? message.author.username;
  void db
    .insert(memberActivityTable)
    .values({
      guildId: message.guildId,
      userId: message.author.id,
      userTag,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [memberActivityTable.guildId, memberActivityTable.userId],
      set: {
        userTag,
        lastSeenAt: new Date(),
      },
    })
    .catch(() => {
      /* non-critical */
    });
}

/**
 * Top-level MessageCreate dispatcher: DMs go to the guard RSVP flow, guild
 * messages get activity-tracked, screened by Overwatch, and only then handed to
 * the Jarvis conversational handler.
 */
export async function handleMessageCreate(message: Message): Promise<void> {
  if (!message.guild) {
    logger.info(
      {
        userId: message.author.id,
        bot: message.author.bot,
        content: message.content,
      },
      "DM received by bot",
    );
    await handleGuardRsvpDm(message).catch((e) =>
      logger.error({ err: e }, "Guard RSVP DM handler failed"),
    );
    return;
  }

  // Track member activity for inactivity purge (fire-and-forget)
  trackMemberActivity(message);

  if (message.author.bot || !message.member) return;

  // ── Overwatch Mode — runs for every member, every message, whenever active ──
  if (overwatchActiveGuilds.has(message.guild.id)) {
    const trigger = checkOverwatchTrigger(message);
    if (trigger) {
      await handleOverwatchTrigger(message, trigger).catch((e) =>
        logger.error({ err: e }, "Overwatch trigger handling failed"),
      );
      return; // don't also feed this message into the Jarvis conversation flow
    }
  }

  await handleAiChat(message);
}

// ─── Audit-log deletion detector ─────────────────────────────────────────────

export async function handleMessageDelete(
  message: Message | PartialMessage,
): Promise<void> {
  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (
    !logChannelId ||
    (message as { channelId: string }).channelId !== logChannelId
  )
    return;

  const channel = (message as { channel: unknown }).channel as {
    isTextBased: () => boolean;
    send?: (...args: unknown[]) => Promise<unknown>;
    permissionOverwrites?: { edit: (...args: unknown[]) => Promise<void> };
  };

  if (!channel.isTextBased() || !channel.send) return;

  const guildRoles = (message as { guild?: { roles: { everyone: unknown } } })
    .guild?.roles;
  if (guildRoles && channel.permissionOverwrites) {
    await channel.permissionOverwrites
      .edit(guildRoles.everyone, {
        ViewChannel: false,
        SendMessages: false,
      })
      .catch((e) => logger.warn({ err: e }, "Failed to lock channel"));
  }

  const authorMention = (message as { author?: { id: string; tag: string } })
    .author
    ? `<@${(message as { author: { id: string; tag: string } }).author.id}> (${(message as { author: { id: string; tag: string } }).author.tag})`
    : "An unknown user";

  const breachEmbed = new EmbedBuilder()
    .setTitle("🚨 SYSTEM BREACH DETECTED — CHANNEL LOCKED")
    .setDescription(
      `**A MESSAGE WAS DELETED FROM THE AUDIT LOGS.**\n\n` +
        `**Target:** ${authorMention}\n` +
        `**Status:** 🔒 CHANNEL LOCKED DOWN\n\n` +
        `Owner or Fire Lord must run \`/staydown\` to acknowledge and restore access.`,
    )
    .setColor(FIRE_RED)
    .setTimestamp();

  await channel
    .send({ content: "@everyone", embeds: [breachEmbed] })
    .catch((e) => logger.error({ err: e }, "Failed to send breach alert"));
}

// ─── Reaction watch handler ───────────────────────────────────────────────────

export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  client: Client,
): Promise<void> {
  if (user.bot || reactionWatches.size === 0) return;

  const full = reaction.partial
    ? await reaction.fetch().catch(() => reaction)
    : reaction;
  const emojiKey = full.emoji.name ?? String(full.emoji);
  const key = `${full.message.id}:${emojiKey}`;
  const watch = reactionWatches.get(key);
  if (!watch) return;

  const count = full.count ?? 0;
  if (count < watch.threshold) return;

  reactionWatches.delete(key); // one-shot
  try {
    const requester = await client.users.fetch(watch.requesterId);
    const guildName =
      client.guilds.cache.get(watch.guildId)?.name ?? "the server";
    const link = `https://discord.com/channels/${watch.guildId}/${watch.channelId}/${watch.messageId}`;
    await requester.send(
      `Sir, the message you asked me to watch in ${guildName} just hit **${count}** ${watch.emoji} reactions.\n${link}`,
    );
  } catch (e) {
    logger.warn(
      { err: e, watch },
      "Failed to deliver reaction watch notification",
    );
  }
}
