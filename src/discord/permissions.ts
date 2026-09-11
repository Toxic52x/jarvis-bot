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

// Central rank gate for conversational tools that have no per-tool check of
// their own in the tool executor. Add new tools here as they're added to
// DISCORD_TOOLS — if a tool isn't listed, it runs with NO rank restriction.
// Merit's AI tools currently gate themselves inline via
// features/merit/service.ts's assert* functions, so this table is empty for
// now — it exists as the seam for a future tool domain that wants a simple
// declarative rank floor instead.

export const TOOL_MIN_RANK: Partial<Record<string, JarvisRank>> = {};

// Rank gate for legacy conversational actions dispatched outside the normal
// per-domain handler tables. Empty for the same reason as TOOL_MIN_RANK above.

export const LEGACY_TOOL_MIN_RANK: Partial<Record<string, JarvisRank>> = {};
