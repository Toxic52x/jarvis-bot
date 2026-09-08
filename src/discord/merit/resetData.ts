import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { desc, sql } from "drizzle-orm";
import { FIRE_RED } from "../../config";
import { db, meritAwardsTable } from "../../lib/db";
import { canManageJarvis } from "../permissions";
import { logger } from "../../lib/logger";

/**
 * Exports every merit record, then deletes all of them. Both the /resetdata
 * slash command and the reset_merit_data conversational tool go through
 * here. Merit is one shared ledger across every server Jarvis is in (by
 * deliberate choice, not an oversight) — this wipes ALL of it regardless of
 * which server the command was run from. `guildId` is kept only so the log
 * line below records where the reset was triggered from.
 */
export async function exportAndResetMeritData(
  guildId: string,
  executedByTag: string,
): Promise<{ backupEmbed: EmbedBuilder; backupLines: string }> {
  const full = await db
    .select({
      memberId: meritAwardsTable.memberId,
      memberTag: sql<string>`(array_agg(${meritAwardsTable.memberTag} order by ${meritAwardsTable.createdAt} desc))[1]`,
      total: sql<number>`sum(${meritAwardsTable.amount})`,
    })
    .from(meritAwardsTable)
    .groupBy(meritAwardsTable.memberId)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`));

  const backupLines =
    full.length > 0
      ? full
          .map(
            (e, i) =>
              `[ID: ${e.memberId}] #${i + 1} ${e.memberTag} — ${Number(e.total)} merits`,
          )
          .join("\n")
      : "No data recorded prior to reset.";

  const richBackupLines =
    full.length > 0
      ? full
          .map(
            (e, i) =>
              `\`[ID: ${e.memberId}]\` **#${i + 1}** ${e.memberTag} — **${Number(e.total)}** merits`,
          )
          .join("\n")
      : "No data recorded prior to reset.";

  const backupEmbed = new EmbedBuilder()
    .setTitle("JARVIS // SYSTEM DATA BACKUP & RESET EXPORT")
    .setDescription(
      `**DATA BACKUP AT RESET**\n\n${richBackupLines.slice(0, 4000)}`,
    )
    .setColor(FIRE_RED)
    .setFooter({ text: `RESET EXECUTED BY ${executedByTag}` })
    .setTimestamp();

  await db.delete(meritAwardsTable);

  logger.info(
    { triggeredFromGuildId: guildId, exported: full.length },
    "Merit data reset (global — every server's data)",
  );

  return { backupEmbed, backupLines };
}

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

        const { backupEmbed } = await exportAndResetMeritData(
          guild.id,
          interaction.user.tag,
        );

        const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
        if (logId) {
          const ch = await interaction.client.channels
            .fetch(logId)
            .catch(() => null);
          if (ch && ch.isTextBased() && "send" in ch) {
            await ch
              .send({ embeds: [backupEmbed] })
              .catch((e) => logger.warn({ err: e }, "Backup send failed"));
          }
        }

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
