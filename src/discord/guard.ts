import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Message,
} from "discord.js";
import {
  FIRE_ORANGE,
  FIRE_RED,
  GUARD_REQUEST_LIFESPAN_MS,
  GUARD_RSVP_TRACKER_CHANNEL_ID,
  NORMAL_GUARD_CHANNEL_ID,
  ROYAL_GUARD_CHANNEL_ID,
} from "../config";
import { rankAtLeast } from "./permissions";
import type { GuardRequestState } from "./types";
import { logger } from "../lib/logger";

// ─── Live client reference ─────────────────────────────────────────────────
// Guard requests need to fetch channels/guilds outside of any interaction, so
// startBot() hands this module the live client exactly once at startup.

let botClient: Client | null = null;

export function setBotClient(client: Client): void {
  botClient = client;
}

export function getBotClient(): Client | null {
  return botClient;
}

// ─── Guard request RSVP state ──────────────────────────────────────────────

/** Active guard requests, keyed by a generated id. Cleared after 24h. */
export const activeGuardRequests = new Map<string, GuardRequestState>();
export function buildGuardRsvpRow(
  requestId: string,
): ActionRowBuilder<ButtonBuilder> {
  const rsvpBtn = new ButtonBuilder()
    .setCustomId(`guard_rsvp:${requestId}`)
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);
  const cancelBtn = new ButtonBuilder()
    .setCustomId(`guard_rsvp_cancel:${requestId}`)
    .setEmoji("❌")
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    rsvpBtn,
    cancelBtn,
  );
}


export function buildGuardCloseRow(
  requestId: string,
  closed: boolean,
): ActionRowBuilder<ButtonBuilder> {
  const btn = new ButtonBuilder()
    .setCustomId(`guard_close:${requestId}`)
    .setLabel(closed ? "Closed" : "Close Request")
    .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Danger)
    .setDisabled(closed);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(btn);
}
export function buildGuardRequestEmbed(
  state: GuardRequestState,
  includeCount: boolean,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("📋 GUARD REQUEST — HR EXAM")
    .setDescription(
      "Guards are needed for an examination. Click **✅** below to confirm you can make it, or **❌** to cancel.",
    )
    .setColor(FIRE_ORANGE)
    .addFields(
      { name: "REQUESTED BY", value: state.hostTag },
      { name: "WHEN", value: state.when, inline: true },
      { name: "LOCATION", value: state.location, inline: true },
    )
    .setFooter({ text: "FIRE NATION • EXAM SECURITY PROTOCOL" })
    .setTimestamp();

  // Only ever attached to the host's private DM — never to the public channel message.
  if (includeCount) {
    embed.addFields({
      name: `CONFIRMED (${state.rsvps.size})`,
      value: 
        state.rsvps.size > 0
          ? [...state.rsvps].map((id) => `<@${id}>`).join("\n")
          : "_No one yet_",
    });
  }
  return embed;
}

/** Posts the public (count-free) guard request and DMs the host a private, live-updating tracker. */
export async function postGuardRequest(
  client: Client,
  guild: Guild,
  host: { id: string; tag: string },
  when: string,
  location: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const channel = await client.channels
    .fetch(NORMAL_GUARD_CHANNEL_ID)
    .catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    return { ok: false, error: "Could not reach the Guard channel." };
  }

  const state: GuardRequestState = {
    id: `${guild.id}:${Date.now()}`,
    guildId: guild.id,
    hostId: host.id,
    hostTag: host.tag,
    when,
    location,
    rsvps: new Set(),
    hostDmChannelId: null,
    hostDmMessageId: null,
    createdAt: Date.now(),
  };

  const publicMessage = await channel.send({
    content: "@everyone",
    embeds: [buildGuardRequestEmbed(state, false)], // public — no count, no names
    components: [buildGuardRsvpRow(state.id)],
  });

  activeGuardRequests.set(state.id, state);
  setTimeout(
    () => activeGuardRequests.delete(state.id),
    GUARD_REQUEST_LIFESPAN_MS,
  );

  const rsvpCollector = publicMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      i.customId === `guard_rsvp:${state.id}` ||
      i.customId === `guard_rsvp_cancel:${state.id}`,
    time: GUARD_REQUEST_LIFESPAN_MS,
  });

  rsvpCollector.on("collect", async (btn) => {
    if (!activeGuardRequests.has(state.id)) {
      await btn
        .reply({
          content: "This guard request has been closed.",
          ephemeral: true,
        })
        .catch(() => null);
      return;
    }

    if (btn.customId === `guard_rsvp:${state.id}`) {
      if (state.rsvps.has(btn.user.id)) {
        await btn
          .reply({
            content: "You're already marked as confirmed for this one.",
            ephemeral: true,
          })
          .catch(() => null);
        return;
      }
      state.rsvps.add(btn.user.id);
      await btn
        .reply({
          content: "You have confirmed your attendance.",
          ephemeral: true,
        })
        .catch(() => null);
    } else {
      if (!state.rsvps.has(btn.user.id)) {
        await btn
          .reply({
            content: "You're not currently marked as attending this one.",
            ephemeral: true,
          })
          .catch(() => null);
        return;
      }
      state.rsvps.delete(btn.user.id);
      await btn
        .reply({
          content: "You have cancelled your attendance.",
          ephemeral: true,
        })
        .catch(() => null);
    }

    if (botClient) await updateHostGuardDm(botClient, state);
    logger.info(
      { requestId: state.id, userId: btn.user.id, action: btn.customId },
      "Guard RSVP: button interaction processed",
    );
  });

  try {
    const trackerChannel = await client.channels
      .fetch(GUARD_RSVP_TRACKER_CHANNEL_ID)
      .catch(() => null);
    if (
      !trackerChannel ||
      !trackerChannel.isTextBased() ||
      !("send" in trackerChannel)
    ) {
      logger.warn(
        { channelId: GUARD_RSVP_TRACKER_CHANNEL_ID },
        "Guard RSVP tracker channel not found or not writable — check GUARD_RSVP_TRACKER_CHANNEL_ID",
      );
    } else {
      const tracker = await trackerChannel.send({
        content: `RSVP tracker for **${host.tag}**'s guard request. DM me \`RSVP\` or \`RSVP CANCEL\` to update this list. Click below once the exam is done.`,
        embeds: [buildGuardRequestEmbed(state, true)],
        components: [buildGuardCloseRow(state.id, false)],
      });
      state.hostDmChannelId = tracker.channelId;
      state.hostDmMessageId = tracker.id;
      logger.info(
        { channelId: tracker.channelId, messageId: tracker.id, requestId: state.id },
        "Guard RSVP: tracker message posted successfully",
      );

      const collector = tracker.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i) => i.customId === `guard_close:${state.id}`,
        time: GUARD_REQUEST_LIFESPAN_MS,
      });

      collector.on("collect", async (btn) => {
        const clickerMember = await guild.members
          .fetch(btn.user.id)
          .catch(() => null);
        const isHost = btn.user.id === state.hostId;
        const isStaff =
          clickerMember && rankAtLeast(clickerMember, "hr");
        if (!isHost && !isStaff) {
          await btn
            .reply({
              content: "Only the host or HR+ can close this request.",
              ephemeral: true,
            })
            .catch(() => null);
          return;
        }

        activeGuardRequests.delete(state.id);
        await btn
          .update({
            embeds: [buildGuardRequestEmbed(state, true)],
            components: [buildGuardCloseRow(state.id, true)],
          })
          .catch(() => null);
        collector.stop("closed");
        logger.info(
          { requestId: state.id, closedBy: btn.user.tag },
          "Guard RSVP: request manually closed",
        );
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, channelId: GUARD_RSVP_TRACKER_CHANNEL_ID },
      "Could not post the guard-request RSVP tracker to the configured channel",
    );
  }

  return { ok: true };
}

export async function updateHostGuardDm(
  client: Client,
  state: GuardRequestState,
): Promise<void> {
  if (!state.hostDmChannelId || !state.hostDmMessageId) {
    logger.warn(
      { requestId: state.id },
      "Guard RSVP: tracker was never posted (hostDmChannelId/hostDmMessageId is null) — check GUARD_RSVP_TRACKER_CHANNEL_ID and bot permissions in that channel",
    );
    return;
  }
  try {
    const dmChannel = await client.channels
      .fetch(state.hostDmChannelId)
      .catch((e) => {
        logger.warn(
          { err: e, channelId: state.hostDmChannelId },
          "Guard RSVP: failed to fetch tracker channel",
        );
        return null;
      });
    if (!dmChannel || !("messages" in dmChannel)) {
      logger.warn(
        { channelId: state.hostDmChannelId },
        "Guard RSVP: tracker channel not found or not text-based",
      );
      return;
    }
    const msg = await (
      dmChannel as unknown as {
        messages: { fetch: (id: string) => Promise<Message> };
      }
    ).messages
      .fetch(state.hostDmMessageId)
      .catch((e) => {
        logger.warn(
          { err: e, messageId: state.hostDmMessageId },
          "Guard RSVP: failed to fetch tracker message — it may have been deleted",
        );
        return null;
      });
    if (!msg) return;
    await msg
      .edit({ embeds: [buildGuardRequestEmbed(state, true)] })
      .catch((e) =>
        logger.warn(
          { err: e, messageId: state.hostDmMessageId },
          "Guard RSVP: failed to edit tracker message — check bot permissions in that channel",
        ),
      );
  } catch (e) {
    logger.warn({ err: e }, "Guard RSVP: unexpected error updating tracker");
  }
}

/** Handles a DM'd "RSVP" or "RSVP CANCEL" — matches the sender to the relevant active guard request. */
export async function handleGuardRsvpDm(message: Message): Promise<void> {
  if (message.author.bot) return;
  const text = message.content.trim();

  const isConfirm = /^rsvp$/i.test(text);
  const isCancel = /^(rsvp\s*cancel|cancel\s*rsvp|unrsvp)$/i.test(text);
  if (!isConfirm && !isCancel) return;
  if (!("send" in message.channel)) return;

  if (isCancel) {
    const alreadyOn = [...activeGuardRequests.values()]
      .filter((s) => s.rsvps.has(message.author.id))
      .sort((a, b) => b.createdAt - a.createdAt);

    if (alreadyOn.length === 0) {
      await message.channel
        .send(
          "You're not currently marked as attending any active guard request.",
        )
        .catch(() => null);
      return;
    }

    const state = alreadyOn[0];
    state.rsvps.delete(message.author.id);
    await message.channel
      .send("Got it — you're no longer marked as attending.")
      .catch(() => null);
    if (botClient) await updateHostGuardDm(botClient, state);
    return;
  }

  // isConfirm
  const candidates: GuardRequestState[] = [];
  for (const state of activeGuardRequests.values()) {
    const guild = botClient?.guilds.cache.get(state.guildId);
    if (!guild) continue;
    const member =
      guild.members.cache.get(message.author.id) ??
      (await guild.members.fetch(message.author.id).catch(() => null));
    if (member) candidates.push(state);
  }

  if (candidates.length === 0) {
    await message.channel
      .send(
        "I don't see an active guard request you're eligible to RSVP to right now.",
      )
      .catch(() => null);
    return;
  }

  const state = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];

  if (state.rsvps.has(message.author.id)) {
    await message.channel
      .send(
        "You're already marked as confirmed for that one. DM `RSVP CANCEL` if you need to back out.",
      )
      .catch(() => null);
    return;
  }

  state.rsvps.add(message.author.id);
  await message.channel
    .send(
      "Confirmed — you're marked as attending. DM `RSVP CANCEL` anytime if that changes.",
    )
    .catch(() => null);

  if (botClient) await updateHostGuardDm(botClient, state);
}

// ─── Notification handlers ────────────────────────────────────────────────────

export async function handleRoyalGuard(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!rankAtLeast(member, "royalty")) {
    await interaction.reply({
      content: "Access Denied — Royalty and above only.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const location = interaction.options.getString("location");

  const channel = await interaction.client.channels
    .fetch(ROYAL_GUARD_CHANNEL_ID)
    .catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await interaction.editReply("Could not reach the Royal Guard channel.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🛡️ ROYAL GUARD ALERT")
    .setDescription("A Royal is currently in game and requires escort.")
    .setColor(FIRE_RED)
    .addFields(
      { name: "ROYAL", value: `${interaction.user.tag}` },
      ...(location ? [{ name: "LOCATION", value: location }] : []),
    )
    .setFooter({ text: "FIRE NATION • ROYAL PROTECTION PROTOCOL" })
    .setTimestamp();

  await channel.send({ content: "@everyone", embeds: [embed] });
  await interaction.editReply("Royal Guard has been notified.");
}

export async function handleRequestGuards(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!rankAtLeast(member, "hr")) {
    await interaction.reply({
      content: "Access Denied — HR and above only.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const when = interaction.options.getString("when", true);
  const location = interaction.options.getString("location", true);

  const result = await postGuardRequest(
    interaction.client,
    interaction.guild,
    { id: interaction.user.id, tag: interaction.user.tag },
    when,
    location,
  );

  await interaction.editReply(
    result.ok
      ? "Guard request posted."
      : `Could not post the guard request: ${result.error}`,
  );
}
