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
import OpenAI from "openai";
import { db, meritAwardsTable } from "@workspace/db";
import { logger } from "./lib/logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_MEMBERS_PER_AWARD = 25;
const MAX_MERITS_HR = 7;          // HR cap; Owner and Fire Lord are uncapped
const HR_ROLE_NAME = "HR";
const FIRE_RED = 0xb91c1c;
const FIRE_ORANGE = 0xf97316;
const DISCORD_MESSAGE_URL =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord\.com|discordapp\.com)\/channels\/\d+\/\d+\/\d+(?:[/?#].*)?$/i;

// ─── OpenAI client ────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Slash command definitions ────────────────────────────────────────────────

const addMeritCommand = new SlashCommandBuilder()
  .setName("addmerit")
  .setDescription("Award merits to one or more members using a Discord proof link.")
  .addStringOption((o) =>
    o.setName("users")
      .setDescription("Comma-separated mentions, IDs, or exact display names (max 25).")
      .setRequired(true),
  )
  .addIntegerOption((o) =>
    o.setName("amount")
      .setDescription("Merits to award each member (HR: max 7; Owner/Fire Lord: unlimited).")
      .setMinValue(1)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("proof")
      .setDescription("Full Discord message link as proof.")
      .setRequired(true),
  );

const meritsCommand = new SlashCommandBuilder()
  .setName("merits")
  .setDescription("View a member's merit total or the top-30 leaderboard.")
  .addUserOption((o) =>
    o.setName("user").setDescription("The member to look up. Leave empty for the leaderboard."),
  );

const historyCommand = new SlashCommandBuilder()
  .setName("merithistory")
  .setDescription("View a member's recent merit awards.")
  .addUserOption((o) =>
    o.setName("user").setDescription("The member whose history to view."),
  );

const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the top 30 members by merit total.");

const createHrCommand = new SlashCommandBuilder()
  .setName("createhr")
  .setDescription("Create the Jarvis HR role with no elevated Discord permissions.");

const resetDataCommand = new SlashCommandBuilder()
  .setName("resetdata")
  .setDescription("Wipe all merit data. Exports a backup before resetting.");

const staydownCommand = new SlashCommandBuilder()
  .setName("staydown")
  .setDescription("Acknowledge breach, clear alarm, and unlock the audit channel.");

// Active sessions: userId → awaiting follow-up question
const activeSessions = new Set<string>();

// ─── Rank helpers ─────────────────────────────────────────────────────────────

function getConfiguredIds(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

type JarvisRank = "owner" | "second" | "hr" | "none";

function getJarvisRank(member: GuildMember): JarvisRank {
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  const secondIds = getConfiguredIds("DISCORD_SECOND_IN_COMMAND_USER_IDS");
  const hrRoleIds = getConfiguredIds("DISCORD_HR_ROLE_IDS");

  if (ownerIds.has(member.id)) return "owner";
  if (secondIds.has(member.id)) return "second";
  if (
    [...hrRoleIds].some((id) => member.roles.cache.has(id)) ||
    member.roles.cache.some((r) => r.name === HR_ROLE_NAME)
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

// ─── Shared helpers ───────────────────────────────────────────────────────────

function parseUserReferences(rawUsers: string): string[] {
  const refs = rawUsers.split(",").map((v) => v.trim()).filter(Boolean);
  if (refs.length === 0) throw new Error("Add at least one member.");
  if (refs.length > MAX_MEMBERS_PER_AWARD)
    throw new Error(`You can award at most ${MAX_MEMBERS_PER_AWARD} members at once.`);
  return [...new Set(refs)];
}

function getMemberIdFromReference(ref: string): string | null {
  const mention = ref.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  return /^\d+$/.test(ref) ? ref : null;
}

async function resolveMembers(
  interaction: ChatInputCommandInteraction,
  rawUsers: string,
): Promise<GuildMember[]> {
  if (!interaction.guild) throw new Error("This command can only be used inside a server.");

  const refs = parseUserReferences(rawUsers);
  const members: GuildMember[] = [];

  for (const ref of refs) {
    const id = getMemberIdFromReference(ref);
    if (id) {
      const m = await interaction.guild.members.fetch(id).catch(() => null);
      if (!m) throw new Error(`Could not find member \`${ref}\`.`);
      members.push(m);
      continue;
    }
    const matches = await interaction.guild.members.fetch({ query: ref, limit: 10 });
    const norm = ref.toLowerCase();
    const exact = matches.find(
      (m) =>
        m.user.username.toLowerCase() === norm ||
        m.user.globalName?.toLowerCase() === norm ||
        m.displayName.toLowerCase() === norm,
    );
    if (!exact)
      throw new Error(`Could not find \`${ref}\`. Use a mention or exact display name.`);
    members.push(exact);
  }

  return members;
}

function validateProofUrl(proof: string): string {
  const trimmed = proof.trim();
  if (!DISCORD_MESSAGE_URL.test(trimmed))
    throw new Error(
      "Proof must be a full Discord message link — e.g. https://discord.com/channels/…",
    );
  return trimmed;
}

function buildLeaderboardEmbed(
  rows: ReadonlyArray<{ memberTag: string; total: number }>,
): EmbedBuilder {
  const lines = rows.map(
    (e, i) =>
      `**${String(i + 1).padStart(2, "0")}**  ${e.memberTag.slice(0, 45)}  —  **${Number(e.total)}**`,
  );
  return new EmbedBuilder()
    .setTitle("JARVIS // MERIT COMMAND")
    .setDescription(`**TOP 30 PERSONNEL RANKING**\n\n${lines.join("\n")}`)
    .setColor(FIRE_RED)
    .setFooter({ text: "FIRE DIVISION • MERIT LEDGER • AUTHORIZED PERSONNEL ONLY" })
    .setTimestamp();
}

async function awardMerits(
  interaction: ChatInputCommandInteraction,
  members: GuildMember[],
  amount: number,
  proofUrl: string,
): Promise<void> {
  if (!interaction.guild) throw new Error("This command can only be used inside a server.");
  await db.transaction(async (tx) => {
    await tx.insert(meritAwardsTable).values(
      members.map((m) => ({
        guildId: interaction.guild!.id,
        memberId: m.id,
        memberTag: m.user.tag,
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
  if (!logChannelId)
    throw new Error(
      "Owner audit channel not configured. Set DISCORD_OWNER_LOG_CHANNEL_ID.",
    );

  const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
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
      { name: "MERIT VALUE", value: `**+${amount}** merit${amount === 1 ? "" : "s"} per recipient`, inline: true },
      { name: "PROOF OF ACTION", value: proofUrl, inline: true },
      { name: "AUTHORIZED BY", value: `${interaction.user.tag} (${interaction.user.id})` },
    )
    .setFooter({ text: "FIRE DIVISION • OWNER AUDIT CHANNEL" })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleAddMerit(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canAwardMerits(member)) {
    await interaction.reply({
      content: "Access Denied — only the Owner, Fire Lord, or HR can award merits.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const rawUsers = interaction.options.getString("users", true);
    const amount = interaction.options.getInteger("amount", true);
    const actorRank = getJarvisRank(member);

    // HR is capped at MAX_MERITS_HR; Owner and Fire Lord are uncapped
    if (actorRank === "hr" && amount > MAX_MERITS_HR) {
      throw new Error(
        `HR personnel can award a maximum of ${MAX_MERITS_HR} merits per recipient.`,
      );
    }

    const proofUrl = validateProofUrl(interaction.options.getString("proof", true));
    const members = await resolveMembers(interaction, rawUsers);
    const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

    if (actorRank === "second" && members.some((m) => ownerIds.has(m.id))) {
      throw new Error("Fire Lord cannot run merit commands that affect the Owner.");
    }

    await awardMerits(interaction, members, amount, proofUrl);
    await writeOwnerAuditLog(interaction, members, amount, proofUrl);

    await interaction.editReply(
      `Recorded **+${amount}** merit${amount === 1 ? "" : "s"} for ${members.length} member${members.length === 1 ? "" : "s"} — proof logged for owners.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The merit award failed.";
    logger.warn({ err: error, userId: interaction.user.id }, "Merit award rejected");
    await interaction.editReply(`Could not record the award: ${message}`);
  }
}

async function handleCreateHr(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Only the Owner or Fire Lord can create the HR role.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const existing = interaction.guild.roles.cache.find((r) => r.name === HR_ROLE_NAME);
    if (existing) {
      await interaction.editReply(`The ${HR_ROLE_NAME} role already exists: ${existing}. Jarvis will recognize it.`);
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
    const message = error instanceof Error ? error.message : "The HR role could not be created.";
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
      .select({ total: sql<number>`coalesce(sum(${meritAwardsTable.amount}), 0)` })
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
      .setFooter({ text: "FIRE DIVISION • MERIT LEDGER" })
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
    await interaction.editReply("No merits have been recorded yet.");
    return;
  }

  await interaction.editReply({ embeds: [buildLeaderboardEmbed(leaderboard)] });
}

async function handleLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
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
    await interaction.editReply("No merits have been recorded yet.");
    return;
  }

  await interaction.editReply({ embeds: [buildLeaderboardEmbed(leaderboard)] });
}

async function handleMeritHistory(interaction: ChatInputCommandInteraction): Promise<void> {
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
    await interaction.editReply(`No merit history found for **${target.tag}**.`);
    return;
  }

  const lines = history.map(
    (a) =>
      `**+${a.amount}**  •  [Proof of action](${a.proofUrl})  •  <t:${Math.floor(a.createdAt.getTime() / 1000)}:R>`,
  );

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // MERIT HISTORY")
    .setDescription(`**PERSONNEL:** ${target.tag}\n\n${lines.join("\n")}`)
    .setColor(FIRE_ORANGE)
    .setFooter({ text: "FIRE DIVISION • VERIFIED ACTION HISTORY" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleResetData(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({ content: "This command can only be used inside a server channel.", ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Access Denied — only the Owner or Fire Lord can reset system data.", ephemeral: true });
    return;
  }

  const confirmBtn = new ButtonBuilder()
    .setCustomId("confirm_reset").setLabel("Yes, Reset Everything").setStyle(ButtonStyle.Danger);
  const cancelBtn = new ButtonBuilder()
    .setCustomId("cancel_reset").setLabel("Cancel").setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);

  await interaction.reply({
    content: "⚠️ **ARE YOU SURE?** This permanently wipes all merit data. A full backup will be generated first.",
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

        const full = await db
          .select({
            memberId: meritAwardsTable.memberId,
            memberTag: meritAwardsTable.memberTag,
            total: sql<number>`sum(${meritAwardsTable.amount})`,
          })
          .from(meritAwardsTable)
          .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
          .orderBy(desc(sql`sum(${meritAwardsTable.amount})`));

        const backupLines = full.length > 0
          ? full.map((e, i) => `\`[ID: ${e.memberId}]\` **#${i + 1}** ${e.memberTag} — **${Number(e.total)}** merits`).join("\n")
          : "No data recorded prior to reset.";

        const backupEmbed = new EmbedBuilder()
          .setTitle("JARVIS // SYSTEM DATA BACKUP & RESET EXPORT")
          .setDescription(`**DATA BACKUP AT RESET**\n\n${backupLines.slice(0, 4000)}`)
          .setColor(FIRE_RED)
          .setFooter({ text: `RESET EXECUTED BY ${interaction.user.tag}` })
          .setTimestamp();

        const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
        if (logId) {
          const ch = await interaction.client.channels.fetch(logId).catch(() => null);
          if (ch && ch.isTextBased() && "send" in ch) {
            await ch.send({ embeds: [backupEmbed] }).catch((e) => logger.warn({ err: e }, "Backup send failed"));
          }
        }

        await db.delete(meritAwardsTable);
        await interaction.editReply({ content: "✅ **ALL MERIT DATA HAS BEEN RESET.**", embeds: [backupEmbed], components: [] });
        collector.stop("done");
      } else {
        await btn.update({ content: "❌ Data reset cancelled.", components: [] });
        collector.stop("cancelled");
      }
    } catch (e) {
      logger.error({ err: e }, "Error in resetdata collector");
      await interaction.editReply({ content: "❌ An error occurred during the data reset.", components: [] }).catch(() => null);
    }
  });

  collector.on("end", async (_, reason) => {
    if (reason === "time") {
      await interaction.editReply({ content: "⏱️ Confirmation timed out. Data reset cancelled.", components: [] }).catch(() => null);
    }
  });
}

async function handleStaydown(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.channel) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Access Denied — only the Owner or Fire Lord can silence alarms.", ephemeral: true });
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

// ─── Jarvis keyword conversation ──────────────────────────────────────────────

async function handleMessageCreate(message: {
  author: { bot: boolean; id: string };
  guild: null | { id: string };
  member: null | GuildMember;
  content: string;
  reply: (text: string) => Promise<unknown>;
  channel: { sendTyping: () => Promise<void> };
}): Promise<void> {
  if (message.author.bot || !message.guild || !message.member) return;

  const rank = getJarvisRank(message.member);
  if (rank !== "owner" && rank !== "second") return;

  const text = message.content.trim();

  if (activeSessions.has(message.author.id)) {
    // This is the follow-up question — anything goes
    activeSessions.delete(message.author.id);
    await message.channel.sendTyping();

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Jarvis, a sophisticated, precise, and loyal AI assistant serving the leadership of a military-themed Discord community called the Fire Division. " +
              "You speak with calm confidence and military brevity. You address the Owner and Fire Lord as 'Sir'. " +
              "Keep responses concise and direct. Do not use emojis.",
          },
          { role: "user", content: text },
        ],
        max_tokens: 800,
      });

      const reply =
        completion.choices[0]?.message?.content ??
        "I apologize, Sir — I was unable to generate a response.";

      // Discord hard limit is 2000 chars — split if needed
      if (reply.length > 2000) {
        for (let i = 0; i < reply.length; i += 2000) {
          await message.reply(reply.slice(i, i + 2000));
        }
      } else {
        await message.reply(reply);
      }
    } catch (error) {
      logger.error({ err: error }, "OpenAI API request failed");
      await message.reply("I encountered an error communicating with my neural core, Sir.");
    }
    return;
  }

  // Only trigger on the exact word "Jarvis" (case-insensitive), nothing else
  if (text.toLowerCase() === "jarvis") {
    activeSessions.add(message.author.id);
    await message.reply("Yes, Sir?");
  }
}

// ─── Interaction router ───────────────────────────────────────────────────────

async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "addmerit":      await handleAddMerit(interaction);    break;
    case "createhr":      await handleCreateHr(interaction);    break;
    case "merits":        await handleMerits(interaction);      break;
    case "leaderboard":   await handleLeaderboard(interaction); break;
    case "merithistory":  await handleMeritHistory(interaction);break;
    case "resetdata":     await handleResetData(interaction);   break;
    case "staydown":      await handleStaydown(interaction);    break;
  }
}

// ─── Guild ID resolver ────────────────────────────────────────────────────────

async function resolveGuildId(client: Client): Promise<string | null> {
  const configured = process.env.DISCORD_GUILD_ID?.trim();
  if (configured) return configured;

  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logChannelId) return null;

  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel || !("guildId" in channel)) return null;
  return typeof channel.guildId === "string" ? channel.guildId : null;
}

// ─── Audit-log deletion detector ─────────────────────────────────────────────

async function handleMessageDelete(
  message: Parameters<Parameters<Client["on"]>[1]>[0] & { channelId: string },
  client: Client,
): Promise<void> {
  const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!logChannelId || (message as { channelId: string }).channelId !== logChannelId) return;

  const channel = (message as { channel: unknown }).channel as {
    isTextBased: () => boolean;
    send?: (...args: unknown[]) => Promise<unknown>;
    permissionOverwrites?: { edit: (...args: unknown[]) => Promise<void> };
  };

  if (!channel.isTextBased() || !channel.send) return;

  const guildRoles = (message as { guild?: { roles: { everyone: unknown } } }).guild?.roles;
  if (guildRoles && channel.permissionOverwrites) {
    await channel.permissionOverwrites.edit(guildRoles.everyone, {
      ViewChannel: false,
      SendMessages: false,
    }).catch((e) => logger.warn({ err: e }, "Failed to lock channel"));
  }

  const authorMention =
    (message as { author?: { id: string; tag: string } }).author
      ? `<@${(message as { author: { id: string; tag: string } }).author.id}> (${(message as { author: { id: string; tag: string } }).author.tag})`
      : "An unknown user";

  const breachEmbed = new EmbedBuilder()
    .setTitle("🚨 SYSTEM BREACH DETECTED — CHANNEL LOCKED")
    .setDescription(
      `**A MESSAGE WAS DELETED FROM THE AUDIT LOGS.**\n\n` +
      `**Target:** ${authorMention}\n` +
      `**Status:** 🔒 CHANNEL LOCKED DOWN\n\n` +
      `Owner or Fire Lord must run \`/staydown\` to acknowledge and restore access.`,
    )
    .setColor(FIRE_RED)
    .setTimestamp();

  await channel.send({ content: "@everyone", embeds: [breachEmbed] }).catch((e) =>
    logger.error({ err: e }, "Failed to send breach alert"),
  );
}

// ─── Bot startup ──────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN not configured; Jarvis will not start.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged — must be enabled in Discord Developer Portal
    ],
  });

  client.once(Events.ClientReady, async (ready) => {
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
    const guildId = await resolveGuildId(ready);

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(ready.user.id, guildId), { body: commands });
      // Wipe any leftover global commands
      await rest.put(Routes.applicationCommands(ready.user.id), { body: [] });
      logger.info({ guildId }, "Jarvis commands registered for guild");
    } else {
      await rest.put(Routes.applicationCommands(ready.user.id), { body: commands });
      logger.info("Jarvis commands registered globally");
    }

    logger.info({ botUser: ready.user.tag }, "Jarvis online");
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction as ChatInputCommandInteraction).catch((e) =>
      logger.error({ err: e }, "Discord interaction failed"),
    );
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessageCreate(message as Parameters<typeof handleMessageCreate>[0]).catch((e) =>
      logger.error({ err: e }, "MessageCreate handler failed"),
    );
  });

  client.on(Events.MessageDelete, (message) => {
    void handleMessageDelete(message as Parameters<typeof handleMessageDelete>[0], client).catch((e) =>
      logger.error({ err: e }, "MessageDelete handler failed"),
    );
  });

  await client.login(token);
}
