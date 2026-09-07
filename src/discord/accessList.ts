import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config";
import { logger } from "../lib/logger";

// ─── Jarvis standing-access grants ─────────────────────────────────────────────
// Users added here can converse with Jarvis (like Owner/Fire Lord) until revoked.
// Persisted to disk so grants survive restarts.

const JARVIS_ACCESS_FILE_PATH = join(DATA_DIR, "jarvis-access.txt");
export let jarvisAccessIds = new Set<string>();

export function loadJarvisAccess(): Set<string> {
  try {
    const raw = readFileSync(JARVIS_ACCESS_FILE_PATH, "utf-8");
    jarvisAccessIds = new Set(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l)),
    );
    logger.info(
      { count: jarvisAccessIds.size },
      "Jarvis standing-access list loaded",
    );
  } catch (err) {
    logger.info(
      "No jarvis-access.txt found yet — starting with an empty access list",
    );
    jarvisAccessIds = new Set();
  }
  return jarvisAccessIds;
}

export function saveJarvisAccess(): void {
  try {
    writeFileSync(
      JARVIS_ACCESS_FILE_PATH,
      [...jarvisAccessIds].join("\n") + (jarvisAccessIds.size > 0 ? "\n" : ""),
      "utf-8",
    );
  } catch (err) {
    logger.error({ err }, "Failed to persist jarvis-access.txt");
  }
}
