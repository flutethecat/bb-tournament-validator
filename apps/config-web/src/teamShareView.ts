/**
 * Public team view model (owner 10-27: "a public-facing view for teams"). The share route composes the saved
 * builder body exactly like the builder preview does (composeFromBody / composeIntrinsicFromBody + validate in
 * server.ts) and hands the result here. This module turns it into a SANITISED, display-only model: no ids, no
 * coach account data beyond the public fork coach name, no session fields, no other saves. Art paths come from
 * the builder's own generated manifests (public/sprites, public/crests) via the same lookup the builder page
 * uses (ports of team-builder.js Core.resolveSprite / Core.resolveCrest; parity-tested).
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addedSkills,
  findPosition,
  findRoster,
  findSkill,
  isStarName,
  normName,
  skillAccess,
  type Roster,
  type RosterPlayer,
  type ValidationResult,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import type { TeamBuilderSave } from "./teamBuilderSaves.js";
import { shortPositionName } from "./positionNames.js";

export interface SharedSkill {
  name: string;
  /** Dataset category ("General", "Agility", …) or "Trait"; drives the Skill Key colour. */
  category: string;
  /** Added skills only. */
  access?: "primary" | "secondary";
}

export interface SharedPlayer {
  number: number;
  /** Coach-facing short name (shortPositionName: the race prefix dropped, "Dwarf Runner" → "Runner"). Display only. */
  position: string;
  /** The full position name (tooltip). */
  positionFull: string;
  isStar: boolean;
  stats: { MA: number; ST: number; AG: string; PA: string; AV: string };
  printed: SharedSkill[];
  added: SharedSkill[];
  /** Characteristic increases on top of the position ("MA", "AV", …; AG/PA = one step better). */
  statIncreases: string[];
  cost: number | null;
  sprite: string | null;
}

export interface SharedTeamView {
  teamName: string;
  coach: string;
  raceName: string;
  crest: string | null;
  ruleset: { name: string; tierLabel: string | null } | null;
  updatedAt: string;
  players: SharedPlayer[];
  sideline: { reRolls: number; apothecary: boolean; assistantCoaches: number; cheerleaders: number; dedicatedFans: number };
  inducements: Array<{ name: string; count: number; icon: string | null }>;
  specialRules: string[];
  summary: {
    players: number;
    playersCost: number | null;
    starsCost: number | null;
    skillsCost: number | null;
    inducementsCost: number | null;
    sidelineCost: number | null;
    total: number | null;
    cap: number | null;
    primarySkills: number;
    secondarySkills: number;
  };
  validity: { valid: boolean; issues: number; custom: boolean };
  /** Present ONLY when the viewer's session coach owns the save (the "Open in Tournament Builder" link). */
  ownerSaveId?: string;
}

// ── Art lookup (ports of team-builder.js Core.rosterRaceKey / resolveSprite / resolveCrest) ──
const normalizeKey = (value: unknown): string => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function rosterRaceKey(race: string): string {
  const key = normalizeKey(race);
  return key.replace(/^(?:bb\d{4}|bb\d|crp|lrb\d|ffb|20\d{2})+/, "").replace(/(?:bb\d{4}|bb\d|crp|lrb\d|20\d{2})+$/, "") || key;
}
interface SpriteManifest { races?: Record<string, Record<string, string>>; starRace?: string; roleAliases?: Record<string, Record<string, string>> }
interface CrestManifest { crests?: Record<string, string> }
interface IconManifest { icons?: Record<string, string> }
export function resolveSprite(manifest: SpriteManifest | null, race: string, positionName: string): string | null {
  if (!manifest?.races || !positionName) return null;
  const races = manifest.races;
  const starRace = manifest.starRace || "stars";
  const raceKey = races[normalizeKey(race)] ? normalizeKey(race) : rosterRaceKey(race);
  const name = normalizeKey(positionName);
  const roles = races[raceKey];
  if (roles) {
    const alias = manifest.roleAliases?.[raceKey]?.[name];
    const role = alias && roles[alias] ? alias : roles[name] ? name : undefined;
    if (role) return String(roles[role]);
  }
  if (raceKey !== starRace && races[starRace]?.[name]) return String(races[starRace]![name]);
  return null;
}
export function resolveCrest(manifest: CrestManifest | null, race: string): string | null {
  const key = rosterRaceKey(race).replace(/[^a-z]/g, "");
  return key && manifest?.crests?.[key] ? String(manifest.crests[key]) : null;
}
/** Only ever hand out a relative path inside the generated art folders (never a URL or a traversal). */
const safeArt = (path: string | null): string | null =>
  path && /^(?:sprites|crests|icons)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(path) ? path : null;

const manifestCache = new Map<string, { mtimeMs: number; value: unknown }>();
function readManifest<T>(publicDir: string, rel: string): T | null {
  const file = join(publicDir, rel);
  try {
    const { mtimeMs } = statSync(file);
    const hit = manifestCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
    const value = JSON.parse(readFileSync(file, "utf8")) as T;
    manifestCache.set(file, { mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

// ── Model ──
const bareSkill = (skill: string): string => skill.replace(/\*+$/, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\*+$/, "").trim();
function skillCategory(skill: string): string {
  const meta = findSkill(bb2025, bareSkill(skill)) ?? findSkill(bb2025, skill);
  return meta?.category && !meta.trait ? String(meta.category) : "Trait";
}
const targetNum = (t: string): number | null => {
  const m = /^(\d+)\+$/.exec(String(t));
  return m ? Number(m[1]) : null;
};
/** One step per characteristic increase: MA/ST/AV up, AG/PA a lower target. Repeats list the stat again. */
function statIncreases(player: RosterPlayer, base: { MA: number; ST: number; AG: string; PA: string; AV: string } | undefined): string[] {
  if (!base) return [];
  const out: string[] = [];
  const rep = (stat: string, n: number) => { for (let i = 0; i < n && i < 4; i += 1) out.push(stat); };
  rep("MA", player.MA - base.MA);
  rep("ST", player.ST - base.ST);
  const better = (now: string, was: string) => { const a = targetNum(now); const b = targetNum(was); return a !== null && b !== null ? b - a : 0; };
  rep("AG", better(player.AG, base.AG));
  rep("PA", better(player.PA, base.PA));
  const av = (t: string) => targetNum(t) ?? 0;
  rep("AV", av(player.AV) - av(base.AV));
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback);

export interface SharedViewInput {
  coach: string;
  save: TeamBuilderSave;
  /** The composed roster; undefined when the sheet can no longer be composed on this host. */
  roster?: Roster;
  /** Dataset validation (base rosters) — undefined for Secret League (roster-intrinsic) teams. */
  result?: ValidationResult;
  /** Secret League intrinsic legality. */
  intrinsic?: { legal: boolean; issues: number };
  /** Package info from packageResponseInfo (name, budget, rules.tierLabel). */
  ruleset?: { name: string; budget: number | null; tierLabel?: string | null } | null;
  custom?: boolean;
  publicDir: string;
  /** The viewer's proven session coach, when signed in. */
  viewer?: string;
}

export function sharedTeamView(input: SharedViewInput): SharedTeamView {
  const { save, roster, result } = input;
  const body = save.body ?? {};
  const raceName = roster?.rosterName || save.raceName || "";
  const sprites = readManifest<SpriteManifest>(input.publicDir, "sprites/manifest.json");
  const crests = readManifest<CrestManifest>(input.publicDir, "crests/manifest.json");
  const icons = readManifest<IconManifest>(input.publicDir, "icons/inducements/manifest.json");
  const dsRoster = raceName ? findRoster(bb2025, raceName) : undefined;
  const players: SharedPlayer[] = (roster?.players ?? []).map((p) => {
    const star = isStarName(bb2025, p.positionName);
    const ds = dsRoster && !star ? findPosition(dsRoster, p.positionName) : undefined;
    const printedNames = ds ? p.skills.filter((s) => !addedSkills(ds, [s]).length) : p.skills;
    const addedNames = ds ? addedSkills(ds, p.skills) : [];
    return {
      number: int(p.number),
      position: shortPositionName({ name: String(p.positionName) }, { name: raceName }),
      positionFull: String(p.positionName),
      isStar: star,
      stats: { MA: int(p.MA), ST: int(p.ST), AG: String(p.AG), PA: String(p.PA), AV: String(p.AV) },
      printed: printedNames.map((name) => ({ name, category: skillCategory(name) })),
      added: addedNames.map((name) => ({
        name,
        category: skillCategory(name),
        access: ds && skillAccess(bb2025, ds, bareSkill(name)) === "secondary" ? "secondary" as const : "primary" as const,
      })),
      statIncreases: star ? [] : statIncreases(p, ds),
      cost: num(p.cost),
      sprite: safeArt(resolveSprite(sprites, raceName, p.positionName)),
    };
  });
  const rs = result?.recomputedSummary;
  const composedSummary = roster?.summary;
  const playersCost = num(composedSummary?.playersCost);
  const primary = num(rs?.primarySkillCount) ?? players.reduce((n, p) => n + p.added.filter((s) => s.access !== "secondary").length, 0);
  const secondary = num(rs?.secondarySkillCount) ?? players.reduce((n, p) => n + p.added.filter((s) => s.access === "secondary").length, 0);
  const custom = input.custom === true;
  const issues = roster === undefined ? 1 : result ? (custom ? 0 : result.errors.length) : input.intrinsic?.issues ?? 0;
  const valid = roster !== undefined && (result ? custom || result.valid : input.intrinsic?.legal !== false);
  const sideline = roster?.sideline;
  const view: SharedTeamView = {
    teamName: String(roster?.teamName || body.teamName || save.name),
    coach: input.coach,
    raceName,
    crest: safeArt(resolveCrest(crests, raceName)),
    ruleset: input.ruleset ? { name: input.ruleset.name, tierLabel: input.ruleset.tierLabel ?? null } : null,
    updatedAt: save.updatedAt,
    players,
    sideline: {
      reRolls: int(sideline?.reRolls ?? body.reRolls),
      apothecary: (sideline?.apothecary ?? body.apothecary) === true,
      assistantCoaches: int(sideline?.assistantCoaches ?? body.assistantCoaches),
      cheerleaders: int(sideline?.cheerleaders ?? body.cheerleaders),
      dedicatedFans: int(sideline?.dedicatedFans ?? body.dedicatedFans, 1),
    },
    inducements: (roster?.inducements ?? []).map((i) => {
      // Same key the builder's icon lookup and the library row use (teamBuilderBuild.ts builtLibraryTeam).
      const key = i.id?.trim() || normName(i.name).replace(/ /g, "_");
      const icon = icons?.icons && Object.prototype.hasOwnProperty.call(icons.icons, key) ? icons.icons[key]! : null;
      return { name: String(i.name), count: int(i.count, 1), icon: safeArt(icon) };
    }),
    specialRules: (roster?.specialRules ?? []).map(String),
    summary: {
      players: players.length,
      playersCost,
      starsCost: num(rs?.starsCost),
      skillsCost: num(rs?.skillsCost) ?? num(composedSummary?.skillsCost),
      inducementsCost: num(rs?.inducementsCost) ?? num(composedSummary?.inducementCost),
      sidelineCost: num(composedSummary?.sidelineCost),
      total: num(rs?.goldUsed) ?? num(composedSummary?.total),
      cap: num(input.ruleset?.budget) ?? num(rs?.goldBudget) ?? num(body.budget),
      primarySkills: primary,
      secondarySkills: secondary,
    },
    validity: { valid, issues, custom },
  };
  if (input.viewer && input.viewer === input.coach) view.ownerSaveId = save.id;
  return view;
}
