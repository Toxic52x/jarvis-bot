import type {
  ChatInputCommandInteraction,
  Interaction,
} from "discord.js";
import { handleAddMerit, handleRemoveMerit } from "../merit/awards";
import {
  handleLeaderboard,
  handleMeritHistory,
  handleMerits,
} from "../merit/queries";
import { handleResetData } from "../merit/resetData";
import {
  handleCreateAdvisor,
  handleCreateHr,
  handleCreateRoyalty,
} from "../roles";
import {
  handleGlobalBan,
  handleGlobalKick,
  handleGlobalMute,
} from "../moderation/globalActions";
import { handleInactivePurge } from "../moderation/inactivePurge";
import { handleRequestGuards, handleRoyalGuard } from "../guard";
import { handleLookup } from "../roblox/lookup";
import { handleTrackRoblox } from "../roblox/tracking";
import {
  handleAddKnowledge,
  handleReloadKnowledge,
  handleStaydown,
} from "./misc";
import { logger } from "../../lib/logger";

/**
 * Every chat-input command name mapped to the handler that serves it. Adding a
 * command means adding its builder to commands/definitions.ts and one entry
 * here — no switch statement to extend.
 */
export const COMMAND_HANDLERS: Record<
  string,
  (interaction: ChatInputCommandInteraction) => Promise<void>
> = {
  addmerit: handleAddMerit,
  removemerit: handleRemoveMerit,
  merits: handleMerits,
  merithistory: handleMeritHistory,
  leaderboard: handleLeaderboard,
  createhr: handleCreateHr,
  createadvisor: handleCreateAdvisor,
  createroyalty: handleCreateRoyalty,
  resetdata: handleResetData,
  staydown: handleStaydown,
  globalkick: handleGlobalKick,
  globalban: handleGlobalBan,
  globalmute: handleGlobalMute,
  royalguard: handleRoyalGuard,
  requestguards: handleRequestGuards,
  lookup: handleLookup,
  inactivepurge: handleInactivePurge,
  reloadknowledge: handleReloadKnowledge,
  addknowledge: handleAddKnowledge,
  trackroblox: handleTrackRoblox,
};

/**
 * Routes an incoming interaction.
 *
 * Only chat-input commands are dispatched here. Every button in this bot is
 * served by a component collector attached to the message that produced it
 * (leaderboard/merit-history paging, the /resetdata and /inactivepurge
 * confirmations, and the guard RSVP + close buttons), so button, select-menu,
 * modal and autocomplete interactions are intentionally left alone rather than
 * being answered twice.
 */
export async function handleInteraction(
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const handler = COMMAND_HANDLERS[interaction.commandName];
  if (!handler) {
    logger.warn(
      { commandName: interaction.commandName },
      "Received a chat-input command with no registered handler",
    );
    return;
  }

  await handler(interaction);
}
