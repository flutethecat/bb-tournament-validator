/**
 * Roster Builder league mode (registration spec 11-02 §5 (c), lane L7): a coach builds a team for a league season under
 * that season's team-building rules, the same rules redraft reads (settings.ts teamBuildingTable).
 *
 * The rules become an ordinary validator package (leagueSeasonPackage), derived on every read and never stored, so the
 * builder's preview, a save, the shared view and a later registration (L6) all judge the team by the same rules:
 *   - allowed rosters: the league's Registrations setting (Q10 classes: official = the BB2025 dataset rosters, NAF-approved
 *     = the admin-kept list in nafApprovedRosters.json, unofficial = everything else);
 *   - budget: the roster's initial treasury from the Team building table (default 1,000,000);
 *   - tier: the table's tier (labels only);
 *   - starting skills: the table's Primary / Secondary counts (count mode); Elite caps how many of those may be Elite skills;
 *   - no star players and no rostered inducements at team creation (league play buys inducements before each match, from the
 *     season's inducement table, which the builder shows for reference); no characteristic increases.
 * Max per race is a season cap, not a team rule: the race picker disables a full race and the preview reports it.
 *
 * The builder addresses the package by the marker "league:<leagueId>:<seasonId>" (leagueBuilderMarker.ts).
 *
 * Registration window (lane L5): the season's own registration settings (seasonRegistration.ts, the league's as defaults)
 * through the registration core's window: "registration open" = seasonWindowStatus (registrationOpen); allowed rosters,
 * max teams and max per race are the season's.
 */
import { readFileSync } from "node:fs";
import { findRoster, loadPackage, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { leaguePackageName, parseLeaguePackageName } from "../leagueBuilderMarker.js";
import type { ResolvedBuilderPackage } from "../teamBuilderPackage.js";
import { effectiveInducements, inducementConfigOf } from "./inducements.js";
import { isDraftLeague } from "./lifecycle.js";
import { seasonRegistrationOf, seasonWindowStatus } from "./seasonRegistration.js";
import { teamBuildingTable } from "./settings.js";
import type { LeagueStore } from "./store.js";
import type { LeagueRecord, LeagueRegistrations, SeasonRecord } from "./types.js";
import { isLadder, ladderState } from "./ladder.js";

// ---- roster classes (Q10) ----

export type RosterClass = "official" | "nafApproved" | "unofficial";
export const ROSTER_CLASS_LABEL: Readonly<Record<RosterClass, string>> = { official: "Official", nafApproved: "NAF-approved", unofficial: "Unofficial" };

let nafCache: string[] | undefined;
/** The admin-kept NAF-approved list (nafApprovedRosters.json), read once. An unreadable file is an empty list. */
export function nafApprovedRosters(): string[] {
  if (nafCache) return nafCache;
  try {
    const raw = JSON.parse(readFileSync(new URL("./nafApprovedRosters.json", import.meta.url), "utf8")) as { rosters?: unknown };
    nafCache = Array.isArray(raw.rosters) ? raw.rosters.filter((r): r is string => typeof r === "string" && Boolean(r.trim())).map((r) => r.trim()) : [];
  } catch {
    nafCache = [];
  }
  return nafCache;
}

const norm = (s: string): string => s.trim().toLowerCase();
/** The dataset's name for a race (TourPlay imports may spell it differently), else the name as given. */
export const canonicalRace = (name: string): string => findRoster(bb2025, name)?.name ?? name.trim();
const isOfficial = (name: string): boolean => bb2025.teams.some((t) => norm(t.name) === norm(canonicalRace(name)));

/** Every class a roster belongs to (official and NAF-approved may overlap) and its display class (official first). */
export function rosterClasses(name: string, naf: readonly string[] = nafApprovedRosters()): { official: boolean; nafApproved: boolean; primary: RosterClass } {
  const official = isOfficial(name);
  const nafApproved = naf.some((n) => norm(n) === norm(name) || norm(canonicalRace(n)) === norm(canonicalRace(name)));
  return { official, nafApproved, primary: official ? "official" : nafApproved ? "nafApproved" : "unofficial" };
}

/** Whether the league's allowed classes admit the roster ("" reason when they do). A roster in any allowed class is allowed. */
export function rosterAllowed(name: string, allowed: LeagueRegistrations["allowedRosters"], naf?: readonly string[]): { allowed: boolean; reason: string } {
  const c = rosterClasses(name, naf);
  const ok = (c.official && allowed.official) || (c.nafApproved && allowed.nafApproved) || (c.primary === "unofficial" && allowed.unofficial);
  return { allowed: ok, reason: ok ? "" : `${ROSTER_CLASS_LABEL[c.primary]} rosters aren't allowed in this league.` };
}

// ---- the season ----

/** Self-registration is open now: the season's window (seasonRegistration.ts seasonWindowStatus). */
export const registrationOpen = (league: LeagueRecord, season: SeasonRecord, now: Date = new Date()): boolean =>
  seasonWindowStatus(league, season, now).open;

/** Teams per race already in the season (dataset names). */
export function seasonRaceCounts(season: Pick<SeasonRecord, "teams">): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of season.teams ?? []) {
    const race = canonicalRace(String(t.race ?? ""));
    if (race) out.set(race, (out.get(race) ?? 0) + 1);
  }
  return out;
}

/** "Season 7": the header names the season by its number (the stored name may be anything). */
export const seasonLabel = (season: Pick<SeasonRecord, "number" | "name">): string => (Number.isFinite(season.number) ? `Season ${season.number}` : season.name);
export const leagueBuilderLabel = (league: Pick<LeagueRecord, "name">, season: Pick<SeasonRecord, "number" | "name">): string => `${league.name} · ${seasonLabel(season)}`;

/** The team problems the league adds to the validator's: a roster outside the allowed classes, a race at its season cap. */
export function leagueRaceProblems(league: LeagueRecord, season: SeasonRecord, raceName: string, naf?: readonly string[]): string[] {
  const regs = seasonRegistrationOf(league, season);
  const race = canonicalRace(raceName);
  const out: string[] = [];
  const allowed = rosterAllowed(race, regs.allowedRosters, naf);
  if (!allowed.allowed) out.push(allowed.reason);
  const max = regs.maxPerRace;
  const count = seasonRaceCounts(season).get(race) ?? 0;
  if (max !== null && count >= max) out.push(`${race}: ${count} / ${max} teams in this season, full.`);
  return out;
}

// ---- the package ----

/** The season's team-building rules as a validator package (see the header for what each rule maps to). */
export function leagueSeasonPackage(league: LeagueRecord, season: SeasonRecord, naf?: readonly string[]): TournamentPackage {
  const table = teamBuildingTable(season);
  const regs = seasonRegistrationOf(league, season);
  const rows = table.rosters.filter((r) => rosterAllowed(r.roster, regs.allowedRosters, naf).allowed);
  const tiers = [...new Set(rows.map((r) => r.tier))].sort((a, b) => a - b).map((tier) => ({
    tier, label: `Tier ${tier}`, rosters: rows.filter((r) => r.tier === tier).map((r) => r.roster), gold: null,
    starPlayersAllowed: false, bannedStars: [],
  }));
  return loadPackage({
    name: leagueBuilderLabel(league, season),
    description: `Team building rules for ${league.name}, ${season.name}, set by the league's organisers.`,
    ruleset: "bb2025-default",
    // No roster admitted (e.g. only NAF-approved rosters the dataset can't build): a name no roster has, never "every roster".
    eligibleRosters: rows.length ? rows.map((r) => r.roster) : ["(no roster allowed)"],
    tiers,
    teamRules: rows.map((r) => ({
      team: r.roster, gold: r.treasury * 1000,
      maxPrimary: r.startingSkills.primary, maxSecondary: r.startingSkills.secondary, eliteMaxTotal: r.startingSkills.elite,
    })),
    goldBudget: 1_000_000,
    skillAllotment: { skillPointBudget: 0, eliteSkills: [...table.eliteSkills] },
    starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null },
    inducements: { allowed: [], caps: {} },
    statIncreases: { allowed: [] },
    special: { slannAllowed: true, statIncreasesAllowed: false },
  }).pkg;
}

// ---- the builder's read model ----

export interface LeagueBuilderRace {
  roster: string;
  class: RosterClass;
  classLabel: string;
  tier: number;
  /** Initial treasury in gold. */
  treasury: number;
  startingSkills: { primary: number; secondary: number; elite: number };
  /** Teams of this race already in the season. */
  teams: number;
  allowed: boolean;
  full: boolean;
  /** Allowed and not full. */
  selectable: boolean;
  /** Why the race can't be picked ("" when it can). */
  reason: string;
}

export interface LeagueBuilderContext {
  league: { id: string; name: string };
  season: { id: string; name: string; number: number; status: string; ruleset: string };
  /** "TABBL · Season 7" */
  label: string;
  /** The builder's packageName for this season. */
  packageName: string;
  registration: {
    open: boolean;
    allowRegistration: boolean;
    maxPerRace: number | null;
    maxRegistrations: number | null;
    allowedRosters: LeagueRegistrations["allowedRosters"];
    teams: number;
    /** "open" is the season's registration window (lane L5). */
    source: "window";
  };
  races: LeagueBuilderRace[];
  eliteSkills: string[];
  /** The season's inducement table (offered rows only), bought before each match. */
  inducements: Array<{ id: string; name: string; price: number | null; cap: number; iconSrc: string; effectText: string }>;
}

export function leagueBuilderContext(league: LeagueRecord, season: SeasonRecord, naf?: readonly string[]): LeagueBuilderContext {
  const table = teamBuildingTable(season);
  const regs = seasonRegistrationOf(league, season);
  const counts = seasonRaceCounts(season);
  const races = table.rosters.map((r): LeagueBuilderRace => {
    const cls = rosterClasses(r.roster, naf);
    const allowed = rosterAllowed(r.roster, regs.allowedRosters, naf);
    const teams = counts.get(r.roster) ?? 0;
    const full = regs.maxPerRace !== null && teams >= regs.maxPerRace;
    return {
      roster: r.roster, class: cls.primary, classLabel: ROSTER_CLASS_LABEL[cls.primary], tier: r.tier, treasury: r.treasury * 1000,
      startingSkills: { ...r.startingSkills }, teams, allowed: allowed.allowed, full, selectable: allowed.allowed && !full,
      reason: !allowed.allowed ? allowed.reason : full ? `Full: ${teams} / ${regs.maxPerRace} ${r.roster} teams this season.` : "",
    };
  });
  return {
    league: { id: league.id, name: league.name },
    season: { id: season.id, name: season.name, number: season.number, status: season.status, ruleset: season.ruleset },
    label: leagueBuilderLabel(league, season),
    packageName: leaguePackageName(league.id, season.id),
    registration: {
      open: registrationOpen(league, season), allowRegistration: regs.allowRegistration, maxPerRace: regs.maxPerRace,
      maxRegistrations: regs.maxRegistrations, allowedRosters: { ...regs.allowedRosters }, teams: season.teams?.length ?? 0, source: "window",
    },
    races,
    eliteSkills: [...table.eliteSkills],
    inducements: effectiveInducements(inducementConfigOf(season)).filter((i) => i.enabled && i.cap > 0)
      .map((i) => ({ id: i.id, name: i.name, price: i.price, cap: i.cap, iconSrc: i.iconSrc, effectText: i.effectText })),
  };
}

// ---- the builder's package resolver ----

export const LEAGUE_UNKNOWN = "That league season doesn't exist.";
/** An off-dataset (Secret League) roster under league rules: never in a season's Team building table. */
export const LEAGUE_ROSTER_NOT_IN_TABLE = "This roster isn't in this league's team building table.";

/** resolveBuilderPackage's league hook: undefined for a name that is not a league marker. */
export function resolveLeaguePackage(store: Pick<LeagueStore, "league" | "season">, name: string | undefined): ResolvedBuilderPackage | { error: string } | undefined {
  const ref = parseLeaguePackageName(name);
  if (!ref) return undefined;
  // A draft league (lifecycle.ts) is no league to the builder: its name never reaches a save, a share or a preview.
  const found = store.league(ref.leagueId);
  const league = found && !isDraftLeague(found) ? found : undefined;
  const found2 = league ? store.season(league.id, ref.seasonId) : undefined;
  // A ladder in setup (lane 8b) is seen by its organisers only on the league pages: to the builder it does not exist yet.
  const season = found2 && !(isLadder(found2) && ladderState(found2) === "setup") ? found2 : undefined;
  if (!league || !season) return { error: LEAGUE_UNKNOWN };
  const pkg = leagueSeasonPackage(league, season);
  return {
    pkg,
    selected: { name: pkg.name, ...(pkg.description ? { description: pkg.description } : {}) },
    league: { ...ref, raceProblems: (race) => leagueRaceProblems(league, season, race) },
  };
}

/** GET /api/leagues/:id/seasons/:seasonId/team-building (public, like every league read): the builder's league context. */
export function leagueBuilderRoute(
  method: string, rest: string[], league: LeagueRecord | undefined, store: Pick<LeagueStore, "season">,
): { status: number; headers?: Record<string, string>; body: unknown } | undefined {
  const [first, seasonId, third, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "team-building" || more.length) return undefined;
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "Use GET." } };
  if (!league) return { status: 404, body: { error: "League not found." } };
  const season = store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  return { status: 200, headers: { "cache-control": "no-store" }, body: leagueBuilderContext(league, season) };
}

/** Adds the league's own team problems (leagueRaceProblems) to a validator result, as errors (ruleId "league"). A no-op for
 *  anything but a league package. Returns the same result. */
export function withLeagueProblems<T extends { valid: boolean; errors: Array<{ ruleId: string; severity: string; message: string }> }>(
  result: T, resolved: Pick<ResolvedBuilderPackage, "league">, raceName: string,
): T {
  const problems = resolved.league?.raceProblems(raceName) ?? [];
  if (!problems.length) return result;
  result.errors.unshift(...problems.map((message) => ({ ruleId: "league", severity: "error", message })));
  result.valid = false;
  return result;
}
