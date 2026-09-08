import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { desc, eq, sql } from "drizzle-orm";
import { FIRE_ORANGE, FIRE_RED } from "../../config";
import { db, meritAwardsTable } from "../../lib/db";
import { rankAtLeast } from "../permissions";

export const LEADERBOARD_PAGE_SIZE = 15;

export function buildLeaderboardPageEmbed(
  rows: ReadonlyArray<{ memberTag: string; total: number }>,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const start = page * LEADERBOARD_PAGE_SIZE;
  const pageRows = rows.slice(start, start + LEADERBOARD_PAGE_SIZE);
  const lines = pageRows.map(
    (e, i) =>
      `**${String(start + i + 1).padStart(2, "0")}**  ${e.memberTag.slice(0, 45)}  —  **${Number(e.total)}**`,
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
  rows: ReadonlyArray<{ amount: number; proofUrl: string; createdAt: Date }>,
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
  rows: ReadonlyArray<{ amount: number; proofUrl: string; createdAt: Date }>,
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
  rows: ReadonlyArray<{ memberTag: string; total: number }>,
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
    // Merit is one shared ledger across every server Jarvis is in — not
    // filtered by guildId, by design (see git history if this looks wrong).
    const [result] = await db
      .select({
        total: sql<number>`coalesce(sum(${meritAwardsTable.amount}), 0)`,
      })
      .from(meritAwardsTable)
      .where(eq(meritAwardsTable.memberId, target.id));

    const total = Number(result?.total ?? 0);
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

const leaderboard = await db
  .select({
    memberId: meritAwardsTable.memberId,
    // Grouping by memberTag alongside memberId used to silently split one
    // person into two leaderboard lines whenever a row's stored tag didn't
    // match exactly (e.g. a Discord username change, or a manually-restored
    // row using a different tag format) — group by memberId alone and take
    // the most recently recorded tag, so totals always merge correctly.
    memberTag: sql<string>`(array_agg(${meritAwardsTable.memberTag} order by ${meritAwardsTable.createdAt} desc))[1]`,
    total: sql<number>`sum(${meritAwardsTable.amount})`,
  })
  .from(meritAwardsTable)
  .groupBy(meritAwardsTable.memberId)
  .orderBy(desc(sql`sum(${meritAwardsTable.amount})`));

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

  const leaderboard = await db
    .select({
      memberTag: sql<string>`(array_agg(${meritAwardsTable.memberTag} order by ${meritAwardsTable.createdAt} desc))[1]`,
      total: sql<number>`sum(${meritAwardsTable.amount})`,
    })
    .from(meritAwardsTable)
    .groupBy(meritAwardsTable.memberId)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`));

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
  if (!rankAtLeast(member, "hr")) {
    await interaction.editReply({
      content: "Access Denied — HR and above only.",
    });
    return;
  }

  const target = interaction.options.getUser("user") ?? interaction.user;

  const history = await db
    .select()
    .from(meritAwardsTable)
    .where(eq(meritAwardsTable.memberId, target.id))
    .orderBy(desc(meritAwardsTable.createdAt));

  if (history.length === 0) {
    await interaction.editReply(
      `No merit history found for **${target.tag}**.`,
    );
    return;
  }

  await sendPaginatedMeritHistory(interaction, target.tag, history);
}
