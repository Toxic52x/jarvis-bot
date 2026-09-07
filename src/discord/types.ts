import type OpenAI from "openai";

// ─── AI chat ─────────────────────────────────────────────────────────────────

/** Conversation history entry (proper OpenAI message params). */
export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

// ─── Overwatch ───────────────────────────────────────────────────────────────

export type OverwatchTriggerType = "language" | "invite" | "ping_abuse";

export type OverwatchTrigger = {
  type: OverwatchTriggerType;
  detail: string;
};

export type OverwatchLogEntry = {
  timestamp: number;
  type: OverwatchTriggerType;
  detail: string;
  content: string;
  punishment: string;
};

// ─── Reaction watches ────────────────────────────────────────────────────────

export type ReactionWatch = {
  guildId: string;
  channelId: string;
  messageId: string;
  emoji: string;
  threshold: number;
  requesterId: string;
  createdAt: number;
};

// ─── Guard requests ──────────────────────────────────────────────────────────

export type GuardRequestState = {
  id: string;
  guildId: string;
  hostId: string;
  hostTag: string;
  when: string;
  location: string;
  rsvps: Set<string>; // shown in the tracker channel, not in the public everyone-ping embed
  hostDmChannelId: string | null;
  hostDmMessageId: string | null;
  createdAt: number;
};

// ─── Roblox tracking ─────────────────────────────────────────────────────────

export type TrackedRobloxUser = {
  robloxUserId: number;
  robloxUsername: string;
  wasInExperience: boolean;
  lastPresenceType: number | null; // raw Roblox presence type from the last successful poll; null = never polled
  lastPolledAt: number | null; // epoch ms of the last successful poll
};

export type ExperienceInfo = {
  placeId: number;
  universeId: number;
  rootPlaceId: number;
  name: string;
  url: string;
};

export type WatchedExperience = ExperienceInfo | null;

export type RobloxTrackingState = {
  experience: WatchedExperience;
  notifyChannelId: string | null;
  users: TrackedRobloxUser[];
};

// ─── Roblox double-ranking check ─────────────────────────────────────────────

export type DoubleRankGroupDef = {
  label: string;
  groupId: number;
  groupUrl: string;
  rankerFromRoleName: string; // lowest role name that counts as "ranker" (inclusive)
};

export type UserGroupRoleEntry = {
  group: { id: number; name: string };
  role: { name: string; rank: number };
};

export type DoubleRankGroupResult = {
  label: string;
  groupUrl: string;
  memberRoleName: string | null;
  isRanker: boolean;
  note?: string;
};
