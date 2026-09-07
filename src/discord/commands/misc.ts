import type { ChatInputCommandInteraction } from "discord.js";
import { appendFileSync } from "node:fs";
import {
  KNOWLEDGE_FILE_PATH,
  cachedKnowledge,
  loadKnowledge,
} from "../knowledge";
import { canManageJarvis, rankAtLeast } from "../permissions";
import { logger } from "../../lib/logger";

/**
 * Acknowledges a breach alert and restores the audit channel's permissions.
 *
 * The guard below used to `return` without replying at all, which leaves the
 * user staring at "The application did not respond" whenever /staydown is run
 * somewhere Jarvis can't resolve a guild+channel. The interaction is now always
 * acknowledged before we bail.
 */
export async function handleStaydown(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: "This command can only be used inside a server channel.",
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({
      content:
        "Access Denied — only the Owner or Fire Lord can silence alarms.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  try {
    if ("permissionOverwrites" in interaction.channel) {
      await interaction.channel.permissionOverwrites.edit(
        interaction.guild.roles.everyone,
        { ViewChannel: null, SendMessages: null },
      );
    }
    await interaction.editReply(
      `🟢 **LOCKDOWN LIFTED:** ${interaction.user.tag} acknowledged the breach and restored the channel.`,
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to unlock channel");
    await interaction.editReply("❌ Failed to restore channel permissions.");
  }
}

export async function handleAddKnowledge(
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
    const entry = interaction.options.getString("entry", true).trim();
    if (!entry) throw new Error("Entry cannot be empty.");

    const timestamp = new Date().toISOString();
    const line = `\n[Added ${timestamp} by ${interaction.user.tag}] ${entry}\n`;

    appendFileSync(KNOWLEDGE_FILE_PATH, line, "utf-8");
    const reloaded = loadKnowledge();

    await interaction.editReply(
      `Knowledge base updated, Sir. Entry added and reloaded (${reloaded.length} characters total).`,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update the knowledge base.";
    logger.warn(
      { err: error, userId: interaction.user.id },
      "addknowledge failed",
    );
    await interaction.editReply(
      `Could not add to the knowledge base: ${message}`,
    );
  }
}

export async function handleReloadKnowledge(
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
  const before = cachedKnowledge.length;
  const after = loadKnowledge().length;

  await interaction.editReply(
    after > 0
      ? `Knowledge base reloaded, Sir. (${before} → ${after} characters)`
      : "Knowledge base reload failed, Sir — the file could not be read. Check the server logs.",
  );
}
