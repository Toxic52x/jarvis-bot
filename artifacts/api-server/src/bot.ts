import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, meritAwardsTable } from "@workspace/db";
import { logger } from "./lib/logger";

const MAX_MEMBERS_PER_AWARD = 25;
const HR_ROLE_NAME = "HR";
const DISCORD_MESSAGE_URL =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord\.com|discordapp\.com)\/channels\/\d+\/\d+\/\d+(?:[/?#].*)?$/i;

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
      .setMaxValue(100)
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
  .setDescription("View a member's merit total or the server leaderboard.")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member to look up. Leave empty for the leaderboard."),
  );

const historyCommand = new SlashCommandBuilder()
  .setName("merithistory")
  .setDescription("View a member's recent merit awards.")
  .addUserOption((option) =>
    option.setName("user").setDescription("The member whose history to view."),
  );

const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the top 30 members by merit total.");

const createHrCommand = new SlashCommandBuilder()
  .setName("createhr")
  .setDescription("Create the Jarvis HR role with no elevated Discord permissions.");

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
    .setTitle("Merit Award Recorded")
    .setColor(0x4f46e5)
    .addFields(
      { name: "Recipients", value: memberLines.slice(0, 1024) },
      { name: "Proof", value: proofUrl },
      {
        name: "Awarded by",
        value: `${interaction.user.tag} (${interaction.user.id})`,
      },
    )
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
      content: "Only the Owner, Fire Lord, or members with the HR role can award merits.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const rawUsers = interaction.options.getString("users", true);
    const amount = interaction.options.getInteger("amount", true);
    const proofUrl = validateProofUrl(
      interaction.options.getString("proof", true),
    );
    const members = await resolveMembers(interaction, rawUsers);
    const actorRank = getJarvisRank(member);
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
      `Recorded **+${amount}** merit${amount === 1 ? "" : "s"} for ${members.length} member${members.length === 1 ? "" : "s"} and logged the proof for owners.`,
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
      .where(
        and(
          eq(meritAwardsTable.guildId, interaction.guild.id),
          eq(meritAwardsTable.memberId, target.id),
        ),
      );

    await interaction.editReply(
      `**${target.tag}** has **${Number(result?.total ?? 0)}** merit${Number(result?.total ?? 0) === 1 ? "" : "s"}.`,
    );
    return;
  }

  const leaderboard = await db
    .select({
      memberId: meritAwardsTable.memberId,
      memberTag: meritAwardsTable.memberTag,
      total: sql<number>`sum(${meritAwardsTable.amount})`,
    })
    .from(meritAwardsTable)
    .where(eq(meritAwardsTable.guildId, interaction.guild.id))
    .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`))
    .limit(30);

  if (leaderboard.length === 0) {
    await interaction.editReply("No merits have been recorded for this server yet.");
    return;
  }

  const lines = leaderboard.map(
    (entry, index) =>
      `**${index + 1}.** ${entry.memberTag.slice(0, 45)} — **${Number(entry.total)}**`,
  );
  await interaction.editReply(`**Merit leaderboard — Top 30**\n${lines.join("\n")}`);
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
    .where(eq(meritAwardsTable.guildId, interaction.guild.id))
    .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
    .orderBy(desc(sql`sum(${meritAwardsTable.amount})`))
    .limit(30);

  if (leaderboard.length === 0) {
    await interaction.editReply("No merits have been recorded for this server yet.");
    return;
  }

  const lines = leaderboard.map(
    (entry, index) =>
      `**${index + 1}.** ${entry.memberTag.slice(0, 45)} — **${Number(entry.total)}**`,
  );
  await interaction.editReply(`**Merit leaderboard — Top 30**\n${lines.join("\n")}`);
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
    .where(
      and(
        eq(meritAwardsTable.guildId, interaction.guild.id),
        eq(meritAwardsTable.memberId, target.id),
      ),
    )
    .orderBy(desc(meritAwardsTable.createdAt))
    .limit(10);

  if (history.length === 0) {
    await interaction.editReply(`No merit history found for **${target.tag}**.`);
    return;
  }

  const lines = history.map(
    (award) =>
      `• **+${award.amount}** — <${award.proofUrl}> — <t:${Math.floor(award.createdAt.getTime() / 1000)}:R>`,
  );
  await interaction.editReply(
    `**Recent merit history for ${target.tag}**\n${lines.join("\n")}`,
  );
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
  }
}

async function resolveRegistrationGuildId(client: Client): Promise<string | null> {
  const configuredGuildId = process.env.DISCORD_GUILD_ID?.trim();
  if (configuredGuildId) {
    return configuredGuildId;
  }

  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logChannelId) {
    return null;
  }

  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel || !("guildId" in channel)) {
    return null;
  }

  return typeof channel.guildId === "string" ? channel.guildId : null;
}

export async function startBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Jarvis will not start.");
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    const commands = [
      addMeritCommand.toJSON(),
      meritsCommand.toJSON(),
      historyCommand.toJSON(),
      leaderboardCommand.toJSON(),
      createHrCommand.toJSON(),
    ];
    const rest = new REST({ version: "10" }).setToken(token);
    const guildId = await resolveRegistrationGuildId(readyClient);

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildId), {
        body: commands,
      });
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: [],
      });
      logger.info({ guildId }, "Jarvis commands registered for guild");
    } else {
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: commands,
      });
      logger.info("Jarvis commands registered globally");
    }

    logger.info({ botUser: readyClient.user.tag }, "Jarvis connected to Discord");
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction as ChatInputCommandInteraction).catch((error) => {
      logger.error({ err: error }, "Discord interaction failed");
    });
  });

  await client.login(token);
}