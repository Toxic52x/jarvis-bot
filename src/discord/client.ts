import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lte } from "drizzle-orm";
import { PRESENCE_POLL_INTERVAL_MS } from "../config";
import { db, remindersTable, runMigrations } from "../lib/db";
import { loadJarvisAccess } from "./accessList";
import { ALL_COMMANDS } from "./commands/definitions";
import { handleInteraction } from "./commands/router";
import {
  handleMessageCreate,
  handleMessageDelete,
  handleReactionAdd,
} from "./events/messageEvents";
import { loadTokenUsage } from "./ai/geminiClient";
import { setBotClient } from "./guard";
import { loadKnowledge } from "./knowledge";
import { loadOverwatchFilters } from "./moderation/overwatch";
import { getOfflineAvatarBuffer, startPresenceLoops } from "./presence";
import { loadRobloxTracking, pollRobloxPresence, robloxTracking } from "./roblox/tracking";
import { logger } from "../lib/logger";

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
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  // Guard requests fetch channels/guilds outside of any interaction, so the
  // guard module needs the live client the moment it exists.
  setBotClient(client);

  client.once(Events.ClientReady, async (ready) => {
    const commands = ALL_COMMANDS.map((c) => c.toJSON());
    const rest = new REST({ version: "10" }).setToken(token);

    // ── Command registration — wrapped in try/catch so a failure here
    // (bad payload, permission issue, transient network error) can no
    // longer silently swallow everything below it (status rotation,
    // reminder checker, etc). Errors are now logged loudly. ──────────────
    const testGuildId = process.env.DISCORD_TEST_GUILD_ID?.trim();
    try {
      if (testGuildId) {
        // Guild-scoped commands propagate almost instantly — use this while
        // developing/testing so you don't have to wait up to an hour.
        const result = (await rest.put(
          Routes.applicationGuildCommands(ready.user.id, testGuildId),
          { body: commands },
        )) as unknown[];
        logger.info(
          {
            count: result.length,
            guildId: testGuildId,
            names: commands.map((c) => c.name),
          },
          "Jarvis commands registered to test guild (near-instant propagation)",
        );
      } else {
        const result = (await rest.put(
          Routes.applicationCommands(ready.user.id),
          { body: commands },
        )) as unknown[];
        logger.info(
          { count: result.length, names: commands.map((c) => c.name) },
          "Jarvis commands registered globally (can take up to ~1 hour to appear everywhere)",
        );
      }
    } catch (err) {
      // This is the failure mode that most commonly causes "my command
      // doesn't show up" with zero explanation — log full detail.
      logger.error(
        { err },
        "❌ FAILED to register Jarvis slash commands — none of the commands above were updated. " +
          "Check: (1) the bot was invited with the 'applications.commands' OAuth2 scope, " +
          "(2) DISCORD_BOT_TOKEN is valid, (3) no duplicate command names, " +
          "(4) if using DISCORD_TEST_GUILD_ID, that the bot is actually in that guild.",
      );
    }

    // Status rotation, avatar rotation, the online avatar and the animated
    // profile banner all live in presence.ts now.
    await startPresenceLoops(ready);

    // Reminder delivery checker — runs every 30 seconds, queries the DB
    setInterval(async () => {
      try {
        const now = new Date();
        const due = await db
          .delete(remindersTable)
          .where(lte(remindersTable.dueAt, now))
          .returning();
        for (const r of due) {
          try {
            const user = await ready.users.fetch(r.userId);
            await user.send(`⏰ Reminder, Sir: **${r.message}**`);
          } catch {
            /* user has DMs disabled — silently skip */
          }
        }
      } catch (e) {
        logger.warn({ err: e }, "Reminder checker failed");
      }
    }, 30_000);

    // Roblox presence poller — runs every PRESENCE_POLL_INTERVAL_MS
    logger.info(
      { intervalMs: PRESENCE_POLL_INTERVAL_MS },
      "Roblox presence poller starting",
    );
    setInterval(() => {
      logger.info(
        { trackedCount: robloxTracking.users.length },
        "pollRobloxPresence: tick",
      );
      pollRobloxPresence(ready).catch((err: unknown) =>
        logger.error(
          { err },
          "pollRobloxPresence: uncaught rejection escaped the poller — this should not happen",
        ),
      );
    }, PRESENCE_POLL_INTERVAL_MS);

    logger.info({ botUser: ready.user.tag }, "Jarvis online");
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((e) =>
      logger.error({ err: e }, "Discord interaction failed"),
    );
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessageCreate(message).catch((e) =>
      logger.error({ err: e }, "MessageCreate handler failed"),
    );
  });

  client.on(Events.MessageDelete, (message) => {
    void handleMessageDelete(message).catch((e) =>
      logger.error({ err: e }, "MessageDelete handler failed"),
    );
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReactionAdd(reaction, user, client).catch((e) =>
      logger.error({ err: e }, "MessageReactionAdd handler failed"),
    );
  });

  // Graceful shutdown — switch to offline avatar before exiting
  const shutdown = async (signal: string) => {
    logger.info(
      { signal },
      "Jarvis shutting down — switching to offline avatar",
    );
    try {
      const avatarBuffer = getOfflineAvatarBuffer();
      if (avatarBuffer) await client.user?.setAvatar(avatarBuffer);
      await new Promise((r) => setTimeout(r, 2500)); // allow Discord API to process
    } catch (e) {
      logger.warn({ err: e }, "Could not set offline avatar on shutdown");
    }
    client.destroy();
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Apply any pending DB migrations before connecting to Discord.
  // import.meta.url reliably points to the *bundle* file at runtime (dist/index.mjs)
  // and to this source file in ts-node/tsc dev mode.
  // The build script copies lib/db/migrations → dist/db-migrations so the
  // migrator can find them when running the production build standalone.
  const thisDirUrl = new URL(".", import.meta.url);
  const migrationsDir = join(fileURLToPath(thisDirUrl), "db-migrations");
  await runMigrations(migrationsDir);

  loadKnowledge();
  loadOverwatchFilters();
  loadJarvisAccess();
  loadRobloxTracking();
  loadTokenUsage();

  await client.login(token);
}
