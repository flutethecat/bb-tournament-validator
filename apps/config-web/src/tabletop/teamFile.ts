import type { TeamBuilderSave } from "../teamBuilderSaves.js";
import { bb2025 } from "@bb/validator/dataset";
import type { TeamDetail } from "../teamDetail.js";
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
  const roster = Object.values(bb2025.rosters).find((r) => r.id.toLowerCase() === String(save.rosterId).toLowerCase());
  const previewTv = (save.lastPreview as Record<string, unknown> | undefined)?.teamValue;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  // Team value: the builder preview's figure (thousands of gold) when kept with the sheet, else roster arithmetic
  // (players + rerolls + apothecary + staff + extra fans); undefined when the roster is unknown.
  const teamValue = typeof previewTv === "number" && previewTv > 0 ? previewTv * 1000
    : roster
      ? picks.reduce((n, pk) => n + (roster.positions.find((p) => p.id === pk.positionId)?.cost ?? 0) * num(pk.count), 0)
        + num(body.reRolls) * roster.reRollCost + (body.apothecary ? 50_000 : 0)
        + (num(body.assistantCoaches) + num(body.cheerleaders)) * 10_000 + Math.max(0, num(body.dedicatedFans) - 1) * 10_000
      : undefined;
  const fans = typeof body.dedicatedFans === "number" && body.dedicatedFans >= 1 ? Math.min(6, Math.floor(body.dedicatedFans)) : 1;
  return {
    schema: 1,
    name: save.name,
    rosterId: save.rosterId,
    treasury: typeof body.treasury === "number" && body.treasury >= 0 ? body.treasury : 0,
    dedicatedFans: fans,
    ...(teamValue !== undefined ? { teamValue } : {}),
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

/**
 * A team reference on the wire: "library:<teamId>" (a fork library team: the real team file), "save:<saveId>" or a
 * bare id (a Team Builder save; the bare form is kept for back-compat). `ref` is the canonical stored key: a save
 * stays its bare id, a library team keeps its "library:" prefix.
 */
export function parseTeamRef(value: unknown): { ref: string; kind: "library" | "save"; id: string } | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(?:(library|save):)?([\w-]{1,64})$/.exec(value.trim());
  if (!m) return undefined;
  const kind = m[1] === "library" ? "library" : "save";
  return { ref: kind === "library" ? `library:${m[2]}` : m[2]!, kind, id: m[2]! };
}

/** Lasting injuries that are niggling injuries (FFB names). Other lasting injuries stay listed verbatim in `injuries`. */
const NIGGLING = /niggl|smashed knee/i;

/** Baseline (revision 0) team file from a fork library team (the parsed stored team XML, see teamDetail.ts). */
export function teamFileFromLibraryDetail(team: TeamDetail): TabletopTeamFile {
  const players: TabletopPlayer[] = team.players.map((p) => ({
    id: p.id,
    name: p.name,
    number: p.number,
    ...(p.positionId ? { positionId: p.positionId } : {}),
    spp: p.spp,
    skills: [...p.skills],
    mng: p.mng,
    niggles: p.injuries.filter((i) => NIGGLING.test(i)).length,
    statLoss: {},
    dead: /dead|rip/i.test(p.status ?? ""),
    ...(p.injuries.length ? { injuries: [...p.injuries] } : {}),
  }));
  return {
    schema: 1,
    name: team.name,
    race: team.race,
    treasury: team.treasury,
    dedicatedFans: team.fanFactor,
    rerolls: team.rerolls,
    apothecary: team.apothecary,
    assistantCoaches: team.assistantCoaches,
    cheerleaders: team.cheerleaders,
    teamValue: team.teamValue * 1000,
    ...(team.specialRules?.length ? { specialRules: [...team.specialRules] } : {}),
    players,
  };
}
