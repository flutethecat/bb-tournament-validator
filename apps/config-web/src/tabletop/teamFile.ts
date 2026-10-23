import type { TeamBuilderSave } from "../teamBuilderSaves.js";
import type { TabletopPlayer, TabletopTeamFile } from "./postMatch.js";

/**
 * Baseline (revision 0) team file from a coach's Team Builder save. The save stores picks as
 * {positionId, count, chosenSkills}; each counted pick becomes one player with a stable id
 * `<positionId>-<n>` so events can name them. Treasury and fans come from the save body when present.
 */
export function teamFileFromSave(save: TeamBuilderSave): TabletopTeamFile {
  const body = save.body as Record<string, unknown>;
  const picks = Array.isArray(body.picks) ? (body.picks as Array<Record<string, unknown>>) : [];
  const players: TabletopPlayer[] = [];
  let number = 1;
  const perPosition = new Map<string, number>(); // ids are unique across the WHOLE roster, even for repeated picks
  for (const pick of picks) {
    const positionId = typeof pick.positionId === "string" ? pick.positionId : "player";
    const count = Number.isInteger(pick.count) && (pick.count as number) > 0 ? Math.min(pick.count as number, 16) : 0;
    const skills = Array.isArray(pick.chosenSkills) ? (pick.chosenSkills as unknown[]).filter((s): s is string => typeof s === "string") : [];
    for (let k = 0; k < count && players.length < 16; k += 1) {
      const i = (perPosition.get(positionId) ?? 0) + 1;
      perPosition.set(positionId, i);
      players.push({ id: `${positionId}-${i}`, name: `${positionId} ${i}`, number: number++, positionId, spp: 0, skills: [...skills], mng: false, niggles: 0, statLoss: {}, dead: false });
    }
  }
  const fans = typeof body.dedicatedFans === "number" && body.dedicatedFans >= 1 ? Math.min(6, Math.floor(body.dedicatedFans)) : 1;
  return {
    schema: 1,
    name: save.name,
    rosterId: save.rosterId,
    treasury: typeof body.treasury === "number" && body.treasury >= 0 ? body.treasury : 0,
    dedicatedFans: fans,
    players,
  };
}

/** Persisting a baseline needs every player id unique (events name players by id). */
export function duplicatePlayerId(file: TabletopTeamFile): string | undefined {
  const seen = new Set<string>();
  for (const p of file.players) {
    if (seen.has(p.id)) return p.id;
    seen.add(p.id);
  }
  return undefined;
}
