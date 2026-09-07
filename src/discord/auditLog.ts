import { EmbedBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, GuildMember } from "discord.js";
import { FIRE_RED } from "../config";
import { logger } from "../lib/logger";

/** Writes a generic audit embed to the owner log channel. Never throws. */
export async function writeGenericAuditLog(
  client: Client,
  title: string,
  fields: { name: string; value: string; inline?: boolean }[],
  actorTag: string,
): Promise<void> {
  const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logId) {
    logger.warn(
      { title },
      "No DISCORD_OWNER_LOG_CHANNEL_ID configured — action was not logged",
    );
    return;
  }
  const ch = await client.channels.fetch(logId).catch(() => null);
  if (!ch || !ch.isTextBased() || !("send" in ch)) {
    logger.warn({ logId }, "Owner log channel not found or not writable");
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(FIRE_RED)
    .addFields(...fields, { name: "AUTHORIZED BY", value: actorTag })
    .setFooter({ text: "FIRE NATION • CONVERSATIONAL ACTION LOG" })
    .setTimestamp();
  await ch
    .send({ embeds: [embed] })
    .catch((e) =>
      logger.error({ err: e, title }, "Generic audit log send failed"),
    );
}

export async function writeOwnerAuditLog(
  interaction: ChatInputCommandInteraction,
  members: GuildMember[],
  amount: number,
  meritType: string,
  actorRank: string,
): Promise<void> {
  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logChannelId)
    throw new Error(
      "Owner audit channel not configured. Set DISCORD_OWNER_LOG_CHANNEL_ID.",
    );

  const channel = await interaction.client.channels
    .fetch(logChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel))
    throw new Error("Audit channel not found or not writable.");

  const memberLines = members
    .map((m) => `• ${m.user.tag} (${m.id}) — **+${amount}**`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // MERIT AWARD AUDIT")
    .setDescription("A merit transaction has been authorized and recorded.")
    .setColor(FIRE_RED)
    .addFields(
      { name: "RECIPIENTS", value: memberLines.slice(0, 1024) },
      {
        name: "MERIT VALUE",
        value: `**+${amount}** merit${amount === 1 ? "" : "s"} per recipient`,
        inline: true,
      },
      { name: "TYPE", value: meritType, inline: true },
      {
        name: "AUTHORIZED BY",
        value: `${interaction.user.tag} (${interaction.user.id})`,
      },
    )
    .setFooter({ text: "FIRE NATION • OWNER AUDIT CHANNEL" })
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  // Ping @everyone when a Bonus of more than 3 is awarded — flags it for owner review
  if (meritType === "Bonus" && amount > 3) {
    await channel.send({
      content: `@everyone — HR member **${interaction.user.tag}** has awarded a **+${amount} Bonus**. Owner review requested.`,
      allowedMentions: { parse: ["everyone"] },
    });
  }
}
