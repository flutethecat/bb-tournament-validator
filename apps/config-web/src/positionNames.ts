/**
 * Coach-facing SHORT position names — the desktop client's rule carried over VERBATIM (SpectateView.vue
 * positionNameFor, owner 09-09; owner 10-27 "the same logic we use in-client"): if the position name starts with
 * the team's race name followed by a space (case-insensitive), drop that prefix; if nothing is left, keep the raw
 * name. Nothing else. Display only — the wire, ids, roster XML and the validator keep the full name; renderers
 * show the full name as a tooltip. TypeScript twin of public/team-builder.js Core.shortPositionName
 * (parity-tested over every BB2025 roster in test/shortPositionNames.test.ts — change both together).
 */

export interface ShortNamePosition {
  name?: string | null;
}
export interface ShortNameRoster {
  name?: string | null;
  raceName?: string | null;
}

/**
 * Explicit display overrides, applied AFTER the race-prefix rule (owner 11-01: "rename Jaguar Warriors to just
 * 'Jaguar Warrior' not Blocker"). Keyed by the dataset's full position name; display only. Twin of
 * Core.POSITION_DISPLAY_OVERRIDES in public/team-builder.js.
 */
export const POSITION_DISPLAY_OVERRIDES: Readonly<Record<string, string>> = { "Jaguar Warrior Blocker": "Jaguar Warrior" };

export function shortPositionName(position: ShortNamePosition | null | undefined, roster: ShortNameRoster | null | undefined): string {
  const rawPosition = String(position?.name ?? "");
  const race = String(roster?.name ?? roster?.raceName ?? "").trim();
  const startsWithRace = !!race && rawPosition.toLowerCase().startsWith(race.toLowerCase() + " ");
  const short = startsWithRace ? rawPosition.slice(race.length + 1).trim() || rawPosition : rawPosition;
  return Object.prototype.hasOwnProperty.call(POSITION_DISPLAY_OVERRIDES, short) ? POSITION_DISPLAY_OVERRIDES[short]! : short;
}
