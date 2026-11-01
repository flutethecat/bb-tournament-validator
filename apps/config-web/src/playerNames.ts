/**
 * Roster Builder player names (owner 11-01): every hired non-star player gets a generated name (src/nameGenerate.ts, the
 * same local corpus /api/name/generate serves; no network call) that the coach may edit. A name rides its pick as
 * `names[i]` (one entry per player of the pick, "" for an unnamed one), so saves, share links, the sheet / PDF and the
 * fork build all read it from the same place. No Node imports, so the SPA shares it.
 */
import { generateName } from "./nameGenerate.js";

/** Longest player name the builder keeps (the rename field's maxlength; the wire bound). */
export const PLAYER_NAME_MAX = 30;

/** Characters a stored name never keeps: C0/C1 controls, zero-width and bidi controls, the BOM. */
const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** A player name as stored: plain text, NFC, control characters dropped, whitespace collapsed, trimmed, at most
 *  PLAYER_NAME_MAX characters. Anything that isn't a string is "". */
export function cleanPlayerName(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, PLAYER_NAME_MAX).join("").trim();
}

/** The name/generate style for a race (the roster XML's <nameGenerator> vocabulary); "default" (human) otherwise. */
export function nameGeneratorFor(raceName: string): string {
  const r = String(raceName ?? "").toLowerCase();
  if (/amazon/.test(r)) return "amazon";
  if (/elf|elven/.test(r)) return "elf";
  if (/dwarf/.test(r)) return "dwarf";
  if (/orc|goblin|snotling|underworld/.test(r)) return "orc";
  if (/skaven/.test(r)) return "skaven";
  if (/norse/.test(r)) return "norse";
  if (/vampire|necromantic/.test(r)) return "vampire";
  return "default";
}

/** A fresh player name for this race; never returns `avoid` when another is possible (the reroll button). */
export function randomPlayerName(raceName: string, avoid = "", random: () => number = Math.random): string {
  const generator = nameGeneratorFor(raceName);
  let name = cleanPlayerName(generateName(generator, "neutral", random));
  for (let i = 0; i < 8 && name === avoid; i++) name = cleanPlayerName(generateName(generator, "neutral", random));
  return name;
}

/** The names a picks list carries, one per player in pick order ("" where a player has none). */
export function expandPickNames(picks: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(picks)) return out;
  for (const pick of picks) {
    if (!pick || typeof pick !== "object") continue;
    const p = pick as Record<string, unknown>;
    const count = Math.max(0, Math.floor(Number(p.count ?? 1) || 0));
    const names = Array.isArray(p.names) ? p.names : [];
    for (let i = 0; i < count; i++) out.push(cleanPlayerName(names[i]));
  }
  return out;
}

/** Why a pick's `names` list is malformed (null = fine or absent). */
export function pickNamesError(names: unknown, count: number): string | null {
  if (names === undefined) return null;
  if (!Array.isArray(names)) return "names must be an array when supplied.";
  if (names.length > count) return "names may list at most one entry per player of the pick.";
  for (const n of names) if (typeof n !== "string" || Array.from(n).length > PLAYER_NAME_MAX) return `each names entry must be a string of at most ${PLAYER_NAME_MAX} characters.`;
  return null;
}
