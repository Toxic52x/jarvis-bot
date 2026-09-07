import { EmbedBuilder } from "discord.js";
import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { FIRE_RED, getConfiguredIds } from "../../config";
import { db, meritAwardsTable } from "../../lib/db";
import { writeOwnerAuditLog } from "../auditLog";
import { getJarvisRank, isProtectedOwner, rankAtLeast } from "../permissions";
import { logger } from "../../lib/logger";

/** Extract every unique user ID from an announcement blob containing <@ID> or <@!ID> mentions. */
export function extractMentionIds(text: string): string[] {
  const seen = new Set<string>();
  const pattern = /<@!?(\d+)>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    seen.add(match[1]);
  }
  return [...seen];
}

export async function awardMerits(
  interaction: ChatInputCommandInteraction,
  members: GuildMember[],
  amount: number,
  proofUrl: string,
  meritTypeLabel: string,
): Promise<void> {
  if (!interaction.guild)
    throw new Error("This command can only be used inside a server.");
  logger.info(
    {
      guildId: interaction.guild.id,
      meritTypeLabel,
      amount,
      recipients: members.length,
      awardedBy: interaction.user.id,
    },
    "Recording merit award",
  );
  await db.transaction(async (tx) => {
    await tx.insert(meritAwardsTable).values(
      members.map((m) => ({
        guildId: interaction.guild!.id,
        memberId: m.id,
        memberTag: m.user.tag,
        amount,
        proofUrl,
        awardedById: interaction.user.id,
        awardedByTag: interaction.user.tag,
      })),
    );
  });
}

export async function handleRemoveMerit(
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
  if (!rankAtLeast(member, "advisor")) {
    await interaction.reply({
      content: "Access Denied — Advisor and above only.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const targetUser = interaction.options.getUser("user", true);
    const amount = interaction.options.getNumber("amount", true);
    const reason = interaction.options.getString("reason", true);
    const actorRank = getJarvisRank(member);
    const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

    if (isProtectedOwner(actorRank, targetUser.id, ownerIds)) {
      throw new Error("Fire Lord cannot remove merits from the Owner.");
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id);

    await db.insert(meritAwardsTable).values({
      guildId: interaction.guild.id,
      memberId: targetMember.id,
      memberTag: targetMember.user.tag,
      amount: -amount,
      proofUrl: reason,
      awardedById: interaction.user.id,
      awardedByTag: interaction.user.tag,
    });

    const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
    if (logChannelId) {
      const channel = await interaction.client.channels
        .fetch(logChannelId)
        .catch(() => null);
      if (channel && channel.isTextBased() && "send" in channel) {
        const embed = new EmbedBuilder()
          .setTitle("JARVIS // MERIT REMOVAL AUDIT")
          .setDescription("A merit deduction has been authorized and recorded.")
          .setColor(FIRE_RED)
          .addFields(
            {
              name: "MEMBER",
              value: `${targetMember.user.tag} (${targetMember.id})`,
            },
            { name: "AMOUNT REMOVED", value: `**-${amount}**`, inline: true },
            { name: "REASON", value: reason },
            {
              name: "AUTHORIZED BY",
              value: `${interaction.user.tag} (${interaction.user.id})`,
            },
          )
          .setFooter({ text: "FIRE NATION • OWNER AUDIT CHANNEL" })
          .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(() => null);
      }
    }

    await interaction.editReply(
      `Recorded **-${amount}** merit${amount === 1 ? "" : "s"} for ${targetMember.user.tag} — logged for owners.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The merit removal failed.";
    logger.warn(
      { err: error, userId: interaction.user.id },
      "Merit removal rejected",
    );
    await interaction.editReply(`Could not remove merits: ${message}`);
  }
}

export async function handleAddMerit(
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

  try {
    const sub = interaction.options.getSubcommand() as
      | "exam"
      | "event"
      | "raid"
      | "bonus";
    const actorRank = getJarvisRank(member);
    const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

    // ── Raid + Bonus: Advisor and above only ─────────────────────────────────
    if ((sub === "raid" || sub === "bonus") && actorRank === "hr") {
      throw new Error(
        "Only Advisors and above can award Raid or Bonus merits.",
      );
    }

    // ── Bonus: one or more users + explicit amount ────────────────────────────
    if (sub === "bonus") {
      const usersRaw = interaction.options.getString("users", true);
      const bonusAmount = interaction.options.getNumber("amount", true);
      const mentionIds = extractMentionIds(usersRaw);
      if (mentionIds.length === 0) {
        throw new Error(
          "No @mentions found. Make sure you @mention one or more members.",
        );
      }
      if (mentionIds.some((id) => isProtectedOwner(actorRank, id, ownerIds))) {
        throw new Error("Fire Lord cannot award merits to the Owner.");
      }

      const fetchResults = await Promise.allSettled(
        mentionIds.map((id) => interaction.guild!.members.fetch(id)),
      );
      const targetMembers = fetchResults
        .filter(
          (r): r is PromiseFulfilledResult<GuildMember> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);

      if (targetMembers.length === 0) {
        throw new Error(
          "None of the mentioned members were found in this server.",
        );
      }

      await awardMerits(
        interaction,
        targetMembers,
        bonusAmount,
        `Bonus award authorized by ${interaction.user.tag}`,
        "Bonus",
      );
      await writeOwnerAuditLog(
        interaction,
        targetMembers,
        bonusAmount,
        "Bonus",
        actorRank,
      );

      const skipped = mentionIds.length - targetMembers.length;
      const skippedNote =
        skipped > 0
          ? ` (${skipped} mention${skipped === 1 ? "" : "s"} not found in server — skipped)`
          : "";
      await interaction.editReply(
        `Recorded **+${bonusAmount}** Bonus merit${bonusAmount === 1 ? "" : "s"} for **${targetMembers.length}** member${targetMembers.length === 1 ? "" : "s"}${skippedNote} — logged for owners.`,
      );
      return;
    }

    // ── Exam / Event / Raid: extract @mentions + explicit host ────────────────
    const announcement = interaction.options.getString("announcement", true);
    const hostUser = interaction.options.getUser("host", true);
    const mentionIds = extractMentionIds(announcement);
    if (mentionIds.length === 0) {
      throw new Error(
        "No @mentions found in the announcement. Make sure you pasted the full conclusion text.",
      );
    }

    const label = sub.charAt(0).toUpperCase() + sub.slice(1);
    const meritAmount = sub === "raid" ? 3 : 1;

    if (isProtectedOwner(actorRank, hostUser.id, ownerIds)) {
      throw new Error("Fire Lord cannot award merits that affect the Owner.");
    }

    const hostMember = await interaction.guild.members
      .fetch(hostUser.id)
      .catch(() => null);
    if (!hostMember) {
      throw new Error("The specified host is not currently in the server.");
    }

    // Fetch all mentioned members in parallel; silently skip anyone who left the server
    const fetchResults = await Promise.allSettled(
      mentionIds.map((id) => interaction.guild!.members.fetch(id)),
    );
    const mentioned = fetchResults
      .filter(
        (r): r is PromiseFulfilledResult<GuildMember> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);

    if (mentioned.some((m) => isProtectedOwner(actorRank, m.id, ownerIds))) {
      throw new Error("Fire Lord cannot award merits that affect the Owner.");
    }

    // Host always receives merit, whether or not they were tagged in the announcement
    const allMembers = [...mentioned];
    if (!allMembers.some((m) => m.id === hostMember.id)) {
      allMembers.push(hostMember);
    }

    await awardMerits(
      interaction,
      allMembers,
      meritAmount,
      announcement,
      label,
    );
    await writeOwnerAuditLog(
      interaction,
      allMembers,
      meritAmount,
      label,
      actorRank,
    );

    const skipped = mentionIds.length - mentioned.length;
    const skippedNote =
      skipped > 0
        ? ` (${skipped} mention${skipped === 1 ? "" : "s"} not found in server — skipped)`
        : "";
    await interaction.editReply(
      `Recorded **+${meritAmount}** ${label} merit${meritAmount === 1 ? "" : "s"} for **${allMembers.length}** member${allMembers.length === 1 ? "" : "s"} (Host: ${hostMember.user.tag})${skippedNote} — logged for owners.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The merit award failed.";
    logger.warn(
      { err: error, userId: interaction.user.id },
      "Merit award rejected",
    );
    await interaction.editReply(`Could not record the award: ${message}`);
  }
}
