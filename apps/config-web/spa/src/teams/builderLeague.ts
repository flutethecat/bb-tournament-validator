// Roster Builder league mode (registration spec 11-02, lane L7): the league season's context as the builder reads it
// (GET /api/leagues/:id/seasons/:seasonId/team-building, src/leagues/leagueBuilder.ts leagueBuilderContext) and the race
// picker rows. The server derives the season's package and judges every team; this module only shapes what it sent.
import { core, type BuilderRoster } from "./builderCore";

export type RosterClass = "official" | "nafApproved" | "unofficial";
export interface LeagueRace {
  roster: string;
  class: RosterClass;
  classLabel: string;
  tier: number;
  treasury: number;
  startingSkills: { primary: number; secondary: number; elite: number };
  teams: number;
  allowed: boolean;
  full: boolean;
  selectable: boolean;
  reason: string;
}
export interface LeagueInducementRow { id: string; name: string; price: number | null; cap: number; iconSrc: string; effectText: string }
export interface LeagueContext {
  league: { id: string; name: string };
  season: { id: string; name: string; number: number; status: string; ruleset: string };
  label: string;
  packageName: string;
  registration: {
    open: boolean;
    allowRegistration: boolean;
    maxPerRace: number | null;
    maxRegistrations: number | null;
    allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
    teams: number;
  };
  races: LeagueRace[];
  eliteSkills: string[];
  inducements: LeagueInducementRow[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const sv = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const CLASSES: readonly RosterClass[] = ["official", "nafApproved", "unofficial"];

/** The server's league context, defensively shaped; null when it is not one. */
export function sanitizeLeagueContext(raw: unknown): LeagueContext | null {
  if (!isRec(raw) || !isRec(raw.league) || !isRec(raw.season) || typeof raw.packageName !== "string" || !raw.packageName) return null;
  const reg = isRec(raw.registration) ? raw.registration : {};
  const allowed = isRec(reg.allowedRosters) ? reg.allowedRosters : {};
  const races = (Array.isArray(raw.races) ? raw.races : []).filter(isRec).map((r): LeagueRace => {
    const skills = isRec(r.startingSkills) ? r.startingSkills : {};
    return {
      roster: sv(r.roster), class: CLASSES.includes(r.class as RosterClass) ? (r.class as RosterClass) : "unofficial", classLabel: sv(r.classLabel),
      tier: num(r.tier, 1), treasury: num(r.treasury, 1_000_000),
      startingSkills: { primary: num(skills.primary), secondary: num(skills.secondary), elite: num(skills.elite) },
      teams: num(r.teams), allowed: r.allowed === true, full: r.full === true, selectable: r.selectable === true, reason: sv(r.reason),
    };
  }).filter((r) => r.roster);
  return {
    league: { id: sv(raw.league.id), name: sv(raw.league.name) },
    season: { id: sv(raw.season.id), name: sv(raw.season.name), number: num(raw.season.number), status: sv(raw.season.status), ruleset: sv(raw.season.ruleset) },
    label: sv(raw.label),
    packageName: raw.packageName,
    registration: {
      open: reg.open === true, allowRegistration: reg.allowRegistration === true, maxPerRace: numOrNull(reg.maxPerRace), maxRegistrations: numOrNull(reg.maxRegistrations),
      allowedRosters: { official: allowed.official === true, nafApproved: allowed.nafApproved === true, unofficial: allowed.unofficial === true },
      teams: num(reg.teams),
    },
    races,
    eliteSkills: Array.isArray(raw.eliteSkills) ? raw.eliteSkills.map(sv) : [],
    inducements: (Array.isArray(raw.inducements) ? raw.inducements : []).filter(isRec).map((i) => ({
      id: sv(i.id), name: sv(i.name), price: numOrNull(i.price), cap: num(i.cap), iconSrc: sv(i.iconSrc), effectText: sv(i.effectText),
    })),
  };
}

export const NOT_INSTALLED = "Not installed on this server.";

export interface LeagueRaceRow extends LeagueRace {
  /** The fork roster for the race (null = not installed here). */
  rosterId: string | null;
  crest: string;
  selected: boolean;
  /** Short terms line: "Tier 1 · 1,000k · 2 primary, 1 secondary (1 Elite)". */
  terms: string;
}

/** The starting skills in words ("" for none). */
export function startingSkillsText(s: LeagueRace["startingSkills"]): string {
  const parts = [s.primary ? `${s.primary} primary` : "", s.secondary ? `${s.secondary} secondary` : ""].filter(Boolean);
  if (!parts.length) return "";
  return `${parts.join(", ")}${s.elite ? ` (up to ${s.elite} Elite)` : ""}`;
}

/** The race picker rows: every race of the season's table, with the fork roster and why a race can't be picked. */
export function leagueRaceRows(ctx: LeagueContext, rosters: BuilderRoster[], crestPath: (race: string) => string, selected: string | null): LeagueRaceRow[] {
  return ctx.races.map((r) => {
    const roster = rosters.find((x) => core.norm(x.raceName) === core.norm(r.roster)) ?? null;
    const installed = Boolean(roster);
    const skills = startingSkillsText(r.startingSkills);
    return {
      ...r,
      rosterId: roster?.rosterId ?? null,
      crest: crestPath(r.roster),
      selected: Boolean(roster && roster.rosterId === selected),
      selectable: r.selectable && installed,
      reason: r.reason || (installed ? "" : NOT_INSTALLED),
      terms: [`Tier ${r.tier}`, core.gold(r.treasury), skills ? `${skills} starting skills` : ""].filter(Boolean).join(" · "),
    };
  });
}
