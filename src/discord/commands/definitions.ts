import { SlashCommandBuilder } from "discord.js";

// ─── Slash command definitions ────────────────────────────────────────────────
// Every user-visible command name/description/option lives here and nowhere
// else. Adding a future command means adding its builder below and appending it
// to ALL_COMMANDS — that array is what startBot() registers with Discord's REST
// API, so there is exactly one place to keep in sync.

export const addMeritCommand = new SlashCommandBuilder()
  .setName("addmerit")
  .setDescription("Award merits based on activity type.")
  .addSubcommand((sub) =>
    sub
      .setName("exam")
      .setDescription(
        "Award 1 merit to all participants. Paste the conclusion announcement.",
      )
    .addStringOption((o) =>
      o
        .setName("announcement")
        .setDescription(
          "Paste the full exam conclusion — Jarvis extracts every @mention automatically.",
        )
        .setRequired(true),
    )
    .addUserOption((o) =>
      o
        .setName("host")
        .setDescription("The host who ran this exam — receives the merit.")
        .setRequired(true),
    ),
    )
  .addSubcommand((sub) =>
    sub
      .setName("event")
      .setDescription(
        "Award 1 merit to all participants. Paste the conclusion announcement.",
      )
      .addStringOption((o) =>
        o
          .setName("announcement")
          .setDescription(
            "Paste the full event conclusion — Jarvis extracts every @mention automatically.",
          )
          .setRequired(true),
      )
      .addUserOption((o) =>
        o
          .setName("host")
          .setDescription("The host who ran this event — receives the merit.")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("raid")
      .setDescription(
        "Award 3 merits to all participants. Advisor and above only.",
      )
      .addStringOption((o) =>
        o
          .setName("announcement")
          .setDescription(
            "Paste the full raid conclusion — Jarvis extracts every @mention automatically.",
          )
          .setRequired(true),
      )
      .addUserOption((o) =>
        o
          .setName("host")
          .setDescription("The host who led this raid — receives the merit.")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("bonus")
      .setDescription(
        "Award 0.1–7 bonus merits to one or more members. Advisor and above only.",
      )
      .addStringOption((o) =>
        o
          .setName("users")
          .setDescription("@mention one or more members to award, e.g. @Alice @Bob.")
          .setRequired(true),
      )
      .addNumberOption((o) =>
        o
          .setName("amount")
          .setDescription("Merit amount (0.1–7).")
          .setMinValue(0.1)
          .setMaxValue(7)
          .setRequired(true),
      ),
  );

export const removeMeritCommand = new SlashCommandBuilder()
  .setName("removemerit")
  .setDescription("Remove merits from a member. Advisor and above only.")
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("The member to deduct merits from.")
      .setRequired(true),
  )
  .addNumberOption((o) =>
    o
      .setName("amount")
      .setDescription("Merit amount to remove (0.1–7).")
      .setMinValue(0.1)
      .setMaxValue(7)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("reason")
      .setDescription("Reason for the removal.")
      .setRequired(true),
  );

export const meritsCommand = new SlashCommandBuilder()
  .setName("merits")
  .setDescription("View a member's merit total or the top-30 leaderboard.")
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription(
        "The member to look up. Leave empty for the leaderboard.",
      ),
  );

export const historyCommand = new SlashCommandBuilder()
  .setName("merithistory")
  .setDescription("View a member's recent merit awards.")
  .addUserOption((o) =>
    o.setName("user").setDescription("The member whose history to view."),
  );

export const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the top 30 members by merit total.");

export const createHrCommand = new SlashCommandBuilder()
  .setName("createhr")
  .setDescription(
    "Create the Jarvis HR role with no elevated Discord permissions.",
  );

export const createAdvisorCommand = new SlashCommandBuilder()
  .setName("createadvisor")
  .setDescription(
    "Create the Jarvis Advisor role (above HR) with no elevated Discord permissions.",
  );

export const createRoyaltyCommand = new SlashCommandBuilder()
  .setName("createroyalty")
  .setDescription(
    "Create the Royalty role (between Fire Lord and Advisor) with no permissions.",
  );

export const resetDataCommand = new SlashCommandBuilder()
  .setName("resetdata")
  .setDescription("Wipe all merit data. Exports a backup before resetting.");

export const reloadKnowledgeCommand = new SlashCommandBuilder()
  .setName("reloadknowledge")
  .setDescription(
    "Reload the Fire Nation knowledge file without restarting Jarvis.",
  );

export const addKnowledgeCommand = new SlashCommandBuilder()
  .setName("addknowledge")
  .setDescription(
    "Append an entry to the Fire Nation knowledge base. HR and above only.",
  )
  .addStringOption((o) =>
    o
      .setName("entry")
      .setDescription("The knowledge entry to add.")
      .setRequired(true),
  );

/**
 * Every command Jarvis registers. Add a new command's builder here (and only
 * here) to have it picked up by startBot()'s REST registration.
 */
export const ALL_COMMANDS = [
  addMeritCommand,
  removeMeritCommand,
  meritsCommand,
  historyCommand,
  leaderboardCommand,
  createHrCommand,
  createAdvisorCommand,
  createRoyaltyCommand,
  resetDataCommand,
  reloadKnowledgeCommand,
  addKnowledgeCommand,
] as const;
