import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../lib/db";
import { loadJarvisAccess } from "./accessList";
import { ALL_COMMANDS } from "./commands/definitions";
import { handleInteraction } from "./commands/router";
import { handleMessageCreate } from "./events/messageEvents";
import { loadTokenUsage } from "./ai/geminiClient";
import { loadKnowledge } from "../features/knowledge/service";
import { getOfflineAvatarBuffer, startPresenceLoops } from "./presence";
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
    ],
  });

  client.once(Events.ClientReady, async (ready) => {
    const commands = ALL_COMMANDS.map((c) => c.toJSON());
    const rest = new REST({ version: "10" }).setToken(token);

    // ── Command registration — wrapped in try/catch so a failure here
    // (bad payload, permission issue, transient network error) can no
    // longer silently swallow everything below it (status rotation, etc).
    // Errors are now logged loudly. ─────────────────────────────────────
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
  loadJarvisAccess();
  loadTokenUsage();

  await client.login(token);
}
