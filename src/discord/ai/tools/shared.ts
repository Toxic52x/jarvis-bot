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

// Resolve a member by username, display name, or ID
export async function findMember(
  guild: Guild,
  query: string,
): Promise<GuildMember | null> {
  const mention = query.match(/^<@!?(\d+)>$/);
  if (mention) return guild.members.fetch(mention[1]).catch(() => null);
  if (/^\d+$/.test(query)) return guild.members.fetch(query).catch(() => null);
  const results = await guild.members
    .fetch({ query, limit: 10 })
    .catch(() => null);
  if (!results?.size) return null;
  const norm = query.toLowerCase();
  return (
    results.find(
      (m) =>
        m.user.username.toLowerCase() === norm ||
        m.user.globalName?.toLowerCase() === norm ||
        m.displayName.toLowerCase() === norm,
    ) ??
    results.first() ??
    null
  );
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
