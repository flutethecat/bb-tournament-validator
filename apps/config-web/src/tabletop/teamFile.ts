import type { TeamBuilderSave } from "../teamBuilderSaves.js";
import { bb2025 } from "@bb/validator/dataset";
import type { TeamDetail } from "../teamDetail.js";
import { rosterFor } from "./pregame.js";
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
  const rosterOf = Object.values(bb2025.rosters).find((r) => r.id.toLowerCase() === String(save.rosterId).toLowerCase());
  const perPosition = new Map<string, number>(); // ids are unique across the WHOLE roster, even for repeated picks
  for (const pick of picks) {
    const positionId = typeof pick.positionId === "string" ? pick.positionId : "player";
    const count = Number.isInteger(pick.count) && (pick.count as number) > 0 ? Math.min(pick.count as number, 16) : 0;
    const skills = Array.isArray(pick.chosenSkills) ? (pick.chosenSkills as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const dsPos = rosterOf?.positions.find((p) => p.id === positionId);
    const stats = dsPos ? { ...positionStats(dsPos), ...applyIncreases(dsPos, pick) } : {};
    for (let k = 0; k < count && players.length < 16; k += 1) {
      const i = (perPosition.get(positionId) ?? 0) + 1;
      perPosition.set(positionId, i);
      players.push({ ...stats, id: `${positionId}-${i}`, name: dsPos ? `${dsPos.name} ${i}` : `${positionId} ${i}`, number: number++, positionId, spp: 0, skills: [...skills], mng: false, niggles: 0, statLoss: {}, dead: false });
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

const target = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace("+", ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

type DatasetPos = NonNullable<ReturnType<typeof rosterFor>>["positions"][number];
type StatKey = "MA" | "ST" | "AG" | "PA" | "AV";
export const positionStats = (pos: DatasetPos) => ({
  positionName: pos.name, ma: pos.MA as number, st: pos.ST as number, ag: target(pos.AG) ?? 0, pa: target(pos.PA), av: target(pos.AV) ?? 0,
});

/** The pick's recorded characteristic changes on top of the position: chosenStats overrides, then chosenStatIncreases (AG/PA improve downwards). */
function applyIncreases(pos: DatasetPos, pick: Record<string, unknown>): Partial<{ ma: number; st: number; ag: number; pa: number | null; av: number }> {
  const base = positionStats(pos);
  const out = { ma: base.ma, st: base.st, ag: base.ag, pa: base.pa, av: base.av };
  const given = pick.chosenStats && typeof pick.chosenStats === "object" ? (pick.chosenStats as Record<string, unknown>) : {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (num(given.MA) !== undefined) out.ma = given.MA as number;
  if (num(given.ST) !== undefined) out.st = given.ST as number;
  if (num(given.AG) !== undefined) out.ag = given.AG as number;
  if (num(given.PA) !== undefined) out.pa = given.PA as number;
  if (num(given.AV) !== undefined) out.av = given.AV as number;
  const incs = Array.isArray(pick.chosenStatIncreases) ? (pick.chosenStatIncreases as unknown[]) : [];
  for (const raw of incs) {
    const k = String(raw).trim().toUpperCase() as StatKey;
    if (k === "MA") out.ma += 1;
    else if (k === "ST") out.st += 1;
    else if (k === "AV") out.av += 1;
    else if (k === "AG") out.ag = Math.max(1, out.ag - 1);
    else if (k === "PA" && out.pa !== null) out.pa = Math.max(1, out.pa - 1);
  }
  return out;
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
  const dsRoster = rosterFor({ race: team.race } as TabletopTeamFile);
  const players: TabletopPlayer[] = team.players.map((p) => {
    const ds = dsRoster?.positions.find((x) => x.name === p.position) ?? undefined;
    const dsStats = ds ? positionStats(ds) : undefined;
    return {
    // current characteristics from the stored team file (advancements and injuries already applied); the roster fills gaps
    ...(p.position ?? dsStats?.positionName ? { positionName: (p.position ?? dsStats?.positionName)! } : {}),
    ...((p.movement ?? dsStats?.ma) !== undefined ? { ma: (p.movement ?? dsStats?.ma)! } : {}),
    ...((p.strength ?? dsStats?.st) !== undefined ? { st: (p.strength ?? dsStats?.st)! } : {}),
    ...((p.agility ?? dsStats?.ag) !== undefined ? { ag: (p.agility ?? dsStats?.ag)! } : {}),
    ...(p.passing !== null || dsStats ? { pa: p.passing ?? dsStats?.pa ?? null } : {}),
    ...((p.armour ?? dsStats?.av) !== undefined ? { av: (p.armour ?? dsStats?.av)! } : {}),
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
    };
  });
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
