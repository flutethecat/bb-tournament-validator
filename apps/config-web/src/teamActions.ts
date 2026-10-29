/**
 * Outstanding actions on a coach's team, for the red badge on the coach page's My teams tiles (owner 10-30). Pure over
 * the team detail (teamDetail.ts) plus the team's registrations; the server wraps it in a per-file cache (mtime + size).
 * Counts: a stored advancement roll waiting to be resolved, a player with an affordable advancement (the team
 * management page's canAddSkill / canAddCharacteristic rules), and a registration whose roster check flags problems.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TeamDetail } from "./teamDetail.js";

export interface TeamActions {
  count: number;
  items: string[];
}

export interface TeamRegistration {
  tournamentId: string;
  tournamentName: string;
  /** Roster problems the validator flagged for this registration (0 = none, or an organiser verified it). */
  problems: number;
}

export const NO_ACTIONS: TeamActions = { count: 0, items: [] };

const playerLabel = (p: { number: number; name: string }) => `#${p.number} ${p.name || "Player"}`;

/** Advancement items for one team detail: a pending roll first, else an affordable skill / characteristic. When advancement
 *  is blocked on this host (the management page's `advancementBlocked`, e.g. no fork admin API) affordable entries are
 *  suppressed, as the page disables them; a stored pending roll still counts. */
export function advancementItems(detail: Pick<TeamDetail, "players">, retired = false, blocked = false): string[] {
  if (retired) return [];
  const items: string[] = [];
  for (const p of detail.players) {
    if (/dead|rip|retired/i.test(p.status ?? "")) continue;
    if (p.pendingAdvancement) { items.push(`${playerLabel(p)}: finish the advancement roll`); continue; }
    if (blocked) continue;
    const m = p.advancementMethods;
    if (m.randomPrimary.available || m.chosenPrimary.available || m.characteristic.available) items.push(`${playerLabel(p)}: advancement available`);
  }
  return items;
}

export function registrationItems(registrations: readonly TeamRegistration[]): string[] {
  return registrations.filter((r) => r.problems > 0).map((r) => `${r.tournamentName}: ${r.problems} roster problem${r.problems === 1 ? "" : "s"}`);
}

export function teamActions(advancement: readonly string[], registrations: readonly TeamRegistration[]): TeamActions {
  const items = [...advancement, ...registrationItems(registrations)];
  return { count: items.length, items };
}

/** Cache of the advancement items per stored team file, valid while the file's mtime and size are unchanged. */
export function createAdvancementCache() {
  const cache = new Map<string, { stamp: string; items: string[] }>();
  const safePart = (value: string): string => value.replace(/[^\w.-]+/g, "_") || "unknown";
  return (teamsDir: string, teamId: string, compute: () => string[]): string[] => {
    let stamp = "";
    try {
      const suffix = `_${safePart(teamId)}.xml`;
      const file = readdirSync(teamsDir).find((f) => f.startsWith("team_") && f.endsWith(suffix));
      if (file) { const s = statSync(join(teamsDir, file)); stamp = `${file}:${s.mtimeMs}:${s.size}`; }
    } catch { /* unreadable dir: no cache, compute below */ }
    const key = `${teamsDir}\u0000${teamId}`;
    const hit = cache.get(key);
    if (stamp && hit?.stamp === stamp) return hit.items;
    const items = compute();
    if (stamp) cache.set(key, { stamp, items });
    else cache.delete(key);
    return items;
  };
}
