import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, FIRE_ORANGE, FIRE_RED } from "../../config";
import { canManageJarvis } from "../permissions";
import type {
  ExperienceInfo,
  RobloxTrackingState,
} from "../types";
import { logger } from "../../lib/logger";

// ─── Roblox presence tracking state ────────────────────────────────────────────

export const ROBLOX_TRACKING_FILE_PATH = join(DATA_DIR, "roblox-tracking.json");

export let robloxTracking: RobloxTrackingState = {
  experience: null,
  notifyChannelId: null,
  users: [],
};

export function loadRobloxTracking(): void {
  logger.info(
    { path: ROBLOX_TRACKING_FILE_PATH },
    "loadRobloxTracking: resolved file path",
  );
  let raw: string;
  try {
    raw = readFileSync(ROBLOX_TRACKING_FILE_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      logger.info(
        { path: ROBLOX_TRACKING_FILE_PATH },
        "No roblox-tracking.json found yet — starting empty (expected on first run)",
      );
    } else {
      logger.error(
        { err, path: ROBLOX_TRACKING_FILE_PATH },
        "loadRobloxTracking: failed to read file for a reason other than 'missing' — check filesystem permissions",
      );
    }
    robloxTracking = { experience: null, notifyChannelId: null, users: [] };
    return;
  }
  try {
    robloxTracking = JSON.parse(raw) as RobloxTrackingState;
    logger.info(
      {
        users: robloxTracking.users.length,
        experience: robloxTracking.experience?.name,
        notifyChannelId: robloxTracking.notifyChannelId,
      },
      "Roblox tracking state loaded successfully",
    );
  } catch (err) {
    logger.error(
      { err, path: ROBLOX_TRACKING_FILE_PATH, raw },
      "loadRobloxTracking: file exists but is not valid JSON — starting empty. Check for a corrupted or partially-written file.",
    );
    robloxTracking = { experience: null, notifyChannelId: null, users: [] };
  }
}

export function saveRobloxTracking(): void {
  try {
    writeFileSync(
      ROBLOX_TRACKING_FILE_PATH,
      JSON.stringify(robloxTracking, null, 2),
      "utf-8",
    );
    logger.info(
      { path: ROBLOX_TRACKING_FILE_PATH, users: robloxTracking.users.length },
      "saveRobloxTracking: wrote successfully",
    );
  } catch (err) {
    logger.error(
      { err, path: ROBLOX_TRACKING_FILE_PATH },
      "Failed to persist roblox-tracking.json — tracked users/experience will be lost on restart",
    );
  }
}

/** Polls Roblox presence for every tracked user and posts join/leave notifications. */
export async function pollRobloxPresence(client: Client): Promise<void> {
  if (!robloxTracking.experience) {
    logger.info("pollRobloxPresence: skipped — no experience set");
    return;
  }
  if (robloxTracking.users.length === 0) {
    logger.info("pollRobloxPresence: skipped — no users tracked");
    return;
  }

  const userIds = robloxTracking.users.map((u) => u.robloxUserId);
  let presenceData: {
    userPresences?: Array<{
      userId: number;
      userPresenceType: number;
      universeId?: number;
    }>;
  };
  logger.info(
    { userIds },
    "pollRobloxPresence: sending presence request to Roblox",
  );
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s hard timeout
    let res: Response;
    try {
      res = await fetch("https://presence.roblox.com/v1/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    logger.info(
      { status: res.status, userIds },
      "pollRobloxPresence: got response from Roblox",
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status, userIds },
        "pollRobloxPresence: non-OK status from Roblox presence API",
      );
      return;
    }
    presenceData = (await res.json()) as {
      userPresences?: Array<{
        userId: number;
        userPresenceType: number;
        universeId?: number;
      }>;
    };
    if (!presenceData.userPresences) {
      logger.warn(
        { presenceData, userIds },
        "pollRobloxPresence: response had no userPresences field",
      );
      return;
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    logger.error(
      { err, userIds, isTimeout },
      isTimeout
        ? "pollRobloxPresence: request to presence.roblox.com timed out after 10s — likely blocked or unreachable from this network"
        : "pollRobloxPresence: fetch/parse threw — network or Roblox API failure",
    );
    return;
  }

  const channelId =
    robloxTracking.notifyChannelId ??
    process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
  if (!channelId) {
    logger.warn(
      "pollRobloxPresence: no notify channel configured (neither robloxTracking.notifyChannelId nor DISCORD_OWNER_LOG_CHANNEL_ID) — presence changes will be detected but never posted",
    );
    return;
  }
  const channel = await client.channels
    .fetch(channelId)
    .catch((err: unknown) => {
      logger.warn(
        { err, channelId },
        "pollRobloxPresence: failed to fetch notify channel",
      );
      return null;
    });
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    logger.warn(
      { channelId },
      "pollRobloxPresence: notify channel not found or not a sendable text channel",
    );
    return;
  }

  let changed = false;
  const now = Date.now();

  // Warn once per poll if any tracked user simply wasn't returned by Roblox at all
  // (distinct from being returned as offline/type 0).
  const returnedIds = new Set(
    (presenceData.userPresences ?? []).map((p) => p.userId),
  );
  for (const tracked of robloxTracking.users) {
    if (!returnedIds.has(tracked.robloxUserId)) {
      logger.warn(
        {
          robloxUserId: tracked.robloxUserId,
          robloxUsername: tracked.robloxUsername,
        },
        "pollRobloxPresence: Roblox did not return presence data for this tracked user at all",
      );
    }
  }

  for (const presence of presenceData.userPresences ?? []) {
    const tracked = robloxTracking.users.find(
      (u) => u.robloxUserId === presence.userId,
    );
    if (!tracked) continue;

    const nowInExperience =
      presence.userPresenceType === 2 &&
      presence.universeId === robloxTracking.experience.universeId;

    // Flag likely privacy-restricted accounts: consistently reported offline (type 0)
    // across polls is the signature of a user whose join-activity privacy hides them
    // from this unauthenticated API call, indistinguishable here from "actually offline".
    if (presence.userPresenceType === 0 && tracked.lastPresenceType === 0) {
      logger.debug(
        {
          robloxUserId: tracked.robloxUserId,
          robloxUsername: tracked.robloxUsername,
        },
        "pollRobloxPresence: user has been reported offline across consecutive polls — may have join-activity privacy restricted, or may genuinely be offline",
      );
    }

    tracked.lastPresenceType = presence.userPresenceType;
    tracked.lastPolledAt = now;
    changed = true; // diagnostics changed even if in/out-of-experience state didn't

    if (nowInExperience && !tracked.wasInExperience) {
      await channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setTitle("🎮 ROBLOX PRESENCE — JOINED")
              .setDescription(
                `**${tracked.robloxUsername}** just joined **${robloxTracking.experience.name}**.`,
              )
              .setColor(FIRE_ORANGE)
              .setURL(robloxTracking.experience.url)
              .setTimestamp(),
          ],
        })
        .catch((err: unknown) =>
          logger.warn(
            { err, robloxUsername: tracked.robloxUsername },
            "pollRobloxPresence: failed to send JOINED notification",
          ),
        );
    } else if (!nowInExperience && tracked.wasInExperience) {
      await channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setTitle("👋 ROBLOX PRESENCE — LEFT")
              .setDescription(
                `**${tracked.robloxUsername}** left **${robloxTracking.experience.name}**.`,
              )
              .setColor(FIRE_RED)
              .setTimestamp(),
          ],
        })
        .catch((err: unknown) =>
          logger.warn(
            { err, robloxUsername: tracked.robloxUsername },
            "pollRobloxPresence: failed to send LEFT notification",
          ),
        );
    }

    tracked.wasInExperience = nowInExperience;
  }

  if (changed) saveRobloxTracking();
}

// ─── Roblox tracking helpers ────────────────────────────────────────────────

export async function resolveRobloxUser(
  username: string,
): Promise<{ id: number; name: string } | null> {
  try {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false,
      }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, username },
        "resolveRobloxUser: non-OK status from Roblox",
      );
      return null;
    }
    const data = (await res.json()) as {
      data: Array<{ id: number; name: string }>;
    };
    if (!data.data?.[0]) {
      logger.info(
        { username },
        "resolveRobloxUser: no matching Roblox account found",
      );
      return null;
    }
    return { id: data.data[0].id, name: data.data[0].name };
  } catch (err) {
    logger.error(
      { err, username },
      "resolveRobloxUser: threw — network or parsing failure",
    );
    return null;
  }
}

export function extractPlaceId(url: string): number | null {
  const match = url.match(/roblox\.com\/games\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

export async function resolveExperience(
  url: string,
): Promise<ExperienceInfo | { error: string }> {
  const placeId = extractPlaceId(url);
  if (!placeId) {
    logger.warn(
      { url },
      "resolveExperience: URL did not match roblox.com/games/<id> pattern",
    );
    return {
      error: "That doesn't look like a valid roblox.com/games/... link.",
    };
  }

  try {
    const universeRes = await fetch(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
    );
    if (!universeRes.ok) {
      logger.warn(
        { status: universeRes.status, placeId },
        "resolveExperience: universe lookup non-OK status",
      );
      return {
        error: `Roblox rejected that place ID (HTTP ${universeRes.status}) — check the link and try again.`,
      };
    }
    const universeData = (await universeRes.json()) as { universeId?: number };
    if (!universeData.universeId) {
      logger.warn(
        { placeId, universeData },
        "resolveExperience: response missing universeId",
      );
      return { error: "Could not resolve that experience — check the link." };
    }

    const gameRes = await fetch(
      `https://games.roblox.com/v1/games?universeIds=${universeData.universeId}`,
    );
    if (!gameRes.ok) {
      logger.warn(
        { status: gameRes.status, universeId: universeData.universeId },
        "resolveExperience: games lookup non-OK status",
      );
      return {
        error: `Roblox rejected that universe ID (HTTP ${gameRes.status}) — the experience may be private.`,
      };
    }
    const gameData = (await gameRes.json()) as {
      data?: Array<{ name: string; rootPlaceId: number }>;
    };
    const game = gameData.data?.[0];
    if (!game) {
      logger.warn(
        { universeId: universeData.universeId, gameData },
        "resolveExperience: no game data returned",
      );
      return { error: "Could not fetch experience details from Roblox." };
    }

    logger.info(
      { placeId, universeId: universeData.universeId, name: game.name },
      "resolveExperience: resolved successfully",
    );
    return {
      placeId,
      universeId: universeData.universeId,
      rootPlaceId: game.rootPlaceId,
      name: game.name,
      url,
    };
  } catch (err) {
    logger.error(
      { err, url, placeId },
      "resolveExperience: threw — network or parsing failure",
    );
    return {
      error:
        "I couldn't reach Roblox's API (network error or unexpected response). Check the logs and try again.",
    };
  }
}

// ─── Roblox tracking slash command handler ─────────────────────────────────────

export async function handleTrackRoblox(
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
      content: "Access Denied — Fire Lord and Owner only.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await handleTrackRobloxSub(interaction);
  } catch (error) {
    logger.error(
      { err: error, userId: interaction.user.id },
      "trackroblox: uncaught error in handler",
    );
    const message = error instanceof Error ? error.message : String(error);
    await interaction
      .editReply(
        `❌ Something went wrong, Sir: ${message}\n(Full details are in the server logs.)`,
      )
      .catch((e: unknown) =>
        logger.error(
          { err: e },
          "trackroblox: also failed to send the error reply",
        ),
      );
  }
}

export async function handleTrackRobloxSub(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "setexperience") {
    const url = interaction.options.getString("url", true);
    const resolved = await resolveExperience(url);
    if ("error" in resolved)
      return void (await interaction.editReply(resolved.error));
    robloxTracking.experience = resolved;
    robloxTracking.users.forEach((u) => (u.wasInExperience = false));
    saveRobloxTracking();
    await interaction.editReply(`Now watching **${resolved.name}** for joins.`);
    return;
  }

  if (sub === "add") {
    const username = interaction.options.getString("username", true);
    if (!robloxTracking.experience)
      return void (await interaction.editReply(
        "Set an experience first with `/trackroblox setexperience`.",
      ));

    const resolvedUser = await resolveRobloxUser(username);
    if (!resolvedUser) {
      return void (await interaction.editReply(
        `No Roblox account found for "${username}".`,
      ));
    }
    const { id: robloxUserId, name: robloxUsername } = resolvedUser;
    if (robloxTracking.users.some((u) => u.robloxUserId === robloxUserId))
      return void (await interaction.editReply(
        `${robloxUsername} is already being tracked.`,
      ));
    robloxTracking.users.push({
      robloxUserId,
      robloxUsername,
      wasInExperience: false,
      lastPresenceType: null,
      lastPolledAt: null,
    });
    saveRobloxTracking();
    await interaction.editReply(
      `Now tracking **${robloxUsername}** for joins into **${robloxTracking.experience.name}**.`,
    );
    return;
  }

  if (sub === "remove") {
    const username = interaction.options
      .getString("username", true)
      .toLowerCase();
    const before = robloxTracking.users.length;
    robloxTracking.users = robloxTracking.users.filter(
      (u) => u.robloxUsername.toLowerCase() !== username,
    );
    saveRobloxTracking();
    await interaction.editReply(
      robloxTracking.users.length < before
        ? `Stopped tracking ${username}.`
        : `${username} wasn't being tracked.`,
    );
    return;
  }

  if (sub === "channel") {
    robloxTracking.notifyChannelId = interaction.channelId;
    saveRobloxTracking();
    await interaction.editReply(
      "Notifications will post in this channel from now on.",
    );
    return;
  }

  // list
  if (!robloxTracking.experience)
    return void (await interaction.editReply("No experience set yet."));
  const userLines = robloxTracking.users.length
    ? robloxTracking.users
        .map((u) => {
          const status = u.wasInExperience ? "🟢 in-game" : "⚪ not in-game";
          const diag =
            u.lastPolledAt === null
              ? " _(never successfully polled — check logs)_"
              : u.lastPresenceType === 0
                ? " _(reported offline — could be genuinely offline, or this user's join-activity privacy may be hiding them)_"
                : "";
          return `• ${u.robloxUsername} — ${status}${diag}`;
        })
        .join("\n")
    : "_No users tracked yet_";
  await interaction.editReply(
    `**Watching:** [${robloxTracking.experience.name}](${robloxTracking.experience.url})\n**Tracked users:**\n${userLines}`,
  );
}
