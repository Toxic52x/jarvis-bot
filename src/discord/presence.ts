import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "discord.js";
import { logger } from "../lib/logger";

// ─── Cached image assets ──────────────────────────────────────────────────────
// These three files never change at runtime, so they are read from disk exactly
// once at module load instead of on every avatar swap (which used to happen
// inside the message-handling hot path).

const OFFLINE_AVATAR_PATH = resolve(
  process.cwd(),
  "src/assets/avatar-offline.png",
);
const ONLINE_AVATAR_PATH = resolve(
  process.cwd(),
  "src/assets/avatar-online.gif",
);
const BANNER_PATH = resolve(process.cwd(), "src/assets/banner.gif");

function readAssetOnce(path: string, label: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    logger.warn(
      { err, path },
      `Could not read the ${label} image — that visual will be skipped`,
    );
    return null;
  }
}

const offlineAvatarBuffer = readAssetOnce(OFFLINE_AVATAR_PATH, "offline avatar");
const onlineAvatarBuffer = readAssetOnce(ONLINE_AVATAR_PATH, "online avatar");
const bannerBuffer = readAssetOnce(BANNER_PATH, "profile banner");

export function getOfflineAvatarBuffer(): Buffer | null {
  return offlineAvatarBuffer;
}

export function getOnlineAvatarBuffer(): Buffer | null {
  return onlineAvatarBuffer;
}

export function getBannerBuffer(): Buffer | null {
  return bannerBuffer;
}

// ─── Avatar rotation ──────────────────────────────────────────────────────────
// Set JARVIS_AVATAR_URLS to a comma-separated list of direct image URLs to
// enable cycling. Unset (the default) means no rotation at all.

export const AVATAR_URLS: string[] = (process.env.JARVIS_AVATAR_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
let avatarIndex = 0;

// ─── Protocol Silent state ────────────────────────────────────────────────────

let protocolSilentActive = false;
let protocolSilentGuildId: string | null = null;

export function isProtocolSilentActive(): boolean {
  return protocolSilentActive;
}

export function getProtocolSilentGuildId(): string | null {
  return protocolSilentGuildId;
}

export function setProtocolSilent(active: boolean, guildId: string | null): void {
  protocolSilentActive = active;
  protocolSilentGuildId = guildId;
}

// ─── Sleep / wake state ───────────────────────────────────────────────────────

let jarvisAsleep = false;

export function isJarvisAsleep(): boolean {
  return jarvisAsleep;
}

export function setJarvisAsleep(asleep: boolean): void {
  jarvisAsleep = asleep;
}

// ─── Status rotation control (paused during Protocol Silent / sleep) ──────────

let statusRotationPaused = false;
let rotateStatusFn: (() => void) | null = null;

export function setStatusRotationPaused(paused: boolean): void {
  statusRotationPaused = paused;
}

export function triggerStatusRotation(): void {
  if (rotateStatusFn) rotateStatusFn();
}

/**
 * Starts the status rotation and avatar rotation timers, restores the online
 * avatar, and sets the animated profile banner. Called once from ClientReady.
 */
export async function startPresenceLoops(ready: Client<true>): Promise<void> {
  // ── Status rotation ──────────────────────────────────────────────────────
  const statuses = [
    "Monitoring Fire Nation protocols",
    "Standing by, Sir.",
    "Analyzing threat intelligence",
    "Surveillance systems active",
    "Fire Nation command online",
    "Awaiting orders, Sir.",
    "All systems nominal.",
    "Securing Fire Nation perimeter",
  ];
  let statusIndex = 0;
  rotateStatusFn = () => {
    if (statusRotationPaused) return;
    ready.user.setActivity(statuses[statusIndex % statuses.length]);
    statusIndex++;
  };
  rotateStatusFn();
  setInterval(rotateStatusFn, 5 * 60 * 1000); // rotate every 5 minutes

  // Avatar rotation — cycles through AVATAR_URLS every 4 hours
  if (AVATAR_URLS.length > 0) {
    setInterval(
      async () => {
        try {
          await ready.user.setAvatar(
            AVATAR_URLS[avatarIndex % AVATAR_URLS.length],
          );
          avatarIndex++;
        } catch {
          /* rate-limited or bad URL — skip silently */
        }
      },
      4 * 60 * 60 * 1000,
    );
  }

  // Restore online avatar on startup
  try {
    if (onlineAvatarBuffer) await ready.user.setAvatar(onlineAvatarBuffer);
  } catch {
    /* skip */
  }

  // Set animated banner
  try {
    if (bannerBuffer) {
      await ready.user.setBanner(bannerBuffer);
      logger.info("Jarvis banner set successfully");
    }
  } catch (e) {
    logger.warn(
      { err: e },
      "Failed to set Jarvis banner — animated banners require Nitro-level eligibility on the bot account; consider a static PNG fallback if this keeps failing",
    );
  }
}
