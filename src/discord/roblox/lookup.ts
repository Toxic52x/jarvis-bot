import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { FIRE_ORANGE, FIRE_RED } from "../../config";
import { rankAtLeast } from "../permissions";
import type {
  DoubleRankGroupDef,
  DoubleRankGroupResult,
  UserGroupRoleEntry,
} from "../types";
import { logger } from "../../lib/logger";

// ─── Double-ranking check (TSB element group cross-rank monitor) ──────────────

export const DOUBLE_RANK_GROUPS: DoubleRankGroupDef[] = [
  {
    label: "TSB Water",
    groupId: 1029776236,
    groupUrl: "https://www.roblox.com/communities/1029776236/TSB-Water",
    rankerFromRoleName: "Private",
  },
  {
    label: "TSB Earth",
    groupId: 592750791,
    groupUrl: "https://www.roblox.com/communities/592750791/TSB-Earth",
    rankerFromRoleName: "Private",
  },
  {
    label: "TSB Air",
    groupId: 485588074,
    groupUrl: "https://www.roblox.com/communities/485588074/TSB-Air",
    rankerFromRoleName: "Pupil",
  },
  {
    label: "TSB Fire",
    groupId: 44315578,
    groupUrl: "https://www.roblox.com/communities/44315578/TSB-Fire",
    rankerFromRoleName: "Recruit",
  },
];

// Caches each monitored group's role list so we don't refetch the roster on
// every /lookup. If a TSB group ever restructures its ranks, restart Jarvis.
export const groupRoleListCache = new Map<
  number,
  Array<{ name: string; rank: number }>
>();

export async function getGroupRoleList(
  groupId: number,
): Promise<Array<{ name: string; rank: number }> | null> {
  const cached = groupRoleListCache.get(groupId);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://groups.roblox.com/v1/groups/${groupId}/roles`,
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status, groupId },
        "getGroupRoleList: non-OK status",
      );
      return null;
    }
    const data = (await res.json()) as {
      roles?: Array<{ name: string; rank: number }>;
    };
    if (!data.roles) return null;
    groupRoleListCache.set(groupId, data.roles);
    return data.roles;
  } catch (err) {
    logger.error(
      { err, groupId },
      "getGroupRoleList: threw — network or parsing failure",
    );
    return null;
  }
}

export async function checkDoubleRanking(
  userGroupRoles: UserGroupRoleEntry[],
): Promise<{
  results: DoubleRankGroupResult[];
  rankerCount: number;
  isDoubleRanking: boolean;
}> {
  const results: DoubleRankGroupResult[] = [];

  for (const def of DOUBLE_RANK_GROUPS) {
    const membership = userGroupRoles.find((g) => g.group.id === def.groupId);

    if (!membership) {
      results.push({
        label: def.label,
        groupUrl: def.groupUrl,
        memberRoleName: null,
        isRanker: false,
      });
      continue;
    }

    const roleList = await getGroupRoleList(def.groupId);
    const thresholdRole = roleList?.find(
      (r) => r.name.toLowerCase() === def.rankerFromRoleName.toLowerCase(),
    );

    if (!thresholdRole) {
      results.push({
        label: def.label,
        groupUrl: def.groupUrl,
        memberRoleName: membership.role.name,
        isRanker: false,
        note: `Could not verify — "${def.rankerFromRoleName}" threshold not found in ${def.label}'s current role list`,
      });
      continue;
    }

    results.push({
      label: def.label,
      groupUrl: def.groupUrl,
      memberRoleName: membership.role.name,
      isRanker: membership.role.rank >= thresholdRole.rank,
    });
  }

  const rankerCount = results.filter((r) => r.isRanker).length;
  return { results, rankerCount, isDoubleRanking: rankerCount > 1 };
}

export function formatDoubleRankingField(report: {
  results: DoubleRankGroupResult[];
  rankerCount: number;
  isDoubleRanking: boolean;
}): { name: string; value: string } {
  const lines = report.results.map((r) => {
    if (r.note)
      return `⚠️ **${r.label}** — ${r.memberRoleName ?? "?"} _(${r.note})_`;
    if (!r.memberRoleName) return `⬜ **${r.label}** — not in group`;
    return `${r.isRanker ? "🔴" : "⬜"} **${r.label}** — ${r.memberRoleName}${r.isRanker ? " (RANKER)" : ""}`;
  });

  const verdict = report.isDoubleRanking
    ? `🚨 DOUBLE RANKING DETECTED — ranked in ${report.rankerCount} groups`
    : report.rankerCount === 1
      ? "✅ Single ranker — no double ranking"
      : "✅ Not a ranker in any monitored group";

  return { name: `DOUBLE RANKING CHECK — ${verdict}`, value: lines.join("\n") };
}
/** Core Roblox account investigation logic, shared by /lookup and the
 * conversational lookup_roblox_account tool. Returns an EmbedBuilder or an
 * error string. */
export async function performRobloxLookup(
  username: string,
  requestedByTag: string,
): Promise<{ embed: EmbedBuilder } | { error: string }> {
  try {
    const usernameRes = await fetch(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: false,
        }),
      },
    );
    const usernameData = (await usernameRes.json()) as {
      data: Array<{ id: number; name: string; displayName: string }>;
    };

    if (!usernameData.data?.length) {
      return {
        error: `No Roblox account found with the username "${username}".`,
      };
    }

    const resolved = usernameData.data[0];
    const userId = resolved.id;

    const [
      userInfo,
      friendData,
      groupsData,
      favGamesData,
      followersData,
      followingsData,
      platformBadgesData,
      avatarData,
    ] = await Promise.all([
      fetch(`https://users.roblox.com/v1/users/${userId}`).then((r) =>
        r.json(),
      ),
      fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`)
        .then((r) => r.json())
        .catch(() => ({ count: 0 })),
      fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`)
        .then((r) => r.json())
        .catch(() => ({ data: [] })),
      fetch(
        `https://games.roblox.com/v2/users/${userId}/favorite/games?pageSize=50&sortOrder=Desc`,
      )
        .then((r) => r.json())
        .catch(() => ({ data: [], nextPageCursor: null })),
      fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`)
        .then((r) => r.json())
        .catch(() => ({ count: 0 })),
      fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`)
        .then((r) => r.json())
        .catch(() => ({ count: 0 })),
      fetch(
        `https://accountinformation.roblox.com/v1/users/${userId}/roblox-badges`,
      )
        .then((r) => r.json())
        .catch(() => []),
      fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`,
      )
        .then((r) => r.json())
        .catch(() => null),
    ]);

    const accountCreated = new Date((userInfo as { created: string }).created);
    const accountAgeDays = Math.floor(
      (Date.now() - accountCreated.getTime()) / 86_400_000,
    );
    const friends = (friendData as { count?: number }).count ?? 0;
    const followers = (followersData as { count?: number }).count ?? 0;
    const following = (followingsData as { count?: number }).count ?? 0;
    type PlatformBadge = { name: string };
    const platformBadges: PlatformBadge[] = Array.isArray(platformBadgesData)
      ? (platformBadgesData as PlatformBadge[])
      : [];
    const hasVeteran = platformBadges.some((b) => b.name === "Veteran");
    const groups = ((groupsData as { data?: UserGroupRoleEntry[] }).data ??
      []) as UserGroupRoleEntry[];
    const favGames =
      (favGamesData as { data?: unknown[]; nextPageCursor?: string | null })
        .data ?? [];
    const favGamesHasMore = !!(
      favGamesData as { nextPageCursor?: string | null }
    ).nextPageCursor;
    const description = (
      (userInfo as { description?: string }).description ?? ""
    ).trim();
    const displayName =
      (userInfo as { displayName?: string }).displayName ?? resolved.name;
    const isBanned = (userInfo as { isBanned?: boolean }).isBanned ?? false;
    const avatarUrl =
      (avatarData as { data?: Array<{ imageUrl: string }> } | null)?.data?.[0]
        ?.imageUrl ?? null;

    const flags: string[] = [];
    let score = 0;

    if (isBanned) {
      flags.push("🚫 Account is currently **banned** on Roblox");
      score += 2;
    }
    if (accountAgeDays < 30) {
      flags.push(
        `🆕 Created only **${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"} ago** — extremely new`,
      );
      score += 3;
    } else if (accountAgeDays < 180) {
      flags.push(
        `📅 Account is only **${accountAgeDays} days old** (under 6 months)`,
      );
      score += 2;
    } else if (accountAgeDays < 365) {
      flags.push(`📅 Account is **${accountAgeDays} days old** (under 1 year)`);
      score += 1;
    }
    if (friends === 0) {
      flags.push("👥 **Zero friends** — no social connections at all");
      score += 3;
    } else if (friends < 5) {
      flags.push(
        `👥 Only **${friends} friend${friends === 1 ? "" : "s"}** — very low social presence`,
      );
      score += 1;
    }
    if (groups.length === 0) {
      flags.push("🏠 Not a member of **any groups**");
      score += 1;
    }
    if (!description) {
      flags.push("📝 **No bio or description** set");
      score += 1;
    }
    if (followers === 0 && accountAgeDays < 365) {
      flags.push("📭 **Zero followers** — no social footprint");
      score += 1;
    }
    if (platformBadges.length === 0 && accountAgeDays > 180) {
      flags.push(
        `🏅 **No Roblox platform badges** on a ${accountAgeDays}-day-old account — no recorded activity milestones`,
      );
      score += 2;
    } else if (platformBadges.length <= 2 && accountAgeDays > 365) {
      flags.push(
        `🏅 Only **${platformBadges.length}** platform badge${platformBadges.length === 1 ? "" : "s"} on a ${Math.floor(accountAgeDays / 365)}-year-old account — very low activity`,
      );
      score += 1;
    } else if (!hasVeteran && accountAgeDays > 730) {
      flags.push(
        "🏅 No **Veteran** badge despite being 2+ years old — account may not have been actively played",
      );
      score += 1;
    }
    if (favGames.length === 0) {
      flags.push("🎮 **No favorited games**");
      score += 1;
    }
    if (displayName !== resolved.name && accountAgeDays < 90) {
      flags.push(
        `✏️ Display name **"${displayName}"** differs from username on a new account`,
      );
      score += 1;
    }

    const riskLabel =
      score >= 7
        ? "🚨 HIGH RISK — Very Likely Alt / Threat"
        : score >= 4
          ? "⚠️ MEDIUM RISK — Suspicious"
          : "✅ LOW RISK — Appears Legitimate";
    const riskColor =
      score >= 7 ? FIRE_RED : score >= 4 ? FIRE_ORANGE : 0x16a34a;

    type GroupEntry = { group: { name: string; id: number } };
    const groupList =
      groups.length > 0
        ? (groups as GroupEntry[])
            .slice(0, 5)
            .map(
              (g) =>
                `• [${g.group.name}](https://www.roblox.com/groups/${g.group.id})`,
            )
            .join("\n") +
          (groups.length > 5 ? `\n_…and ${groups.length - 5} more_` : "")
        : "_None_";

    const favCount = favGamesHasMore
      ? `${favGames.length}+`
      : String(favGames.length);
    const doubleRankReport = await checkDoubleRanking(groups);
    const doubleRankField = formatDoubleRankingField(doubleRankReport);

    const embed = new EmbedBuilder()
      .setTitle("JARVIS // ROBLOX ACCOUNT INVESTIGATION")
      .setDescription(
        `**[${resolved.name}](https://www.roblox.com/users/${userId}/profile)**` +
          (displayName !== resolved.name
            ? ` *(display: ${displayName})*`
            : "") +
          `\n\n**VERDICT: ${riskLabel}**`,
      )
      .setColor(riskColor)
      .addFields(
        { name: "USER ID", value: `\`${userId}\``, inline: true },
        {
          name: "ACCOUNT AGE",
          value: `${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"}`,
          inline: true,
        },
        {
          name: "CREATED",
          value: `<t:${Math.floor(accountCreated.getTime() / 1000)}:D>`,
          inline: true,
        },
        { name: "FRIENDS", value: String(friends), inline: true },
        { name: "FOLLOWERS", value: String(followers), inline: true },
        { name: "FOLLOWING", value: String(following), inline: true },
        { name: "GROUPS", value: String(groups.length), inline: true },
        {
          name: "PLATFORM BADGES",
          value:
            platformBadges.length > 0
              ? `${platformBadges.length} — ${platformBadges.map((b) => b.name).join(", ")}`
              : "None",
        },
        { name: "FAVORITED GAMES", value: favCount, inline: true },
        {
          name: "STATUS",
          value: isBanned ? "🚫 Banned" : "✅ Active",
          inline: true,
        },
        {
          name: "BIO",
          value: description ? description.slice(0, 300) : "_No description_",
        },
        { name: `GROUPS (${groups.length})`, value: groupList },
        {
          name: `RED FLAGS (${flags.length}) — Score: ${score}`,
          value:
            flags.length > 0 ? flags.join("\n") : "✅ No red flags detected",
        },
        doubleRankField,
      )
      .setFooter({
        text: `FIRE NATION • INTEL REPORT • Requested by ${requestedByTag}`,
      })
      .setTimestamp();

    if (avatarUrl) embed.setThumbnail(avatarUrl);
    return { embed };
  } catch (error) {
    logger.error({ err: error }, "Roblox lookup failed");
    return {
      error:
        "I was unable to complete the investigation, Sir. The Roblox API may be temporarily unavailable.",
    };
  }
}

// ─── Roblox lookup handler ────────────────────────────────────────────────────

export async function handleLookup(
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
  if (!rankAtLeast(member, "hr")) {
    await interaction.reply({
      content: "Access Denied — HR and above only.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  const username = interaction.options.getString("username", true).trim();

  const bar = (pct: number) =>
    `${"▰".repeat(Math.round(pct / 10))}${"▱".repeat(10 - Math.round(pct / 10))} ${pct}%`;
  const loadEmbed = (desc: string, pct: number) =>
    new EmbedBuilder()
      .setTitle("JARVIS // ROBLOX ACCOUNT INVESTIGATION")
      .setColor(FIRE_ORANGE)
      .setDescription(`${desc}\n\n${bar(pct)}`);

  await interaction.editReply({
    embeds: [loadEmbed("Initiating investigation...", 0)],
  });

  try {
    // Resolve username → userId
    const usernameRes = await fetch(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: false,
        }),
      },
    );
    const usernameData = (await usernameRes.json()) as {
      data: Array<{ id: number; name: string; displayName: string }>;
    };

    if (!usernameData.data?.length) {
      await interaction.editReply(
        `No Roblox account found with the username **${username}**.`,
      );
      return;
    }

    const resolved = usernameData.data[0];
    const userId = resolved.id;

    // Fetch all data in parallel
    const [
      userInfo,
      friendData,
      groupsData,
      favGamesData,
      followersData,
      followingsData,
      platformBadgesData,
      avatarData,
    ] = await Promise.all([
      fetch(`https://users.roblox.com/v1/users/${userId}`).then((r) =>
        r.json(),
      ),
      fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`)
        .then((r) => r.json())
        .catch(() => ({ count: 0 })),
      fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`)
        .then((r) => r.json())
        .catch(() => ({ data: [] })),
      fetch(
        `https://games.roblox.com/v2/users/${userId}/favorite/games?pageSize=50&sortOrder=Desc`,
      )
        .then((r) => r.json())
        .catch(() => ({ data: [], nextPageCursor: null })),
      fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`)
        .then((r) => r.json())
        .catch(() => ({ count: 0 })),
      fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`)
        .then((r) => r.json())
        .catch(() => ({ count: 0 })),
      fetch(
        `https://accountinformation.roblox.com/v1/users/${userId}/roblox-badges`,
      )
        .then((r) => r.json())
        .catch(() => []),
      fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`,
      )
        .then((r) => r.json())
        .catch(() => null),
    ]);

    const accountCreated = new Date((userInfo as { created: string }).created);
    const accountAgeDays = Math.floor(
      (Date.now() - accountCreated.getTime()) / 86_400_000,
    );
    const friends = (friendData as { count?: number }).count ?? 0;
    const followers = (followersData as { count?: number }).count ?? 0;
    const following = (followingsData as { count?: number }).count ?? 0;
    type PlatformBadge = { name: string };
    const platformBadges: PlatformBadge[] = Array.isArray(platformBadgesData)
      ? (platformBadgesData as PlatformBadge[])
      : [];
    const hasVeteran = platformBadges.some((b) => b.name === "Veteran");
    const groups = ((groupsData as { data?: UserGroupRoleEntry[] }).data ??
      []) as UserGroupRoleEntry[];
    const favGames =
      (favGamesData as { data?: unknown[]; nextPageCursor?: string | null })
        .data ?? [];
    const favGamesHasMore = !!(
      favGamesData as { nextPageCursor?: string | null }
    ).nextPageCursor;
    const description = (
      (userInfo as { description?: string }).description ?? ""
    ).trim();
    const displayName =
      (userInfo as { displayName?: string }).displayName ?? resolved.name;
    const isBanned = (userInfo as { isBanned?: boolean }).isBanned ?? false;
    const avatarUrl =
      (avatarData as { data?: Array<{ imageUrl: string }> } | null)?.data?.[0]
        ?.imageUrl ?? null;

    // ── Red flag scoring ───────────────────────────────────────────────────────
    const flags: string[] = [];
    let score = 0;

    if (isBanned) {
      flags.push("🚫 Account is currently **banned** on Roblox");
      score += 2;
    }
    if (accountAgeDays < 30) {
      flags.push(
        `🆕 Created only **${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"} ago** — extremely new`,
      );
      score += 3;
    } else if (accountAgeDays < 180) {
      flags.push(
        `📅 Account is only **${accountAgeDays} days old** (under 6 months)`,
      );
      score += 2;
    } else if (accountAgeDays < 365) {
      flags.push(`📅 Account is **${accountAgeDays} days old** (under 1 year)`);
      score += 1;
    }
    if (friends === 0) {
      flags.push("👥 **Zero friends** — no social connections at all");
      score += 3;
    } else if (friends < 5) {
      flags.push(
        `👥 Only **${friends} friend${friends === 1 ? "" : "s"}** — very low social presence`,
      );
      score += 1;
    }
    if (groups.length === 0) {
      flags.push("🏠 Not a member of **any groups**");
      score += 1;
    }
    if (!description) {
      flags.push("📝 **No bio or description** set");
      score += 1;
    }
    if (followers === 0 && accountAgeDays < 365) {
      flags.push("📭 **Zero followers** — no social footprint");
      score += 1;
    }
    if (platformBadges.length === 0 && accountAgeDays > 180) {
      flags.push(
        `🏅 **No Roblox platform badges** on a ${accountAgeDays}-day-old account — no recorded activity milestones`,
      );
      score += 2;
    } else if (platformBadges.length <= 2 && accountAgeDays > 365) {
      flags.push(
        `🏅 Only **${platformBadges.length}** platform badge${platformBadges.length === 1 ? "" : "s"} on a ${Math.floor(accountAgeDays / 365)}-year-old account — very low activity`,
      );
      score += 1;
    } else if (!hasVeteran && accountAgeDays > 730) {
      flags.push(
        "🏅 No **Veteran** badge despite being 2+ years old — account may not have been actively played",
      );
      score += 1;
    }
    if (favGames.length === 0) {
      flags.push("🎮 **No favorited games**");
      score += 1;
    }
    if (displayName !== resolved.name && accountAgeDays < 90) {
      flags.push(
        `✏️ Display name **"${displayName}"** differs from username on a new account`,
      );
      score += 1;
    }

    const riskLabel =
      score >= 7
        ? "🚨 HIGH RISK — Very Likely Alt / Threat"
        : score >= 4
          ? "⚠️ MEDIUM RISK — Suspicious"
          : "✅ LOW RISK — Appears Legitimate";
    const riskColor =
      score >= 7 ? FIRE_RED : score >= 4 ? FIRE_ORANGE : 0x16a34a;

    type GroupEntry = { group: { name: string; id: number } };
    const groupList =
      groups.length > 0
        ? (groups as GroupEntry[])
            .slice(0, 5)
            .map(
              (g) =>
                `• [${g.group.name}](https://www.roblox.com/groups/${g.group.id})`,
            )
            .join("\n") +
          (groups.length > 5 ? `\n_…and ${groups.length - 5} more_` : "")
        : "_None_";

    const favCount = favGamesHasMore
      ? `${favGames.length}+`
      : String(favGames.length);
    const doubleRankReport = await checkDoubleRanking(groups);
    const doubleRankField = formatDoubleRankingField(doubleRankReport);

    const embed = new EmbedBuilder()
      .setTitle("JARVIS // ROBLOX ACCOUNT INVESTIGATION")
      .setDescription(
        `**[${resolved.name}](https://www.roblox.com/users/${userId}/profile)**` +
          (displayName !== resolved.name
            ? ` *(display: ${displayName})*`
            : "") +
          `\n\n**VERDICT: ${riskLabel}**`,
      )
      .setColor(riskColor)
      .addFields(
        { name: "USER ID", value: `\`${userId}\``, inline: true },
        {
          name: "ACCOUNT AGE",
          value: `${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"}`,
          inline: true,
        },
        {
          name: "CREATED",
          value: `<t:${Math.floor(accountCreated.getTime() / 1000)}:D>`,
          inline: true,
        },
        { name: "FRIENDS", value: String(friends), inline: true },
        { name: "FOLLOWERS", value: String(followers), inline: true },
        { name: "FOLLOWING", value: String(following), inline: true },
        { name: "GROUPS", value: String(groups.length), inline: true },
        {
          name: "PLATFORM BADGES",
          value:
            platformBadges.length > 0
              ? `${platformBadges.length} — ${platformBadges.map((b) => b.name).join(", ")}`
              : "None",
          inline: false,
        },
        { name: "FAVORITED GAMES", value: favCount, inline: true },
        {
          name: "STATUS",
          value: isBanned ? "🚫 Banned" : "✅ Active",
          inline: true,
        },
        {
          name: "BIO",
          value: description ? description.slice(0, 300) : "_No description_",
        },
        { name: `GROUPS (${groups.length})`, value: groupList },
        {
          name: `RED FLAGS (${flags.length}) — Score: ${score}`,
          value:
            flags.length > 0 ? flags.join("\n") : "✅ No red flags detected",
        },
        doubleRankField,
      )
      .setFooter({
        text: `FIRE NATION • INTEL REPORT • Requested by ${interaction.user.tag}`,
      })
      .setTimestamp();

    if (avatarUrl) embed.setThumbnail(avatarUrl);

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error({ err: error }, "Roblox lookup failed");
    await interaction.editReply(
      "I was unable to complete the investigation, Sir. The Roblox API may be temporarily unavailable.",
    );
  }
}
