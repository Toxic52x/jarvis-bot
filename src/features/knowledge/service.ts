import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../lib/logger";

/** Escapes a string for safe use inside a RegExp. Shared with Overwatch. */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fire Nation knowledge base — editable without touching code
export const KNOWLEDGE_FILE_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fire-nation-knowledge.txt",
);
export let cachedKnowledge = "";

export function loadKnowledge(): string {
  try {
    cachedKnowledge = readFileSync(KNOWLEDGE_FILE_PATH, "utf-8");
    logger.info(
      { chars: cachedKnowledge.length },
      "Fire Nation knowledge file loaded",
    );
  } catch (err) {
    logger.warn(
      { err },
      "Could not read fire-nation-knowledge.txt — continuing without it",
    );
    cachedKnowledge = "";
  }
  return cachedKnowledge;
}
export function getRelevantKnowledge(userText: string): string {
  if (!cachedKnowledge) return "";
  const text = userText.toLowerCase();
  const sections = cachedKnowledge.split(/(?==== SECTION:)/);
  const matches = sections.filter((s) => {
    const aliasLine = s.match(/ALIASES:\s*(.+)/i)?.[1] ?? "";
    return aliasLine
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .some((alias) => {
        if (alias.length < 4) return false; // skip ultra-common short slang (def, sta, str)
        return new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(text);
      });
  });
  const matchedTitles = [
    ...matches.join("").matchAll(/=== SECTION: (\w+)/g),
  ].map((m) => m[1]);
  if (matchedTitles.length > 0) {
    logger.info({ matchedTitles }, "Jarvis: KB sections injected this turn");
  }
  return matches.join("\n").trim();
}
