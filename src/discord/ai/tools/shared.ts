import type { Guild, GuildMember, Message } from "discord.js";
import type { JarvisRank } from "../../../config";

// ─── Shared tool-handler contract ──────────────────────────────────────────
//
// Every conversational tool handler receives the same context object. It is
// assembled once per `executeTool` call, so handlers only destructure what
// they actually need. `guild` is already null-checked by executeTool's
// preamble before any handler runs.

export type ToolContext = {
  name: string;
  args: Record<string, unknown>;
  message: Message;
  guild: Guild;
  actorRank: JarvisRank;
  ownerIds: Set<string>;
  reason: string;
};

export type ToolHandler = (ctx: ToolContext) => Promise<string>;

// ─── Resolution helpers ────────────────────────────────────────────────────

// Resolve a member by username, display name, or ID. Discord's own member
// search is a prefix match, so an abbreviation like "nar" can return several
// candidates — if none is an exact match, this used to silently guess the
// first result. Now it reports ambiguity instead of guessing, so a caller can
// ask "did you mean X?" rather than risk acting on the wrong person.
export type MemberLookupResult =
  | { status: "found"; member: GuildMember }
  | { status: "ambiguous"; candidates: GuildMember[] }
  | { status: "not_found" };

export async function findMemberResult(
  guild: Guild,
  query: string,
): Promise<MemberLookupResult> {
  const mention = query.match(/^<@!?(\d+)>$/);
  if (mention) {
    const m = await guild.members.fetch(mention[1]).catch(() => null);
    return m ? { status: "found", member: m } : { status: "not_found" };
  }
  if (/^\d+$/.test(query)) {
    const m = await guild.members.fetch(query).catch(() => null);
    return m ? { status: "found", member: m } : { status: "not_found" };
  }
  const results = await guild.members
    .fetch({ query, limit: 10 })
    .catch(() => null);
  if (!results?.size) return { status: "not_found" };
  const norm = query.toLowerCase();
  const exact = results.find(
    (m) =>
      m.user.username.toLowerCase() === norm ||
      m.user.globalName?.toLowerCase() === norm ||
      m.displayName.toLowerCase() === norm,
  );
  if (exact) return { status: "found", member: exact };
  if (results.size === 1) return { status: "found", member: results.first()! };
  return { status: "ambiguous", candidates: [...results.values()] };
}

/** Formats an ambiguous-match list for a reply, e.g. "did you mean X, Y, or Z?" */
export function formatAmbiguousMembers(
  query: string,
  candidates: GuildMember[],
): string {
  const names = candidates
    .slice(0, 5)
    .map((m) => `${m.user.tag}${m.nickname ? ` (${m.nickname})` : ""}`)
    .join(", ");
  const more = candidates.length > 5 ? `, and ${candidates.length - 5} more` : "";
  return `I found multiple members matching "${query}", Sir — did you mean: ${names}${more}? Please be more specific.`;
}

/**
 * Convenience wrapper for the common case: resolve a name and return either
 * the member or an explanatory string ready to hand straight back to the
 * user (covers both "not found" and "ambiguous, did you mean X?").
 */
export async function findMember(
  guild: Guild,
  query: string,
): Promise<GuildMember | { error: string }> {
  const result = await findMemberResult(guild, query);
  if (result.status === "found") return result.member;
  if (result.status === "ambiguous")
    return { error: formatAmbiguousMembers(query, result.candidates) };
  return { error: `I could not locate a member matching "${query}", Sir.` };
}

/** Finds a text/announcement/voice/stage channel by name (case-insensitive). */
export function findAnyChannel(guild: Guild, name: string) {
  const norm = name.toLowerCase().replace(/^#/, "");
  return guild.channels.cache.find((c) => c.name.toLowerCase() === norm);
}

/** Finds a role by name (case-insensitive), excluding @everyone. */
export function findRole(guild: Guild, name: string) {
  const norm = name.toLowerCase();
  return guild.roles.cache.find(
    (r) => r.name.toLowerCase() === norm && r.name !== "@everyone",
  );
}
