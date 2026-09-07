import type { TextChannel } from "discord.js";
import type OpenAI from "openai";
import { RANK_ORDER } from "../../../config";
import { performRobloxLookup } from "../../roblox/lookup";
import {
  resolveExperience,
  resolveRobloxUser,
  robloxTracking,
  saveRobloxTracking,
} from "../../roblox/tracking";
import type { ToolHandler } from "./shared";

export const robloxToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "lookup_roblox_account",
      description:
        "Investigates a Roblox username for account-age, social-presence, and alt-account red flags. HR and above only.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
    },
  },

  // ── Roblox presence tracking (Fire Lord/Owner only) ─────────────────────────
  {
    type: "function" as const,
    function: {
      name: "track_roblox_user",
      description:
        "Adds a Roblox username to be tracked for joins into the currently-watched experience. Fire Lord/Owner only.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Roblox username to track.",
          },
        },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "untrack_roblox_user",
      description: "Stops tracking a Roblox username. Fire Lord/Owner only.",
      parameters: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_roblox_experience",
      description:
        "Sets which Roblox experience Jarvis watches for tracked-user joins, given a roblox.com/games/ link. Fire Lord/Owner only.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "A roblox.com/games/<placeId>/... link.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_roblox_tracking_status",
      description:
        "Reports the currently-watched Roblox experience and every tracked user's current in-game status. Fire Lord/Owner only.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
] satisfies OpenAI.Chat.ChatCompletionTool[];

// Shared by track_roblox_user / untrack_roblox_user / set_roblox_experience /
// get_roblox_tracking_status — the original executor handled all four names in
// one block behind a single Owner/Fire Lord gate, then branched on the name.
const robloxTrackingHandler: ToolHandler = async ({
  name,
  args,
  actorRank,
}) => {
  if (actorRank !== "owner" && actorRank !== "second") {
    return "Only the Owner or Fire Lord may manage Roblox tracking, Sir.";
  }

  if (name === "set_roblox_experience") {
    const url = String(args.url ?? "").trim();
    const resolved = await resolveExperience(url);
    if ("error" in resolved) return resolved.error;
    robloxTracking.experience = resolved;
    robloxTracking.users.forEach((u) => (u.wasInExperience = false));
    saveRobloxTracking();
    return `Now watching **${resolved.name}**, Sir.`;
  }

  if (name === "track_roblox_user") {
    if (!robloxTracking.experience)
      return "Set an experience first with set_roblox_experience, Sir.";
    const username = String(args.username ?? "").trim();
    const resolvedUser = await resolveRobloxUser(username);
    if (!resolvedUser)
      return `No Roblox account found for "${username}", Sir.`;
    const { id: robloxUserId, name: robloxUsername } = resolvedUser;
    robloxTracking.users.push({
      robloxUserId,
      robloxUsername,
      wasInExperience: false,
      lastPresenceType: null,
      lastPolledAt: null,
    });
    saveRobloxTracking();
    return `Now tracking **${robloxUsername}** for joins into **${robloxTracking.experience.name}**, Sir.`;
  }

  if (name === "untrack_roblox_user") {
    const username = String(args.username ?? "")
      .trim()
      .toLowerCase();
    const before = robloxTracking.users.length;
    robloxTracking.users = robloxTracking.users.filter(
      (u) => u.robloxUsername.toLowerCase() !== username,
    );
    saveRobloxTracking();
    return robloxTracking.users.length < before
      ? `Stopped tracking ${username}, Sir.`
      : `${username} wasn't being tracked, Sir.`;
  }

  // get_roblox_tracking_status
  if (!robloxTracking.experience)
    return "No experience is currently set, Sir.";
  const lines = robloxTracking.users.length
    ? robloxTracking.users
        .map((u) => {
          const status = u.wasInExperience ? "🟢 in-game" : "⚪ not in-game";
          const diag =
            u.lastPolledAt === null
              ? " (never successfully polled — check logs)"
              : u.lastPresenceType === 0
                ? " (reported offline — could be genuinely offline, or privacy-restricted)"
                : "";
          return `• ${u.robloxUsername} — ${status}${diag}`;
        })
        .join("\n")
    : "_No users tracked yet_";
  return `Watching **${robloxTracking.experience.name}**, Sir.\nTracked:\n${lines}`;
};

export const robloxToolHandlers: Record<string, ToolHandler> = {
  lookup_roblox_account: async ({ args, message, actorRank }) => {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const result = await performRobloxLookup(
      String(args.username ?? ""),
      message.author.tag,
    );
    if ("error" in result) return result.error;
    if ("sendTyping" in message.channel)
      await (message.channel as TextChannel).send({ embeds: [result.embed] });
    return "Investigation complete, Sir — report posted above.";
  },

  track_roblox_user: robloxTrackingHandler,

  untrack_roblox_user: robloxTrackingHandler,

  set_roblox_experience: robloxTrackingHandler,

  get_roblox_tracking_status: robloxTrackingHandler,
};
