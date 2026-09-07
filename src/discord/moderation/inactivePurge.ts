import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { sql as drizzleSql } from "drizzle-orm";
import { FIRE_ORANGE } from "../../config";
import { db, memberActivityTable } from "../../lib/db";
import { rankAtLeast } from "../permissions";
import { logger } from "../../lib/logger";

export async function handleInactivePurge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!rankAtLeast(interaction.member as GuildMember, "advisor")) {
    await interaction.reply({
      content: "Access Denied — Advisor and above only.",
      ephemeral: true,
    });
    return;
  }
  const guild = interaction.guild!;
  const days = interaction.options.getInteger("days", true);
  await interaction.deferReply();

  try {
    const cutoff = new Date(Date.now() - days * 86_400_000);

    // Fetch all current members
    const allMembers = await guild.members.fetch();
    const nonBotIds = [...allMembers.values()]
      .filter((m) => !m.user.bot)
      .map((m) => m.id);

    // Get activity records for this guild
    const activeRecords = await db
      .select({ userId: memberActivityTable.userId })
      .from(memberActivityTable)
      .where(
        drizzleSql`${memberActivityTable.guildId} = ${guild.id} AND ${memberActivityTable.lastSeenAt} >= ${cutoff}`,
      );
    const activeIds = new Set(activeRecords.map((r) => r.userId));

    const inactiveMembers = nonBotIds
      .filter((id) => !activeIds.has(id))
      .map((id) => allMembers.get(id)!)
      .filter(Boolean)
      .slice(0, 30);

    if (inactiveMembers.length === 0) {
      await interaction.editReply(
        `No members found with ${days}+ days of inactivity, Sir.`,
      );
      return;
    }

    const list = inactiveMembers
      .map((m) => `• ${m.user.tag} (${m.id})`)
      .join("\n");
    const embed = new EmbedBuilder()
      .setTitle("JARVIS // INACTIVITY REPORT")
      .setDescription(
        `Members with no recorded activity in the last **${days} day${days === 1 ? "" : "s"}**:\n\n${list}`,
      )
      .setColor(FIRE_ORANGE)
      .setFooter({
        text: `${inactiveMembers.length} member${inactiveMembers.length === 1 ? "" : "s"} flagged — note: only tracks activity since Jarvis came online`,
      })
      .setTimestamp();

    const kickBtn = new ButtonBuilder()
      .setCustomId("purge_kick_confirm")
      .setLabel(`Kick All ${inactiveMembers.length}`)
      .setStyle(ButtonStyle.Danger);
    const cancelBtn = new ButtonBuilder()
      .setCustomId("purge_kick_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      kickBtn,
      cancelBtn,
    );

    const reply = await interaction.editReply({
      embeds: [embed],
      components: [row],
    });

    try {
      const btn = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 30_000,
      });
      if (btn.customId === "purge_kick_confirm") {
        await btn.update({ components: [] });
        let kicked = 0;
        for (const m of inactiveMembers) {
          try {
            await m.kick(
              `Inactivity purge — ${days}d — by ${interaction.user.tag}`,
            );
            kicked++;
          } catch {
            /* skip */
          }
        }
        await interaction.editReply({
          embeds: [
            embed.setDescription(
              `✅ Kicked **${kicked}** inactive member${kicked === 1 ? "" : "s"}.`,
            ),
          ],
          components: [],
        });
      } else {
        await btn.update({
          embeds: [],
          components: [],
          content: "Purge cancelled, Sir.",
        });
      }
    } catch {
      await interaction.editReply({ components: [] });
    }
  } catch (error) {
    logger.error({ err: error }, "inactivepurge failed");
    await interaction
      .editReply(
        "I was unable to complete the inactivity scan, Sir. This usually means the Server Members Intent isn't enabled for my application in the Discord Developer Portal.",
      )
      .catch(() => null);
  }
}
