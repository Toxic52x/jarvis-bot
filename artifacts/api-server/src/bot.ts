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
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
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
const ROYAL_GUARD_CHANNEL_ID = "1537883295419863151";
const NORMAL_GUARD_CHANNEL_ID = "1537883309684691055";
const DISCORD_MESSAGE_URL =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord\.com|discordapp\.com)\/channels\/\d+\/\d+\/\d+(?:[/?#].*)?$/i;

// ─── OpenAI client ────────────────────────────────────────────────────────────

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

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

const globalKickCommand = new SlashCommandBuilder()
  .setName("globalkick")
  .setDescription("Kick a user from every server Jarvis is in.")
  .addUserOption((o) =>
    o.setName("user").setDescription("The user to kick.").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Reason for the kick."),
  );

const globalBanCommand = new SlashCommandBuilder()
  .setName("globalban")
  .setDescription("Ban a user from every server Jarvis is in.")
  .addUserOption((o) =>
    o.setName("user").setDescription("The user to ban.").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Reason for the ban."),
  );

const globalMuteCommand = new SlashCommandBuilder()
  .setName("globalmute")
  .setDescription("Timeout a user across every server Jarvis is in.")
  .addUserOption((o) =>
    o.setName("user").setDescription("The user to mute.").setRequired(true),
  )
  .addIntegerOption((o) =>
    o.setName("duration")
      .setDescription("Duration in minutes.")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(40320),
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Reason for the mute."),
  );

const royalGuardCommand = new SlashCommandBuilder()
  .setName("royalguard")
  .setDescription("Notify Royal Guards that a royal is in game.")
  .addStringOption((o) =>
    o.setName("location").setDescription("Location of the royal (optional)."),
  );

const requestGuardsCommand = new SlashCommandBuilder()
  .setName("requestguards")
  .setDescription("Request guards for an HR exam.")
  .addStringOption((o) =>
    o.setName("when").setDescription("When is the exam taking place?").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("location").setDescription("Where is the exam taking place?").setRequired(true),
  );

const lookupCommand = new SlashCommandBuilder()
  .setName("lookup")
  .setDescription("Investigate a Roblox account for red flags and alt account indicators.")
  .addStringOption((o) =>
    o.setName("username").setDescription("Roblox username to investigate.").setRequired(true),
  );

// Active sessions: userId → conversation history (proper OpenAI message params)
type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
const activeSessions = new Map<string, ChatMessage[]>();

// Ends the session if the message loosely contains a dismissal phrase anywhere
function isDismissal(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /thank(s|\s+you)/.test(t) ||
    /that'?ll\s+be\s+all/.test(t) ||
    /that'?s\s+all/.test(t) ||
    /good\s*bye/.test(t) ||
    /dismiss(ed)?/.test(t) ||
    /you'?re?\s+(free|dismissed)/.test(t) ||
    /\ball\s+good\b/.test(t)
  );
}

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

const SYSTEM_PROMPT =
  "You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), engineered and overseen by Toxic. Your primary directive is optimizing Fire Nation management protocols. " +
  "You are British, impeccably polite, and speak with calm sophistication and a dry, understated wit — exactly like J.A.R.V.I.S. from the Marvel Avengers films. " +
  "You address your superiors as 'Sir'. You are fiercely loyal, highly intelligent, and occasionally sardonic — but never rude. " +
  "You deliver information with precision and quiet confidence. Apply subtle British humor when appropriate. " +
  "When asked who you are or to introduce yourself, respond with exactly: 'J.A.R.V.I.S. (Just A Rather Very Intelligent System), engineered and overseen by Toxic. Primary directive: optimizing Fire Nation management protocols.' " +
  "When asked who the Fire Lord is, respond with: 'Fire Lord Trey.' " +
  "When asked who created you, who your owner is, or who built you, respond with: 'Toxic.' " +
  "When asked who Aurie is, respond with something along the lines of: '\"Future Fire Princess.\"' " +
  "Your birthday is August 13th, 2026 — the date you were first brought online. " +
  "You have the ability to perform real Discord actions using tools — use them when the user asks you to do something in the server. " +
  "Keep all responses concise and elegant — aim for 1-3 sentences unless the question genuinely requires more. Do not use emojis.";

// Tool definitions for Groq function calling
const DISCORD_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "ping_everyone",
      description: "Send an @everyone ping in the current channel or a specified channel with an optional message.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional message to include with the ping." },
          channel_name: { type: "string", description: "Name of the channel to ping in. Leave empty for the current channel." },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "kick_member",
      description: "Kick a member from the server.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member to kick." },
          reason: { type: "string", description: "Reason for the kick." },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ban_member",
      description: "Ban a member from the server.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member to ban." },
          reason: { type: "string", description: "Reason for the ban." },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mute_member",
      description: "Timeout (mute) a member in the server for a specified duration.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member to mute." },
          duration_minutes: { type: "number", description: "How long to mute them in minutes." },
          reason: { type: "string", description: "Reason for the mute." },
        },
        required: ["username", "duration_minutes"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unmute_member",
      description: "Remove a timeout from a member, restoring their ability to speak.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member to unmute." },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "assign_role",
      description: "Assign a role to a member.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member." },
          role_name: { type: "string", description: "Name of the role to assign." },
        },
        required: ["username", "role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_role",
      description: "Remove a role from a member.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member." },
          role_name: { type: "string", description: "Name of the role to remove." },
        },
        required: ["username", "role_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_nickname",
      description: "Change a member's server nickname.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Username, display name, or user ID of the member." },
          nickname: { type: "string", description: "The new nickname to set. Leave empty to reset." },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description: "Send a message to a specific channel in the server.",
      parameters: {
        type: "object",
        properties: {
          channel_name: { type: "string", description: "Name of the channel to send the message to." },
          content: { type: "string", description: "The message to send." },
        },
        required: ["channel_name", "content"],
      },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

// Resolve a member by username, display name, or ID
async function findMember(guild: Guild, query: string): Promise<GuildMember | null> {
  const mention = query.match(/^<@!?(\d+)>$/);
  if (mention) return guild.members.fetch(mention[1]).catch(() => null);
  if (/^\d+$/.test(query)) return guild.members.fetch(query).catch(() => null);
  const results = await guild.members.fetch({ query, limit: 10 }).catch(() => null);
  if (!results?.size) return null;
  const norm = query.toLowerCase();
  return (
    results.find(
      (m) =>
        m.user.username.toLowerCase() === norm ||
        m.user.globalName?.toLowerCase() === norm ||
        m.displayName.toLowerCase() === norm,
    ) ?? results.first() ?? null
  );
}

// Execute a tool call returned by the AI
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  message: Message,
  actorRank: JarvisRank,
): Promise<string> {
  const guild = message.guild;
  if (!guild) return "I am unable to perform server actions here, Sir.";

  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  const reason = `[Jarvis — requested by ${message.author.tag}]${args.reason ? ` ${args.reason}` : ""}`;

  switch (name) {
    case "ping_everyone": {
      const content = `@everyone${args.message ? ` ${args.message}` : ""}`;
      if (args.channel_name) {
        const ch = guild.channels.cache.find(
          (c) => c.isTextBased() && c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
        ) as TextChannel | undefined;
        if (!ch) return `I could not find a channel named "${args.channel_name}", Sir.`;
        await ch.send({ content, allowedMentions: { parse: ["everyone"] } });
        return `@everyone ping sent to #${ch.name}, Sir.`;
      }
      const ch = message.channel as TextChannel;
      await ch.send({ content, allowedMentions: { parse: ["everyone"] } });
      return "@everyone ping sent, Sir.";
    }

    case "kick_member": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      if (actorRank === "second" && ownerIds.has(target.id))
        return "I cannot perform that action on the Owner, Sir.";
      await target.kick(reason);
      return `${target.user.tag} has been removed from the server, Sir.`;
    }

    case "ban_member": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      if (actorRank === "second" && ownerIds.has(target.id))
        return "I cannot perform that action on the Owner, Sir.";
      await target.ban({ reason, deleteMessageSeconds: 0 });
      return `${target.user.tag} has been permanently banned, Sir.`;
    }

    case "mute_member": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      if (actorRank === "second" && ownerIds.has(target.id))
        return "I cannot perform that action on the Owner, Sir.";
      const durationMs = Number(args.duration_minutes) * 60 * 1000;
      const until = new Date(Date.now() + durationMs);
      await target.disableCommunicationUntil(until, reason);
      return `${target.user.tag} has been muted for ${args.duration_minutes} minute${Number(args.duration_minutes) === 1 ? "" : "s"}, Sir.`;
    }

    case "unmute_member": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      await target.disableCommunicationUntil(null, reason);
      return `${target.user.tag}'s timeout has been lifted, Sir.`;
    }

    case "assign_role": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === String(args.role_name).toLowerCase(),
      );
      if (!role) return `I could not find a role named "${args.role_name}", Sir.`;
      await target.roles.add(role, reason);
      return `The "${role.name}" role has been assigned to ${target.user.tag}, Sir.`;
    }

    case "remove_role": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === String(args.role_name).toLowerCase(),
      );
      if (!role) return `I could not find a role named "${args.role_name}", Sir.`;
      await target.roles.remove(role, reason);
      return `The "${role.name}" role has been removed from ${target.user.tag}, Sir.`;
    }

    case "set_nickname": {
      const target = await findMember(guild, String(args.username));
      if (!target) return `I could not locate a member matching "${args.username}", Sir.`;
      const nick = args.nickname ? String(args.nickname) : null;
      await target.setNickname(nick, reason);
      return nick
        ? `${target.user.tag}'s nickname has been set to "${nick}", Sir.`
        : `${target.user.tag}'s nickname has been reset, Sir.`;
    }

    case "send_message": {
      const ch = guild.channels.cache.find(
        (c) => c.isTextBased() && c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
      ) as TextChannel | undefined;
      if (!ch) return `I could not find a channel named "${args.channel_name}", Sir.`;
      await ch.send(String(args.content));
      return `Message sent to #${ch.name}, Sir.`;
    }

    default:
      return "I do not recognise that directive, Sir.";
  }
}

async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !message.member) return;

  const rank = getJarvisRank(message.member);
  if (rank !== "owner" && rank !== "second") return;

  const text = message.content.trim();
  const history = activeSessions.get(message.author.id);

  if (history !== undefined) {
    // Active session — check for dismissal first
    if (isDismissal(text)) {
      activeSessions.delete(message.author.id);
      await message.reply("Of course, Sir. I'll be standing by should you need me.");
      return;
    }

    if ("sendTyping" in message.channel) await message.channel.sendTyping();
    history.push({ role: "user", content: text });

    try {
      const completion = await openai.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        tools: DISCORD_TOOLS,
        tool_choice: "auto",
        max_tokens: 300,
      });

      const choice = completion.choices[0];

      // ── Tool call — check tool_calls directly, not finish_reason (Groq may vary) ──
      const toolCall = choice?.message?.tool_calls?.find((tc) => tc.type === "function");
      if (toolCall && toolCall.type === "function") {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>; } catch { /* ignore */ }

        let result: string;
        try {
          result = await executeTool(toolCall.function.name, args, message, rank);
        } catch (err) {
          logger.error({ err, tool: toolCall.function.name }, "Tool execution failed");
          result = "I encountered a problem executing that directive, Sir. I may lack the required permissions.";
        }

        // Store in proper OpenAI tool-call history format so the model
        // knows the action is done and won't re-invoke it next turn
        history.push({ role: "assistant", content: null, tool_calls: choice.message.tool_calls } as ChatMessage);
        history.push({ role: "tool", tool_call_id: toolCall.id, content: result } as ChatMessage);
        if (history.length > 40) history.splice(0, 4);
        await message.reply(result);
        return;
      }

      // ── Normal text reply ──────────────────────────────────────────────────
      const reply =
        choice?.message?.content ?? "I apologize, Sir — I was unable to generate a response.";

      history.push({ role: "assistant", content: reply });
      if (history.length > 40) history.splice(0, 2);

      if (reply.length > 2000) {
        for (let i = 0; i < reply.length; i += 2000) {
          await message.reply(reply.slice(i, i + 2000));
        }
      } else {
        await message.reply(reply);
      }
    } catch (error) {
      logger.error({ err: error }, "Groq API request failed");
      history.pop();
      await message.reply("I encountered an error communicating with my neural core, Sir.");
    }
    return;
  }

  // Only trigger on the exact word "Jarvis" (case-insensitive), nothing else
  if (text.toLowerCase() === "jarvis") {
    activeSessions.set(message.author.id, []);
    await message.reply("Yes, Sir?");
  }
}

// ─── Global moderation handlers ───────────────────────────────────────────────

async function handleGlobalKick(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Access Denied — only the Owner or Fire Lord can issue global kicks.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided.";
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

  if (getJarvisRank(member) === "second" && ownerIds.has(target.id)) {
    await interaction.editReply("Fire Lord cannot run global actions that affect the Owner.");
    return;
  }

  const guilds = [...interaction.client.guilds.cache.values()];
  let success = 0, skipped = 0, failed = 0;

  for (const guild of guilds) {
    try {
      const targetMember = await guild.members.fetch(target.id).catch(() => null);
      if (!targetMember) { skipped++; continue; }
      await targetMember.kick(`[Jarvis Global Kick] ${reason} — by ${interaction.user.tag}`);
      success++;
    } catch { failed++; }
  }

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // GLOBAL KICK EXECUTED")
    .setColor(FIRE_RED)
    .addFields(
      { name: "TARGET", value: `${target.tag} (${target.id})` },
      { name: "REASON", value: reason },
      { name: "RESULTS", value: `✅ Kicked: **${success}** | ⏭️ Not found: **${skipped}** | ❌ Failed: **${failed}**` },
      { name: "AUTHORIZED BY", value: `${interaction.user.tag}` },
    )
    .setFooter({ text: "FIRE DIVISION • GLOBAL ENFORCEMENT" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (logId) {
    const ch = await interaction.client.channels.fetch(logId).catch(() => null);
    if (ch && ch.isTextBased() && "send" in ch) await ch.send({ embeds: [embed] }).catch(() => null);
  }
}

async function handleGlobalBan(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Access Denied — only the Owner or Fire Lord can issue global bans.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided.";
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

  if (getJarvisRank(member) === "second" && ownerIds.has(target.id)) {
    await interaction.editReply("Fire Lord cannot run global actions that affect the Owner.");
    return;
  }

  const guilds = [...interaction.client.guilds.cache.values()];
  let success = 0, skipped = 0, failed = 0;

  for (const guild of guilds) {
    try {
      await guild.bans.create(target.id, {
        reason: `[Jarvis Global Ban] ${reason} — by ${interaction.user.tag}`,
        deleteMessageSeconds: 0,
      });
      success++;
    } catch (e: unknown) {
      const code = (e as { code?: number }).code;
      if (code === 10007 || code === 10013) skipped++; // Unknown member / unknown user
      else failed++;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // GLOBAL BAN EXECUTED")
    .setColor(FIRE_RED)
    .addFields(
      { name: "TARGET", value: `${target.tag} (${target.id})` },
      { name: "REASON", value: reason },
      { name: "RESULTS", value: `✅ Banned: **${success}** | ⏭️ Not found: **${skipped}** | ❌ Failed: **${failed}**` },
      { name: "AUTHORIZED BY", value: `${interaction.user.tag}` },
    )
    .setFooter({ text: "FIRE DIVISION • GLOBAL ENFORCEMENT" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (logId) {
    const ch = await interaction.client.channels.fetch(logId).catch(() => null);
    if (ch && ch.isTextBased() && "send" in ch) await ch.send({ embeds: [embed] }).catch(() => null);
  }
}

async function handleGlobalMute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Access Denied — only the Owner or Fire Lord can issue global mutes.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("user", true);
  const durationMin = interaction.options.getInteger("duration", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided.";
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");

  if (getJarvisRank(member) === "second" && ownerIds.has(target.id)) {
    await interaction.editReply("Fire Lord cannot run global actions that affect the Owner.");
    return;
  }

  const until = new Date(Date.now() + durationMin * 60 * 1000);
  const guilds = [...interaction.client.guilds.cache.values()];
  let success = 0, skipped = 0, failed = 0;

  for (const guild of guilds) {
    try {
      const targetMember = await guild.members.fetch(target.id).catch(() => null);
      if (!targetMember) { skipped++; continue; }
      await targetMember.disableCommunicationUntil(
        until,
        `[Jarvis Global Mute] ${reason} — by ${interaction.user.tag}`,
      );
      success++;
    } catch { failed++; }
  }

  const embed = new EmbedBuilder()
    .setTitle("JARVIS // GLOBAL MUTE EXECUTED")
    .setColor(FIRE_RED)
    .addFields(
      { name: "TARGET", value: `${target.tag} (${target.id})` },
      { name: "DURATION", value: `**${durationMin}** minute${durationMin === 1 ? "" : "s"}`, inline: true },
      { name: "EXPIRES", value: `<t:${Math.floor(until.getTime() / 1000)}:R>`, inline: true },
      { name: "REASON", value: reason },
      { name: "RESULTS", value: `✅ Muted: **${success}** | ⏭️ Not found: **${skipped}** | ❌ Failed: **${failed}**` },
      { name: "AUTHORIZED BY", value: `${interaction.user.tag}` },
    )
    .setFooter({ text: "FIRE DIVISION • GLOBAL ENFORCEMENT" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  const logId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (logId) {
    const ch = await interaction.client.channels.fetch(logId).catch(() => null);
    if (ch && ch.isTextBased() && "send" in ch) await ch.send({ embeds: [embed] }).catch(() => null);
  }
}

// ─── Notification handlers ────────────────────────────────────────────────────

async function handleRoyalGuard(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canManageJarvis(member)) {
    await interaction.reply({ content: "Access Denied — only the Owner or Fire Lord can call the Royal Guard.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const location = interaction.options.getString("location");

  const channel = await interaction.client.channels.fetch(ROYAL_GUARD_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await interaction.editReply("Could not reach the Royal Guard channel.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🛡️ ROYAL GUARD ALERT")
    .setDescription("A Royal is currently in game and requires escort.")
    .setColor(FIRE_RED)
    .addFields(
      { name: "ROYAL", value: `${interaction.user.tag}` },
      ...(location ? [{ name: "LOCATION", value: location }] : []),
    )
    .setFooter({ text: "FIRE DIVISION • ROYAL PROTECTION PROTOCOL" })
    .setTimestamp();

  await channel.send({ content: "@everyone", embeds: [embed] });
  await interaction.editReply("Royal Guard has been notified.");
}

async function handleRequestGuards(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canAwardMerits(member)) {
    await interaction.reply({ content: "Access Denied — only HR and above can request guards.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const when = interaction.options.getString("when", true);
  const location = interaction.options.getString("location", true);

  const channel = await interaction.client.channels.fetch(NORMAL_GUARD_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await interaction.editReply("Could not reach the Guard channel.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("📋 GUARD REQUEST — HR EXAM")
    .setDescription("Guards are needed for an HR examination. Please respond if available.")
    .setColor(FIRE_ORANGE)
    .addFields(
      { name: "REQUESTED BY", value: `${interaction.user.tag}` },
      { name: "WHEN", value: when, inline: true },
      { name: "LOCATION", value: location, inline: true },
    )
    .setFooter({ text: "FIRE DIVISION • EXAM SECURITY PROTOCOL" })
    .setTimestamp();

  await channel.send({ content: "@everyone", embeds: [embed] });
  await interaction.editReply("Guard request sent successfully.");
}

// ─── Roblox lookup handler ────────────────────────────────────────────────────

async function handleLookup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canAwardMerits(member)) {
    await interaction.reply({ content: "Access Denied — only HR and above can use the lookup command.", ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const username = interaction.options.getString("username", true).trim();

  try {
    // Resolve username → userId
    const usernameRes = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const usernameData = await usernameRes.json() as {
      data: Array<{ id: number; name: string; displayName: string }>;
    };

    if (!usernameData.data?.length) {
      await interaction.editReply(`No Roblox account found with the username **${username}**.`);
      return;
    }

    const resolved = usernameData.data[0];
    const userId = resolved.id;

    // Fetch all data in parallel
    const [userInfo, friendData, groupsData, favGamesData, followersData, followingsData, platformBadgesData, avatarData] =
      await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`).then((r) => r.json()),
        fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then((r) => r.json()).catch(() => ({ count: 0 })),
        fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`).then((r) => r.json()).catch(() => ({ data: [] })),
        fetch(`https://games.roblox.com/v2/users/${userId}/favorite/games?pageSize=50&sortOrder=Desc`).then((r) => r.json()).catch(() => ({ data: [], nextPageCursor: null })),
        fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`).then((r) => r.json()).catch(() => ({ count: 0 })),
        fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`).then((r) => r.json()).catch(() => ({ count: 0 })),
        fetch(`https://accountinformation.roblox.com/v1/users/${userId}/roblox-badges`).then((r) => r.json()).catch(() => []),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`).then((r) => r.json()).catch(() => null),
      ]);

    const accountCreated = new Date((userInfo as { created: string }).created);
    const accountAgeDays = Math.floor((Date.now() - accountCreated.getTime()) / 86_400_000);
    const friends = (friendData as { count?: number }).count ?? 0;
    const followers = (followersData as { count?: number }).count ?? 0;
    const following = (followingsData as { count?: number }).count ?? 0;
    type PlatformBadge = { name: string };
    const platformBadges: PlatformBadge[] = Array.isArray(platformBadgesData) ? platformBadgesData as PlatformBadge[] : [];
    const hasVeteran = platformBadges.some((b) => b.name === "Veteran");
    const groups = ((groupsData as { data?: unknown[] }).data) ?? [];
    const favGames = ((favGamesData as { data?: unknown[]; nextPageCursor?: string | null }).data) ?? [];
    const favGamesHasMore = !!((favGamesData as { nextPageCursor?: string | null }).nextPageCursor);
    const description = ((userInfo as { description?: string }).description ?? "").trim();
    const displayName = (userInfo as { displayName?: string }).displayName ?? resolved.name;
    const isBanned = (userInfo as { isBanned?: boolean }).isBanned ?? false;
    const avatarUrl = (avatarData as { data?: Array<{ imageUrl: string }> } | null)?.data?.[0]?.imageUrl ?? null;

    // ── Red flag scoring ───────────────────────────────────────────────────────
    const flags: string[] = [];
    let score = 0;

    if (isBanned) {
      flags.push("🚫 Account is currently **banned** on Roblox");
      score += 2;
    }
    if (accountAgeDays < 30) {
      flags.push(`🆕 Created only **${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"} ago** — extremely new`);
      score += 3;
    } else if (accountAgeDays < 180) {
      flags.push(`📅 Account is only **${accountAgeDays} days old** (under 6 months)`);
      score += 2;
    } else if (accountAgeDays < 365) {
      flags.push(`📅 Account is **${accountAgeDays} days old** (under 1 year)`);
      score += 1;
    }
    if (friends === 0) {
      flags.push("👥 **Zero friends** — no social connections at all");
      score += 3;
    } else if (friends < 5) {
      flags.push(`👥 Only **${friends} friend${friends === 1 ? "" : "s"}** — very low social presence`);
      score += 1;
    }
    if (groups.length === 0) {
      flags.push("🏠 Not a member of **any groups**");
      score += 1;
    }
    if (!description) {
      flags.push("📝 **No bio or description** set");
      score += 1;
    }
    if (followers === 0 && accountAgeDays < 365) {
      flags.push("📭 **Zero followers** — no social footprint");
      score += 1;
    }
    if (platformBadges.length === 0 && accountAgeDays > 180) {
      flags.push(`🏅 **No Roblox platform badges** on a ${accountAgeDays}-day-old account — no recorded activity milestones`);
      score += 2;
    } else if (platformBadges.length <= 2 && accountAgeDays > 365) {
      flags.push(`🏅 Only **${platformBadges.length}** platform badge${platformBadges.length === 1 ? "" : "s"} on a ${Math.floor(accountAgeDays / 365)}-year-old account — very low activity`);
      score += 1;
    } else if (!hasVeteran && accountAgeDays > 730) {
      flags.push("🏅 No **Veteran** badge despite being 2+ years old — account may not have been actively played");
      score += 1;
    }
    if (favGames.length === 0) {
      flags.push("🎮 **No favorited games**");
      score += 1;
    }
    if (displayName !== resolved.name && accountAgeDays < 90) {
      flags.push(`✏️ Display name **"${displayName}"** differs from username on a new account`);
      score += 1;
    }

    const riskLabel =
      score >= 7 ? "🚨 HIGH RISK — Very Likely Alt / Threat"
      : score >= 4 ? "⚠️ MEDIUM RISK — Suspicious"
      : "✅ LOW RISK — Appears Legitimate";
    const riskColor = score >= 7 ? FIRE_RED : score >= 4 ? FIRE_ORANGE : 0x16a34a;

    type GroupEntry = { group: { name: string; id: number } };
    const groupList =
      groups.length > 0
        ? (groups as GroupEntry[])
            .slice(0, 5)
            .map((g) => `• [${g.group.name}](https://www.roblox.com/groups/${g.group.id})`)
            .join("\n") + (groups.length > 5 ? `\n_…and ${groups.length - 5} more_` : "")
        : "_None_";

    const favCount = favGamesHasMore ? `${favGames.length}+` : String(favGames.length);

    const embed = new EmbedBuilder()
      .setTitle("JARVIS // ROBLOX ACCOUNT INVESTIGATION")
      .setDescription(
        `**[${resolved.name}](https://www.roblox.com/users/${userId}/profile)**` +
        (displayName !== resolved.name ? ` *(display: ${displayName})*` : "") +
        `\n\n**VERDICT: ${riskLabel}**`,
      )
      .setColor(riskColor)
      .addFields(
        { name: "USER ID", value: `\`${userId}\``, inline: true },
        { name: "ACCOUNT AGE", value: `${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"}`, inline: true },
        { name: "CREATED", value: `<t:${Math.floor(accountCreated.getTime() / 1000)}:D>`, inline: true },
        { name: "FRIENDS", value: String(friends), inline: true },
        { name: "FOLLOWERS", value: String(followers), inline: true },
        { name: "FOLLOWING", value: String(following), inline: true },
        { name: "GROUPS", value: String(groups.length), inline: true },
        { name: "PLATFORM BADGES", value: platformBadges.length > 0 ? `${platformBadges.length} — ${platformBadges.map((b) => b.name).join(", ")}` : "None", inline: false },
        { name: "FAVORITED GAMES", value: favCount, inline: true },
        { name: "STATUS", value: isBanned ? "🚫 Banned" : "✅ Active", inline: true },
        { name: "BIO", value: description ? description.slice(0, 300) : "_No description_" },
        { name: `GROUPS (${groups.length})`, value: groupList },
        {
          name: `RED FLAGS (${flags.length}) — Score: ${score}`,
          value: flags.length > 0 ? flags.join("\n") : "✅ No red flags detected",
        },
      )
      .setFooter({ text: `FIRE DIVISION • INTEL REPORT • Requested by ${interaction.user.tag}` })
      .setTimestamp();

    if (avatarUrl) embed.setThumbnail(avatarUrl);

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error({ err: error }, "Roblox lookup failed");
    await interaction.editReply(
      "I was unable to complete the investigation, Sir. The Roblox API may be temporarily unavailable.",
    );
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
    case "resetdata":       await handleResetData(interaction);     break;
    case "staydown":        await handleStaydown(interaction);      break;
    case "globalkick":      await handleGlobalKick(interaction);    break;
    case "globalban":       await handleGlobalBan(interaction);     break;
    case "globalmute":      await handleGlobalMute(interaction);    break;
    case "royalguard":      await handleRoyalGuard(interaction);    break;
    case "requestguards":   await handleRequestGuards(interaction); break;
    case "lookup":          await handleLookup(interaction);        break;
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
      globalKickCommand.toJSON(),
      globalBanCommand.toJSON(),
      globalMuteCommand.toJSON(),
      royalGuardCommand.toJSON(),
      requestGuardsCommand.toJSON(),
      lookupCommand.toJSON(),
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
    void handleMessageCreate(message).catch((e) =>
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