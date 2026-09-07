import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import { FIRE_RED, getConfiguredIds, type JarvisRank } from "../../config";
import { getJarvisRank, isProtectedOwner, rankAtLeast } from "../permissions";
import { logger } from "../../lib/logger";

/**
 * Thrown by a perGuildAction to signal "the target simply isn't in this guild",
 * which is counted as skipped rather than failed.
 */
class GuildActionSkipped extends Error {}

type GlobalModerationOptions = {
  /** Short verb used in logs, e.g. "kick", "ban", "timeout". */
  actionLabel: string;
  /** Minimum Jarvis rank allowed to run this command. */
  requiredRank: JarvisRank;
  /** Embed title, e.g. "JARVIS // GLOBAL KICK EXECUTED". */
  embedTitle: string;
  /** Past-tense verb used in the RESULTS line, e.g. "Kicked". */
  resultVerb: string;
  /** Audit-reason prefix, e.g. "[Jarvis Global Kick]". */
  reasonPrefix: string;
  /** Extra embed fields inserted between TARGET and REASON. */
  extraFields?: { name: string; value: string; inline?: boolean }[];
  /** Performs the action in one guild. Throw to signal failure. */
  perGuildAction: (
    guild: Guild,
    targetId: string,
    reason: string,
  ) => Promise<void>;
};

/**
 * Shared driver for every /global* command: guard checks, rank gate,
 * Owner protection, the per-guild loop with success/skipped/failed counters,
 * the results embed, and the owner-log copy. The individual commands only
 * supply what actually differs between them.
 */
async function executeGlobalModerationAction(
  interaction: ChatInputCommandInteraction,
  opts: GlobalModerationOptions,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!rankAtLeast(member, opts.requiredRank)) {
    const rankLabel =
      opts.requiredRank.charAt(0).toUpperCase() + opts.requiredRank.slice(1);
    await interaction.reply({
      content: `Access Denied — ${rankLabel} and above only.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("user", true);
  const reason =
    interaction.options.getString("reason") ?? "No reason provided.";
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

  if (isProtectedOwner(getJarvisRank(member), target.id, ownerIds)) {
    await interaction.editReply(
      "Fire Lord cannot run global actions that affect the Owner.",
    );
    return;
  }

  const fullReason = `${opts.reasonPrefix} ${reason} — by ${interaction.user.tag}`;
  const guilds = [...interaction.client.guilds.cache.values()];
  let success = 0,
    skipped = 0,
    failed = 0;

  for (const guild of guilds) {
    try {
      await opts.perGuildAction(guild, target.id, fullReason);
      success++;
    } catch (e: unknown) {
      if (e instanceof GuildActionSkipped) {
        skipped++;
        continue;
      }
      const code = (e as { code?: number }).code;
      if (code === 10007 || code === 10013)
        skipped++; // Unknown member / unknown user
      else failed++;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(opts.embedTitle)
    .setColor(FIRE_RED)
    .addFields(
      { name: "TARGET", value: `${target.tag} (${target.id})` },
      ...(opts.extraFields ?? []),
      { name: "REASON", value: reason },
      {
        name: "RESULTS",
        value: `✅ ${opts.resultVerb}: **${success}** | ⏭️ Not found: **${skipped}** | ❌ Failed: **${failed}**`,
      },
      { name: "AUTHORIZED BY", value: `${interaction.user.tag}` },
    )
    .setFooter({ text: "FIRE NATION • GLOBAL ENFORCEMENT" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  logger.info(
    {
      action: opts.actionLabel,
      targetId: target.id,
      success,
      skipped,
      failed,
    },
    "Global moderation action complete",
  );

  const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (logId) {
    const ch = await interaction.client.channels.fetch(logId).catch(() => null);
    if (ch && ch.isTextBased() && "send" in ch)
      await ch.send({ embeds: [embed] }).catch(() => null);
  }
}

export async function handleGlobalKick(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await executeGlobalModerationAction(interaction, {
    actionLabel: "kick",
    requiredRank: "advisor",
    embedTitle: "JARVIS // GLOBAL KICK EXECUTED",
    resultVerb: "Kicked",
    reasonPrefix: "[Jarvis Global Kick]",
    perGuildAction: async (guild, targetId, reason) => {
      const targetMember = await guild.members
        .fetch(targetId)
        .catch(() => null);
      if (!targetMember) throw new GuildActionSkipped();
      await targetMember.kick(reason);
    },
  });
}

export async function handleGlobalBan(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await executeGlobalModerationAction(interaction, {
    actionLabel: "ban",
    requiredRank: "royalty",
    embedTitle: "JARVIS // GLOBAL BAN EXECUTED",
    resultVerb: "Banned",
    reasonPrefix: "[Jarvis Global Ban]",
    perGuildAction: async (guild, targetId, reason) => {
      await guild.bans.create(targetId, { reason, deleteMessageSeconds: 0 });
    },
  });
}

export async function handleGlobalMute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const durationMin = interaction.options.getInteger("duration", true);
  const until = new Date(Date.now() + durationMin * 60 * 1000);

  await executeGlobalModerationAction(interaction, {
    actionLabel: "timeout",
    requiredRank: "advisor",
    embedTitle: "JARVIS // GLOBAL MUTE EXECUTED",
    resultVerb: "Muted",
    reasonPrefix: "[Jarvis Global Mute]",
    extraFields: [
      {
        name: "DURATION",
        value: `**${durationMin}** minute${durationMin === 1 ? "" : "s"}`,
        inline: true,
      },
      {
        name: "EXPIRES",
        value: `<t:${Math.floor(until.getTime() / 1000)}:R>`,
        inline: true,
      },
    ],
    perGuildAction: async (guild, targetId, reason) => {
      const targetMember = await guild.members
        .fetch(targetId)
        .catch(() => null);
      if (!targetMember) throw new GuildActionSkipped();
      await targetMember.disableCommunicationUntil(until, reason);
    },
  });
}
