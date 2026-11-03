/**
 * League creation wizard and lifecycle routes (registration spec 2026-11-02 §4 (b), lane L5).
 *
 *   POST   /api/leagues                                    { name, fullName?, slug?, description?, address? } create a DRAFT
 *                                                          league (site organisers and admins, Q1); the creator becomes its
 *                                                          owner; Season 1 is made in setup with the league's defaults
 *   GET    /api/leagues/:id/draft                          the wizard's read model (organisers + admins; webhook masked)
 *   PATCH  /api/leagues/:id/draft                          { revision, step?, identity?, rules?, season?, connections?, complete? }
 *                                                          one or more wizard steps, all validated before anything is written;
 *                                                          only while the league is a draft
 *   POST   /api/leagues/:id/publish                        draft -> published (organisers + admins)
 *   POST   /api/leagues/:id/seasons/:seasonId/stage        { stage: "registration" | "active" | "setup" } Open registration,
 *                                                          Start season, Close registration (lifecycle.ts canMoveStage)
 *   GET    /api/leagues/:id/seasons/:seasonId/registration the season's registration settings and whether it is open now
 *                                                          (public, like every league read of a visible league)
 *   PATCH  /api/leagues/:id/seasons/:seasonId/registration { revision (the season's), ...SeasonRegistration fields }
 *
 * Every step reuses the League settings parsers (settings.ts parseInformation, parseRegistrations, parseTeamBuilding,
 * parseConnections; seasonRegistration.ts parseSeasonRegistration), so the wizard and the settings tabs accept and refuse
 * the same things. Test sign-in sessions (Q13): a league a test session creates is marked test, and a test session writes
 * only in test leagues (testSession.ts).
 */
import { announceUpcomingOnPublish } from "./leagueEvents.js";
import { existsSync } from "node:fs";
import { assertTestSessionMayWrite, RegistrationError, registrationCounts } from "../registration/index.js";
import { artUrl, assertRulesetPackage, leaguePath, seasonSummary, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "./api.js";
import { houseRulesOf, type HouseRules } from "../competition/houseRules.js";
import { discordEvents, maskWebhookUrl } from "./discord.js";
import { populateSeasonDiscord } from "../discord/api.js";
import { leagueTimeZone, leagueTimeZoneSet } from "./timeZone.js";
import { readJsonObject, requestRevision } from "./http.js";
import { fixturePlayed } from "./tourplay.js";
import { canMoveStage, isDraftLeague, MIN_TEAMS_TO_START, leagueVisibility, managesLeague, SEASON_STAGE_LABEL, seasonStage, STAGE_ACTION_LABEL, type SeasonStage } from "./lifecycle.js";
import { seasonTeamEntries } from "./registrationCheck.js";
import { LEAGUE_FIXTURE_REF } from "./tabletopFixtures.js";
import { defaultSeasonRegistration, parseSeasonRegistration, seasonRegistrationOf, seasonWindow, seasonWindowStatus, type SeasonRegistration } from "./seasonRegistration.js";
import {
  DEFAULT_REGISTRATIONS, parseConnections, parseInformation, parseLeagueHouseRules, parseLeagueRegions, parseRegistrations, parseTeamBuilding, registrationsOf, SettingsError, teamBuildingTable,
} from "./settings.js";
import { LEAGUE_ID, leagueOwner, LeagueStoreError } from "./store.js";
import { NEW_LEAGUE_REDRAFT_RULES } from "./redraftRules.js";
import type { LeaguePhase, LeagueRecord, LeagueRegistrations, SeasonRecord } from "./types.js";

export const WIZARD_STEPS = 5;
export const WIZARD_MAX_BYTES = 256 * 1024;
/** Open drafts one coach may own at a time (a typo-made draft is cheap; a pile of them is noise). */
export const MAX_OPEN_DRAFTS = 10;
/** Ids the SPA's routes own (/app/leagues/new). */
export const RESERVED_LEAGUE_IDS: ReadonlySet<string> = new Set(["new", "create", "import", "settings", "api"]);
export const DIVISIONS_MAX = 16;
export const DIVISION_NAME_MAX = 40;
export const SEASON_NAME_MAX = 60;
export const REGULAR_PHASE_ID = "season-regular";
export const PLAYOFF_PHASE_ID = "cup-play-offs";

const noStore = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): LeagueApiResult => ({ status, headers: noStore, body });
const fail = (status: number, error: string, field?: string): LeagueApiResult => res(status, { error, ...(field ? { field } : {}) });

/** A league id from a name: lower-case letters, digits and dashes, at most 64 ("Tahoma Area BBL" -> "tahoma-area-bbl"). */
export function slugifyLeagueName(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return s;
}

function parseSlug(raw: unknown, name: string): string {
  if (raw !== undefined && raw !== null && raw !== "" && typeof raw !== "string") throw new SettingsError(400, "The league address must be text.", "slug");
  const v = typeof raw === "string" && raw.trim() ? raw.trim() : slugifyLeagueName(name);
  if (!v) throw new SettingsError(400, "Pick a league address: lower-case letters, digits and dashes.", "slug");
  if (!LEAGUE_ID.test(v)) throw new SettingsError(400, "The league address must be lower-case letters, digits and dashes (at most 64), starting with a letter or digit.", "slug");
  if (RESERVED_LEAGUE_IDS.has(v)) throw new SettingsError(400, `"${v}" is reserved. Pick another league address.`, "slug");
  return v;
}

/** Divisions = the regular phase's groups: 1 to 16 unique names; none (or one blank) = a single unnamed division. */
export function parseDivisions(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [""];
  if (!Array.isArray(raw)) throw new SettingsError(400, "Divisions must be a list.", "divisions");
  const names = raw.map((d, i) => {
    if (typeof d !== "string") throw new SettingsError(400, "Each division name must be text.", `divisions[${i}]`);
    const t = d.trim();
    if (t.length > DIVISION_NAME_MAX) throw new SettingsError(400, `Division names must be at most ${DIVISION_NAME_MAX} characters.`, `divisions[${i}]`);
    return t;
  }).filter(Boolean);
  if (names.length > DIVISIONS_MAX) throw new SettingsError(400, `At most ${DIVISIONS_MAX} divisions.`, "divisions");
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n.toLowerCase())) throw new SettingsError(400, `${n} is listed twice.`, "divisions");
    seen.add(n.toLowerCase());
  }
  return names.length ? names : [""];
}

const regularPhase = (groups: string[]): LeaguePhase => ({ id: REGULAR_PHASE_ID, category: "Season", name: "Regular", groups, standings: [] });
const playoffPhase = (): LeaguePhase => ({ id: PLAYOFF_PHASE_ID, category: "Cup", name: "Play-offs", groups: [""], standings: [], format: "knockout" });

/** Season 1 of a new league: setup stage, one Regular phase, the league's registration defaults. */
export function firstSeason(league: LeagueRecord, at: string): SeasonRecord {
  return {
    id: "season-1", leagueId: league.id, number: 1, name: "Season 1", sourceSlug: "season-1", ruleset: league.ruleset ?? "BB2025", status: "active", stage: "setup",
    phases: [regularPhase([""])], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [],
    importedAt: at, source: "manual", registration: defaultSeasonRegistration(league),
  };
}

/** The draft's working season: the newest one. */
const workingSeason = (seasons: SeasonRecord[]): SeasonRecord | undefined => [...seasons].sort((a, b) => b.number - a.number)[0];

export interface WizardView {
  id: string;
  revision: number;
  visibility: "draft" | "published";
  step: number;
  completedAt?: string;
  test: boolean;
  /** General (step 1): `playOnFork` is the Played on setting (creation wizards v2 moved it out of Connections). */
  identity: { name: string; fullName: string; slug: string; description: string; address: LeagueRecord["address"] | null; logoUrl?: string; bannerUrl?: string; playOnFork: boolean; timeZone: string | null };
  rules: {
    ruleset: "BB2020" | "BB2025";
    /** The ruleset card: a saved package name, or null = the plain base ruleset. */
    rulesetPackage: string | null;
    houseRules: HouseRules;
    allowedRosters: LeagueRegistrations["allowedRosters"];
    maxRegistrations: number | null;
    maxPerRace: number | null;
    teamBuilding: ReturnType<typeof teamBuildingTable>;
  };
  season: {
    id: string; name: string; number: number; startedAt?: string; stage: SeasonStage; divisions: string[]; playoffs: boolean;
    registration: SeasonRegistration; revision: number;
    /** The organiser's regions (kept on the league; coaches pick one at join, a later lane). */
    regions: string[];
  } | null;
  connections: { playOnFork: boolean; discord: { configured: boolean; maskedUrl: string; events: ReturnType<typeof discordEvents> } };
}

export function wizardView(league: LeagueRecord, seasons: SeasonRecord[], webhook: string | undefined): WizardView {
  const season = workingSeason(seasons);
  const regs = registrationsOf(league);
  const logo = artUrl(league, "logo");
  const banner = artUrl(league, "banner");
  const regular = season?.phases.find((p) => p.id === REGULAR_PHASE_ID) ?? season?.phases[0];
  return {
    id: league.id,
    revision: league.revision ?? 0,
    visibility: leagueVisibility(league),
    step: league.wizard?.step ?? WIZARD_STEPS,
    ...(league.wizard?.completedAt ? { completedAt: league.wizard.completedAt } : {}),
    test: league.test === true,
    identity: {
      name: league.name, fullName: league.fullName, slug: league.slug || league.id, description: league.description, address: league.address ?? null,
      ...(logo ? { logoUrl: logo } : {}), ...(banner ? { bannerUrl: banner } : {}),
      playOnFork: league.playOnFork === true,
      timeZone: leagueTimeZoneSet(league) ? leagueTimeZone(league) : null,
    },
    rules: {
      ruleset: league.ruleset ?? "BB2025",
      rulesetPackage: league.rulesetPackage ?? null,
      houseRules: houseRulesOf(league, "league"),
      allowedRosters: { ...regs.allowedRosters },
      maxRegistrations: regs.maxRegistrations,
      maxPerRace: regs.maxPerRace,
      teamBuilding: teamBuildingTable(season),
    },
    season: season ? {
      id: season.id, name: season.name, number: season.number, ...(season.startedAt ? { startedAt: season.startedAt } : {}), stage: seasonStage(season),
      divisions: (regular?.groups ?? [""]).filter((g) => g !== ""), playoffs: season.phases.some((p) => p.id === PLAYOFF_PHASE_ID),
      registration: seasonRegistrationOf(league, season), revision: season.revision ?? 0,
      regions: league.regions ?? [],
    } : null,
    connections: { playOnFork: league.playOnFork === true, discord: { configured: Boolean(webhook), maskedUrl: maskWebhookUrl(webhook), events: discordEvents(league) } },
  };
}

function knownError(e: unknown): LeagueApiResult | undefined {
  if (e instanceof SettingsError) return fail(e.status, e.message, e.field);
  if (e instanceof LeagueStoreError) return fail(e.status, e.message);
  if (e instanceof RegistrationError) return fail(e.status, e.message);
  return undefined;
}

async function body(deps: LeagueApiDeps): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: LeagueApiResult }> {
  const r = await readJsonObject(deps, WIZARD_MAX_BYTES);
  if (r.ok) return r;
  return { ok: false, result: { status: r.status, headers: noStore, ...(r.close ? { close: true } : {}), body: { error: r.error } } };
}

/** Site organisers and admins create leagues (Q1). */
export const mayCreateLeague = (auth: LeagueApiIdentity | undefined): boolean => Boolean(auth && (auth.admin || auth.organizer));

/** POST /api/leagues: a new draft league with Season 1 in setup. */
export async function createLeagueRoute(auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in to create a league.");
  if (!mayCreateLeague(auth)) return fail(403, "Only site organisers can create leagues. Ask to become an organiser from your Account page.");
  const b = await body(deps);
  if (!b.ok) return b.result;
  const input = b.value;
  try {
    // The organiser's browser time zone comes with the create call (owner 11-02); absent = the league reads UTC.
    const info = parseInformation({ name: input.name ?? "", fullName: input.fullName, description: input.description, address: input.address, playOnFork: input.playOnFork, timeZone: input.timeZone });
    const name = info.name!;
    const id = parseSlug(input.slug, name);
    const { store } = deps;
    // Synchronous from here to the writes: no other request can take the same id in between.
    if (store.league(id) || existsSync(store.leagueDir(id))) return fail(409, "That league address is taken. Pick another.", "slug");
    const coachKey = auth.coach.trim().toLowerCase();
    const open = store.list().filter((l) => isDraftLeague(l) && leagueOwner(l).toLowerCase() === coachKey).length;
    if (open >= MAX_OPEN_DRAFTS) return fail(429, `You have ${open} draft leagues. Publish or finish one before starting another.`);
    const now = deps.now?.() ?? new Date();
    const at = now.toISOString();
    const league = store.upsertLeague({
      id, name, slug: id, fullName: info.fullName ?? "", description: info.description ?? "",
      organisers: [auth.coach], owner: auth.coach, ruleset: "BB2025", mode: "individual",
      ...(info.address ? { address: info.address } : {}),
      registrations: structuredClone(DEFAULT_REGISTRATIONS),
      visibility: "draft", wizard: { step: 2, createdBy: auth.coach }, revision: 0, authorised: true,
      // New leagues lift teams to the redraft budget (owner 11-02); leagues made before keep the old behaviour.
      redraftRules: { ...NEW_LEAGUE_REDRAFT_RULES },
      ...(info.playOnFork ? { playOnFork: true } : {}),
      ...(info.timeZone ? { timeZone: info.timeZone } : {}),
      // Q13: what a test sign-in makes is a test league, the only kind it may change afterwards.
      ...(auth.test ? { test: true as const } : {}),
    }, now);
    store.putSeason(firstSeason(league, at));
    return res(201, { ok: true, id, draft: wizardView(store.league(id)!, store.seasons(id), undefined) });
  } catch (e) {
    return knownError(e) ?? fail(500, "Could not create the league right now.");
  }
}

/** Anonymous 401, others 403 (the league itself was already found and is visible to the caller). */
function manageGate(league: LeagueRecord, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can change it.");
  try { assertTestSessionMayWrite(auth, league); } catch (e) { return knownError(e); }
  return undefined;
}

interface DraftPlan {
  info?: ReturnType<typeof parseInformation>;
  regs?: ReturnType<typeof parseRegistrations>;
  team?: ReturnType<typeof parseTeamBuilding>["rosters"];
  seasonName?: string;
  startedAt?: string | null;
  divisions?: string[];
  playoffs?: boolean;
  registration?: SeasonRegistration;
  /** Season 1's payment links, also kept as the league defaults a later season copies. */
  payDefaults?: { payPal?: string; venmo?: string };
  connections?: ReturnType<typeof parseConnections>;
  playOnFork?: boolean;
  rulesetPackage?: string | null;
  houseRules?: HouseRules;
  regions?: string[];
}

/** PATCH /api/leagues/:id/draft: synchronous from validation to the last write, like the settings PATCH. */
function patchDraft(league: LeagueRecord, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  if (!isDraftLeague(league)) return fail(409, "This league is published: change it from League settings.");
  const current = league.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return res(428, { error: "Send the draft revision you loaded (revision or If-Match).", revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", "revision");
  if (asked !== current) return res(409, { error: "This draft changed since you opened it. Reload to see the latest.", revision: current });
  const { store } = deps;
  const season = workingSeason(store.seasons(league.id));
  if (!season) return fail(409, "This draft has no season. Start one from League settings.");
  const now = deps.now?.() ?? new Date();
  const plan: DraftPlan = {};
  const obj = (v: unknown, field: string): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new SettingsError(400, `${field} must be an object.`, field);
    return v as Record<string, unknown>;
  };

  // Everything is validated before anything is written.
  if (input.identity !== undefined) {
    const i = obj(input.identity, "identity");
    if (i.slug !== undefined && i.slug !== league.id) throw new SettingsError(400, "The league address is set when the league is created.", "slug");
    plan.info = parseInformation({ name: i.name, fullName: i.fullName, description: i.description, address: i.address, timeZone: i.timeZone });
    // Played on lives in General (creation wizards v2).
    if (i.playOnFork !== undefined) plan.playOnFork = parseInformation({ playOnFork: i.playOnFork }).playOnFork;
  }
  if (input.rules !== undefined) {
    const r = obj(input.rules, "rules");
    if (r.ruleset !== undefined) plan.info = { ...(plan.info ?? {}), ...parseInformation({ ruleset: r.ruleset }) };
    plan.regs = parseRegistrations({ allowedRosters: r.allowedRosters, maxRegistrations: r.maxRegistrations, maxPerRace: r.maxPerRace }, registrationsOf(league));
    if (r.teamBuilding !== undefined) plan.team = parseTeamBuilding({ ...obj(r.teamBuilding, "teamBuilding"), seasonId: season.id }).rosters;
    if (r.rulesetPackage !== undefined) {
      plan.rulesetPackage = parseInformation({ rulesetPackage: r.rulesetPackage }).rulesetPackage;
      assertRulesetPackage(plan.rulesetPackage, deps);
    }
    if (r.houseRules !== undefined) plan.houseRules = parseLeagueHouseRules(r.houseRules, league);
  }
  if (input.season !== undefined) {
    const s = obj(input.season, "season");
    if (s.name !== undefined) {
      if (typeof s.name !== "string" || !s.name.trim() || s.name.trim().length > SEASON_NAME_MAX) throw new SettingsError(400, `Season name must be 1 to ${SEASON_NAME_MAX} characters.`, "season.name");
      plan.seasonName = s.name.trim();
    }
    if (s.startsAt !== undefined) {
      if (s.startsAt === null || s.startsAt === "") plan.startedAt = null;
      else {
        const t = typeof s.startsAt === "string" ? Date.parse(s.startsAt) : NaN;
        if (Number.isNaN(t) || t < Date.UTC(2000, 0, 1) || t > Date.UTC(2100, 0, 1)) throw new SettingsError(400, "Season start must be a date.", "season.startsAt");
        plan.startedAt = new Date(t).toISOString();
      }
    }
    if (s.divisions !== undefined) plan.divisions = parseDivisions(s.divisions);
    if (s.regions !== undefined) plan.regions = parseLeagueRegions(s.regions);
    if (s.playoffs !== undefined) {
      if (typeof s.playoffs !== "boolean") throw new SettingsError(400, "playoffs must be true or false.", "season.playoffs");
      plan.playoffs = s.playoffs;
    }
    if ((plan.divisions !== undefined || plan.playoffs !== undefined) && season.fixtures.length)
      throw new SettingsError(409, "This season already has fixtures: change its phases from the Fixtures editor.", "season");
  }
  // The season's registration starts from the league defaults the rules step just set (the draft keeps them in step).
  const regBase: SeasonRegistration = plan.regs ? { ...seasonRegistrationOf(league, season), ...plan.regs } : seasonRegistrationOf(league, season);
  if (input.season !== undefined && (input.season as Record<string, unknown>).registration !== undefined) {
    const raw = obj((input.season as Record<string, unknown>).registration, "season.registration");
    plan.registration = parseSeasonRegistration(raw, regBase);
    if (raw.payPal !== undefined || raw.venmo !== undefined) plan.payDefaults = { payPal: plan.registration.payPal, venmo: plan.registration.venmo };
  } else if (plan.regs) plan.registration = regBase;
  if (input.connections !== undefined) plan.connections = parseConnections(input.connections, discordEvents(league));
  let step: number | undefined;
  if (input.step !== undefined) {
    if (typeof input.step !== "number" || !Number.isInteger(input.step) || input.step < 1 || input.step > WIZARD_STEPS) throw new SettingsError(400, `step must be 1 to ${WIZARD_STEPS}.`, "step");
    step = input.step;
  }
  if (input.complete !== undefined && input.complete !== true) throw new SettingsError(400, "complete must be true.", "complete");

  // Writes: the season (team building, phases, registration), the secrets, then league.json (revision last).
  const at = now.toISOString();
  if (plan.team || plan.seasonName || plan.startedAt !== undefined || plan.divisions || plan.playoffs !== undefined || plan.registration || plan.info?.ruleset) {
    if (plan.team) season.rules = { ...(season.rules ?? {}), teamBuilding: { rosters: plan.team, eliteSkills: teamBuildingTable(season).eliteSkills, updatedAt: at, updatedBy: who.coach } };
    if (plan.seasonName) season.name = plan.seasonName;
    if (plan.startedAt === null) delete season.startedAt; else if (plan.startedAt) season.startedAt = plan.startedAt;
    if (plan.info?.ruleset) season.ruleset = plan.info.ruleset;
    if (plan.divisions) {
      const regular = season.phases.find((p) => p.id === REGULAR_PHASE_ID);
      if (regular) regular.groups = plan.divisions; else season.phases.unshift(regularPhase(plan.divisions));
    }
    if (plan.playoffs === true && !season.phases.some((p) => p.id === PLAYOFF_PHASE_ID)) season.phases.push(playoffPhase());
    if (plan.playoffs === false) season.phases = season.phases.filter((p) => p.id !== PLAYOFF_PHASE_ID);
    if (plan.registration) season.registration = plan.registration;
    store.putSeason(season);
  }
  if (plan.connections?.discordUrl !== undefined) {
    const secrets = store.secrets(league.id);
    if (plan.connections.discordUrl === null) delete secrets.discordWebhookUrl; else secrets.discordWebhookUrl = plan.connections.discordUrl;
    store.setSecrets(league.id, secrets);
  }
  const updated = store.updateLeague(league.id, (l) => {
    if (plan.info) {
      if (plan.info.name !== undefined) l.name = plan.info.name;
      if (plan.info.fullName !== undefined) l.fullName = plan.info.fullName;
      if (plan.info.description !== undefined) l.description = plan.info.description;
      if (plan.info.ruleset !== undefined) l.ruleset = plan.info.ruleset;
      if (plan.info.address !== undefined) { if (plan.info.address === null) delete l.address; else l.address = plan.info.address; }
      if (plan.info.timeZone !== undefined) { if (plan.info.timeZone === null) delete l.timeZone; else l.timeZone = plan.info.timeZone; }
    }
    if (plan.regs) l.registrations = plan.regs;
    if (plan.payDefaults) {
      const regs = l.registrations ? { ...l.registrations } : structuredClone(DEFAULT_REGISTRATIONS);
      for (const kind of ["payPal", "venmo"] as const) {
        const v = plan.payDefaults[kind];
        if (v) regs[kind] = v; else delete regs[kind];
      }
      l.registrations = regs;
    }
    if (plan.connections?.playOnFork !== undefined) l.playOnFork = plan.connections.playOnFork;
    if (plan.playOnFork !== undefined) l.playOnFork = plan.playOnFork;
    if (plan.rulesetPackage !== undefined) { if (plan.rulesetPackage === null) delete l.rulesetPackage; else { l.rulesetPackage = plan.rulesetPackage; l.ruleset = "BB2025"; } }
    if (plan.houseRules) l.houseRules = plan.houseRules;
    if (plan.regions) { if (plan.regions.length) l.regions = plan.regions; else delete l.regions; }
    if (plan.connections?.discordEvents) l.discordEvents = plan.connections.discordEvents;
    const w = l.wizard ?? { step: 1, createdBy: who.coach };
    l.wizard = { ...w, step: Math.max(w.step, step ?? w.step), ...(input.complete === true ? { completedAt: w.completedAt ?? at } : {}) };
    l.revision = current + 1;
  }, now);
  return res(200, { ok: true, draft: wizardView(updated, store.seasons(league.id), store.secrets(league.id).discordWebhookUrl) });
}

function publish(league: LeagueRecord, who: LeagueApiIdentity, deps: LeagueApiDeps): LeagueApiResult {
  if (!isDraftLeague(league)) return res(200, { ok: true, changed: false, visibility: "published" });
  const now = deps.now?.() ?? new Date();
  const updated = deps.store.updateLeague(league.id, (l) => {
    l.visibility = "published";
    l.publishedAt = now.toISOString();
    if (l.wizard && !l.wizard.completedAt) l.wizard = { ...l.wizard, completedAt: now.toISOString() };
    l.revision = (l.revision ?? 0) + 1;
  }, now);
  // The wizard's seasons take the league's webhook and Discord options now (they were made before Connections was set).
  for (const s of deps.store.seasons(league.id)) populateSeasonDiscord(deps.store, league.id, s.id);
  // League Events: a draft told nobody; publishing sends one "upcoming events" note and lets the Discord sync run.
  try { announceUpcomingOnPublish(deps.store, updated, deps.notify, now); } catch { /* never blocks publish */ }
  try { deps.leagueEvents?.kick?.(); } catch { /* the sync timer picks it up */ }
  void who;
  return res(200, { ok: true, changed: true, visibility: leagueVisibility(updated), publishedAt: updated.publishedAt, revision: updated.revision });
}

/** POST .../seasons/:seasonId/stage: Open registration (Allow registration turns on with it), Start season, Close registration. */
function moveStage(league: LeagueRecord, seasonId: string, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const to = input.stage;
  if (to !== "setup" && to !== "registration" && to !== "active") return fail(400, "stage must be setup, registration or active.", "stage");
  const from = seasonStage(season);
  if (from === to) return res(200, { ok: true, changed: false, season: seasonSummary(season) });
  if (!canMoveStage(from, to)) return fail(409, `${STAGE_ACTION_LABEL[to]} is not possible: ${season.name} is ${SEASON_STAGE_LABEL[from].toLowerCase()}.`, "stage");
  if (to === "active" && season.teams.length < MIN_TEAMS_TO_START)
    return fail(409, `Start season needs at least ${MIN_TEAMS_TO_START} teams; ${season.name} has ${season.teams.length}.`, "stage");
  if (from === "active" && season.fixtures.some(fixturePlayed))
    return fail(409, `${season.name} already has results: registration can't reopen. Turn on joining mid-season instead.`, "stage");
  season.stage = to;
  if (to === "registration") season.registration = { ...seasonRegistrationOf(league, season), allowRegistration: true };
  if (to === "active" && !season.startedAt) season.startedAt = (deps.now?.() ?? new Date()).toISOString();
  deps.store.putSeason(season);
  return res(200, { ok: true, changed: true, season: seasonSummary(season) });
}

/** The season's registration read model (public for a visible league; the organiser view adds the season revision). */
export function seasonRegistrationView(league: LeagueRecord, season: SeasonRecord, now: Date, manager: boolean) {
  const settings = seasonRegistrationOf(league, season);
  const status = seasonWindowStatus(league, season, now);
  const counts = registrationCounts(seasonWindow(settings), seasonTeamEntries(league, season));
  return {
    seasonId: season.id,
    stage: seasonStage(season),
    stageLabel: SEASON_STAGE_LABEL[seasonStage(season)],
    open: status.open,
    ...(status.open ? {} : { reason: status.reason, message: status.message }),
    settings,
    counts: { teams: counts.accepted, cap: counts.cap, placesLeft: counts.placesLeft },
    ...(manager ? { revision: season.revision ?? 0 } : {}),
  };
}

function patchSeasonRegistration(league: LeagueRecord, seasonId: string, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  if (season.status === "completed") return fail(409, `${season.name} is finished.`);
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return res(428, { error: "Send the season revision you loaded (revision or If-Match).", revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", "revision");
  if (asked !== current) return res(409, { error: "This season changed since you opened it. Reload to see the latest.", revision: current });
  const { revision: _r, ...fields } = input;
  season.registration = parseSeasonRegistration(fields, seasonRegistrationOf(league, season));
  deps.store.putSeason(season);
  const saved = deps.store.season(league.id, season.id) ?? season;
  return res(200, { ok: true, registration: seasonRegistrationView(league, saved, deps.now?.() ?? new Date(), true) });
}

/**
 * The wizard and lifecycle routes under /api/leagues/:id (undefined = not one of them). `league` is the league the
 * caller may see (the visibility gate in api.ts already answered 404 for a draft that is not theirs).
 */
export async function leagueLifecycleRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, second, third, ...more] = rest;
  const isDraft = first === "draft" && second === undefined;
  const isPublish = first === "publish" && second === undefined;
  const isStage = first === "seasons" && Boolean(second) && third === "stage" && more.length === 0;
  const isReg = first === "seasons" && Boolean(second) && third === "registration" && more.length === 0;
  if (!isDraft && !isPublish && !isStage && !isReg) return undefined;
  const read = method === "GET" || method === "HEAD";
  if (!league) return fail(404, "League not found.");
  if (isReg && read) {
    const season = deps.store.season(league.id, second!);
    if (!season) return fail(404, "Season not found.");
    return res(200, { registration: seasonRegistrationView(league, season, deps.now?.() ?? new Date(), managesLeague(league, auth)) });
  }
  const allowed = isDraft ? ["GET", "HEAD", "PATCH"] : isReg ? ["GET", "HEAD", "PATCH"] : ["POST"];
  if (!allowed.includes(method)) return fail(405, `Use ${allowed.filter((m) => m !== "HEAD").join(" or ")}.`);
  const early = manageGate(league, auth);
  if (early) return early;
  if (isDraft && read) return res(200, { draft: wizardView(league, deps.store.seasons(league.id), deps.store.secrets(league.id).discordWebhookUrl) });
  // Writes read the body first, then re-load the league and re-check the gate (the caller may have lost the role).
  const b = await body(deps);
  if (!b.ok) return b.result;
  const lg = deps.store.league(league.id);
  if (!lg) return fail(404, "League not found.");
  const again = manageGate(lg, auth);
  if (again) return again;
  try {
    if (isDraft) return patchDraft(lg, auth!, b.value, deps);
    if (isPublish) return publish(lg, auth!, deps);
    if (isStage) return moveStage(lg, second!, b.value, deps);
    return patchSeasonRegistration(lg, second!, b.value, deps);
  } catch (e) {
    return knownError(e) ?? fail(500, "Could not save the league right now.");
  }
}

/**
 * The server's test sign-in rule for league writes (Q13): a test session may create a league (it becomes a test league)
 * and write in a test league; every other league write is refused before any handler runs.
 */
export function testSessionMayWriteLeaguePath(store: Pick<LeagueApiDeps["store"], "league">, pathname: string): boolean {
  const route = leaguePath(pathname);
  if (!route) return false;
  if (!route.id) return route.rest.length === 0;
  return store.league(route.id)?.test === true;
}

/** A recorder match played for a draft league's fixture (its Discord announcements are skipped: lane L5). */
export function draftLeagueMatch(store: Pick<LeagueApiDeps["store"], "league">, match: { fixtureRef?: string; leagueSeason?: { leagueId: string } }): boolean {
  const leagueId = match.leagueSeason?.leagueId ?? (match.fixtureRef ? LEAGUE_FIXTURE_REF.exec(match.fixtureRef)?.[1] : undefined);
  return Boolean(leagueId && isDraftLeague(store.league(leagueId)));
}
