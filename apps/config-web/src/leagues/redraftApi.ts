/**
 * Redraft routes (session-gated; anonymous 401; organiser writes revision-checked like the settings PATCH: no revision
 * 428, an older one 409). Rules and maths: redraft.ts; budget rules: redraftRules.ts; the window and play block:
 * redraftWindow.ts. The organiser board lives in League settings -> Redraft, the coach side in the Roster Builder's
 * Redraft mode (owner 11-02); the old /app/leagues/:id/redraft page redirects to them.
 *
 *   GET  /api/leagues/:id/redraft[?source=&target=]            organiser board (active + inactive teams, budgets earned vs
 *                                                              set, statuses, window); source = the finished season to
 *                                                              redraft from, target = the season that receives the lists
 *   POST /api/leagues/:id/redraft                              { revision, action: "confirm", sourceSeasonId?, targetSeasonId?, capEnabled, cap,
 *                                                                opensAt?: ISO, windowDays?, teams: [{ teamId, selected, override? }] }
 *                                                              { revision, action: "team", teamId, override: { budget, reason } | null } | { ..., skip: true }
 *                                                              { revision, action: "lift", teamId } | { revision, action: "lift", all: true }
 *                                                              { revision, action: "close" }
 *   GET  /api/leagues/:id/redraft/teams/:teamId                the team's coach or an organiser: the coach's redraft view
 *   POST /api/leagues/:id/redraft/teams/:teamId/rest           { revision, mode: "site" | "entered", rolls?: { [playerId]: number[] } }
 *   POST /api/leagues/:id/redraft/teams/:teamId/submit         { revision, keep: playerId[], hires: [{ position, count }], staff }
 *   GET  /api/leagues/:id/seasons/:seasonId/teams/:teamId/redraft-budget
 *                                                              the team summary's current redraft budget (public where the
 *                                                              season is: every term is already in the season read); the
 *                                                              redraft task (override, lift, history) only for the team's
 *                                                              coach and the organisers
 *   GET  /api/leagues?redraft=mine                             the signed-in coach's open redraft tasks (team management page)
 */
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { buildRedraftPost, discordEvents, postWebhook as defaultPoster, type DiscordPayload } from "./discord.js";
import { postLeagueEvent } from "./events.js";
import { readJsonObject, requestRevision } from "./http.js";
import {
  budgetBase, coachOwnsTeam, coachView, draftContext, leagueAliases, gold, liftApplies, OVERRIDE_MAX, parseDraftInput, redraftBudget, redraftPhase,
  finishedSeasons, redraftBoard, RedraftError, redraftSource, redraftTarget, redraftTargets, restAndRelaxation, sameCoach, spendable, stateRules, teamRecord,
  windowView, type BoardRow, type CoachRedraftView,
} from "./redraft.js";
import { amountsOf, effectiveRedraftRules, WINDOW_DAYS_MAX } from "./redraftRules.js";
import { applyingRebuild, commitDraft, newWindow, redraftBoardLink, redraftModeLink, redraftSeasons, whenText, windowBefore } from "./redraftWindow.js";
import { isLeagueOrganiser, leagueOwner, type LeagueStore } from "./store.js";
import type { LeagueRecord, RedraftBudget, RedraftLogEntry, RedraftRules, RedraftState, RedraftTeamTask, RedraftWindow, SeasonRecord } from "./types.js";
import { isDraftLeague, publishedLeagues } from "./lifecycle.js";
import { gateBlock, gateRefusal } from "./gates.js";
import { parseWall, wallInstant } from "./leagueEvents.js";
import { leagueTimeZone } from "./timeZone.js";

export const REDRAFT_MAX_BYTES = 64 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const res = (status: number, body: unknown, headers: Record<string, string> = {}): LeagueApiResult => ({ status, body, headers: { ...NO_STORE, ...headers } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

/** The coach's Redraft mode (with a team) or the organiser's board (without): server links, /app/... */
export const redraftLink = (leagueId: string, teamId?: string): string => (teamId ? redraftModeLink(leagueId, teamId) : redraftBoardLink(leagueId));

/** The league's seasons, newest first, with seasonsPlayed derived (shared with the window job: redraftWindow.ts). */
const loadSeasons = (store: LeagueStore, leagueId: string): SeasonRecord[] => redraftSeasons(store, leagueId);

const isManager = (league: LeagueRecord, auth: LeagueApiIdentity): boolean => auth.admin || isLeagueOrganiser(league, auth.coach);

export interface RedraftBoardView {
  leagueId: string;
  leagueName: string;
  /** The league's zone: the board shows and takes the window's Opens at in it (gates lane). */
  timeZone: string;
  revision: number;
  source: { id: string; name: string; number: number; ruleset: string } | null;
  target: { id: string; name: string } | null;
  /** Pickers (organiser): every finished season, and the seasons after the source. */
  sources: Array<{ id: string; name: string }>;
  targets: Array<{ id: string; name: string; status: string }>;
  state: Omit<RedraftState, "teams"> | null;
  capEnabled: boolean;
  cap: number;
  /** The formula the board shows (the confirmed redraft's snapshot, else the league's settings). */
  rules: RedraftRules;
  /** The league settings revision the formula was read at: Confirm sends it back (409 when the settings changed since). */
  settingsRevision: number;
  /** The window (confirmed redrafts since 11-02) with open / before flags at read time. */
  window: (RedraftWindow & { open: boolean; before: boolean }) | null;
  active: BoardRow[];
  inactive: BoardRow[];
  note: string;
}

export interface RedraftPicks { source?: string; target?: string }

function boardView(league: LeagueRecord, seasons: SeasonRecord[], picks: RedraftPicks = {}, now: Date = new Date()): RedraftBoardView {
  // An unknown source pick falls back to the default (a stale link must not blank the board).
  const source = redraftSource(seasons, picks.source) ?? redraftSource(seasons);
  const rules = effectiveRedraftRules(league);
  const sources = finishedSeasons(seasons).map((s) => ({ id: s.id, name: s.name }));
  if (!source) {
    return {
      leagueId: league.id, leagueName: league.name, timeZone: leagueTimeZone(league), revision: 0, source: null, target: null, sources, targets: [], state: null, capEnabled: rules.capEnabled, cap: rules.cap,
      rules, settingsRevision: league.revision ?? 0, window: null, active: [], inactive: [], note: "Finish a season first: a redraft runs between seasons.",
    };
  }
  // Once confirmed, the target is the one the redraft stored (or the default); a pick only steers an unconfirmed board.
  const target = (source.redraft ? undefined : picks.target ? redraftTarget(seasons, source, picks.target) : undefined) ?? redraftTarget(seasons, source);
  const targets = redraftTargets(seasons, source).map((s) => ({ id: s.id, name: s.name, status: s.status }));
  const state = source.redraft;
  const { active, inactive } = redraftBoard(seasons, source, state, rules, target ?? null);
  const { teams: _t, ...meta } = state ?? ({} as RedraftState);
  const w = state ? windowView(state, now) : null;
  return {
    leagueId: league.id, leagueName: league.name, timeZone: leagueTimeZone(league), revision: state?.revision ?? 0,
    source: { id: source.id, name: source.name, number: source.number, ruleset: source.ruleset },
    target: target ? { id: target.id, name: target.name } : null,
    sources, targets,
    state: state ? meta : null,
    capEnabled: state?.capEnabled ?? rules.capEnabled, cap: state?.cap ?? rules.cap,
    rules: state ? stateRules(state) : rules,
    settingsRevision: league.revision ?? 0,
    window: state?.window && w ? { ...state.window, open: w.open, before: w.before } : null,
    active, inactive,
    note: target ? `Draft lists go into ${target.name}.` : "Draft lists are kept until the next season is started, then go into it.",
  };
}

function checkRevision(input: Record<string, unknown>, current: number, ifMatch: string | undefined): LeagueApiResult | undefined {
  const asked = requestRevision(input, ifMatch);
  if (asked === "missing") return fail(428, "Send the redraft revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "The redraft changed since you opened it. Reload to see the latest.", { revision: current });
  return undefined;
}

async function discord(league: LeagueRecord, deps: LeagueApiDeps, key: "news" | "milestones", payload: DiscordPayload): Promise<void> {
  // Through the one cleaned sender (src/discord/targets.ts postTo): drafts post nothing, the toggle and webhook are checked,
  // listed words are starred; best effort, the URL is never logged.
  await postLeagueEvent(deps.store, league, key, payload, deps.postWebhook ?? defaultPoster);
}

function notifyAll(deps: LeagueApiDeps, list: Array<{ coach: string; input: NotificationInput }>): void {
  for (const n of list) {
    try { deps.notify?.(n.coach, n.input); } catch { /* fire-and-forget */ }
  }
}

const organisersOf = (league: LeagueRecord): string[] => {
  const out: string[] = [];
  for (const c of [leagueOwner(league), ...league.organisers]) if (c && !out.some((o) => sameCoach(o, c))) out.push(c.trim());
  return out;
};

function parseOverride(raw: unknown): { budget: number; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RedraftError(400, "override must be an object.", "override");
  const { budget, reason } = raw as Record<string, unknown>;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0 || budget > OVERRIDE_MAX)
    throw new RedraftError(400, `Budget override must be a whole number of gold from 0 to ${OVERRIDE_MAX.toLocaleString("en-US")}.`, "override.budget");
  const why = typeof reason === "string" ? reason.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (why.length < 3 || why.length > 200) throw new RedraftError(400, "Give a reason for the budget override (3 to 200 characters).", "override.reason");
  return { budget, reason: why };
}

/** An ISO instant with an explicit zone (Z or ±hh:mm), years 2000-2199, as UTC ISO; undefined when it is not one. */
export function parseInstant(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v.trim())) return undefined;
  const ms = Date.parse(v.trim());
  if (!Number.isFinite(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year < 2200 ? iso : undefined;
}

/** Lifts one task to the set budget (when it applies) and logs it with the actor and time. True when it lifted. */
function liftTask(state: RedraftState, task: RedraftTeamTask, setBudget: number, by: string, at: string, auto: boolean): boolean {
  if (!liftApplies(task, setBudget)) return false;
  const from = spendable(task);
  task.lift = { to: setBudget, by, at, auto };
  state.log.unshift({
    at, by, teamId: task.teamId,
    text: auto ? `${task.name} was lifted from ${gold(from)} to the set budget of ${gold(setBudget)} (Lift teams to the budget, opened by ${by}).`
      : `${by} lifted ${task.name} from ${gold(from)} to the set budget of ${gold(setBudget)}.`,
  });
  return true;
}

export async function redraftRoutes(
  method: string,
  rest: string[],
  league: LeagueRecord | undefined,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
  query?: URLSearchParams,
): Promise<LeagueApiResult | undefined> {
  if (rest[0] !== "redraft") return undefined;
  const [, second, teamId, action, ...more] = rest;
  const board = second === undefined;
  const team = second === "teams" && Boolean(teamId) && more.length === 0 && (action === undefined || action === "rest" || action === "submit");
  if (!board && !team) return fail(404, "Not found.");
  const read = method === "GET" || method === "HEAD";
  if (board && !read && method !== "POST") return fail(405, "Use GET or POST.");
  if (!board && action === undefined && !read) return fail(405, "Use GET.");
  if (!board && action !== undefined && method !== "POST") return fail(405, "Use POST.");
  if (!auth) return fail(401, "Sign in to see the redraft.");
  if (!league) return fail(404, "League not found.");

  let input: Record<string, unknown> = {};
  if (!read) {
    const body = await readJsonObject(deps, REDRAFT_MAX_BYTES);
    if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
    input = body.value;
  }
  // Judged against the league as it is now (after the body arrived); synchronous from here to the writes.
  const lg = deps.store.league(league.id);
  if (!lg) return fail(404, "League not found.");
  const nowDate = deps.now?.() ?? new Date();
  try {
    if (board) {
      if (!isManager(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins run the redraft.");
      const seasons = loadSeasons(deps.store, lg.id);
      if (read) return res(200, { redraft: boardView(lg, seasons, { source: query?.get("source") || undefined, target: query?.get("target") || undefined }, nowDate) });
      return await boardPost(lg, auth, input, seasons, deps);
    }
    const seasons = loadSeasons(deps.store, lg.id);
    const source = redraftSource(seasons);
    const ctx = source ? draftContext(seasons, source, teamId!) : undefined;
    if (!source || !source.redraft || !ctx) return fail(404, "No redraft for this team.");
    if (!isManager(lg, auth) && !coachOwnsTeam(ctx.team, auth.coach, leagueAliases(seasons))) return fail(403, "This is not your team: only its coach and the league organisers can see its redraft.");
    const state = source.redraft;
    const target = redraftTarget(seasons, source);
    const view = (): CoachRedraftView => coachView(lg.id, state, ctx, target, nowDate);
    if (read) return res(200, { redraft: view() });
    const stale = checkRevision(input, state.revision, deps.ifMatch);
    if (stale) return stale;
    if (state.closedAt) return fail(409, "The redraft is closed.");
    if (ctx.task.status !== "pending") {
      const why = ctx.task.status === "submitted" ? "This team's draft list is already submitted."
        : ctx.task.status === "expired" ? `This redraft expired: ${ctx.task.expiredReason ?? "the next season moved on."}` : "This team was taken out of the redraft.";
      return fail(409, why);
    }
    const zone = leagueTimeZone(lg);
    // The redraft window gate, read directly (never only through the window it projects): shut = the window is not open.
    const windowShut = gateBlock(deps.store, lg, "redraft-window", "league", nowDate);
    if (windowShut) return windowShut;
    if (windowBefore(state.window, nowDate)) {
      return fail(409, `The redraft opens at ${whenText(state.window!.opensAt, zone)}.`, {
        code: "gate-shut", gate: { id: "redraft-window:league", kind: "redraft-window", target: "league", label: "Redraft window", opensAt: state.window!.opensAt, secondsLeft: Math.max(0, Math.ceil((Date.parse(state.window!.opensAt) - nowDate.getTime()) / 1000)) },
      });
    }
    // Gates (gates.ts): rest rolls and submissions each wait for their own "Opens at" (a league night, say).
    const shut = gateBlock(deps.store, lg, action === "rest" ? "redraft-rest" : "redraft-submit", "league", nowDate);
    if (shut) return shut;
    const now = nowDate.toISOString();

    if (action === "rest") {
      if (ctx.task.rest) return fail(409, "Rest & Relaxation is already rolled for this team.");
      const mode = input.mode;
      if (mode !== "site" && mode !== "entered") throw new RedraftError(400, 'mode must be "site" or "entered".', "mode");
      const entered = input.rolls && typeof input.rolls === "object" && !Array.isArray(input.rolls) ? (input.rolls as Record<string, unknown>) : {};
      const rolls = restAndRelaxation(ctx.team, mode, entered, deps.rollD6);
      ctx.task.rest = { at: now, by: auth.coach, rolls };
      state.revision += 1;
      deps.store.putSeason(source);
      // Discord "Redraft rolls" (off by default): each roll with its player and outcome.
      if (rolls.length) {
        const name = (id: string): string => { const p = ctx.team.players.find((x) => x.playerId === id); return p ? (p.name || p.position) : "A player"; };
        const lines = rolls.map((r) => `${name(r.playerId)}: rolled ${r.roll} (needs ${r.target}+), ${r.recovered ? "niggling injury healed" : "niggling injury stays"}`);
        await postLeagueEvent(deps.store, lg, "redraftRolls", buildRedraftPost(lg, `${ctx.team.name} Rest & Relaxation`, `${lines.join("\n")}${mode === "entered" ? "\n(tabletop rolls)" : ""}`), deps.postWebhook);
      }
      return res(200, { ok: true, redraft: view() });
    }

    // submit
    if (!ctx.task.rest && ctx.team.players.some((p) => (p.niggling | 0) > 0)) return fail(409, "Roll Rest & Relaxation first.");
    const draftInput = parseDraftInput(input);
    // The next season may have moved on since the board was confirmed: commitDraft re-checks it inside this write.
    const done = commitDraft(seasons, lg.id, source, ctx, draftInput, auth.coach, now);
    state.revision += 1;
    if (!done.ok) {
      deps.store.putSeason(source);
      return fail(409, `This redraft expired: ${done.conflict}`, { revision: state.revision });
    }
    if (done.target) deps.store.putSeason(done.target);
    deps.store.putSeason(source);
    // The team's own season (an inactive team drafts from an earlier one) holds the teamUid minted at the redraft.
    if (ctx.source.id !== source.id) deps.store.putSeason(ctx.source);
    notifyAll(deps, organisersOf(lg).filter((c) => !sameCoach(c, auth.coach)).map((coach) => ({
      coach, input: { type: "league-broadcast", title: "Redraft submitted", body: `${lg.name}: ${done.text}`, link: redraftLink(lg.id), from: auth.coach },
    })));
    await discord(lg, deps, "news", buildRedraftPost(lg, `${ctx.team.name} redrafted`, done.text));
    return res(200, { ok: true, redraft: view() });
  } catch (e) {
    if (e instanceof RedraftError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    return fail(500, "Could not save the redraft right now.");
  }
}

const pickId = (v: unknown, field: string): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new RedraftError(400, `${field} must be a season id.`, field);
  return v;
};

async function boardPost(lg: LeagueRecord, auth: LeagueApiIdentity, input: Record<string, unknown>, seasons: SeasonRecord[], deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const sourcePick = pickId(input.sourceSeasonId, "sourceSeasonId");
  const source = redraftSource(seasons, sourcePick);
  if (sourcePick && !source) return fail(400, "Pick a finished season to redraft from.", { field: "sourceSeasonId" });
  if (!source) return fail(409, "Finish a season first: a redraft runs between seasons.");
  const stale = checkRevision(input, source.redraft?.revision ?? 0, deps.ifMatch);
  if (stale) return stale;
  const nowDate = deps.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const action = input.action;
  const view = (): RedraftBoardView => boardView(deps.store.league(lg.id) ?? lg, seasons, {}, nowDate);

  if (action === "confirm") {
    if (source.redraft) return fail(409, `A redraft from ${source.name} has already been confirmed.`);
    const open = seasons.find((s) => s.id !== source.id && s.redraft && !s.redraft.closedAt);
    if (open) return fail(409, `Close the redraft from ${open.name} first.`);
    const targetPick = pickId(input.targetSeasonId, "targetSeasonId");
    const target = redraftTarget(seasons, source, targetPick);
    if (targetPick && !target) return fail(400, `Pick a season after ${source.name} to receive the draft lists.`, { field: "targetSeasonId" });
    if (target && target.fixtures.some((f) => f.home.score !== null && f.away.score !== null))
      return fail(409, `${target.name} already has results: a redraft happens between seasons.`);
    // The board was read against one version of the league's redraft settings: a save since then (another tab, another
    // organiser) must not be confirmed with the stale formula.
    if (input.settingsRevision !== undefined && input.settingsRevision !== (lg.revision ?? 0))
      return fail(409, "The league's redraft settings changed since you opened the board. Reload to see the latest.", { settingsRevision: lg.revision ?? 0 });
    if (typeof input.capEnabled !== "boolean") throw new RedraftError(400, "capEnabled must be true or false.", "capEnabled");
    const settings = effectiveRedraftRules(lg);
    const capAmount = input.cap === undefined ? settings.cap : input.cap;
    if (typeof capAmount !== "number" || !Number.isInteger(capAmount) || capAmount < 0 || capAmount > OVERRIDE_MAX)
      throw new RedraftError(400, "cap must be a whole number of gold.", "cap");
    const cap = { enabled: input.capEnabled, cap: capAmount };
    let opensAt: string | undefined;
    const zone = leagueTimeZone(lg);
    if (input.opensAtWall !== undefined && input.opensAtWall !== null && input.opensAtWall !== "") {
      // The board's "Opens at": a wall-clock time in the league's zone (never the organiser's browser zone).
      const wall = parseWall(input.opensAtWall);
      if (!wall) throw new RedraftError(400, "Opens at must be a date and time (2026-11-09T18:00).", "opensAtWall");
      opensAt = new Date(wallInstant(wall, zone)).toISOString();
    } else if (input.opensAt !== undefined && input.opensAt !== null && input.opensAt !== "") {
      opensAt = parseInstant(input.opensAt);
      if (!opensAt) throw new RedraftError(400, "Opens at must be a date and time with a timezone.", "opensAt");
    }
    if (opensAt) {
      if (Date.parse(opensAt) > nowDate.getTime() + 365 * 24 * 60 * 60 * 1000) throw new RedraftError(400, "Opens at must be within a year.", "opensAt");
      // A time in the past opens it now.
      if (Date.parse(opensAt) < nowDate.getTime()) opensAt = undefined;
    }
    // The redraft window gate (gates.ts), while shut, decides when the window opens (and moves it with its League Event).
    const windowGate = gateRefusal(deps.store, lg, "redraft-window", "league", nowDate);
    if (windowGate) {
      if (!windowGate.gate?.opensAt) return fail(409, "The redraft window gate has no time yet: pick one (or open it) before you confirm.", { code: "gate-shut", gate: windowGate.gate });
      opensAt = windowGate.gate.opensAt;
    }
    let days = settings.windowDays;
    if (input.windowDays !== undefined) {
      const d = input.windowDays;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > WINDOW_DAYS_MAX) throw new RedraftError(400, `The redraft window must be 1 to ${WINDOW_DAYS_MAX} days.`, "windowDays");
      days = d;
    }
    const rules: RedraftRules = { ...settings, capEnabled: cap.enabled, cap: cap.cap, windowDays: days };
    if (!Array.isArray(input.teams)) throw new RedraftError(400, "teams must be a list.", "teams");
    const { active, inactive } = redraftBoard(seasons, source, undefined, rules, target ?? null);
    const rows = new Map([...active, ...inactive].map((r) => [r.teamId, r]));
    const picks = new Map<string, { selected: boolean; override?: { budget: number; reason: string } }>();
    for (const [i, raw] of (input.teams as unknown[]).entries()) {
      if (!raw || typeof raw !== "object") throw new RedraftError(400, "Each team needs a teamId.", `teams[${i}]`);
      const r = raw as Record<string, unknown>;
      if (typeof r.teamId !== "string" || !rows.has(r.teamId)) throw new RedraftError(400, "Unknown team in the redraft list.", `teams[${i}].teamId`);
      if (picks.has(r.teamId)) throw new RedraftError(400, "A team is listed twice.", `teams[${i}].teamId`);
      if (typeof r.selected !== "boolean") throw new RedraftError(400, "selected must be true or false.", `teams[${i}].selected`);
      picks.set(r.teamId, { selected: r.selected, ...(r.override !== undefined && r.override !== null ? { override: parseOverride(r.override) } : {}) });
    }
    const chosen = [...picks.values()].filter((p) => p.selected).length;
    if (!chosen) throw new RedraftError(400, "Select at least one team for the redraft.", "teams");
    const teams: RedraftTeamTask[] = [...rows.values()].map((row) => {
      const pick = picks.get(row.teamId);
      const selected = pick?.selected ?? false;
      return {
        teamId: row.teamId, sourceSeasonId: row.sourceSeasonId, name: row.name, coach: row.coach, ...(row.coachId ? { coachId: row.coachId } : {}), race: row.race,
        selected, budget: row.budget, status: selected ? "pending" : "skipped",
        ...(selected && pick?.override ? { override: { ...pick.override, by: auth.coach, at: now } } : {}),
      };
    });
    const window = newWindow(nowDate, opensAt, days);
    const text = `${auth.coach} started the redraft from ${source.name}${targetPick && target ? ` into ${target.name}` : ""}: ${chosen} team${chosen === 1 ? "" : "s"} selected${cap.enabled ? `, budgets capped at ${gold(cap.cap)}` : ", no budget cap"}. The window runs from ${whenText(window.opensAt, zone)} to ${whenText(window.closesAt, zone)}.`;
    const state: RedraftState = {
      startedAt: now, byCoach: auth.coach, capEnabled: cap.enabled, cap: cap.cap, revision: 1, teams, log: [{ at: now, by: auth.coach, text }],
      // Every resolved target is bound now: starting another season later never redirects this redraft.
      ...(target ? { targetSeasonId: target.id } : {}),
      rules, window,
    };
    // Lift teams to the budget (league setting): every selected team below the set budget, logged per team.
    if (rules.liftToBudget) for (const t of teams) if (t.selected && t.status === "pending") liftTask(state, t, rules.setBudget, auth.coach, now, true);
    const openNow = Date.parse(window.opensAt) <= nowDate.getTime();
    if (openNow) window.openNotifiedAt = now;
    source.redraft = state;
    deps.store.putSeason(source);
    // The cap picked here is this redraft's (snapshot above); the league's saved settings are left as they are. The old
    // remembered cap is kept for leagues that never saved one (it sits under redraftRules in effectiveRedraftRules).
    deps.store.updateLeague(lg.id, (l) => { l.redraftCap = cap; });
    // Coaches are told now when the window is open; otherwise the window job tells them when it opens.
    if (openNow) {
      notifyAll(deps, teams.filter((t) => t.selected && t.coachId).map((t) => ({
        coach: t.coachId!, input: {
          type: "league-broadcast" as const, title: "Redraft: build next season's roster",
          body: `${lg.name}: ${t.name} is in the redraft with a budget of ${gold(spendable(t))}, until ${whenText(window.closesAt, zone)}. Roll Rest & Relaxation, re-hire players and staff in the Roster Builder, then submit your draft list.`,
          link: redraftLink(lg.id, t.teamId), from: auth.coach, action: true,
        },
      })));
    }
    await discord(lg, deps, "milestones", buildRedraftPost(lg, "Redraft started", text));
    return res(200, { ok: true, redraft: view() });
  }

  const state = source.redraft;
  if (!state) return fail(409, "Confirm the redraft first.");
  if (state.closedAt) return fail(409, "The redraft is closed.");

  if (action === "team") {
    const task = state.teams.find((t) => t.teamId === input.teamId && t.selected);
    if (!task) return fail(404, "That team is not in the redraft.", { field: "teamId" });
    if (task.status !== "pending") return fail(409, "Only a team still drafting can be changed.");
    let text: string;
    let notice: NotificationInput | undefined;
    if (input.skip === true) {
      task.status = "skipped";
      delete task.needsRedraft;
      text = `${auth.coach} took ${task.name} out of the redraft.`;
    } else if (input.override === null) {
      delete task.override;
      text = `${auth.coach} removed the budget override of ${task.name} (budget ${gold(spendable(task))}).`;
      notice = { type: "league-broadcast", title: "Redraft budget changed", body: `${lg.name}: ${task.name}'s redraft budget is back to ${gold(spendable(task))}.`, link: redraftLink(lg.id, task.teamId), from: auth.coach };
    } else if (input.override !== undefined) {
      const o = parseOverride(input.override);
      task.override = { ...o, by: auth.coach, at: now };
      text = `${auth.coach} set ${task.name}'s budget to ${gold(o.budget)}: ${o.reason}`;
      notice = { type: "league-broadcast", title: "Redraft budget changed", body: `${lg.name}: ${task.name}'s redraft budget is now ${gold(o.budget)} (${o.reason}).`, link: redraftLink(lg.id, task.teamId), from: auth.coach };
    } else throw new RedraftError(400, "Send override (or null) or skip.", "override");
    state.log.unshift({ at: now, by: auth.coach, text, teamId: task.teamId });
    state.revision += 1;
    deps.store.putSeason(source);
    if (notice && task.coachId && !sameCoach(task.coachId, auth.coach)) notifyAll(deps, [{ coach: task.coachId, input: notice }]);
    return res(200, { ok: true, redraft: view() });
  }

  if (action === "lift") {
    const setBudget = stateRules(state).setBudget;
    let targets: RedraftTeamTask[];
    if (input.all === true) targets = state.teams.filter((t) => t.selected && t.status === "pending");
    else {
      const task = state.teams.find((t) => t.teamId === input.teamId && t.selected);
      if (!task) return fail(404, "That team is not in the redraft.", { field: "teamId" });
      if (task.status !== "pending") return fail(409, "Only a team still drafting can be lifted.");
      if (!liftApplies(task, setBudget)) return fail(409, task.override ? `${task.name} has a budget override: clear it first.` : `${task.name} already has at least the set budget of ${gold(setBudget)}.`);
      targets = [task];
    }
    const lifted = targets.filter((t) => liftTask(state, t, setBudget, auth.coach, now, false));
    if (!lifted.length) return fail(409, `No team still drafting is below the set budget of ${gold(setBudget)}.`);
    state.revision += 1;
    deps.store.putSeason(source);
    notifyAll(deps, lifted.filter((t) => t.coachId && !sameCoach(t.coachId, auth.coach)).map((t) => ({
      coach: t.coachId!, input: { type: "league-broadcast" as const, title: "Redraft budget lifted", body: `${lg.name}: ${t.name}'s redraft budget was lifted to the set budget of ${gold(setBudget)}.`, link: redraftLink(lg.id, t.teamId), from: auth.coach },
    })));
    return res(200, { ok: true, redraft: view() });
  }

  if (action === "close") {
    // The window close may still be writing rebuilt rosters into the next season (the job resumes each minute).
    if (state.teams.some((t) => applyingRebuild(state, t)))
      return fail(409, "The window close is still writing rebuilt rosters into the next season. Try Close redraft again in a minute.");
    const left = state.teams.filter((t) => t.selected && t.status === "pending");
    for (const t of left) { t.status = "skipped"; delete t.needsRedraft; }
    const done = state.teams.filter((t) => t.status === "submitted").length;
    const text = `${auth.coach} closed the redraft: ${done} draft list${done === 1 ? "" : "s"} submitted${left.length ? `, ${left.length} team${left.length === 1 ? "" : "s"} did not redraft` : ""}.`;
    state.closedAt = now;
    state.closedBy = auth.coach;
    state.log.unshift({ at: now, by: auth.coach, text });
    state.revision += 1;
    deps.store.putSeason(source);
    await discord(lg, deps, "milestones", buildRedraftPost(lg, "Redraft closed", text));
    return res(200, { ok: true, redraft: view() });
  }
  throw new RedraftError(400, 'action must be "confirm", "team", "lift" or "close".', "action");
}

// ---- the team summary's redraft budget ----

export interface TeamRedraftBudgetView {
  teamId: string;
  teamName: string;
  seasonId: string;
  seasonName: string;
  record: { played: number; wins: number; draws: number; losses: number };
  /** The league's formula (Lift teams to the budget included). */
  rules: Pick<RedraftRules, "base" | "perGame" | "perWin" | "perDraw" | "perLoss" | "capEnabled" | "cap" | "setBudget" | "liftToBudget">;
  /** The budget if the redraft ran from this season now. */
  budget: RedraftBudget;
  earned: number;
  setBudget: number;
  /** The team earned less than the set budget: a lift would raise it (automatically when liftToBudget is on). */
  liftWouldApply: boolean;
  /** max(earned, set budget) when Lift teams to the budget is on, else earned. */
  expected: number;
  /** The open redraft task: only for the team's coach and the league's organisers. */
  redraft: null | {
    phase: string; spendable: number; override: RedraftTeamTask["override"] | null; lift: RedraftTeamTask["lift"] | null;
    window: RedraftWindow | null; history: RedraftLogEntry[]; link: string;
  };
}

/** GET .../seasons/:seasonId/teams/:teamId/redraft-budget (undefined when the path is not this route). */
export function teamRedraftBudgetRoute(method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): LeagueApiResult | undefined {
  const [first, seasonId, third, teamId, fifth, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "teams" || !teamId || fifth !== "redraft-budget" || more.length) return undefined;
  if (method !== "GET" && method !== "HEAD") return fail(405, "Use GET.");
  if (!league) return fail(404, "League not found.");
  const seasons = loadSeasons(deps.store, league.id);
  const season = seasons.find((s) => s.id === seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const rules = effectiveRedraftRules(league);
  const rec = teamRecord(season, team);
  const budget = redraftBudget({ base: budgetBase(rules, season, team.race), treasury: team.treasury ?? 0, ...rec }, { enabled: rules.capEnabled, cap: rules.cap }, amountsOf(rules));
  const earnedNow = budget.capped;
  const liftWouldApply = earnedNow < rules.setBudget;
  let redraft: TeamRedraftBudgetView["redraft"] = null;
  // The open task belongs to the team's CURRENT coach: authorise against the roster the task was made from (as the coach
  // routes do), never against the requested season's team (a former coach of an older season must not read it).
  const open = seasons.find((s) => s.redraft && !s.redraft.closedAt && s.redraft.teams.some((t) => t.teamId === team.id && t.selected));
  const ctx = open ? draftContext(seasons, open, team.id) : undefined;
  const mine = Boolean(auth && ctx && (isManager(league, auth) || coachOwnsTeam(ctx.team, auth.coach, leagueAliases(seasons))));
  if (mine && open && ctx) {
    const task = ctx.task;
    {
      redraft = {
        phase: redraftPhase(task), spendable: spendable(task), override: task.override ?? null, lift: task.lift ?? null, window: open.redraft!.window ?? null,
        history: open.redraft!.log.filter((l) => l.teamId === team.id).slice(0, 20), link: redraftLink(league.id, team.id),
      };
    }
  }
  const view: TeamRedraftBudgetView = {
    teamId: team.id, teamName: team.name, seasonId: season.id, seasonName: season.name, record: rec,
    rules: { base: rules.base, perGame: rules.perGame, perWin: rules.perWin, perDraw: rules.perDraw, perLoss: rules.perLoss, capEnabled: rules.capEnabled, cap: rules.cap, setBudget: rules.setBudget, liftToBudget: rules.liftToBudget },
    budget, earned: earnedNow, setBudget: rules.setBudget, liftWouldApply, expected: rules.liftToBudget ? Math.max(earnedNow, rules.setBudget) : earnedNow, redraft,
  };
  return res(200, { budget: view }, mine ? { "cache-control": "private, no-store" } : {});
}

export interface MyRedraftTask {
  leagueId: string;
  leagueName: string;
  teamId: string;
  teamName: string;
  race: string;
  status: RedraftTeamTask["status"];
  spendable: number;
  link: string;
  /** not started / in progress / submitted / needs redraft / expired (redraftPhase). */
  phase?: string;
  closesAt?: string;
}

/** Open redraft tasks (pending, submitted or expired; redraft not closed) of this coach across every league. */
export function myRedraftTasks(store: LeagueStore, coach: string): MyRedraftTask[] {
  const out: MyRedraftTask[] = [];
  for (const lg of publishedLeagues(store.list())) {
    const seasons = store.seasons(lg.id);
    const source = redraftSource(seasons);
    const state = source?.redraft;
    if (!state || state.closedAt) continue;
    const aliases = leagueAliases(seasons);
    for (const t of state.teams) {
      if (!t.selected || t.status === "skipped") continue;
      const team = seasons.find((s) => s.id === t.sourceSeasonId)?.teams.find((x) => x.id === t.teamId) ?? t;
      if (!coachOwnsTeam(team, coach, aliases)) continue;
      out.push({
        leagueId: lg.id, leagueName: lg.name, teamId: t.teamId, teamName: t.name, race: t.race, status: t.status, spendable: spendable(t), link: redraftLink(lg.id, t.teamId),
        phase: redraftPhase(t), ...(state.window ? { closesAt: state.window.closesAt } : {}),
      });
    }
  }
  return out;
}
