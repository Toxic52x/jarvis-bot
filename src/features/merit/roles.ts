import type { ChatInputCommandInteraction } from "discord.js";
import {
  ADVISOR_ROLE_NAME,
  HR_ROLE_NAME,
  ROYALTY_ROLE_NAME,
} from "../../config";
import { canManageJarvis, rankAtLeast } from "../../discord/permissions";
import { logger } from "../../lib/logger";

export async function handleCreateHr(
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

  try {
    const existing = interaction.guild.roles.cache.find(
      (r) => r.name === HR_ROLE_NAME,
    );
    if (existing) {
      await interaction.editReply(
        `The ${HR_ROLE_NAME} role already exists: ${existing}. Jarvis will recognize it.`,
      );
      return;
    }
    const role = await interaction.guild.roles.create({
      name: HR_ROLE_NAME,
      permissions: [],
      reason: "Jarvis HR rank created by an authorized administrator",
    });
    await interaction.editReply(
      `Created ${role} with no elevated Discord permissions. Assign it to HR members.`,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The HR role could not be created.";
    logger.warn(
      { err: error, userId: interaction.user.id },
      "HR role creation failed",
    );
    await interaction.editReply(`Could not create the HR role: ${message}`);
  }
}

export async function handleCreateRoyalty(
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
  if (!canManageJarvis(member)) {
    await interaction.reply({
      content: "Only the Owner or Fire Lord can create the Royalty role.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const existing = interaction.guild.roles.cache.find(
      (r) => r.name === ROYALTY_ROLE_NAME,
    );
    if (existing) {
      await interaction.editReply(
        `The ${ROYALTY_ROLE_NAME} role already exists: ${existing}. Jarvis will recognize it.`,
      );
      return;
    }
    const role = await interaction.guild.roles.create({
      name: ROYALTY_ROLE_NAME,
      permissions: [],
      reason: "Jarvis Royalty rank created by an authorized administrator",
    });
    await interaction.editReply(
      `Created ${role} with no elevated Discord permissions. Assign it to Royalty members.`,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Royalty role could not be created.";
    logger.warn(
      { err: error, userId: interaction.user.id },
      "Royalty role creation failed",
    );
    await interaction.editReply(
      `Could not create the Royalty role: ${message}`,
    );
  }
}

export async function handleCreateAdvisor(
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
  if (!rankAtLeast(member, "royalty")) {
    await interaction.editReply({
      content: "Access Denied — Royalty and above only.",
    });
    return;
  }

  try {
    const existing = interaction.guild.roles.cache.find(
      (r) => r.name === ADVISOR_ROLE_NAME,
    );
    if (existing) {
      await interaction.editReply(
        `The ${ADVISOR_ROLE_NAME} role already exists: ${existing}. Jarvis will recognize it.`,
      );
      return;
    }
    const role = await interaction.guild.roles.create({
      name: ADVISOR_ROLE_NAME,
      permissions: [],
      reason: "Jarvis Advisor rank created by an authorized administrator",
    });
    await interaction.editReply(
      `Created ${role} with no elevated Discord permissions. Assign it to Advisors.`,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Advisor role could not be created.";
    logger.warn(
      { err: error, userId: interaction.user.id },
      "Advisor role creation failed",
    );
    await interaction.editReply(
      `Could not create the Advisor role: ${message}`,
    );
  }
}
