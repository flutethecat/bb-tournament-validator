/**
 * Redraft routes (session-gated; anonymous 401; organiser writes revision-checked like the settings PATCH: no revision
 * 428, an older one 409). Rules and maths: redraft.ts.
 *
 *   GET  /api/leagues/:id/redraft                              organiser board (active + inactive teams, budgets, tasks)
 *   POST /api/leagues/:id/redraft                              { revision, action: "confirm", capEnabled, cap, teams: [{ teamId, selected, override? }] }
 *                                                              { revision, action: "team", teamId, override: { budget, reason } | null } | { ..., skip: true }
 *                                                              { revision, action: "close" }
 *   GET  /api/leagues/:id/redraft/teams/:teamId                the team's coach or an organiser: the coach's redraft view
 *   POST /api/leagues/:id/redraft/teams/:teamId/rest           { revision, mode: "site" | "entered", rolls?: { [playerId]: number[] } }
 *   POST /api/leagues/:id/redraft/teams/:teamId/submit         { revision, keep: playerId[], hires: [{ position, count }], staff }
 *   GET  /api/leagues?redraft=mine                             the signed-in coach's open redraft tasks (team management page)
 */
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { buildRedraftPost, discordEvents, postWebhook as defaultPoster, type DiscordPayload } from "./discord.js";
import { readJsonObject, requestRevision } from "./http.js";
import { assignSeasonsPlayed, teamPlayedIn } from "./playerIds.js";
import {
  applyDraftTeam, buildDraftTeam, coachOwnsTeam, coachView, leagueAliases, targetConflict, DEFAULT_CAP, datasetRoster, draftList, gold, leaguePlayerIds, OVERRIDE_MAX, parseDraftInput,
  redraftBoard, RedraftError, redraftSource, redraftTarget, restAndRelaxation, sameCoach, spendable, validateDraft, type BoardRow, type DraftContext,
} from "./redraft.js";
import { isLeagueOrganiser, leagueOwner, type LeagueStore } from "./store.js";
import type { LeagueRecord, RedraftState, RedraftTeamTask, SeasonRecord } from "./types.js";

export const REDRAFT_MAX_BYTES = 64 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const res = (status: number, body: unknown, headers: Record<string, string> = {}): LeagueApiResult => ({ status, body, headers: { ...NO_STORE, ...headers } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

export const redraftLink = (leagueId: string, teamId?: string): string =>
  `/app/leagues/${encodeURIComponent(leagueId)}/redraft${teamId ? `?team=${encodeURIComponent(teamId)}` : ""}`;

/** The league's seasons, newest first, with seasonsPlayed derived when a stored season predates the field. */
function loadSeasons(store: LeagueStore, leagueId: string): SeasonRecord[] {
  const seasons = store.seasons(leagueId);
  if (seasons.some((s) => s.teams.some((t) => t.players.some((p) => p.seasonsPlayed === undefined)))) assignSeasonsPlayed(seasons);
  return seasons;
}

const isManager = (league: LeagueRecord, auth: LeagueApiIdentity): boolean => auth.admin || isLeagueOrganiser(league, auth.coach);
const capOf = (league: LeagueRecord): { enabled: boolean; cap: number } => league.redraftCap ?? { enabled: true, cap: DEFAULT_CAP };

export interface RedraftBoardView {
  leagueId: string;
  leagueName: string;
  revision: number;
  source: { id: string; name: string; number: number; ruleset: string } | null;
  target: { id: string; name: string } | null;
  state: Omit<RedraftState, "teams"> | null;
  capEnabled: boolean;
  cap: number;
  active: BoardRow[];
  inactive: BoardRow[];
  note: string;
}

function boardView(league: LeagueRecord, seasons: SeasonRecord[]): RedraftBoardView {
  const source = redraftSource(seasons);
  const cap = capOf(league);
  if (!source) {
    return {
      leagueId: league.id, leagueName: league.name, revision: 0, source: null, target: null, state: null, capEnabled: cap.enabled, cap: cap.cap,
      active: [], inactive: [], note: "Finish a season first: a redraft runs between seasons.",
    };
  }
  const target = redraftTarget(seasons, source);
  const state = source.redraft;
  const { active, inactive } = redraftBoard(seasons, source, state, cap);
  const { teams: _t, ...meta } = state ?? ({} as RedraftState);
  return {
    leagueId: league.id, leagueName: league.name, revision: state?.revision ?? 0,
    source: { id: source.id, name: source.name, number: source.number, ruleset: source.ruleset },
    target: target ? { id: target.id, name: target.name } : null,
    state: state ? meta : null,
    capEnabled: state?.capEnabled ?? cap.enabled, cap: state?.cap ?? cap.cap,
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
  const url = deps.store.secrets(league.id).discordWebhookUrl;
  if (!url || !discordEvents(league)[key]) return;
  try { await (deps.postWebhook ?? defaultPoster)(url, payload); } catch { /* best effort; the URL is never logged */ }
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

/** The open task, its team and roster for the coach routes. */
function draftContext(seasons: SeasonRecord[], source: SeasonRecord, teamId: string): DraftContext | undefined {
  const task = source.redraft?.teams.find((t) => t.teamId === teamId && t.selected);
  if (!task) return undefined;
  const from = seasons.find((s) => s.id === task.sourceSeasonId);
  const team = from?.teams.find((t) => t.id === teamId);
  if (!from || !team) return undefined;
  return { task, source: from, team, roster: datasetRoster(team.race), teamPlayed: teamPlayedIn(from, team) };
}

export async function redraftRoutes(
  method: string,
  rest: string[],
  league: LeagueRecord | undefined,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
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
  try {
    if (board) {
      if (!isManager(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins run the redraft.");
      const seasons = loadSeasons(deps.store, lg.id);
      if (read) return res(200, { redraft: boardView(lg, seasons) });
      return await boardPost(lg, auth, input, seasons, deps);
    }
    const seasons = loadSeasons(deps.store, lg.id);
    const source = redraftSource(seasons);
    const ctx = source ? draftContext(seasons, source, teamId!) : undefined;
    if (!source || !source.redraft || !ctx) return fail(404, "No redraft for this team.");
    if (!isManager(lg, auth) && !coachOwnsTeam(ctx.team, auth.coach, leagueAliases(seasons))) return fail(403, "This is not your team: only its coach and the league organisers can see its redraft.");
    const state = source.redraft;
    const target = redraftTarget(seasons, source);
    if (read) return res(200, { redraft: coachView(lg.id, state, ctx, target) });
    const stale = checkRevision(input, state.revision, deps.ifMatch);
    if (stale) return stale;
    if (state.closedAt) return fail(409, "The redraft is closed.");
    if (ctx.task.status !== "pending") {
      const why = ctx.task.status === "submitted" ? "This team's draft list is already submitted."
        : ctx.task.status === "expired" ? `This redraft expired: ${ctx.task.expiredReason ?? "the next season moved on."}` : "This team was taken out of the redraft.";
      return fail(409, why);
    }
    const now = (deps.now?.() ?? new Date()).toISOString();

    if (action === "rest") {
      if (ctx.task.rest) return fail(409, "Rest & Relaxation is already rolled for this team.");
      const mode = input.mode;
      if (mode !== "site" && mode !== "entered") throw new RedraftError(400, 'mode must be "site" or "entered".', "mode");
      const entered = input.rolls && typeof input.rolls === "object" && !Array.isArray(input.rolls) ? (input.rolls as Record<string, unknown>) : {};
      const rolls = restAndRelaxation(ctx.team, mode, entered, deps.rollD6);
      ctx.task.rest = { at: now, by: auth.coach, rolls };
      state.revision += 1;
      deps.store.putSeason(source);
      return res(200, { ok: true, redraft: coachView(lg.id, state, ctx, target) });
    }

    // submit
    if (!ctx.task.rest && ctx.team.players.some((p) => (p.niggling | 0) > 0)) return fail(409, "Roll Rest & Relaxation first.");
    const draftInput = parseDraftInput(input);
    const price = validateDraft(ctx, draftInput);
    // The next season may have moved on since the board was confirmed: re-check it inside this read-modify-write.
    const conflict = target ? targetConflict(target, ctx.team) : "";
    if (conflict) {
      ctx.task.status = "expired";
      ctx.task.expiredReason = conflict;
      state.log.unshift({ at: now, by: auth.coach, text: `${ctx.team.name}'s redraft expired: ${conflict}` });
      state.revision += 1;
      deps.store.putSeason(source);
      return fail(409, `This redraft expired: ${conflict}`, { revision: state.revision });
    }
    const used = leaguePlayerIds(seasons);
    const newTeam = buildDraftTeam(ctx, price, draftInput, { leagueId: lg.id, slug: target?.sourceSlug ?? `redraft:${source.id}` }, used);
    ctx.task.draft = draftList(price, draftInput, newTeam);
    ctx.task.status = "submitted";
    ctx.task.submittedAt = now;
    ctx.task.submittedBy = auth.coach;
    if (target) {
      applyDraftTeam(target, newTeam);
      ctx.task.appliedTo = target.id;
    }
    const retired = ctx.team.players.length - price.keep.length;
    const text = `${ctx.team.name} (${ctx.team.coach}) submitted a draft list: ${price.players} players, ${gold(price.spent)} spent, ${gold(price.remaining)} to the treasury${retired ? `, ${retired} retired` : ""}.`;
    state.log.unshift({ at: now, by: auth.coach, text });
    state.revision += 1;
    if (target) deps.store.putSeason(target);
    deps.store.putSeason(source);
    notifyAll(deps, organisersOf(lg).filter((c) => !sameCoach(c, auth.coach)).map((coach) => ({
      coach, input: { type: "league-broadcast", title: "Redraft submitted", body: `${lg.name}: ${text}`, link: redraftLink(lg.id), from: auth.coach },
    })));
    await discord(lg, deps, "news", buildRedraftPost(lg, `${ctx.team.name} redrafted`, text));
    return res(200, { ok: true, redraft: coachView(lg.id, state, ctx, target) });
  } catch (e) {
    if (e instanceof RedraftError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    return fail(500, "Could not save the redraft right now.");
  }
}

async function boardPost(lg: LeagueRecord, auth: LeagueApiIdentity, input: Record<string, unknown>, seasons: SeasonRecord[], deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const source = redraftSource(seasons);
  if (!source) return fail(409, "Finish a season first: a redraft runs between seasons.");
  const stale = checkRevision(input, source.redraft?.revision ?? 0, deps.ifMatch);
  if (stale) return stale;
  const now = (deps.now?.() ?? new Date()).toISOString();
  const action = input.action;

  if (action === "confirm") {
    if (source.redraft) return fail(409, `A redraft from ${source.name} has already been confirmed.`);
    const target = redraftTarget(seasons, source);
    if (target && target.fixtures.some((f) => f.home.score !== null && f.away.score !== null))
      return fail(409, `${target.name} already has results: a redraft happens between seasons.`);
    if (typeof input.capEnabled !== "boolean") throw new RedraftError(400, "capEnabled must be true or false.", "capEnabled");
    const capAmount = input.cap === undefined ? DEFAULT_CAP : input.cap;
    if (typeof capAmount !== "number" || !Number.isInteger(capAmount) || capAmount < 0 || capAmount > OVERRIDE_MAX)
      throw new RedraftError(400, "cap must be a whole number of gold.", "cap");
    const cap = { enabled: input.capEnabled, cap: capAmount };
    if (!Array.isArray(input.teams)) throw new RedraftError(400, "teams must be a list.", "teams");
    const { active, inactive } = redraftBoard(seasons, source, undefined, cap);
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
    const text = `${auth.coach} started the redraft from ${source.name}: ${chosen} team${chosen === 1 ? "" : "s"} selected${cap.enabled ? `, budgets capped at ${gold(cap.cap)}` : ", no budget cap"}.`;
    source.redraft = { startedAt: now, byCoach: auth.coach, capEnabled: cap.enabled, cap: cap.cap, revision: 1, teams, log: [{ at: now, by: auth.coach, text }] };
    deps.store.putSeason(source);
    deps.store.updateLeague(lg.id, (l) => { l.redraftCap = cap; });
    const coachNotices = teams.filter((t) => t.selected && t.coachId).map((t) => ({
      coach: t.coachId!, input: {
        type: "league-broadcast" as const, title: "Redraft: build next season's roster",
        body: `${lg.name}: ${t.name} is in the redraft with a budget of ${gold(spendable(t))}. Roll Rest & Relaxation, re-hire players and staff, then submit your draft list.`,
        link: redraftLink(lg.id, t.teamId), from: auth.coach,
      },
    }));
    notifyAll(deps, coachNotices);
    await discord(lg, deps, "milestones", buildRedraftPost(lg, "Redraft started", text));
    return res(200, { ok: true, redraft: boardView(deps.store.league(lg.id) ?? lg, seasons) });
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
    state.log.unshift({ at: now, by: auth.coach, text });
    state.revision += 1;
    deps.store.putSeason(source);
    if (notice && task.coachId && !sameCoach(task.coachId, auth.coach)) notifyAll(deps, [{ coach: task.coachId, input: notice }]);
    return res(200, { ok: true, redraft: boardView(lg, seasons) });
  }

  if (action === "close") {
    const left = state.teams.filter((t) => t.selected && t.status === "pending");
    for (const t of left) t.status = "skipped";
    const done = state.teams.filter((t) => t.status === "submitted").length;
    const text = `${auth.coach} closed the redraft: ${done} draft list${done === 1 ? "" : "s"} submitted${left.length ? `, ${left.length} team${left.length === 1 ? "" : "s"} did not redraft` : ""}.`;
    state.closedAt = now;
    state.closedBy = auth.coach;
    state.log.unshift({ at: now, by: auth.coach, text });
    state.revision += 1;
    deps.store.putSeason(source);
    await discord(lg, deps, "milestones", buildRedraftPost(lg, "Redraft closed", text));
    return res(200, { ok: true, redraft: boardView(lg, seasons) });
  }
  throw new RedraftError(400, 'action must be "confirm", "team" or "close".', "action");
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
}

/** Open redraft tasks (pending, submitted or expired; redraft not closed) of this coach across every league. */
export function myRedraftTasks(store: LeagueStore, coach: string): MyRedraftTask[] {
  const out: MyRedraftTask[] = [];
  for (const lg of store.list()) {
    const seasons = store.seasons(lg.id);
    const source = redraftSource(seasons);
    const state = source?.redraft;
    if (!state || state.closedAt) continue;
    const aliases = leagueAliases(seasons);
    for (const t of state.teams) {
      if (!t.selected || t.status === "skipped") continue;
      const team = seasons.find((s) => s.id === t.sourceSeasonId)?.teams.find((x) => x.id === t.teamId) ?? t;
      if (!coachOwnsTeam(team, coach, aliases)) continue;
      out.push({ leagueId: lg.id, leagueName: lg.name, teamId: t.teamId, teamName: t.name, race: t.race, status: t.status, spendable: spendable(t), link: redraftLink(lg.id, t.teamId) });
    }
  }
  return out;
}
