import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { FIRE_ORANGE, FIRE_RED } from "../../config";
import {
  canManageJarvis,
  getJarvisRank as getActorRank,
  rankAtLeast,
} from "../../discord/permissions";
import { logger } from "../../lib/logger";
import {
  MeritError,
  type LeaderboardRow,
  type MeritHistoryRow,
  type MeritType,
  assertCanAward,
  assertCanManageData,
  assertCanRemove,
  assertCanViewHistory,
  assertNotProtectedOwner,
  auditAward,
  auditRemoval,
  auditReset,
  fixedMeritAmount,
  getLeaderboard,
  getMemberHistory,
  getMemberTotal,
  meritTypeLabel,
  recordAward,
  recordRemoval,
  resetAllData,
} from "./service";

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

// ─── /addmerit, /removemerit ────────────────────────────────────────────────

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
    const meritType = interaction.options.getSubcommand() as MeritType;
    const actorRank = getActorRank(member);
    assertCanAward(actorRank, meritType);

    if (meritType === "bonus") {
      const usersRaw = interaction.options.getString("users", true);
      const amount = interaction.options.getNumber("amount", true);
      const mentionIds = extractMentionIds(usersRaw);
      if (mentionIds.length === 0) {
        throw new MeritError(
          "No @mentions found. Make sure you @mention one or more members.",
        );
      }
      for (const id of mentionIds) assertNotProtectedOwner(actorRank, id);

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
        throw new MeritError(
          "None of the mentioned members were found in this server.",
        );
      }

      await recordAward({
        guildId: interaction.guild.id,
        recipients: targetMembers.map((m) => ({ id: m.id, tag: m.user.tag })),
        amount,
        proofUrl: `Bonus award authorized by ${interaction.user.tag}`,
        awardedById: interaction.user.id,
        awardedByTag: interaction.user.tag,
      });
      await auditAward(
        interaction.client,
        targetMembers.map((m) => ({ id: m.id, tag: m.user.tag })),
        amount,
        "Bonus",
        interaction.user.tag,
      );

      const skipped = mentionIds.length - targetMembers.length;
      const skippedNote =
        skipped > 0
          ? ` (${skipped} mention${skipped === 1 ? "" : "s"} not found in server — skipped)`
          : "";
      await interaction.editReply(
        `Recorded **+${amount}** Bonus merit${amount === 1 ? "" : "s"} for **${targetMembers.length}** member${targetMembers.length === 1 ? "" : "s"}${skippedNote} — logged for owners.`,
      );
      return;
    }

    // exam / event / raid — extract @mentions + explicit host
    const announcement = interaction.options.getString("announcement", true);
    const hostUser = interaction.options.getUser("host", true);
    const mentionIds = extractMentionIds(announcement);
    if (mentionIds.length === 0) {
      throw new MeritError(
        "No @mentions found in the announcement. Make sure you pasted the full conclusion text.",
      );
    }

    assertNotProtectedOwner(actorRank, hostUser.id);

    const hostMember = await interaction.guild.members
      .fetch(hostUser.id)
      .catch(() => null);
    if (!hostMember) {
      throw new MeritError("The specified host is not currently in the server.");
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

    for (const m of mentioned) assertNotProtectedOwner(actorRank, m.id);

    // Host always receives merit, whether or not they were tagged in the announcement
    const allMembers = [...mentioned];
    if (!allMembers.some((m) => m.id === hostMember.id)) {
      allMembers.push(hostMember);
    }

    const amount = fixedMeritAmount(meritType);
    const label = meritTypeLabel(meritType);

    await recordAward({
      guildId: interaction.guild.id,
      recipients: allMembers.map((m) => ({ id: m.id, tag: m.user.tag })),
      amount,
      proofUrl: announcement,
      awardedById: interaction.user.id,
      awardedByTag: interaction.user.tag,
    });
    await auditAward(
      interaction.client,
      allMembers.map((m) => ({ id: m.id, tag: m.user.tag })),
      amount,
      label,
      interaction.user.tag,
    );

    const skipped = mentionIds.length - mentioned.length;
    const skippedNote =
      skipped > 0
        ? ` (${skipped} mention${skipped === 1 ? "" : "s"} not found in server — skipped)`
        : "";
    await interaction.editReply(
      `Recorded **+${amount}** ${label} merit${amount === 1 ? "" : "s"} for **${allMembers.length}** member${allMembers.length === 1 ? "" : "s"} (Host: ${hostMember.user.tag})${skippedNote} — logged for owners.`,
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
    const actorRank = getActorRank(member);

    assertCanRemove(actorRank);
    assertNotProtectedOwner(actorRank, targetUser.id);

    const targetMember = await interaction.guild.members.fetch(targetUser.id);

    await recordRemoval({
      guildId: interaction.guild.id,
      target: { id: targetMember.id, tag: targetMember.user.tag },
      amount,
      reason,
      awardedById: interaction.user.id,
      awardedByTag: interaction.user.tag,
    });
    await auditRemoval(
      interaction.client,
      { id: targetMember.id, tag: targetMember.user.tag },
      amount,
      reason,
      interaction.user.tag,
    );

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

// ─── /merits, /leaderboard, /merithistory ───────────────────────────────────

export const LEADERBOARD_PAGE_SIZE = 15;

export function buildLeaderboardPageEmbed(
  rows: ReadonlyArray<LeaderboardRow>,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const start = page * LEADERBOARD_PAGE_SIZE;
  const pageRows = rows.slice(start, start + LEADERBOARD_PAGE_SIZE);
  const lines = pageRows.map(
    (e, i) =>
      `**${String(start + i + 1).padStart(2, "0")}**  ${e.memberTag.slice(0, 45)}  —  **${e.total}**`,
  );
  return new EmbedBuilder()
    .setTitle("JARVIS // MERIT COMMAND")
    .setDescription(`**FULL PERSONNEL RANKING**\n\n${lines.join("\n")}`)
    .setColor(FIRE_RED)
    .setFooter({
      text: `FIRE NATION • MERIT SYSTEM • Page ${page + 1}/${totalPages} • ${rows.length} total • AUTHORIZED PERSONNEL ONLY`,
    })
    .setTimestamp();
}

export function buildLeaderboardButtons(
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> {
  const prev = new ButtonBuilder()
    .setCustomId("leaderboard_prev")
    .setLabel("◀ Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page <= 0);
  const next = new ButtonBuilder()
    .setCustomId("leaderboard_next")
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);
}

export const MERIT_HISTORY_PAGE_SIZE = 10;

export function buildMeritHistoryPageEmbed(
  targetTag: string,
  rows: ReadonlyArray<MeritHistoryRow>,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const start = page * MERIT_HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(start, start + MERIT_HISTORY_PAGE_SIZE);
  const lines = pageRows.map(
    (a) =>
      `**${a.amount > 0 ? "+" : ""}${a.amount}**  •  [Proof of action](${a.proofUrl})  •  <t:${Math.floor(a.createdAt.getTime() / 1000)}:R>`,
  );
  return new EmbedBuilder()
    .setTitle("JARVIS // MERIT HISTORY")
    .setDescription(`**PERSONNEL:** ${targetTag}\n\n${lines.join("\n")}`)
    .setColor(FIRE_ORANGE)
    .setFooter({
      text: `FIRE NATION • VERIFIED ACTION HISTORY • Page ${page + 1}/${totalPages} • ${rows.length} total`,
    })
    .setTimestamp();
}

export function buildMeritHistoryButtons(
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> {
  const prev = new ButtonBuilder()
    .setCustomId("merithistory_prev")
    .setLabel("◀ Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page <= 0);
  const next = new ButtonBuilder()
    .setCustomId("merithistory_next")
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);
}

export async function sendPaginatedMeritHistory(
  interaction: ChatInputCommandInteraction,
  targetTag: string,
  rows: ReadonlyArray<MeritHistoryRow>,
): Promise<void> {
  const totalPages = Math.max(
    1,
    Math.ceil(rows.length / MERIT_HISTORY_PAGE_SIZE),
  );
  let page = 0;

  const reply = await interaction.editReply({
    embeds: [buildMeritHistoryPageEmbed(targetTag, rows, page, totalPages)],
    components:
      totalPages > 1 ? [buildMeritHistoryButtons(page, totalPages)] : [],
  });

  if (totalPages <= 1) return;

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      i.user.id === interaction.user.id &&
      (i.customId === "merithistory_prev" ||
        i.customId === "merithistory_next"),
    time: 5 * 60_000,
  });

  collector.on("collect", async (btn) => {
    if (btn.customId === "merithistory_next") {
      page = Math.min(totalPages - 1, page + 1);
    } else {
      page = Math.max(0, page - 1);
    }
    await btn
      .update({
        embeds: [buildMeritHistoryPageEmbed(targetTag, rows, page, totalPages)],
        components: [buildMeritHistoryButtons(page, totalPages)],
      })
      .catch(() => null);
  });

  collector.on("end", async () => {
    await interaction.editReply({ components: [] }).catch(() => null);
  });
}

export async function sendPaginatedLeaderboard(
  interaction: ChatInputCommandInteraction,
  rows: ReadonlyArray<LeaderboardRow>,
): Promise<void> {
  const totalPages = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
  let page = 0;

  const reply = await interaction.editReply({
    embeds: [buildLeaderboardPageEmbed(rows, page, totalPages)],
    components: totalPages > 1 ? [buildLeaderboardButtons(page, totalPages)] : [],
  });

  if (totalPages <= 1) return;

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      i.user.id === interaction.user.id &&
      (i.customId === "leaderboard_prev" || i.customId === "leaderboard_next"),
    time: 5 * 60_000,
  });

  collector.on("collect", async (btn) => {
    if (btn.customId === "leaderboard_next") {
      page = Math.min(totalPages - 1, page + 1);
    } else {
      page = Math.max(0, page - 1);
    }
    await btn
      .update({
        embeds: [buildLeaderboardPageEmbed(rows, page, totalPages)],
        components: [buildLeaderboardButtons(page, totalPages)],
      })
      .catch(() => null);
  });

  collector.on("end", async () => {
    await interaction.editReply({ components: [] }).catch(() => null);
  });
}

export async function handleMerits(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  const target = interaction.options.getUser("user");

  if (target) {
    const total = await getMemberTotal(target.id);
    const embed = new EmbedBuilder()
      .setTitle("JARVIS // PERSONNEL MERIT RECORD")
      .setDescription("Current standing for the selected personnel.")
      .setColor(FIRE_RED)
      .addFields(
        { name: "PERSONNEL", value: target.tag, inline: true },
        { name: "TOTAL MERITS", value: `**${total}**`, inline: true },
      )
      .setFooter({ text: "FIRE NATION • MERIT SYSTEM" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const leaderboard = await getLeaderboard();
  if (leaderboard.length === 0) {
    await interaction.editReply("No merits have been recorded yet.");
    return;
  }

  await sendPaginatedLeaderboard(interaction, leaderboard);
}

export async function handleLeaderboard(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const leaderboard = await getLeaderboard();
  if (leaderboard.length === 0) {
    await interaction.editReply("No merits have been recorded yet.");
    return;
  }

  await sendPaginatedLeaderboard(interaction, leaderboard);
}

export async function handleMeritHistory(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const member = await interaction.guild.members.fetch(interaction.user.id);
  try {
    assertCanViewHistory(getActorRank(member));
  } catch (error) {
    const message =
      error instanceof MeritError ? error.message : "Access Denied.";
    await interaction.editReply({ content: message });
    return;
  }

  const target = interaction.options.getUser("user") ?? interaction.user;
  const history = await getMemberHistory(target.id);

  if (history.length === 0) {
    await interaction.editReply(
      `No merit history found for **${target.tag}**.`,
    );
    return;
  }

  await sendPaginatedMeritHistory(interaction, target.tag, history);
}

// ─── /resetdata ──────────────────────────────────────────────────────────────

export async function handleResetData(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: "This command can only be used inside a server channel.",
      ephemeral: true,
    });
    return;
  }

  // Captured here so the collector callback below keeps the non-null narrowing
  // the guard above established — TypeScript cannot carry it into a closure.
  const guild = interaction.guild;

  const member = await guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({
      content:
        "Access Denied — only the Owner or Fire Lord can reset system data.",
      ephemeral: true,
    });
    return;
  }

  const confirmBtn = new ButtonBuilder()
    .setCustomId("confirm_reset")
    .setLabel("Yes, Reset Everything")
    .setStyle(ButtonStyle.Danger);
  const cancelBtn = new ButtonBuilder()
    .setCustomId("cancel_reset")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    confirmBtn,
    cancelBtn,
  );

  await interaction.reply({
    content:
      "⚠️ **ARE YOU SURE?** This permanently wipes all merit data. A full backup will be generated first.",
    components: [row],
    ephemeral: true,
  });

  const collector = interaction.channel.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      i.user.id === interaction.user.id &&
      (i.customId === "confirm_reset" || i.customId === "cancel_reset"),
    time: 30_000,
  });

  collector.on("collect", async (btn) => {
    try {
      if (btn.customId === "confirm_reset") {
        await btn.deferUpdate();

        assertCanManageData(getActorRank(member));
        const { entries } = await resetAllData(guild.id);
        const backupEmbed = await auditReset(
          interaction.client,
          entries,
          interaction.user.tag,
        );

        await interaction.editReply({
          content: "✅ **ALL MERIT DATA HAS BEEN RESET.**",
          embeds: [backupEmbed],
          components: [],
        });
        collector.stop("done");
      } else {
        await btn.update({
          content: "❌ Data reset cancelled.",
          components: [],
        });
        collector.stop("cancelled");
      }
    } catch (e) {
      logger.error({ err: e }, "Error in resetdata collector");
      await interaction
        .editReply({
          content: "❌ An error occurred during the data reset.",
          components: [],
        })
        .catch(() => null);
    }
  });

  collector.on("end", async (_, reason) => {
    if (reason === "time") {
      await interaction
        .editReply({
          content: "⏱️ Confirmation timed out. Data reset cancelled.",
          components: [],
        })
        .catch(() => null);
    }
  });
}
