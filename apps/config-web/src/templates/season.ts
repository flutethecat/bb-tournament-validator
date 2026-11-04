/**
 * Season templates (src/competition/templates.ts SeasonTemplateContent): capture from a league season, check on read,
 * and turn into a new season's settings. Also "Copy last season", which takes the same pieces from the newest season.
 *
 * Captured: the phase structure (ids, names, categories, divisions, table/knockout, points, tiebreaks), the season's
 * registration settings without the window's dates, the league regions, the payment-link defaults (optional) and the
 * rules snapshot (base ruleset, ruleset card, league house rules). Never: standings, fixtures, teams, participants,
 * registrations, honours, news, the Discord webhook or any coach name.
 */
import { houseRulesOf, parseHouseRules } from "../competition/houseRules.js";
import { parseRegions } from "../competition/format.js";
import { parsePayLinks, TemplateError, type SeasonTemplateContent, type SeasonTemplatePhase, type SeasonTemplateRegistration, type TemplatePayLinks } from "../competition/templates.js";
import { parsePayField } from "../payments/links.js";
import { DIVISION_NAME_MAX, DIVISIONS_MAX, PLAYOFF_PHASE_ID, REGULAR_PHASE_ID } from "../leagues/wizard.js";
import { defaultSeasonRegistration, parseSeasonRegistration, seasonRegistrationOf, type SeasonRegistration } from "../leagues/seasonRegistration.js";
import { registrationsOf } from "../leagues/settings.js";
import type { LeaguePhase, LeagueRecord, SeasonRecord, TiebreakKey } from "../leagues/types.js";

export const PHASES_MAX = 16;
const PHASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const TIEBREAKS: readonly TiebreakKey[] = ["points", "tdDiff", "casDiff", "headToHead", "tdFor", "casFor", "wins", "name"];
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** One phase's structure (no standings), or undefined when it is not a usable phase. */
function phaseShape(p: unknown): SeasonTemplatePhase | undefined {
  if (!isObj(p) || typeof p.id !== "string" || !PHASE_ID.test(p.id)) return undefined;
  const groups = Array.isArray(p.groups) ? p.groups.filter((g): g is string => typeof g === "string").map((g) => g.trim().slice(0, DIVISION_NAME_MAX)) : [""];
  const named = [...new Set(groups.filter(Boolean))].slice(0, DIVISIONS_MAX);
  const out: SeasonTemplatePhase = { id: p.id, category: text(p.category, 40) || "Season", name: text(p.name, 60) || p.id, groups: named.length ? named : [""] };
  if (p.format === "table" || p.format === "knockout") out.format = p.format;
  if (Array.isArray(p.includes)) {
    const inc = p.includes.filter((x): x is string => typeof x === "string" && PHASE_ID.test(x)).slice(0, PHASES_MAX);
    if (inc.length) out.includes = inc;
  }
  if (isObj(p.points) && [p.points.win, p.points.draw, p.points.loss].every((n) => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 100000))
    out.points = { win: p.points.win as number, draw: p.points.draw as number, loss: p.points.loss as number };
  if (Array.isArray(p.tiebreaks)) {
    const tb = p.tiebreaks.filter((k): k is TiebreakKey => (TIEBREAKS as readonly unknown[]).includes(k));
    if (tb.length) out.tiebreaks = [...new Set(tb)];
  }
  return out;
}

/** The phases of a template or a season: unique ids, at most 16, a Regular phase always first if there is none. */
function phasesShape(raw: unknown): SeasonTemplatePhase[] {
  const list = (Array.isArray(raw) ? raw : []).map(phaseShape).filter((p): p is SeasonTemplatePhase => Boolean(p));
  const seen = new Set<string>();
  const out = list.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).slice(0, PHASES_MAX);
  return out.length ? out : [{ id: REGULAR_PHASE_ID, category: "Season", name: "Regular", groups: [""] }];
}

function registrationShape(r: SeasonRegistration): SeasonTemplateRegistration {
  return {
    allowedRosters: { ...r.allowedRosters }, allowRegistration: r.allowRegistration, maxRegistrations: r.maxRegistrations, maxPerRace: r.maxPerRace,
    approval: r.approval, waitlist: r.waitlist, allowExistingTeams: r.allowExistingTeams, allowMidSeason: r.allowMidSeason, entryFee: r.entryFee,
  };
}

/** The payment links a season uses: its own, else the league defaults ("" on the season = cleared there). */
function seasonPayLinks(league: LeagueRecord, reg: SeasonRegistration): TemplatePayLinks | undefined {
  const regs = registrationsOf(league);
  const payPal = reg.payPal !== undefined ? reg.payPal : regs.payPal;
  const venmo = reg.venmo !== undefined ? reg.venmo : regs.venmo;
  return parsePayLinks({ ...(payPal ? { payPal } : {}), ...(venmo ? { venmo } : {}) }, parsePayField);
}

/** "Save as template" from a season (League settings, or the wizard's Season step after it saved). */
export function captureSeason(league: LeagueRecord, season: SeasonRecord, includePayLinks: boolean): SeasonTemplateContent {
  const reg = seasonRegistrationOf(league, season);
  const pay = includePayLinks ? seasonPayLinks(league, reg) : undefined;
  return {
    ruleset: (season.ruleset ?? league.ruleset) === "BB2020" ? "BB2020" : "BB2025",
    rulesetPackage: league.rulesetPackage ?? null,
    houseRules: houseRulesOf(league, "league"),
    phases: phasesShape(season.phases),
    registration: registrationShape(reg),
    regions: [...(league.regions ?? [])],
    ...(pay ? { payLinks: pay } : {}),
  };
}

/** A stored season template checked again on read (a value written another way, or by an older build, is refused). */
export function checkSeasonContent(raw: unknown): SeasonTemplateContent {
  if (!isObj(raw)) throw new TemplateError(500, "That template is damaged.");
  try {
    const reg = parseSeasonRegistration(isObj(raw.registration) ? stripWindow(raw.registration) : {}, defaultSeasonRegistration({ registrations: undefined }));
    const pay = parsePayLinks(raw.payLinks, parsePayField);
    return {
      ruleset: raw.ruleset === "BB2020" ? "BB2020" : "BB2025",
      rulesetPackage: typeof raw.rulesetPackage === "string" && raw.rulesetPackage.trim() ? raw.rulesetPackage.trim().slice(0, 200) : null,
      houseRules: parseHouseRules(isObj(raw.houseRules) ? raw.houseRules : {}, "league"),
      phases: phasesShape(raw.phases),
      registration: registrationShape(reg),
      regions: parseRegions(Array.isArray(raw.regions) ? raw.regions : []),
      ...(pay ? { payLinks: pay } : {}),
    };
  } catch (e) {
    if (e instanceof TemplateError) throw e;
    throw new TemplateError(409, `That template can't be used: ${(e as Error).message}`);
  }
}

/** Registration fields without the window dates or payment links (they never come from a template body). */
function stripWindow(r: Record<string, unknown>): Record<string, unknown> {
  const { opensAt: _o, closesAt: _c, payPal: _p, venmo: _v, ...rest } = r;
  return rest;
}

/** A phase as the season stores it (fresh, empty standings). */
const toPhase = (p: SeasonTemplatePhase): LeaguePhase => ({
  id: p.id, category: p.category, name: p.name, groups: [...p.groups], standings: [],
  ...(p.format ? { format: p.format } : {}), ...(p.includes ? { includes: [...p.includes] } : {}),
  ...(p.points ? { points: { ...p.points } } : {}), ...(p.tiebreaks ? { tiebreaks: [...p.tiebreaks] as TiebreakKey[] } : {}),
});

export interface NewSeasonSettings {
  phases: LeaguePhase[];
  registration: SeasonRegistration;
  ruleset?: "BB2020" | "BB2025";
}

/** "Copy last season": the newest season's phase structure and registration settings (no dates, no teams). */
export function copyLastSeason(league: LeagueRecord, last: SeasonRecord | undefined): NewSeasonSettings | undefined {
  if (!last) return undefined;
  const reg = seasonRegistrationOf(league, last);
  const { opensAt: _o, closesAt: _c, ...rest } = reg;
  return { phases: phasesShape(last.phases).map(toPhase), registration: { ...rest } };
}

/** A new season's settings from a template. `usePayLinks` = the template's links become the season's own. */
export function seasonFromTemplate(league: LeagueRecord, content: SeasonTemplateContent, usePayLinks: boolean): NewSeasonSettings {
  const base = defaultSeasonRegistration(league);
  const registration = parseSeasonRegistration({ ...content.registration }, base);
  delete registration.opensAt;
  delete registration.closesAt;
  if (usePayLinks && content.payLinks) {
    if (content.payLinks.payPal) registration.payPal = content.payLinks.payPal;
    if (content.payLinks.venmo) registration.venmo = content.payLinks.venmo;
  }
  return { phases: content.phases.map(toPhase), registration, ruleset: content.ruleset };
}

/** Phase id constants re-exported for the tests and the SPA's labels. */
export { PLAYOFF_PHASE_ID, REGULAR_PHASE_ID };
