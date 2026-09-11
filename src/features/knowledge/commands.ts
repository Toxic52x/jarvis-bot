import type { ChatInputCommandInteraction } from "discord.js";
import { appendFileSync } from "node:fs";
import { rankAtLeast } from "../../discord/permissions";
import { logger } from "../../lib/logger";
import { KNOWLEDGE_FILE_PATH, cachedKnowledge, loadKnowledge } from "./service";

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
