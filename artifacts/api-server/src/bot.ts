import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { desc, eq, sql } from "drizzle-orm";
import { db, meritAwardsTable } from "@workspace/db";
import { logger } from "./lib/logger";
import OpenAI from "openai"; // Added OpenAI import

const MAX_MEMBERS_PER_AWARD = 25;
const MAX_MERITS_PER_COMMAND = 7;
const HR_ROLE_NAME = "HR";
const FIRE_RED = 0xb91c1c;
const FIRE_ORANGE = 0xf97316;
const DISCORD_MESSAGE_URL =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord\.com|discordapp\.com)\/channels\/\d+\/\d+\/\d+(?:[/?#].*)?$/i;

// Initialize OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Tracks users who triggered "Jarvis" and are awaiting a follow-up command
const activePromptSessions = new Set<string>();

const addMeritCommand = new SlashCommandBuilder()
  .setName("addmerit")
  .setDescription("Award merits to one or more members using a Discord proof link.")
  .addStringOption((option) =>
    option
      .setName("users")
      .setDescription(
        "Comma-separated mentions, IDs, or exact display names (maximum 25).",
      )
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("amount")
      .setDescription("Number of merits to award to each member.")
      .setMinValue(1)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("proof")
      .setDescription("Link to the Discord message proving the award.")
      .setRequired(true),
  );

const meritsCommand = new SlashCommandBuilder()
  .setName("merits")
  .setDescription("View a member's global merit total or the global leaderboard.")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member to look up. Leave empty for the global leaderboard."),
  );

const historyCommand = new SlashCommandBuilder()
  .setName("merithistory")
  .setDescription("View a member's recent global merit awards.")
  .addUserOption((option) =>
    option.setName("user").setDescription("The member whose history to view."),
  );

const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the global top 30 members by merit total.");

const createHrCommand = new SlashCommandBuilder()
  .setName("createhr")
  .setDescription("Create the Jarvis HR role with no elevated Discord permissions.");

const resetDataCommand = new SlashCommandBuilder()
  .setName("resetdata")
  .setDescription("Wipe all global merit data. Exports a backup leaderboard before resetting.");

const staydownCommand = new SlashCommandBuilder()
  .setName("staydown")
  .setDescription("Acknowledge breach, clear alarm, and unlock the audit channel.");

function getConfiguredIds(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

type JarvisRank = "owner" | "second" | "hr" | "none";

function getJarvisRank(member: GuildMember): JarvisRank {
  const hrRoleIds = getConfiguredIds("DISCORD_HR_ROLE_IDS");
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  const secondInCommandIds = getConfiguredIds(
    "DISCORD_SECOND_IN_COMMAND_USER_IDS",
  );

  if (ownerIds.has(member.id)) {
    return "owner";
  }

  if (secondInCommandIds.has(member.id)) {
    return "second";
  }

  if (
    [...hrRoleIds].some((roleId) => member.roles.cache.has(roleId)) ||
    member.roles.cache.some((role) => role.name === HR_ROLE_NAME)
  ) {
    return "hr";
  }

  return "none";
}

function canAwardMerits(member: GuildMember): boolean {
  const rank = getJarvisRank(member);
  return rank === "owner" || rank === "second" || rank === "hr";
}

function canManageJarvis(member: GuildMember): boolean {
  const rank = getJarvisRank(member);
  return rank === "owner" || rank === "second";
}

function parseUserReferences(rawUsers: string): string[] {
  const references = rawUsers
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (references.length === 0) {
    throw new Error("Add at least one member.");
  }

  if (references.length > MAX_MEMBERS_PER_AWARD) {
    throw new Error(`You can award at most ${MAX_MEMBERS_PER_AWARD} members at once.`);
  }

  return [...new Set(references)];
}

function getMemberIdFromReference(reference: string): string | null {
  const mention = reference.match(/^<@!?(\d+)>$/);
  if (mention) {
    return mention[1];
  }

  return /^\d+$/.test(reference) ? reference : null;
}

async function resolveMembers(
  interaction: ChatInputCommandInteraction,
  rawUsers: string,
): Promise<GuildMember[]> {
  if (!interaction.guild) {
    throw new Error("This command can only be used inside a server.");
  }

  const references = parseUserReferences(rawUsers);
  const members: GuildMember[] = [];

  for (const reference of references) {
    const memberId = getMemberIdFromReference(reference);
    if (memberId) {
      const member = await interaction.guild.members.fetch(memberId).catch(() => null);
      if (!member) {
        throw new Error(`I could not find member \`${reference}\`.`);
      }
      members.push(member);
      continue;
    }

    const matches = await interaction.guild.members.fetch({
      query: reference,
      limit: 10,
    });
    const normalizedReference = reference.toLowerCase();
    const exactMatch = matches.find(
      (member) =>
        member.user.username.toLowerCase() === normalizedReference ||
        member.user.globalName?.toLowerCase() === normalizedReference ||
        member.displayName.toLowerCase() === normalizedReference,
    );

    if (!exactMatch) {
      throw new Error(
        `I could not find \`${reference}\`. Use a member mention or exact display name.`,
      );
    }

    members.push(exactMatch);
  }

  return members;
}

function validateProofUrl(proof: string): string {
  const trimmedProof = proof.trim();
  if (!DISCORD_MESSAGE_URL.test(trimmedProof)) {
    throw new Error(
      "Proof must be a full Discord message link, such as https://discord.com/channels/server/channel/message.",
    );
  }

  return trimmedProof;
}

function buildLeaderboardEmbed(
  leaderboard: ReadonlyArray<{ memberTag: string; total: number }>,
): EmbedBuilder {
  const lines = leaderboard.map(
    (entry, index) =>
      `**${String(index + 1).padStart(2, "0")}** ${entry.memberTag.slice(0, 45)}  —  **${Number(entry.total)}**`,
  );

  return new EmbedBuilder()
    .setTitle("JARVIS // GLOBAL MERIT RANKINGS")
    .setDescription(
      `**TOP PERSONNEL RANKING (UNIVERSAL)**\n\n${lines.join("\n")}`,
    )
    .setColor(FIRE_RED)
    .setFooter({ text: "FIRE NATION • UNIVERSAL MERIT SYSTEM" })
    .setTimestamp();
}

async function awardMerits(
  interaction: ChatInputCommandInteraction,
  members: GuildMember[],
  amount: number,
  proofUrl: string,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("This command can only be used inside a server.");
  }

  await db.transaction(async (tx) => {
    await tx.insert(meritAwardsTable).values(
      members.map((member) => ({
        guildId: interaction.guild!.id,
        memberId: member.id,
        memberTag: member.user.tag,
        amount,
        proofUrl,
        awardedById: interaction.user.id,
        awardedByTag: interaction.user.tag,
      })),
    );
  });
}

async function writeOwnerAuditLog(
  interaction: ChatInputCommandInteraction,
  members: GuildMember[],
  amount: number,
  proofUrl: string,
): Promise<void> {
  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logChannelId) {
    throw new Error(
      "The owner audit channel is not configured. Set DISCORD_OWNER_LOG_CHANNEL_ID before awarding merits.",
    );
  }

  const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error("The configured owner audit channel could not be found or is not writable.");
  }

  const memberLines = members
    .map((member) => `• ${member.user.tag} (${member.id}) — **+${amount}**`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // MERIT AWARD AUDIT")
    .setDescription("A global merit transaction has been authorized and recorded.")
    .setColor(FIRE_RED)
    .addFields(
      { name: "SERVER", value: `${interaction.guild?.name ?? "Unknown"} (${interaction.guild?.id})` },
      { name: "RECIPIENTS", value: memberLines.slice(0, 1024) },
      {
        name: "MERIT VALUE",
        value: `**+${amount}** merit${amount === 1 ? "" : "s"} per recipient`,
        inline: true,
      },
      { name: "PROOF OF ACTION", value: proofUrl, inline: true },
      {
        name: "AUTHORIZED BY",
        value: `${interaction.user.tag} (${interaction.user.id})`,
      },
    )
    .setFooter({ text: "FIRE NATION • OWNER AUDIT CHANNEL" })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function handleAddMerit(
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
  if (!canAwardMerits(member)) {
    await interaction.reply({
      content: "Access Denied: Only the Owner, Fire Lord, or members with the HR role can award merits.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const rawUsers = interaction.options.getString("users", true);
    const amount = interaction.options.getInteger("amount", true);
    const actorRank = getJarvisRank(member);

    if (actorRank === "hr" && amount > MAX_MERITS_PER_COMMAND) {
      throw new Error(
        `HR personnel can award a maximum of ${MAX_MERITS_PER_COMMAND} merits per recipient.`,
      );
    }

    const proofUrl = validateProofUrl(
      interaction.options.getString("proof", true),
    );
    const members = await resolveMembers(interaction, rawUsers);
    const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

    if (
      actorRank === "second" &&
      members.some((recipient) => ownerIds.has(recipient.id))
    ) {
      throw new Error("Fire Lord cannot run merit commands that affect the Owner.");
    }

    await awardMerits(interaction, members, amount, proofUrl);
    await writeOwnerAuditLog(interaction, members, amount, proofUrl);

    await interaction.editReply(
      `Recorded **+${amount}** global merit${amount === 1 ? "" : "s"} for ${members.length} member${members.length === 1 ? "" : "s"} and logged proof.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The merit award failed.";
    logger.warn({ err: error, userId: interaction.user.id }, "Merit award rejected");
    await interaction.editReply(`Could not record the award: ${message}`);
  }
}

async function handleCreateHr(
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
      content: "Only the Owner or Fire Lord can create the HR role.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const existingRole = interaction.guild.roles.cache.find(
      (role) => role.name === HR_ROLE_NAME,
    );
    if (existingRole) {
      await interaction.editReply(
        `The ${HR_ROLE_NAME} role already exists: ${existingRole}. Jarvis will recognize it for limited bot access.`,
      );
      return;
    }

    const role = await interaction.guild.roles.create({
      name: HR_ROLE_NAME,
      permissions: [],
      reason: "Jarvis HR rank created by an authorized administrator",
    });
    await interaction.editReply(
      `Created ${role} with no elevated Discord permissions. Assign it to HR members to grant Jarvis HR access.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The HR role could not be created.";
    logger.warn({ err: error, userId: interaction.user.id }, "HR role creation failed");
    await interaction.editReply(`Could not create the HR role: ${message}`);
  }
}

async function handleMerits(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const target = interaction.options.getUser("user");

  if (target) {
    const [result] = await db
      .select({
        total: sql<number>`coalesce(sum(${meritAwardsTable.amount}), 0)`,
      })
      .from(meritAwardsTable)
      .where(eq(meritAwardsTable.memberId, target.id));

    const total = Number(result?.total ?? 0);
    const embed = new EmbedBuilder()
      .setTitle("JARVIS // PERSONNEL MERIT RECORD")
      .setDescription("Global standing for the selected personnel.")
      .setColor(FIRE_RED)
      .addFields(
        { name: "PERSONNEL", value: target.tag, inline: true },
        {
          name: "TOTAL MERITS (GLOBAL)",
          value: `**${total}**`,
          inline: true,
        },
      )
      .setFooter({ text: "FIRE NATION • UNIVERSAL MERIT SYSTEM" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const leaderboard = await db
    .select({
      memberId: meritAwardsTable.memberId,
      memberTag: meritAwardsTable.memberTag,
      total: sql<number>`sum(${meritAwardsTable.amount})`,
    })
    .from(meritAwardsTable)
    .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`))
    .limit(30);

  if (leaderboard.length === 0) {
    await interaction.editReply("No global merits have been recorded yet.");
    return;
  }

  await interaction.editReply({ embeds: [buildLeaderboardEmbed(leaderboard)] });
}

async function handleLeaderboard(
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
      memberTag: meritAwardsTable.memberTag,
      total: sql<number>`sum(${meritAwardsTable.amount})`,
    })
    .from(meritAwardsTable)
    .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`))
    .limit(30);

  if (leaderboard.length === 0) {
    await interaction.editReply("No global merits have been recorded yet.");
    return;
  }

  await interaction.editReply({ embeds: [buildLeaderboardEmbed(leaderboard)] });
}

async function handleMeritHistory(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("user") ?? interaction.user;

  const history = await db
    .select()
    .from(meritAwardsTable)
    .where(eq(meritAwardsTable.memberId, target.id))
    .orderBy(desc(meritAwardsTable.createdAt))
    .limit(10);

  if (history.length === 0) {
    await interaction.editReply(`No global merit history found for **${target.tag}**.`);
    return;
  }

  const lines = history.map(
    (award) =>
      `**+${award.amount}** •  [Proof of action](${award.proofUrl})  •  <t:${Math.floor(award.createdAt.getTime() / 1000)}:R>`,
  );
  const embed = new EmbedBuilder()
    .setTitle("JARVIS // GLOBAL MERIT HISTORY")
    .setDescription(
      `**PERSONNEL:** ${target.tag}\n\n${lines.join("\n")}`,
    )
    .setColor(FIRE_ORANGE)
    .setFooter({ text: "FIRE NATION • VERIFIED GLOBAL HISTORY" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleResetData(
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
      content: "Access Denied: Only the Owner or Fire Lord can reset system data.",
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);

  await interaction.reply({
    content: "⚠️ **ARE YOU SURE YOU WANT TO RESET ALL MERIT DATA?**\nThis will permanently wipe all user merits across every server. A full backup leaderboard will be generated before wipe.",
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

  collector.on("collect", async (buttonInteraction) => {
    try {
      if (buttonInteraction.customId === "confirm_reset") {
        await buttonInteraction.deferUpdate();

        const fullLeaderboard = await db
          .select({
            memberId: meritAwardsTable.memberId,
            memberTag: meritAwardsTable.memberTag,
            total: sql<number>`sum(${meritAwardsTable.amount})`,
          })
          .from(meritAwardsTable)
          .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
          .orderBy(desc(sql`sum(${meritAwardsTable.amount})`));

        const backupLines = fullLeaderboard.length > 0
          ? fullLeaderboard.map(
              (e, i) => `\`[ID: ${e.memberId}]\` **#${i + 1}** ${e.memberTag} — **${Number(e.total)}** merits`,
            ).join("\n")
          : "No data was recorded prior to reset.";

        const backupEmbed = new EmbedBuilder()
          .setTitle("JARVIS // SYSTEM DATA BACKUP & RESET EXPORT")
          .setDescription(`**DATA BACKUP CREATED AT RESET**\n\n${backupLines.slice(0, 4000)}`)
          .setColor(FIRE_RED)
          .setFooter({ text: `RESET EXECUTED BY ${interaction.user.tag}` })
          .setTimestamp();

        const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
        if (logChannelId) {
          const auditChannel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
          if (auditChannel && auditChannel.isTextBased() && "send" in auditChannel) {
            await auditChannel.send({ embeds: [backupEmbed] }).catch((err) => {
              logger.warn({ err }, "Failed to send backup to audit channel");
            });
          }
        }

        await db.delete(meritAwardsTable);

        await interaction.editReply({
          content: "✅ **ALL MERIT DATA HAS BEEN RESET.** Below is your final restore backup log:",
          embeds: [backupEmbed],
          components: [],
        });
        collector.stop("reset_completed");
      } else {
        await buttonInteraction.update({
          content: "❌ Data reset operation cancelled.",
          components: [],
        });
        collector.stop("reset_cancelled");
      }
    } catch (err) {
      logger.error({ err }, "Failed inside resetdata collector handler");
      await interaction.editReply({
        content: "❌ An error occurred while executing the data reset.",
        components: [],
      }).catch(() => null);
    }
  });

  collector.on("end", async (_, reason) => {
    if (reason === "time") {
      await interaction.editReply({
        content: "⏱️ Confirmation timed out. Data reset cancelled.",
        components: [],
      }).catch(() => null);
    }
  });
}

async function handleStaydown(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({
      content: "Access Denied: Only the Owner or Fire Lord can silence alarms and unlock the channel.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    if ("permissionOverwrites" in interaction.channel) {
      await interaction.channel.permissionOverwrites.edit(
        interaction.guild.roles.everyone,
        { 
          ViewChannel: null, 
          SendMessages: null 
        },
      );
    }

    await interaction.editReply(
      `🟢 **SECURITY LOCKDOWN LIFTED:** ${interaction.user.tag} acknowledged the breach and unlocked the channel.`,
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to unlock channel");
    await interaction.editReply("❌ Failed to restore channel permissions.");
  }
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "addmerit") {
    await handleAddMerit(interaction);
  } else if (interaction.commandName === "createhr") {
    await handleCreateHr(interaction);
  } else if (interaction.commandName === "merits") {
    await handleMerits(interaction);
  } else if (interaction.commandName === "leaderboard") {
    await handleLeaderboard(interaction);
  } else if (interaction.commandName === "merithistory") {
    await handleMeritHistory(interaction);
  } else if (interaction.commandName === "resetdata") {
    await handleResetData(interaction);
  } else if (interaction.commandName === "staydown") {
    await handleStaydown(interaction);
  }
}

export async function startBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Jarvis will not start.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    const commands = [
      addMeritCommand.toJSON(),
      meritsCommand.toJSON(),
      historyCommand.toJSON(),
      leaderboardCommand.toJSON(),
      createHrCommand.toJSON(),
      resetDataCommand.toJSON(),
      staydownCommand.toJSON(),
    ];
    const rest = new REST({ version: "10" }).setToken(token);

    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: commands,
    });
    logger.info("Jarvis commands registered globally across all servers.");

    logger.info({ botUser: readyClient.user.tag }, "Jarvis connected to Discord");
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction as ChatInputCommandInteraction).catch((error) => {
      logger.error({ err: error }, "Discord interaction failed");
    });
  });

  // Updated Conversation Listener for Owner & Second in Command connected to OpenAI
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot || !message.guild || !message.member) return;

      const rank = getJarvisRank(message.member);
      // Only Owner and Second in Command trigger this conversation
      if (rank !== "owner" && rank !== "second") return;

      const trimmedText = message.content.trim();

      // Check if the user has an active session (sent "Jarvis" in previous message)
      if (activePromptSessions.has(message.author.id)) {
        activePromptSessions.delete(message.author.id);

        // Show typing indicator while calling OpenAI
        await message.channel.sendTyping();

        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are Jarvis, a sophisticated, polite, and helpful AI assistant." },
              { role: "user", content: trimmedText }
            ],
          });

          const aiReply = completion.choices[0]?.message?.content ?? "I apologize, Sir, but I couldn't generate a response.";

          // Split response if it goes over Discord's 2000 character limit
          if (aiReply.length > 2000) {
            for (let i = 0; i < aiReply.length; i += 2000) {
              await message.reply(aiReply.slice(i, i + 2000));
            }
          } else {
            await message.reply(aiReply);
          }
        } catch (apiError) {
          logger.error({ err: apiError }, "OpenAI API request failed");
          await message.reply("I encountered an error communicating with my neural core, Sir.");
        }
        return;
      }

      // Check if message is exactly "Jarvis" (case-insensitive)
      if (trimmedText.toLowerCase() === "jarvis") {
        activePromptSessions.add(message.author.id);
        await message.reply("Yes, Sir?");
      }
    } catch (error) {
      logger.error({ err: error }, "Error handling conversational prompt");
    }
  });

  client.on(Events.MessageDelete, async (message) => {
    try {
      const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
      if (!logChannelId || message.channelId !== logChannelId) return;

      const channel = message.channel;
      if (
        channel.isTextBased() &&
        "send" in channel &&
        "permissionOverwrites" in channel &&
        message.guild
      ) {
        await channel.permissionOverwrites.edit(
          message.guild.roles.everyone,
          { 
            ViewChannel: false, 
            SendMessages: false 
          },
        );

        const authorMention = message.author
          ? `<@${message.author.id}> (${message.author.tag})`
          : "An unknown user";

        const breachEmbed = new EmbedBuilder()
          .setTitle("🚨 SYSTEM BREACH DETECTED — CHANNEL LOCKED")
          .setDescription(
            `**A MESSAGE WAS DELETED FROM THE AUDIT LOGS!**\n\n` +
            `**Target User:** ${authorMention}\n` +
            `**Status:** 🔒 CHANNEL LOCKED DOWN\n\n` +
            `An Owner or Fire Lord must run \`/staydown\` to acknowledge the breach and unlock this channel.`
          )
          .setColor(FIRE_RED)
          .setTimestamp();

        await channel.send({
          content: "@everyone",
          embeds: [breachEmbed],
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to process deleted message in audit log channel");
    }
  });

  await client.login(token);
}