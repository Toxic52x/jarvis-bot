import {
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";
import { appendFileSync } from "node:fs";
import { desc, eq, sql } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";
import {
  FIRE_RED,
  GEMINI_DAILY_LIMIT,
  GOOGLE_TPM_LIMIT,
  RANK_ORDER,
  ROYAL_GUARD_CHANNEL_ID,
  getConfiguredIds,
  type JarvisRank,
} from "../../config";
import {
  db,
  memberActivityTable,
  meritAwardsTable,
  remindersTable,
} from "../../lib/db";
import { jarvisAccessIds, saveJarvisAccess } from "../accessList";
import { writeGenericAuditLog } from "../auditLog";
import { postGuardRequest } from "../guard";
import {
  KNOWLEDGE_FILE_PATH,
  cachedKnowledge,
  loadKnowledge,
} from "../knowledge";
import { exportAndResetMeritData } from "../merit/resetData";
import {
  buildOverwatchDetailReport,
  overwatchActiveGuilds,
  overwatchViolations,
  reactionWatches,
} from "../moderation/overwatch";
import { TOOL_MIN_RANK, LEGACY_TOOL_MIN_RANK, isProtectedOwner } from "../permissions";
import {
  setProtocolSilent,
  setStatusRotationPaused,
  triggerStatusRotation,
} from "../presence";
import { performRobloxLookup } from "../roblox/lookup";
import {
  resolveExperience,
  resolveRobloxUser,
  robloxTracking,
  saveRobloxTracking,
} from "../roblox/tracking";
import {
  dailyTokensUsed,
  minuteTokensUsed,
  minuteWindowStart,
} from "./geminiClient";
import {
  GUIDE_TIER_ORDER,
  buildCommandGuide,
  buildFullCapabilityGuide,
  type CommandGuideTier,
} from "./systemPrompt";
import { findMember } from "./tools";

// ─── Additional resolution helpers ─────────────────────────────────────────

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

// Execute a tool call returned by the AI

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  message: Message,
  actorRank: JarvisRank,
): Promise<string> {
  const guild = message.guild;
  if (!guild) return "I am unable to perform server actions here, Sir.";

  const centralMinRank = TOOL_MIN_RANK[name];
  if (centralMinRank && RANK_ORDER[actorRank] < RANK_ORDER[centralMinRank]) {
    return `Access Denied — ${centralMinRank.charAt(0).toUpperCase() + centralMinRank.slice(1)} and above only, Sir.`;
  }

  // Handle tools that don't need reason before anything else
  if (name === "get_token_usage" || name === "get_server_status") {
    if (name === "get_server_status") {
      const allMembers = await guild.members.fetch();
      const totalMembers = allMembers.filter((m) => !m.user.bot).size;
      const onlineMembers = allMembers.filter(
        (m) =>
          !m.user.bot && m.presence?.status && m.presence.status !== "offline",
      ).size;

      let roleLine = "";
      const roleName = args.role_name ? String(args.role_name).trim() : "";
      if (roleName) {
        const role = guild.roles.cache.find(
          (r) => r.name.toLowerCase() === roleName.toLowerCase(),
        );
        if (role) {
          const roleMembers = allMembers.filter((m) =>
            m.roles.cache.has(role.id),
          );
          const roleOnline = roleMembers.filter(
            (m) => m.presence?.status && m.presence.status !== "offline",
          ).size;
          roleLine = ` Of those holding the "${role.name}" role: ${roleMembers.size} total, ${roleOnline} currently online.`;
        } else {
          roleLine = ` No role named "${roleName}" was found.`;
        }
      }

      return `${onlineMembers} of ${totalMembers} personnel currently online.${roleLine}`;
    }

    // Only reached when name === "get_token_usage"
    const dailyRemaining = Math.max(0, GEMINI_DAILY_LIMIT - dailyTokensUsed);
    const dailyPct = Math.min(
      100,
      (dailyTokensUsed / GEMINI_DAILY_LIMIT) * 100,
    ).toFixed(1);

    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilDailyReset = midnight.getTime() - now.getTime();
    const hoursUntilReset = Math.floor(msUntilDailyReset / 3_600_000);
    const minsUntilReset = Math.floor((msUntilDailyReset % 3_600_000) / 60_000);

    const nowMs = Date.now();
    const currentMinuteUsed =
      nowMs - minuteWindowStart >= 60_000 ? 0 : minuteTokensUsed;
    const minuteRemaining = Math.max(0, GOOGLE_TPM_LIMIT - currentMinuteUsed);
    const minutePct = Math.min(
      100,
      (currentMinuteUsed / GOOGLE_TPM_LIMIT) * 100,
    ).toFixed(1);
    const secsUntilMinuteReset = Math.max(
      0,
      Math.ceil((60_000 - (nowMs - minuteWindowStart)) / 1000),
    );

    return (
      `Daily: ${dailyTokensUsed.toLocaleString()} / ${GEMINI_DAILY_LIMIT.toLocaleString()} tokens used (${dailyPct}%), ${dailyRemaining.toLocaleString()} remaining — resets in ${hoursUntilReset}h ${minsUntilReset}m.\n` +
      `Per-minute: ${currentMinuteUsed.toLocaleString()} / ${GOOGLE_TPM_LIMIT.toLocaleString()} tokens used this minute (${minutePct}%), ${minuteRemaining.toLocaleString()} remaining — resets in ${secsUntilMinuteReset}s.`
    );
  }

  if (name === "get_command_guide") {
    const tierArg = String(args.tier ?? "member").toLowerCase();
    if (tierArg !== "member" && tierArg !== "hr" && tierArg !== "advisor") {
      return "I need a valid tier — Member, HR, or Advisor, Sir.";
    }
    return buildCommandGuide(tierArg as CommandGuideTier);
  }

  if (name === "get_full_capabilities") {
    const tierArg = String(
      args.tier ?? "member",
    ).toLowerCase() as CommandGuideTier;
    if (!GUIDE_TIER_ORDER.includes(tierArg)) return "I need a valid tier, Sir.";
    return buildFullCapabilityGuide(tierArg);
  }

  if (name === "search_nicknames") {
    const allMembers = await guild.members.fetch();
    const query = args.query ? String(args.query).trim().toLowerCase() : "";
    const withNicknames = allMembers.filter(
      (m) =>
        !!m.nickname && (!query || m.nickname!.toLowerCase().includes(query)),
    );
    if (withNicknames.size === 0) {
      return query
        ? `No members found with a nickname matching "${query}", Sir.`
        : "No members currently have a nickname set, Sir.";
    }
    const lines = [...withNicknames.values()]
      .slice(0, 50)
      .map((m) => `• ${m.user.tag} — "${m.nickname}"`);
    const extra =
      withNicknames.size > 50
        ? `\n…and ${withNicknames.size - 50} more not shown`
        : "";
    const label = query ? `matching "${query}"` : "with a nickname set";
    return `Members ${label} (${withNicknames.size}), Sir:\n${lines.join("\n")}${extra}`;
  }

  if (name === "list_servers") {
    const guilds = [...message.client.guilds.cache.values()];
    const lines = guilds
      .map((g) => `• ${g.name} (${g.memberCount ?? "?"} members)`)
      .join("\n");
    return `I am currently active in **${guilds.length}** server${guilds.length === 1 ? "" : "s"}, Sir:\n${lines}`;
  }

  if (name === "delete_message") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;

    let toDelete: Message | undefined;
    const msgIdArg = args.message_id
      ? String(args.message_id).match(/\d+/)?.[0]
      : undefined;

    if (msgIdArg) {
      toDelete = await target.messages.fetch(msgIdArg).catch(() => undefined);
      if (!toDelete)
        return `I could not find a message with ID "${msgIdArg}" in #${target.name}, Sir.`;
    } else {
      const recent = await target.messages.fetch({ limit: 20 });
      const usernameFilter = args.username
        ? String(args.username).toLowerCase()
        : null;
      toDelete = usernameFilter
        ? recent.find(
            (m) =>
              m.author.username.toLowerCase().includes(usernameFilter) ||
              m.author.tag.toLowerCase().includes(usernameFilter),
          )
        : recent.first();
      if (!toDelete)
        return "I could not find a matching message to delete, Sir.";
    }

    const authorTag = toDelete.author.tag;
    const snippet = toDelete.content
      ? toDelete.content.slice(0, 80)
      : "_(no text — embed/attachment)_";
    await toDelete.delete().catch(() => null);

    await writeGenericAuditLog(
      message.client,
      "JARVIS // MESSAGE DELETED (conversational)",
      [
        { name: "AUTHOR", value: authorTag },
        { name: "CHANNEL", value: `#${target.name}` },
        { name: "CONTENT", value: snippet },
      ],
      message.author.tag,
    );

    return `Deleted a message from ${authorTag} in #${target.name}, Sir.`;
  }

  if (
    name === "track_roblox_user" ||
    name === "untrack_roblox_user" ||
    name === "set_roblox_experience" ||
    name === "get_roblox_tracking_status"
  ) {
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
  }

  if (name === "activate_overwatch_mode") {
    overwatchActiveGuilds.add(guild.id);
    return "Overwatch Mode engaged, Sir. I will monitor silently and act on filtered language, invite links, and ping abuse without further prompting.";
  }

  if (name === "deactivate_overwatch_mode") {
    overwatchActiveGuilds.delete(guild.id);
    return "Overwatch Mode disengaged, Sir. Automated monitoring is off.";
  }

  if (name === "get_overwatch_status") {
    const active = overwatchActiveGuilds.has(guild.id);
    const totalViolations = [...overwatchViolations.entries()]
      .filter(([k]) => k.startsWith(`${guild.id}:`))
      .reduce((sum, [, v]) => sum + v, 0);
    return active
      ? `Overwatch Mode is currently **ON**, Sir. ${totalViolations} tracked violation${totalViolations === 1 ? "" : "s"} across monitored members since activation.`
      : "Overwatch Mode is currently **OFF**, Sir.";
  }

  if (name === "get_overwatch_detail") {
    const usernameFilter = args.username
      ? String(args.username).trim()
      : undefined;
    return buildOverwatchDetailReport(guild, usernameFilter);
  }

  // ── Jarvis standing-access grant/revoke/status ─────────────────────────────
  if (name === "grant_jarvis_access" || name === "revoke_jarvis_access") {
    if (actorRank !== "owner" && actorRank !== "second") {
      return "Only the Owner or Fire Lord may modify Jarvis access, Sir.";
    }
    const usernameArg = String(args.username ?? "").trim();
    if (!usernameArg) return "I need a user to target, Sir.";
    const targetMember = await findMember(guild, usernameArg);
    if (!targetMember)
      return `I could not locate a member matching "${usernameArg}", Sir.`;

    if (name === "grant_jarvis_access") {
      jarvisAccessIds.add(targetMember.id);
      saveJarvisAccess();
      await writeGenericAuditLog(
        message.client,
        "JARVIS // STANDING ACCESS GRANTED",
        [
          { name: "TARGET", value: `${targetMember.user.tag} (${targetMember.id})` },
          { name: "TOTAL WITH ACCESS", value: String(jarvisAccessIds.size), inline: true },
        ],
        message.author.tag,
      );
      return `${targetMember.user.tag} now has standing access to speak with me, Sir — this persists until revoked. (${jarvisAccessIds.size} total with granted access.)`;
    }
    const had = jarvisAccessIds.delete(targetMember.id);
    saveJarvisAccess();
    if (had) {
      await writeGenericAuditLog(
        message.client,
        "JARVIS // STANDING ACCESS REVOKED",
        [
          { name: "TARGET", value: `${targetMember.user.tag} (${targetMember.id})` },
          { name: "REMAINING WITH ACCESS", value: String(jarvisAccessIds.size), inline: true },
        ],
        message.author.tag,
      );
    }
    return had
      ? `${targetMember.user.tag}'s access has been revoked, Sir. (${jarvisAccessIds.size} remaining with granted access.)`
      : `${targetMember.user.tag} did not have standing access to begin with, Sir.`;
  }

  if (name === "get_jarvis_access_status") {
    if (jarvisAccessIds.size === 0)
      return "No one currently holds granted access, Sir — only the Owner and Fire Lord may speak with me by default.";
    const names = [...jarvisAccessIds].map((id) => {
      const m = guild.members.cache.get(id);
      return m ? m.user.tag : `Unknown User (${id})`;
    });
    return `${jarvisAccessIds.size} member${jarvisAccessIds.size === 1 ? "" : "s"} currently hold${jarvisAccessIds.size === 1 ? "s" : ""} granted access, Sir: ${names.join(", ")}`;
  }

  if (name === "set_avatar") {
    const url = String(args.url ?? "");
    if (!url) return "No image URL provided, Sir.";
    try {
      await message.client.user.setAvatar(url);
      return "Avatar updated, Sir.";
    } catch {
      return "I was unable to update my avatar, Sir. Discord may be rate-limiting avatar changes — try again in a few minutes.";
    }
  }

  if (name === "set_username") {
    const username = String(args.username ?? "").trim();
    if (!username) return "No username provided, Sir.";
    try {
      await message.client.user.setUsername(username);
      return `Username updated to "${username}", Sir.`;
    } catch {
      return "I was unable to update my username, Sir. Discord rate-limits username changes — please wait a while before trying again.";
    }
  }

  if (name === "set_reminder") {
    const minutes = Number(args.minutes_from_now);
    if (!minutes || minutes <= 0)
      return "I need a valid time for the reminder, Sir.";
    const reminderMsg = String(args.message ?? "").trim();
    if (!reminderMsg) return "I need something to remind you about, Sir.";
    const dueAt = new Date(Date.now() + minutes * 60_000);
    await db
      .insert(remindersTable)
      .values({ userId: message.author.id, message: reminderMsg, dueAt });
    const timeStr = dueAt.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    const label =
      minutes < 60
        ? `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`
        : `${(minutes / 60).toFixed(1).replace(/\.0$/, "")} hour${minutes === 60 ? "" : "s"}`;
    return `Understood, Sir. I will remind you about "${reminderMsg}" in ${label} (at ${timeStr} ET).`;
  }

  if (name === "activate_protocol_silent") {
    const everyoneRole = guild.roles.everyone;
    const channels = guild.channels.cache.filter(
      (c) =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement,
    ) as Map<string, TextChannel>;
    let count = 0;
    for (const [, ch] of channels) {
      try {
        await ch.permissionOverwrites.edit(everyoneRole, {
          SendMessages: false,
        });
        count++;
      } catch {
        /* skip channels bot can't edit */
      }
    }
    setProtocolSilent(true, guild.id);
    setStatusRotationPaused(true);
    message.client.user.setActivity("🔒 Protocol Silent — Server Locked");
    return `Protocol Silent activated, Sir. ${count} channel${count === 1 ? "" : "s"} locked.`;
  }

  if (name === "deactivate_protocol_silent") {
    const everyoneRole = guild.roles.everyone;
    const channels = guild.channels.cache.filter(
      (c) =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement,
    ) as Map<string, TextChannel>;
    let count = 0;
    for (const [, ch] of channels) {
      try {
        await ch.permissionOverwrites.edit(everyoneRole, {
          SendMessages: null,
        });
        count++;
      } catch {
        /* skip */
      }
    }
    setProtocolSilent(false, null);
    setStatusRotationPaused(false);
    triggerStatusRotation();
    return `Protocol Silent deactivated, Sir. ${count} channel${count === 1 ? "" : "s"} restored.`;
  }

  if (name === "lock_channel") {
    const target = guild.channels.cache.find(
      (c) =>
        (c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement) &&
        c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
    ) as TextChannel | undefined;
    if (!target)
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
    });
    return `#${target.name} has been locked, Sir.`;
  }

  if (name === "unlock_channel") {
    const target = guild.channels.cache.find(
      (c) =>
        (c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement) &&
        c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
    ) as TextChannel | undefined;
    if (!target)
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: null,
    });
    return `#${target.name} has been unlocked, Sir.`;
  }
  // ── Merit system ──────────────────────────────────────────────────────────
  if (name === "award_merit") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const meritType = String(args.merit_type ?? "") as
      | "exam"
      | "event"
      | "raid"
      | "bonus";
    const usernames = Array.isArray(args.usernames)
      ? (args.usernames as string[])
      : [];
    if (
      (meritType === "raid" || meritType === "bonus") &&
      RANK_ORDER[actorRank] < RANK_ORDER.advisor
    )
      return "Only Advisors and above can award Raid or Bonus merits, Sir.";

    const ownerIdsForAward = getConfiguredIds("DISCORD_OWNER_USER_IDS");

    if (meritType === "bonus") {
      if (!usernames.length) return "I need at least one member to award, Sir.";
      const amount = Number(args.amount);
      if (!amount || amount < 0.1 || amount > 7)
        return "Bonus amount must be between 0.1 and 7, Sir.";

      const resolvedBonus: GuildMember[] = [];
      const notFoundBonus: string[] = [];
      for (const u of usernames) {
        const m = await findMember(guild, u);
        if (m) resolvedBonus.push(m);
        else notFoundBonus.push(u);
      }
      if (resolvedBonus.length === 0)
        return "I could not locate any of the members you named, Sir.";
      if (
        resolvedBonus.some((m) =>
          isProtectedOwner(actorRank, m.id, ownerIdsForAward),
        )
      )
        return "Fire Lord cannot award merits that affect the Owner, Sir.";

      await db.insert(meritAwardsTable).values(
        resolvedBonus.map((m) => ({
          guildId: guild.id,
          memberId: m.id,
          memberTag: m.user.tag,
          amount,
          proofUrl: "Bonus (conversational)",
          awardedById: message.author.id,
          awardedByTag: message.author.tag,
        })),
      );
      await writeGenericAuditLog(
        message.client,
        "JARVIS // MERIT AWARD AUDIT",
        [
          {
            name: "RECIPIENTS",
            value: resolvedBonus
              .map((m) => `• ${m.user.tag} (+${amount})`)
              .join("\n")
              .slice(0, 1024),
          },
          { name: "TYPE", value: "Bonus (conversational)" },
        ],
        message.author.tag,
      );

      const notFoundNote =
        notFoundBonus.length > 0
          ? ` (${notFoundBonus.length} not found: ${notFoundBonus.join(", ")} — skipped)`
          : "";
      return `Recorded **+${amount}** Bonus merit${amount === 1 ? "" : "s"} for **${resolvedBonus.length}** member${resolvedBonus.length === 1 ? "" : "s"}${notFoundNote}, Sir — logged for owners.`;
    }

    // exam / event / raid — host is required and is the one credited
    const hostQuery = String(args.host ?? "").trim();
    if (!hostQuery)
      return "I need a host for that award, Sir — that's who receives the merit.";
    const hostMember = await findMember(guild, hostQuery);
    if (!hostMember)
      return `I could not locate a host matching "${hostQuery}", Sir.`;
    if (isProtectedOwner(actorRank, hostMember.id, ownerIdsForAward))
      return "Fire Lord cannot award merits that affect the Owner, Sir.";

    const resolvedMembers: GuildMember[] = [];
    for (const u of usernames) {
      const m = await findMember(guild, u);
      if (m) resolvedMembers.push(m);
    }
    if (
      resolvedMembers.some((m) =>
        isProtectedOwner(actorRank, m.id, ownerIdsForAward),
      )
    )
      return "Fire Lord cannot award merits that affect the Owner, Sir.";

    const amount = meritType === "raid" ? 3 : 1;
    if (!resolvedMembers.some((m) => m.id === hostMember.id))
      resolvedMembers.push(hostMember);

    await db.transaction(async (tx) => {
      await tx.insert(meritAwardsTable).values(
        resolvedMembers.map((m) => ({
          guildId: guild.id,
          memberId: m.id,
          memberTag: m.user.tag,
          amount,
          proofUrl: `${meritType[0].toUpperCase()}${meritType.slice(1)} (conversational)`,
          awardedById: message.author.id,
          awardedByTag: message.author.tag,
        })),
      );
    });
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MERIT AWARD AUDIT",
      [
        {
          name: "RECIPIENTS",
          value: resolvedMembers
            .map((m) => `• ${m.user.tag} (+${amount})`)
            .join("\n")
            .slice(0, 1024),
        },
        { name: "TYPE", value: meritType },
        { name: "HOST", value: hostMember.user.tag },
      ],
      message.author.tag,
    );
    return `Recorded **+${amount}** ${meritType} merit${amount === 1 ? "" : "s"} for **${resolvedMembers.length}** member${resolvedMembers.length === 1 ? "" : "s"} (Host: ${hostMember.user.tag}), Sir — logged for owners.`;
  }

  if (name === "remove_merit") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const amount = Number(args.amount);
    if (!amount || amount < 0.1 || amount > 7)
      return "Amount must be between 0.1 and 7, Sir.";
    const reasonText = String(args.reason ?? "").trim();
    if (!reasonText) return "I need a reason for the removal, Sir.";
    const ownerIdsForRemove = getConfiguredIds("DISCORD_OWNER_USER_IDS");
    if (isProtectedOwner(actorRank, target.id, ownerIdsForRemove))
      return "Fire Lord cannot remove merits from the Owner, Sir.";

    await db.insert(meritAwardsTable).values({
      guildId: guild.id,
      memberId: target.id,
      memberTag: target.user.tag,
      amount: -amount,
      proofUrl: reasonText,
      awardedById: message.author.id,
      awardedByTag: message.author.tag,
    });
    await writeGenericAuditLog(
      message.client,
      "JARVIS // MERIT REMOVAL AUDIT",
      [
        { name: "MEMBER", value: `${target.user.tag} (${target.id})` },
        { name: "AMOUNT REMOVED", value: `-${amount}` },
        { name: "REASON", value: reasonText },
      ],
      message.author.tag,
    );
    return `Recorded **-${amount}** merit${amount === 1 ? "" : "s"} for ${target.user.tag}, Sir — logged for owners.`;
  }

  if (name === "get_merits") {
    const usernameArg = args.username ? String(args.username).trim() : "";
    if (usernameArg) {
      const target = await findMember(guild, usernameArg);
      if (!target)
        return `I could not locate a member matching "${usernameArg}", Sir.`;
      const [result] = await db
        .select({
          total: sql<number>`coalesce(sum(${meritAwardsTable.amount}), 0)`,
        })
        .from(meritAwardsTable)
        .where(eq(meritAwardsTable.memberId, target.id));
      return `${target.user.tag} currently has **${Number(result?.total ?? 0)}** merits, Sir.`;
    }
    const leaderboard = await db
      .select({
        memberTag: meritAwardsTable.memberTag,
        total: sql<number>`sum(${meritAwardsTable.amount})`,
      })
      .from(meritAwardsTable)
      .groupBy(meritAwardsTable.memberId, meritAwardsTable.memberTag)
      .orderBy(desc(sql`sum(${meritAwardsTable.amount})`))
      .limit(10);
    if (leaderboard.length === 0)
      return "No merits have been recorded yet, Sir.";
    return `Top personnel by merit, Sir:\n${leaderboard.map((e, i) => `${i + 1}. ${e.memberTag} — ${Number(e.total)}`).join("\n")}`;
  }

  if (name === "get_merit_history") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const usernameArg = args.username ? String(args.username).trim() : "";
    const target = usernameArg
      ? await findMember(guild, usernameArg)
      : message.member!;
    if (!target)
      return `I could not locate a member matching "${usernameArg}", Sir.`;
    const history = await db
      .select()
      .from(meritAwardsTable)
      .where(eq(meritAwardsTable.memberId, target.id))
      .orderBy(desc(meritAwardsTable.createdAt));
    if (history.length === 0)
      return `No merit history found for ${target.user.tag}, Sir.`;
    return `Full merit history for ${target.user.tag} (${history.length} total), Sir:\n${history.map((a) => `• ${a.amount > 0 ? "+" : ""}${a.amount} — ${a.proofUrl}`).join("\n")}`;
  }

  if (name === "reset_merit_data") {
    if (actorRank !== "owner" && actorRank !== "second")
      return "Access Denied — only the Owner or Fire Lord can reset system data, Sir.";
    if (args.confirmed !== true)
      return "This permanently wipes all merit data, Sir. Please confirm explicitly before I proceed.";

    const { backupLines } = await exportAndResetMeritData(
      guild.id,
      message.author.tag,
    );
    await writeGenericAuditLog(
      message.client,
      "JARVIS // SYSTEM DATA BACKUP & RESET EXPORT",
      [{ name: "DATA BACKUP AT RESET", value: backupLines.slice(0, 1024) }],
      message.author.tag,
    );
    return "✅ All merit data has been reset, Sir. A full backup was logged to the owner channel first.";
  }

  // ── Roles ────────────────────────────────────────────────────────────────
  if (name === "create_role") {
    const roleName = String(args.role_name ?? "").trim();
    if (!roleName) return "I need a role name, Sir.";
    const existing = findRole(guild, roleName);
    if (existing) return `The "${existing.name}" role already exists, Sir.`;
    const role = await guild.roles.create({
      name: roleName,
      color: args.color ? (String(args.color) as `#${string}`) : undefined,
      hoist: typeof args.hoist === "boolean" ? args.hoist : undefined,
      mentionable:
        typeof args.mentionable === "boolean" ? args.mentionable : undefined,
      permissions: [],
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created the "${role.name}" role with no elevated permissions, Sir.`;
  }

  if (name === "delete_role") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const role = findRole(guild, String(args.role_name ?? ""));
    if (!role) return `I could not find a role named "${args.role_name}", Sir.`;
    const roleName = role.name;
    await role.delete(`Deleted conversationally by ${message.author.tag}`);
    return `The "${roleName}" role has been deleted, Sir.`;
  }

  if (name === "edit_role") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const role = findRole(guild, String(args.role_name ?? ""));
    if (!role) return `I could not find a role named "${args.role_name}", Sir.`;
    await role.edit({
      name: args.new_name ? String(args.new_name) : undefined,
      color: args.color ? (String(args.color) as `#${string}`) : undefined,
      hoist: typeof args.hoist === "boolean" ? args.hoist : undefined,
      mentionable:
        typeof args.mentionable === "boolean" ? args.mentionable : undefined,
      reason: `Edited conversationally by ${message.author.tag}`,
    });
    return `The "${role.name}" role has been updated, Sir.`;
  }

  if (name === "list_roles") {
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.name !== "@everyone")
      .sort((a, b) => b.position - a.position);
    if (roles.length === 0) return "No custom roles exist in this server, Sir.";
    return `Roles in this server, Sir:\n${roles
      .map(
        (r) =>
          `• ${r.name} — ${r.members.size} member${r.members.size === 1 ? "" : "s"}`,
      )
      .join("\n")
      .slice(0, 1800)}`;
  }

  // ── Messages ─────────────────────────────────────────────────────────────
  if (name === "purge_messages") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const rawCount = Number(args.count);
    if (!Number.isFinite(rawCount) || rawCount < 1)
      return "I need a valid number of messages to delete, Sir.";
    const count = Math.min(100, Math.floor(rawCount));
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("bulkDelete" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const deleted = await target.bulkDelete(count, true).catch(() => null);
    return deleted
      ? `Deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"} from #${target.name}, Sir. (Messages older than 14 days can't be bulk-deleted by Discord's API.)`
      : "❌ Failed to purge messages, Sir — check my Manage Messages permission.";
  }

  if (name === "pin_last_message") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const recent = await target.messages.fetch({ limit: 20 });
    const usernameFilter = args.username
      ? String(args.username).toLowerCase()
      : null;
    const toPin = usernameFilter
      ? recent.find(
          (m) =>
            m.author.username.toLowerCase().includes(usernameFilter) ||
            m.author.tag.toLowerCase().includes(usernameFilter),
        )
      : recent.first();
    if (!toPin) return "I could not find a matching message to pin, Sir.";
    const pinnedOk = await toPin.pin().catch(() => null);
    return pinnedOk
      ? `Pinned a message from ${toPin.author.tag} in #${target.name}, Sir.`
      : `❌ I was unable to pin that message in #${target.name}, Sir — check my Manage Messages permission (or whether the pin limit has been reached).`;
  }

  if (name === "unpin_last_message") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const pinned = await target.messages.fetchPinned();
    const latest = pinned.first();
    if (!latest) return `There are no pinned messages in #${target.name}, Sir.`;
    const unpinnedOk = await latest.unpin().catch(() => null);
    return unpinnedOk
      ? `Unpinned the most recent pin in #${target.name}, Sir.`
      : `❌ I was unable to unpin that message in #${target.name}, Sir — check my Manage Messages permission.`;
  }

  if (name === "react_to_last_message") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const recent = await target.messages.fetch({ limit: 1 });
    const last = recent.first();
    if (!last) return `There are no messages in #${target.name}, Sir.`;
    const reacted = await last
      .react(String(args.emoji ?? "👍"))
      .catch(() => null);
    return reacted
      ? `Reacted to the latest message in #${target.name}, Sir.`
      : `❌ I was unable to react to that message in #${target.name}, Sir — the emoji may be unavailable to me, or I lack the Add Reactions permission.`;
  }

  if (name === "create_poll") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("send" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const options = Array.isArray(args.options)
      ? (args.options as string[]).slice(0, 10)
      : [];
    if (options.length < 2)
      return "A poll needs at least 2 answer options, Sir.";
    const durationHours = Math.min(
      768,
      Math.max(1, Number(args.duration_hours) || 24),
    );
    await target.send({
      poll: {
        question: { text: String(args.question ?? "Poll") },
        answers: options.map((text) => ({ text })),
        duration: durationHours,
        allowMultiselect: false,
      },
    } as never);
    return `Poll posted in #${target.name}, Sir.`;
  }

  // ── Channels ─────────────────────────────────────────────────────────────
  if (name === "create_channel") {
    const catName = args.category_name ? String(args.category_name) : "";
    const parent = catName
      ? guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name.toLowerCase() === catName.toLowerCase(),
        )
      : undefined;
    const type =
      args.channel_type === "voice"
        ? ChannelType.GuildVoice
        : ChannelType.GuildText;
    const created = await guild.channels.create({
      name: String(args.name ?? "new-channel"),
      type,
      parent: parent?.id,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created ${args.channel_type === "voice" ? "voice channel" : "channel"} "${created.name}", Sir.`;
  }

  if (name === "delete_channel") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!target)
      return `I could not find a channel named "${args.channel_name}", Sir.`;
    const channelName = target.name;
    await target
      .delete(`Deleted conversationally by ${message.author.tag}`)
      .catch(() => null);
    return `The "${channelName}" channel has been deleted, Sir.`;
  }

  if (name === "create_category") {
    const created = await guild.channels.create({
      name: String(args.name ?? "New Category"),
      type: ChannelType.GuildCategory,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created the "${created.name}" category, Sir.`;
  }

  if (name === "rename_channel") {
    const target = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!target || !("setName" in target))
      return `I could not find a channel named "${args.channel_name}", Sir.`;
    const oldName = target.name;
    await (target as TextChannel).setName(String(args.new_name ?? oldName));
    return `Renamed #${oldName} to #${args.new_name}, Sir.`;
  }

  if (name === "set_channel_topic") {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("setTopic" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.setTopic(String(args.topic ?? ""));
    return `Updated the topic for #${target.name}, Sir.`;
  }

  if (name === "set_slowmode") {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("setRateLimitPerUser" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const seconds = Math.max(0, Math.min(21600, Number(args.seconds) || 0));
    await target.setRateLimitPerUser(seconds);
    return seconds > 0
      ? `Slowmode set to ${seconds}s in #${target.name}, Sir.`
      : `Slowmode disabled in #${target.name}, Sir.`;
  }

  if (name === "set_channel_nsfw") {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("setNSFW" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await target.setNSFW(Boolean(args.nsfw));
    return `#${target.name} is now marked ${args.nsfw ? "age-restricted" : "safe for all audiences"}, Sir.`;
  }

  // ── Threads ──────────────────────────────────────────────────────────────
  if (name === "create_thread") {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("threads" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const thread = await target.threads.create({
      name: String(args.thread_name ?? "New Thread"),
      reason: `Created conversationally by ${message.author.tag}`,
    });
    if (args.message) await thread.send(String(args.message)).catch(() => null);
    return `Created thread "${thread.name}" in #${target.name}, Sir.`;
  }

  if (name === "archive_thread" || name === "lock_thread") {
    const threadName = String(args.thread_name ?? "").toLowerCase();
    const allThreads = await guild.channels
      .fetchActiveThreads()
      .catch(() => null);
    const thread = allThreads?.threads.find(
      (t) => t.name.toLowerCase() === threadName,
    );
    if (!thread)
      return `I could not find an active thread named "${args.thread_name}", Sir.`;
    if (name === "lock_thread") {
      await thread.setLocked(true).catch(() => null);
      await thread.setArchived(true).catch(() => null);
      return `Locked and archived the "${thread.name}" thread, Sir.`;
    }
    await thread.setArchived(true).catch(() => null);
    return `Archived the "${thread.name}" thread, Sir.`;
  }

  // ── Voice ────────────────────────────────────────────────────────────────
  if (name === "move_voice_member") {
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (!target.voice.channel)
      return `${target.user.tag} is not currently in a voice channel, Sir.`;
    const destination = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!destination || destination.type !== ChannelType.GuildVoice)
      return `I could not find a voice channel named "${args.channel_name}", Sir.`;
    await target.voice.setChannel(destination.id);
    return `Moved ${target.user.tag} to #${destination.name}, Sir.`;
  }

  if (name === "server_mute_member" || name === "server_deafen_member") {
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    if (name === "server_mute_member") {
      const muted = await target.voice
        .setMute(Boolean(args.mute))
        .catch(() => null);
      return muted
        ? `${target.user.tag} has been ${args.mute ? "server-muted" : "unmuted"}, Sir.`
        : `❌ I was unable to ${args.mute ? "server-mute" : "unmute"} ${target.user.tag}, Sir — they may not be in a voice channel, or I lack the Mute Members permission.`;
    }
    const deafened = await target.voice
      .setDeaf(Boolean(args.deafen))
      .catch(() => null);
    return deafened
      ? `${target.user.tag} has been ${args.deafen ? "server-deafened" : "undeafened"}, Sir.`
      : `❌ I was unable to ${args.deafen ? "server-deafen" : "undeafen"} ${target.user.tag}, Sir — they may not be in a voice channel, or I lack the Deafen Members permission.`;
  }

  if (name === "create_stage_channel") {
    const catName = args.category_name ? String(args.category_name) : "";
    const parent = catName
      ? guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name.toLowerCase() === catName.toLowerCase(),
        )
      : undefined;
    const created = await guild.channels.create({
      name: String(args.name ?? "Stage"),
      type: ChannelType.GuildStageVoice,
      parent: parent?.id,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Created stage channel "${created.name}", Sir.`;
  }

  // ── Members ──────────────────────────────────────────────────────────────
  if (name === "unban_member") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const idOrName = String(args.username_or_id ?? "");
    const bans = await guild.bans.fetch().catch(() => null);
    const ban = bans?.find(
      (b) =>
        b.user.id === idOrName ||
        b.user.username.toLowerCase() === idOrName.toLowerCase() ||
        b.user.tag.toLowerCase() === idOrName.toLowerCase(),
    );
    if (!ban) return `I could not find a ban matching "${idOrName}", Sir.`;
    await guild.bans.remove(
      ban.user.id,
      `Unbanned conversationally by ${message.author.tag}`,
    );
    return `${ban.user.tag} has been unbanned, Sir.`;
  }

  if (name === "list_bans") {
    const bans = await guild.bans.fetch().catch(() => null);
    if (!bans || bans.size === 0)
      return "There are no active bans in this server, Sir.";
    return `Currently banned, Sir:\n${[...bans.values()]
      .slice(0, 30)
      .map((b) => `• ${b.user.tag} (${b.user.id})`)
      .join("\n")}`;
  }

  if (name === "softban_member") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const reasonText = `[Jarvis Softban — requested by ${message.author.tag}]${args.reason ? ` ${args.reason}` : ""}`;
    await guild.bans.create(target.id, {
      reason: reasonText,
      deleteMessageSeconds: 7 * 86400,
    });
    await guild.bans.remove(target.id, "Softban cleanup").catch(() => null);
    return `${target.user.tag} has been softbanned — recent messages purged, Sir.`;
  }

  if (name === "get_member_info") {
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const roles = target.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => r.name);
    return (
      `**${target.user.tag}**, Sir:\n` +
      `• Joined server: <t:${Math.floor((target.joinedTimestamp ?? 0) / 1000)}:D>\n` +
      `• Account created: <t:${Math.floor(target.user.createdTimestamp / 1000)}:D>\n` +
      `• Roles: ${roles.length > 0 ? roles.join(", ") : "None"}`
    );
  }

  if (name === "dm_user") {
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    try {
      await target.send(String(args.message ?? ""));
      return `Message sent to ${target.user.tag} via DM, Sir.`;
    } catch {
      return `I was unable to DM ${target.user.tag}, Sir — they likely have DMs disabled.`;
    }
  }

  // ── Server settings ──────────────────────────────────────────────────────
  if (name === "rename_server") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    await guild.setName(String(args.name ?? guild.name));
    return `Server renamed to "${args.name}", Sir.`;
  }

  if (name === "set_server_icon") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    await guild.setIcon(String(args.url ?? "")).catch(() => null);
    return "Server icon updated, Sir.";
  }

  if (name === "set_afk_channel") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = findAnyChannel(guild, String(args.channel_name ?? ""));
    if (!target || target.type !== ChannelType.GuildVoice)
      return `I could not find a voice channel named "${args.channel_name}", Sir.`;
    await guild.setAFKChannel(target.id);
    if (args.timeout_minutes)
      await guild.setAFKTimeout(
        (Number(args.timeout_minutes) * 60) as 60 | 300 | 900 | 1800 | 3600,
      );
    return `AFK channel set to #${target.name}, Sir.`;
  }

  if (name === "set_system_channel") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target)
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    await guild.setSystemChannel(target.id);
    return `System messages channel set to #${target.name}, Sir.`;
  }

  // ── Invites ──────────────────────────────────────────────────────────────
  if (name === "create_invite") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("createInvite" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const maxUses = Number(args.max_uses) || 0;
    const expiresHours = Number(args.expires_hours) || 0;
    const invite = await target.createInvite({
      maxUses,
      maxAge: expiresHours > 0 ? expiresHours * 3600 : 0,
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Invite created, Sir: https://discord.gg/${invite.code}`;
  }

  if (name === "list_invites") {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites || invites.size === 0)
      return "There are no active invites, Sir.";
    return `Active invites, Sir:\n${[...invites.values()]
      .slice(0, 20)
      .map(
        (i) =>
          `• ${i.code} — #${i.channel?.name ?? "unknown"} — ${i.uses ?? 0} uses`,
      )
      .join("\n")}`;
  }

  if (name === "revoke_invite") {
    const invites = await guild.invites.fetch().catch(() => null);
    const invite = invites?.find((i) => i.code === String(args.code ?? ""));
    if (!invite)
      return `I could not find an invite with code "${args.code}", Sir.`;
    await invite.delete(`Revoked conversationally by ${message.author.tag}`);
    return `Invite ${args.code} has been revoked, Sir.`;
  }

  // ── Emoji ────────────────────────────────────────────────────────────────
  if (name === "create_emoji") {
    const created = await guild.emojis
      .create({
        name: String(args.name ?? "emoji"),
        attachment: String(args.url ?? ""),
        reason: `Created conversationally by ${message.author.tag}`,
      })
      .catch(() => null);
    return created
      ? `Created emoji "${created.name}", Sir.`
      : "❌ Failed to create the emoji, Sir — check the image URL and format.";
  }

  if (name === "delete_emoji") {
    const emojiName = String(args.name ?? "").toLowerCase();
    const emoji = guild.emojis.cache.find(
      (e) => e.name?.toLowerCase() === emojiName,
    );
    if (!emoji) return `I could not find an emoji named "${args.name}", Sir.`;
    await emoji.delete(`Deleted conversationally by ${message.author.tag}`);
    return `Emoji "${args.name}" has been deleted, Sir.`;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────
  if (name === "create_webhook") {
    const target = findAnyChannel(guild, String(args.channel_name ?? "")) as
      | TextChannel
      | undefined;
    if (!target || !("createWebhook" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;
    const webhook = await target.createWebhook({
      name: String(args.name ?? "Jarvis Webhook"),
      reason: `Created conversationally by ${message.author.tag}`,
    });
    return `Webhook created in #${target.name}, Sir: ${webhook.url}`;
  }

  // ── Scheduled events ─────────────────────────────────────────────────────
  if (name === "create_scheduled_event") {
    const startAt = new Date(
      Date.now() + Number(args.minutes_from_now) * 60_000,
    );
    const durationMin = Number(args.duration_minutes) || 60;
    const endAt = new Date(startAt.getTime() + durationMin * 60_000);
    const channelName = args.channel_name ? String(args.channel_name) : "";
    const targetChannel = channelName
      ? findAnyChannel(guild, channelName)
      : undefined;

    // Stage → 1, Voice → 2, no channel at all → 3 (External). Anything else
    // (a text channel, a category…) cannot host a scheduled event.
    let entityType: 1 | 2 | 3 = 3;
    if (targetChannel) {
      if (targetChannel.type === ChannelType.GuildStageVoice) entityType = 1;
      else if (targetChannel.type === ChannelType.GuildVoice) entityType = 2;
      else
        return "That's not a voice or stage channel, Sir — scheduled events need one of those.";
    }

    const created = await guild.scheduledEvents
      .create({
        name: String(args.name ?? "Fire Nation Event"),
        scheduledStartTime: startAt,
        scheduledEndTime: endAt,
        privacyLevel: 2, // GuildOnly
        entityType,
        channel: targetChannel?.id,
        entityMetadata: targetChannel
          ? undefined
          : { location: String(args.location ?? "TBD") },
        description: args.description ? String(args.description) : undefined,
        reason: `Created conversationally by ${message.author.tag}`,
      })
      .catch(() => null);
    return created
      ? `Scheduled event "${created.name}" created, starting <t:${Math.floor(startAt.getTime() / 1000)}:R>, Sir.`
      : "❌ Failed to create the scheduled event, Sir.";
  }

  // ── Audit log ────────────────────────────────────────────────────────────
  if (name === "query_audit_log") {
    const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
    const logs = await guild.fetchAuditLogs({ limit }).catch(() => null);
    if (!logs || logs.entries.size === 0)
      return "No audit log entries found, Sir.";
    return `Recent audit log entries, Sir:\n${[...logs.entries.values()]
      .map(
        (e) =>
          `• ${e.actionType} by ${e.executor?.tag ?? "unknown"} — target: ${e.targetId ?? "n/a"}${e.reason ? ` — "${e.reason}"` : ""}`,
      )
      .join("\n")
      .slice(0, 1800)}`;
  }

  // ── Fire Nation admin tools brought over from slash-only commands ──────────
  if (name === "global_ban") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const target = await findMember(guild, String(args.username ?? ""));
    if (!target)
      return `I could not locate a member matching "${args.username}", Sir.`;
    const ownerIdsForGlobal = getConfiguredIds("DISCORD_OWNER_USER_IDS");
    if (isProtectedOwner(actorRank, target.id, ownerIdsForGlobal))
      return "Fire Lord cannot run global actions that affect the Owner, Sir.";
    const reasonText = `[Jarvis Global Ban] ${args.reason ?? "No reason provided."} — by ${message.author.tag}`;
    let success = 0,
      skipped = 0,
      failed = 0;
    for (const g of message.client.guilds.cache.values()) {
      try {
        await g.bans.create(target.id, {
          reason: reasonText,
          deleteMessageSeconds: 0,
        });
        success++;
      } catch (e: unknown) {
        const code = (e as { code?: number }).code;
        if (code === 10007 || code === 10013) skipped++;
        else failed++;
      }
    }
    await writeGenericAuditLog(
      message.client,
      "JARVIS // GLOBAL BAN EXECUTED",
      [
        { name: "TARGET", value: `${target.user.tag} (${target.id})` },
        {
          name: "RESULTS",
          value: `✅ Banned: ${success} | ⏭️ Not found: ${skipped} | ❌ Failed: ${failed}`,
        },
      ],
      message.author.tag,
    );
    return `Global ban complete, Sir — ${success} banned, ${skipped} not found, ${failed} failed.`;
  }

  if (name === "acknowledge_breach") {
    if (actorRank !== "owner" && actorRank !== "second")
      return "Access Denied — only the Owner or Fire Lord can silence alarms, Sir.";
    const logChannelId = process.env.DISCORD_OWNER_LOG_CHANNEL_ID?.trim();
    if (!logChannelId)
      return "❌ I cannot lift the lockdown, Sir — no owner log channel is configured (DISCORD_OWNER_LOG_CHANNEL_ID).";
    const ch = await message.client.channels
      .fetch(logChannelId)
      .catch(() => null);
    if (!ch || !("permissionOverwrites" in ch))
      return "❌ I cannot lift the lockdown, Sir — the configured owner log channel could not be reached.";
    const restored = await (ch as TextChannel).permissionOverwrites
      .edit(guild.roles.everyone, { ViewChannel: null, SendMessages: null })
      .catch(() => null);
    if (restored === null)
      return "❌ I could not restore the channel permissions, Sir — check my Manage Roles/Manage Channels permission there.";
    return `🟢 Lockdown lifted, Sir — breach acknowledged and the channel has been restored.`;
  }

  if (name === "royal_guard_alert") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.royalty)
      return "Access Denied — Royalty and above only, Sir.";
    const ch = await message.client.channels
      .fetch(ROYAL_GUARD_CHANNEL_ID)
      .catch(() => null);
    if (!ch || !ch.isTextBased() || !("send" in ch))
      return "Could not reach the Royal Guard channel, Sir.";
    const embed = new EmbedBuilder()
      .setTitle("🛡️ ROYAL GUARD ALERT")
      .setDescription("A Royal is currently in game and requires escort.")
      .setColor(FIRE_RED)
      .addFields(
        { name: "ROYAL", value: message.author.tag },
        ...(args.location
          ? [{ name: "LOCATION", value: String(args.location) }]
          : []),
      )
      .setTimestamp();
    await ch.send({ content: "@everyone", embeds: [embed] });
    return "Royal Guard has been notified, Sir.";
  }

  if (name === "request_guards") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const result = await postGuardRequest(
      message.client,
      guild,
      { id: message.author.id, tag: message.author.tag },
      String(args.when ?? "TBD"),
      String(args.location ?? "TBD"),
    );
    return result.ok
      ? "Guard request posted, Sir. I'll DM you privately as people confirm — no one else can see who's RSVP'd."
      : `Could not post the guard request: ${result.error}`;
  }

  if (name === "lookup_roblox_account") {
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
  }

  if (name === "inactive_purge") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.advisor)
      return "Access Denied — Advisor and above only, Sir.";
    const days = Math.max(1, Number(args.days) || 30);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const allMembers = await guild.members.fetch();
    const nonBotIds = [...allMembers.values()]
      .filter((m) => !m.user.bot)
      .map((m) => m.id);
    const activeRecords = await db
      .select({ userId: memberActivityTable.userId })
      .from(memberActivityTable)
      .where(
        drizzleSql`${memberActivityTable.guildId} = ${guild.id} AND ${memberActivityTable.lastSeenAt} >= ${cutoff}`,
      );
    const activeIds = new Set(activeRecords.map((r) => r.userId));
    const inactiveMembers = nonBotIds
      .filter((id) => !activeIds.has(id))
      .map((id) => allMembers.get(id)!)
      .filter(Boolean);

    if (inactiveMembers.length === 0)
      return `No members found with ${days}+ days of inactivity, Sir.`;

    if (args.confirmed !== true) {
      return `Found **${inactiveMembers.length}** member${inactiveMembers.length === 1 ? "" : "s"} inactive for ${days}+ days, Sir:\n${inactiveMembers
        .slice(0, 30)
        .map((m) => `• ${m.user.tag}`)
        .join("\n")}\n\nSay the word if you'd like me to kick them.`;
    }

    let kicked = 0;
    for (const m of inactiveMembers) {
      try {
        await m.kick(`Inactivity purge — ${days}d — by ${message.author.tag}`);
        kicked++;
      } catch {
        /* skip */
      }
    }
    return `✅ Kicked **${kicked}** inactive member${kicked === 1 ? "" : "s"}, Sir.`;
  }

  if (name === "reload_knowledge_base") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const before = cachedKnowledge.length;
    loadKnowledge();
    return cachedKnowledge.length > 0
      ? `Knowledge base reloaded, Sir. (${before} → ${cachedKnowledge.length} characters)`
      : "Knowledge base reload failed, Sir — the file could not be read.";
  }

  if (name === "add_knowledge_entry") {
    if (RANK_ORDER[actorRank] < RANK_ORDER.hr)
      return "Access Denied — HR and above only, Sir.";
    const entry = String(args.entry ?? "").trim();
    if (!entry) return "I need something to add, Sir.";
    const timestamp = new Date().toISOString();
    appendFileSync(
      KNOWLEDGE_FILE_PATH,
      `\n[Added ${timestamp} by ${message.author.tag}] ${entry}\n`,
      "utf-8",
    );
    loadKnowledge();
    return `Knowledge base updated, Sir. (${cachedKnowledge.length} characters total)`;
  }

  // ── Reaction watching ────────────────────────────────────────────────────
  if (name === "watch_message_reactions") {
    const target = args.channel_name
      ? (findAnyChannel(guild, String(args.channel_name)) as
          | TextChannel
          | undefined)
      : (message.channel as TextChannel);
    if (!target || !("messages" in target))
      return `I could not find a text channel named "${args.channel_name}", Sir.`;

    const emoji = String(args.emoji ?? "").trim();
    if (!emoji) return "I need an emoji to watch for, Sir.";
    const rawThreshold = Number(args.threshold);
    if (!Number.isFinite(rawThreshold) || rawThreshold < 1)
      return "I need a valid target reaction count, Sir.";
    const threshold = Math.floor(rawThreshold);

    let targetMessage: Message | undefined;
    const msgIdArg = args.message_id
      ? String(args.message_id).match(/\d+/)?.[0]
      : undefined;
    if (msgIdArg) {
      targetMessage = await target.messages
        .fetch(msgIdArg)
        .catch(() => undefined);
      if (!targetMessage)
        return `I could not find a message with ID "${msgIdArg}" in #${target.name}, Sir.`;
    } else {
      targetMessage = (await target.messages.fetch({ limit: 1 })).first();
      if (!targetMessage)
        return `There are no messages in #${target.name} to watch, Sir.`;
    }

    const key = `${targetMessage.id}:${emoji}`;
    reactionWatches.set(key, {
      guildId: guild.id,
      channelId: target.id,
      messageId: targetMessage.id,
      emoji,
      threshold,
      requesterId: message.author.id,
      createdAt: Date.now(),
    });

    const currentCount = targetMessage.reactions.cache.get(emoji)?.count ?? 0;
    return `Watching that message in #${target.name} for **${threshold}** ${emoji} reactions, Sir. (Currently at ${currentCount}.) I'll DM you the moment it hits the target.`;
  }

  if (name === "list_reaction_watches") {
    const entries = [...reactionWatches.entries()].filter(
      ([, w]) => w.guildId === guild.id,
    );
    if (entries.length === 0)
      return "No active reaction watches in this server, Sir.";
    return `Active reaction watches, Sir:\n${entries
      .map(
        ([, w]) =>
          `• [${w.messageId}] ${w.emoji} → ${w.threshold} in <#${w.channelId}> (requested by <@${w.requesterId}>)`,
      )
      .join("\n")}`;
  }

  if (name === "cancel_reaction_watch") {
    const msgIdArg = args.message_id
      ? String(args.message_id).match(/\d+/)?.[0]
      : undefined;
    const guildEntries = [...reactionWatches.entries()].filter(
      ([, w]) => w.guildId === guild.id,
    );
    const toCancel = msgIdArg
      ? guildEntries.filter(([, w]) => w.messageId === msgIdArg)
      : guildEntries
          .sort((a, b) => b[1].createdAt - a[1].createdAt)
          .slice(0, 1);
    if (toCancel.length === 0)
      return "I could not find a matching reaction watch to cancel, Sir.";
    for (const [key] of toCancel) reactionWatches.delete(key);
    return `Cancelled ${toCancel.length} reaction watch${toCancel.length === 1 ? "" : "es"}, Sir.`;
  }

  const ownerIds = getConfiguredIds("DISCORD_OWNER_USER_IDS");
  const reason = `[Jarvis — requested by ${message.author.tag}]${args.reason ? ` ${args.reason}` : ""}`;

  // ── Rank gate for the legacy conversational actions below ──────────────────
  const requiredRank = LEGACY_TOOL_MIN_RANK[name];
  if (requiredRank && RANK_ORDER[actorRank] < RANK_ORDER[requiredRank]) {
    return `Access Denied — ${requiredRank.charAt(0).toUpperCase() + requiredRank.slice(1)} and above only, Sir.`;
  }

  switch (name) {
    case "ping_everyone": {
      const content = `@everyone${args.message ? ` ${args.message}` : ""}`;
      if (args.channel_name) {
        const ch = guild.channels.cache.find(
          (c) =>
            c.isTextBased() &&
            c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
        ) as TextChannel | undefined;
        if (!ch)
          return `I could not find a channel named "${args.channel_name}", Sir.`;
        await ch.send({ content, allowedMentions: { parse: ["everyone"] } });
        return `@everyone ping sent to #${ch.name}, Sir.`;
      }
      const ch = message.channel as TextChannel;
      await ch.send({ content, allowedMentions: { parse: ["everyone"] } });
      return "@everyone ping sent, Sir.";
    }

    case "kick_member": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      if (isProtectedOwner(actorRank, target.id, ownerIds))
        return "I cannot perform that action on the Owner, Sir.";
      await target.kick(reason);
      await writeGenericAuditLog(
        message.client,
        "JARVIS // MEMBER KICKED (conversational)",
        [
          { name: "TARGET", value: `${target.user.tag} (${target.id})` },
          {
            name: "REASON",
            value: String(args.reason ?? "No reason provided."),
          },
        ],
        message.author.tag,
      );
      return `${target.user.tag} has been removed from the server, Sir.`;
    }

    case "ban_member": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      if (isProtectedOwner(actorRank, target.id, ownerIds))
        return "I cannot perform that action on the Owner, Sir.";
      await target.ban({ reason, deleteMessageSeconds: 0 });
      await writeGenericAuditLog(
        message.client,
        "JARVIS // MEMBER BANNED (conversational)",
        [
          { name: "TARGET", value: `${target.user.tag} (${target.id})` },
          {
            name: "REASON",
            value: String(args.reason ?? "No reason provided."),
          },
        ],
        message.author.tag,
      );
      return `${target.user.tag} has been permanently banned, Sir.`;
    }

    case "mute_member": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      if (isProtectedOwner(actorRank, target.id, ownerIds))
        return "I cannot perform that action on the Owner, Sir.";
      const durationMs = Number(args.duration_minutes) * 60 * 1000;
      const until = new Date(Date.now() + durationMs);
      await target.disableCommunicationUntil(until, reason);
      await writeGenericAuditLog(
        message.client,
        "JARVIS // MEMBER MUTED (conversational)",
        [
          { name: "TARGET", value: `${target.user.tag} (${target.id})` },
          { name: "DURATION", value: `${args.duration_minutes} minute(s)` },
          {
            name: "REASON",
            value: String(args.reason ?? "No reason provided."),
          },
        ],
        message.author.tag,
      );
      return `${target.user.tag} has been muted for ${args.duration_minutes} minute${Number(args.duration_minutes) === 1 ? "" : "s"}, Sir.`;
    }

    case "unmute_member": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      await target.disableCommunicationUntil(null, reason);
      return `${target.user.tag}'s timeout has been lifted, Sir.`;
    }

    case "assign_role": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      if (isProtectedOwner(actorRank, target.id, ownerIds))
        return "I cannot perform that action on the Owner, Sir.";
      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === String(args.role_name).toLowerCase(),
      );
      if (!role)
        return `I could not find a role named "${args.role_name}", Sir.`;
      await target.roles.add(role, reason);
      await writeGenericAuditLog(
        message.client,
        "JARVIS // ROLE ASSIGNED (conversational)",
        [
          { name: "TARGET", value: `${target.user.tag} (${target.id})` },
          { name: "ROLE", value: role.name },
        ],
        message.author.tag,
      );
      return `The "${role.name}" role has been assigned to ${target.user.tag}, Sir.`;
    }

    case "remove_role": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      if (isProtectedOwner(actorRank, target.id, ownerIds))
        return "I cannot perform that action on the Owner, Sir.";
      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === String(args.role_name).toLowerCase(),
      );
      if (!role)
        return `I could not find a role named "${args.role_name}", Sir.`;
      await target.roles.remove(role, reason);
      await writeGenericAuditLog(
        message.client,
        "JARVIS // ROLE REMOVED (conversational)",
        [
          { name: "TARGET", value: `${target.user.tag} (${target.id})` },
          { name: "ROLE", value: role.name },
        ],
        message.author.tag,
      );
      return `The "${role.name}" role has been removed from ${target.user.tag}, Sir.`;
    }

    case "set_nickname": {
      const target = await findMember(guild, String(args.username));
      if (!target)
        return `I could not locate a member matching "${args.username}", Sir.`;
      const nick = args.nickname ? String(args.nickname) : null;
      await target.setNickname(nick, reason);
      return nick
        ? `${target.user.tag}'s nickname has been set to "${nick}", Sir.`
        : `${target.user.tag}'s nickname has been reset, Sir.`;
    }

    case "send_message": {
      const ch = guild.channels.cache.find(
        (c) =>
          c.isTextBased() &&
          c.name.toLowerCase() === String(args.channel_name).toLowerCase(),
      ) as TextChannel | undefined;
      if (!ch)
        return `I could not find a channel named "${args.channel_name}", Sir.`;
      await ch.send(String(args.content));
      return `Message sent to #${ch.name}, Sir.`;
    }

    default:
      return "I do not recognise that directive, Sir.";
  }
}
