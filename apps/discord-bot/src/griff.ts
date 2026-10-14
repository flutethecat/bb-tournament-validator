/**
 * BB-Bot Griff Oberwald grounding. The old grognard has a long-running feud with the Blood Bowl
 * star player GRIFF OBERWALD. Whenever a message mentions Griff, we attach his dossier
 * (grognard-griff-dossier.md — a stash of in-character hit-pieces the FUMBBL community wrote about
 * him) so the grognard can draw on it; and if the incoming message is mean-spirited, he fires back
 * a cutting insult about Griff sourced from that dossier. Owner-commissioned 2026-07-22.
 *
 * The dossier lives at the app root (tracked, like grognard-persona.md — NOT in the gitignored
 * data-store) because its source pages sit behind FUMBBL's Anubis anti-bot and can't be auto-
 * refetched. It is re-read on every reply so edits are live with no bot restart.
 */

import { promises as fs } from "fs";
import { fileURLToPath } from "url";

const DOSSIER_PATH = fileURLToPath(new URL("../grognard-griff-dossier.md", import.meta.url));

/**
 * Does this message mention Griff Oberwald? Matches "Griff Oberwald", a bare "Griff", or a bare
 * "Oberwald" — case-insensitive, word-bounded so it won't fire on substrings ("griffin", "griffon").
 */
export function mentionsGriff(text: string): boolean {
  return /\b(griff\s+oberwald|griff|oberwald)\b/i.test(text || "");
}

/**
 * The Griff dossier text, or null if the file is missing/unreadable (in which case the grognard
 * just grumbles about Griff from character, ungrounded). Read fresh each call so edits go live.
 */
export async function loadGriffDossier(): Promise<string | null> {
  try {
    const text = (await fs.readFile(DOSSIER_PATH, "utf8")).trim();
    return text || null;
  } catch {
    return null;
  }
}
