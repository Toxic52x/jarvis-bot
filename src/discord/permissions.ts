import type { GuildMember } from "discord.js";
import {
  ADVISOR_ROLE_NAME,
  HR_ROLE_NAME,
  RANK_ORDER,
  ROYALTY_ROLE_NAME,
  getConfiguredIds,
  type JarvisRank,
} from "../config";

// ─── Rank helpers ─────────────────────────────────────────────────────────────

export function getJarvisRank(member: GuildMember): JarvisRank {
  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  const secondIds = getConfiguredIds("DISCORD_SECOND_IN_COMMAND_USER_IDS");
  const hrRoleIds = getConfiguredIds("DISCORD_HR_ROLE_IDS");

  if (ownerIds.has(member.id)) return "owner";
  if (secondIds.has(member.id)) return "second";
  if (member.roles.cache.some((r) => r.name === ROYALTY_ROLE_NAME))
    return "royalty";
  if (member.roles.cache.some((r) => r.name === ADVISOR_ROLE_NAME))
    return "advisor";
  if (
    [...hrRoleIds].some((id) => member.roles.cache.has(id)) ||
    member.roles.cache.some((r) => r.name === HR_ROLE_NAME)
  ) {
    return "hr";
  }
  return "none";
}

export function canManageJarvis(member: GuildMember): boolean {
  const rank = getJarvisRank(member);
  return rank === "owner" || rank === "second";
}

export function rankAtLeast(member: GuildMember, min: JarvisRank): boolean {
  return RANK_ORDER[getJarvisRank(member)] >= RANK_ORDER[min];
}

/**
 * The Owner is untouchable by the Fire Lord (second in command). This single
 * helper replaces the hand-rolled `actorRank === "second" && ownerIds.has(id)`
 * check that used to be duplicated across every moderation/merit code path.
 */
export function isProtectedOwner(
  actorRank: JarvisRank,
  targetId: string,
  ownerIds: Set<string>,
): boolean {
  return actorRank === "second" && ownerIds.has(targetId);
}

// ─── Conversational-tool rank gates ───────────────────────────────────────────

// Central rank gate for conversational tools that have no per-tool check
// of their own in the tool executor. Add new tools here as they're added to
// DISCORD_TOOLS — if a tool isn't listed, it runs with NO rank restriction.

export const TOOL_MIN_RANK: Partial<Record<string, JarvisRank>> = {
  delete_message: "advisor",
  create_channel: "hr",
  create_category: "hr",
  create_role: "hr",
  create_thread: "hr",
  archive_thread: "hr",
  lock_thread: "advisor",
  create_stage_channel: "hr",
  move_voice_member: "hr",
  server_mute_member: "hr",
  server_deafen_member: "hr",
  dm_user: "advisor",
  create_invite: "hr",
  revoke_invite: "advisor",
  create_emoji: "hr",
  delete_emoji: "advisor",
  create_webhook: "royalty",
  create_scheduled_event: "hr",
  query_audit_log: "advisor",
  watch_message_reactions: "hr",
  list_reaction_watches: "hr",
  cancel_reaction_watch: "hr",
};

// Rank gate for the legacy conversational actions in the switch statement
// at the bottom of executeTool.

export const LEGACY_TOOL_MIN_RANK: Partial<Record<string, JarvisRank>> = {
  ping_everyone: "hr",
  kick_member: "advisor",
  ban_member: "royalty",
  mute_member: "advisor",
  unmute_member: "advisor",
  assign_role: "hr",
  remove_role: "hr",
  set_nickname: "hr",
  send_message: "hr",
};
