/**
 * The redraft window (owner 11-02, the gate stub until League Events ship): a redraft opens at "Opens at" (default the
 * confirm time) for N days (default 7). While it is open the redrafting teams cannot play: fixture result entry (the
 * fixtures editor, the tabletop recorder) and new fixture lobbies refuse them with a clear message (redraftPlayBlock).
 * When it closes, a team without a submitted draft list is rebuilt from its current roster when that fits the budget and
 * the rules (Rest & Relaxation rolled by the site first); otherwise it is marked "needs redraft" and stays blocked until
 * its coach submits a valid list (or an organiser takes it out / closes the redraft).
 *
 * runRedraftWindowJob runs on a server timer (server.ts, like the deadline job), never in a GET handler: coaches are told
 * when the window opens and 24 h before it closes, and the close is processed once. Each step is written to the season
 * before anyone is told, so a restart finds it done and skips it. Notifications go through the caller's notifier
 * wrapped draft-aware (a draft league tells only its organisers and site admins).
 */
import type { NotificationInput } from "../notifications.js";
import { draftAwareNotify } from "./lifecycle.js";
import {
  applyDraftTeam, buildDraftTeam, d6, draftContext, draftList, gold, leaguePlayerIds, LIMITS, RedraftError, redraftTarget, restAndRelaxation,
  targetConflict, validateDraft, type DraftContext, type DraftInput, type Roller,
} from "./redraft.js";
import { leagueOwner, type LeagueStore } from "./store.js";
import { assignSeasonsPlayed } from "./playerIds.js";
import { leagueTimeZone } from "./timeZone.js";
import { gateRefusal } from "./gates.js";
import type { LeagueRecord, RedraftState, RedraftTeamTask, RedraftWindow, SeasonRecord } from "./types.js";

/**
 * The league's seasons for redraft pricing, newest first, with seasonsPlayed derived when a stored season predates the
 * field: the coach routes and the window job price re-hires the same way (agent fee per season played).
 */
export function redraftSeasons(store: Pick<LeagueStore, "seasons">, leagueId: string): SeasonRecord[] {
  const seasons = store.seasons(leagueId);
  if (seasons.some((s) => s.teams.some((t) => t.players.some((p) => p.seasonsPlayed === undefined)))) assignSeasonsPlayed(seasons);
  return seasons;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_MS = DAY_MS;

/** Server links (the SPA base is /app/): the coach's Redraft mode in the Roster Builder, or the organiser's board. */
export const redraftModeLink = (leagueId: string, teamId: string): string =>
  `/app/tournament-team-builder/redraft/${encodeURIComponent(leagueId)}?team=${encodeURIComponent(teamId)}`;
export const redraftBoardLink = (leagueId: string): string => `/app/leagues/${encodeURIComponent(leagueId)}/settings?tab=redraft`;

/** "Nov 9, 2026, 18:00 UTC", or in the league's zone ("Nov 9, 2026, 19:00 Europe/London"; gates lane: the redraft window
 *  reads the league time zone, never the organiser's browser). */
export const whenText = (iso: string, zone = "UTC"): string => {
  const d = new Date(iso);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone })}, ${clock} ${zone === "UTC" ? "UTC" : zone.replace(/_/g, " ")}`;
};

/** The window of a redraft confirmed now: opensAt (default now) for `days` days. */
export function newWindow(now: Date, opensAt: string | undefined, days: number): RedraftWindow {
  const open = opensAt ? Date.parse(opensAt) : now.getTime();
  return { opensAt: new Date(open).toISOString(), closesAt: new Date(open + days * DAY_MS).toISOString() };
}

const t = (iso: string): number => Date.parse(iso);
export const windowOpen = (w: RedraftWindow | undefined, now: Date): boolean => Boolean(w && now.getTime() >= t(w.opensAt) && now.getTime() < t(w.closesAt));
export const windowBefore = (w: RedraftWindow | undefined, now: Date): boolean => Boolean(w && now.getTime() < t(w.opensAt));

// ---- committing a draft list (the coach's submit and the window close share it) ----

export type CommitOutcome = { ok: true; text: string } | { ok: false; conflict: string };

/**
 * Validates and writes the draft list onto the task (and into the receiving season when there is one). Mutates the
 * seasons in memory; the caller writes them. Throws a RedraftError when the list breaks a rule.
 */
export function commitDraft(
  seasons: SeasonRecord[], leagueId: string, source: SeasonRecord, ctx: DraftContext, input: DraftInput, actor: string, now: string, opts: { auto?: boolean; apply?: boolean } = {},
): CommitOutcome & { target?: SeasonRecord } {
  const state = source.redraft!;
  const price = validateDraft(ctx, input);
  const target = redraftTarget(seasons, source);
  const conflict = target ? targetConflict(target, ctx.team) : "";
  if (conflict) {
    ctx.task.status = "expired";
    ctx.task.expiredReason = conflict;
    delete ctx.task.needsRedraft;
    state.log.unshift({ at: now, by: actor, text: `${ctx.team.name}'s redraft expired: ${conflict}`, teamId: ctx.team.id });
    return { ok: false, conflict };
  }
  const newTeam = buildDraftTeam(ctx, price, input, { leagueId, slug: target?.sourceSlug ?? `redraft:${source.id}` }, leaguePlayerIds(seasons));
  ctx.task.draft = draftList(price, input, newTeam);
  ctx.task.status = "submitted";
  ctx.task.submittedAt = now;
  ctx.task.submittedBy = actor;
  delete ctx.task.needsRedraft;
  if (opts.auto) ctx.task.auto = true;
  // apply: false (the window job's journal step) leaves the list waiting on the task; the job's apply step writes it.
  if (target && opts.apply !== false) {
    applyDraftTeam(target, newTeam);
    ctx.task.appliedTo = target.id;
  }
  const retired = ctx.team.players.length - price.keep.length;
  const text = opts.auto
    ? `${ctx.team.name} (${ctx.team.coach}) was rebuilt from its current roster when the redraft window closed: ${price.players} players, ${gold(price.spent)} spent, ${gold(price.remaining)} to the treasury.`
    : `${ctx.team.name} (${ctx.team.coach}) submitted a draft list: ${price.players} players, ${gold(price.spent)} spent, ${gold(price.remaining)} to the treasury${retired ? `, ${retired} retired` : ""}.`;
  state.log.unshift({ at: now, by: actor, text, teamId: ctx.team.id });
  return { ok: true, text, ...(target ? { target } : {}) };
}

/** Every player kept, no hires, the current staff within the limits (an apothecary only where the roster allows one). */
export function currentRosterInput(ctx: DraftContext): DraftInput {
  const { team, roster } = ctx;
  return {
    keep: team.players.map((p) => p.playerId),
    hires: [],
    staff: {
      rerolls: Math.min(team.rerolls ?? 0, roster?.maxReRolls ?? 8),
      assistantCoaches: Math.min(team.assistantCoaches ?? 0, LIMITS.assistantCoaches),
      cheerleaders: Math.min(team.cheerleaders ?? 0, LIMITS.cheerleaders),
      apothecary: Boolean(team.apothecary) && (roster?.apothecaryAllowed ?? true),
    },
  };
}

// ---- the play block ----

/**
 * Why this team may not play right now ("" = it may): its league redraft window is open (every team in the redraft), or
 * the window closed and the team still needs to redraft. Teams are matched by id (fixture sides carry it), else by name.
 */
export function redraftPlayBlock(seasons: SeasonRecord[], team: { teamId?: string; team?: string }, now: Date, zone = "UTC"): string {
  const named = (team.team ?? "").trim().toLowerCase();
  for (const s of seasons) {
    const state = s.redraft;
    if (!state || !state.window) continue;
    for (const task of state.teams) {
      if (!task.selected || (task.status !== "pending" && task.status !== "submitted")) continue;
      const hit = team.teamId ? task.teamId === team.teamId : Boolean(named) && task.name.trim().toLowerCase() === named;
      if (!hit) continue;
      // A journalled rebuild whose roster is not in the receiving season yet stays blocked (also after a close), so no
      // result can reach the team before its new roster is durable.
      if (applyingRebuild(state, task)) return `${task.name}'s rebuilt roster is still being written into the next season: no games until then.`;
      if (state.closedAt) continue;
      if (windowOpen(state.window, now)) return `${task.name} is redrafting until ${whenText(state.window.closesAt, zone)}: no games while the redraft window is open.`;
      if (task.status !== "pending") continue;
      if (task.needsRedraft) return `${task.name} needs to finish its redraft before it can play.`;
      // Past the close but not processed yet (the job runs each minute): still blocked until it is rebuilt or marked.
      if (now.getTime() >= t(state.window.closesAt) && !state.window.processedAt) return `${task.name}'s redraft window has closed and is being processed: no games until then.`;
    }
  }
  return "";
}

/** A window-close rebuild journalled on the task but not yet written into the receiving season (redraftWindow job). */
export function applyingRebuild(state: Pick<RedraftState, "window">, task: Pick<RedraftTeamTask, "auto" | "status" | "draft" | "appliedTo">): boolean {
  return Boolean(task.auto && task.status === "submitted" && task.draft && !task.appliedTo && state.window?.closing && !state.window.processedAt);
}

/** The block for either side of a fixture ("" = both may play). */
export function fixtureRedraftBlock(seasons: SeasonRecord[], f: { home: { teamId?: string; team: string }; away: { teamId?: string; team: string } }, now: Date, zone = "UTC"): string {
  return redraftPlayBlock(seasons, f.home, now, zone) || redraftPlayBlock(seasons, f.away, now, zone);
}

// ---- the job ----

export interface RedraftWindowDeps {
  store: LeagueStore;
  notify?: (coach: string, input: NotificationInput) => void;
  /** Site admins (a draft league's notices reach only its organisers and admins). */
  isAdmin?: (coach: string) => boolean;
  now?: () => Date;
  rollD6?: Roller;
}

export interface RedraftWindowOutcome {
  opened: string[];
  reminded: string[];
  closed: Array<{ leagueId: string; seasonId: string; rebuilt: string[]; needsRedraft: string[] }>;
  /** Leagues whose tick stopped on a failed write (the next tick resumes). */
  failed: string[];
}

const organisersOf = (league: LeagueRecord): string[] => {
  const out: string[] = [];
  for (const c of [leagueOwner(league), ...league.organisers]) if (c && !out.some((o) => o.trim().toLowerCase() === c.trim().toLowerCase())) out.push(c.trim());
  return out;
};

/** Seasons with an open redraft that has a window step still to do (cheap pre-check before any write). */
function due(state: RedraftState, now: number): boolean {
  const w = state.window;
  if (!w) return false;
  // A closed redraft still finishes a journalled close (its rebuilt rosters must reach the receiving season).
  if (state.closedAt) return Boolean(w.closing && !w.processedAt);
  if (!w.openNotifiedAt && now >= t(w.opensAt)) return true;
  if (!w.reminderAt && now >= t(w.closesAt) - REMINDER_MS && now < t(w.closesAt)) return true;
  return !w.processedAt && now >= t(w.closesAt);
}

/** Thrown inside a tick when a write fails: that league's tick stops, and the next tick resumes from what is durable. */
class WriteFailed extends Error {}

/**
 * The close runs in three durable steps, so a failed write or a crash never loses a rebuild (each tick resumes):
 *   1. journal: rebuilt draft lists and needs-redraft marks are written onto the source season's tasks (window.closing
 *      set; nothing is applied to the receiving season yet);
 *   2. apply: every journalled list without appliedTo is written into the receiving season (idempotent: a roster an
 *      interrupted tick already placed is the same roster, so it is placed again unchanged);
 *   3. mark: appliedTo and window.processedAt go onto the source season only after the receiving season is durable.
 * Coaches and organisers are told after step 3, once.
 */
export function runRedraftWindowJob(deps: RedraftWindowDeps): RedraftWindowOutcome {
  const now = deps.now?.() ?? new Date();
  const ms = now.getTime();
  const iso = now.toISOString();
  const out: RedraftWindowOutcome = { opened: [], reminded: [], closed: [], failed: [] };
  for (const league of deps.store.list()) {
    if (!deps.store.seasons(league.id).some((s) => s.redraft && due(s.redraft, ms))) continue;
    const seasons = redraftSeasons(deps.store, league.id);
    const source = seasons.find((s) => s.redraft && due(s.redraft, ms));
    if (!source) continue;
    const state = source.redraft!;
    const w = state.window!;
    const zone = leagueTimeZone(league);
    // Gates (gates.ts), read directly: the window opens only once its gate is open, and the close (with its automatic rest rolls
    // and rebuilds) waits while the rest-roll or submission gate is still shut. Unreadable gates count as shut (fail closed).
    const shut = (k: "redraft-window" | "redraft-rest" | "redraft-submit"): boolean => Boolean(gateRefusal(deps.store, league, k, "league", now));
    const notices: Array<{ coach: string; input: NotificationInput }> = [];
    const pending = state.teams.filter((x) => x.selected && x.status === "pending");
    const coachNote = (coach: string | undefined, teamId: string, title: string, body: string): void => {
      if (coach) notices.push({ coach, input: { type: "league-broadcast", title, body: `${league.name}: ${body}`, link: redraftModeLink(league.id, teamId), from: league.name, action: true } });
    };
    const write = (s: SeasonRecord): void => { try { deps.store.putSeason(s); } catch { throw new WriteFailed(); } };
    try {
      let changed = false;
      const live = !state.closedAt;
      if (live && !w.openNotifiedAt && ms >= t(w.opensAt) && !shut("redraft-window")) {
        w.openNotifiedAt = iso;
        changed = true;
        for (const x of pending) coachNote(x.coachId, x.teamId, "Redraft open", `the redraft for ${x.name} is open until ${whenText(w.closesAt, zone)}. Roll Rest & Relaxation, then build next season's roster in the Roster Builder.`);
        out.opened.push(`${league.id}/${source.id}`);
      }
      if (live && !w.reminderAt && ms >= t(w.closesAt) - REMINDER_MS && ms < t(w.closesAt)) {
        w.reminderAt = iso;
        changed = true;
        for (const x of pending) coachNote(x.coachId, x.teamId, "Redraft closes in 24 hours", `${x.name}'s redraft closes at ${whenText(w.closesAt, zone)}. Submit your draft list, or the team is rebuilt from its current roster if it fits the budget.`);
        out.reminded.push(`${league.id}/${source.id}`);
      }
      const closeWaits = !w.closing && (shut("redraft-rest") || shut("redraft-submit"));
      if (!w.processedAt && ms >= t(w.closesAt) && !closeWaits) {
        // 1. journal (once): rebuild in memory without touching the receiving season, then write the source.
        if (!w.closing && live) {
          w.closing = iso;
          for (const task of pending) {
            if (task.needsRedraft) continue;
            const ctx = draftContext(seasons, source, task.teamId);
            if (!ctx) continue;
            try {
              if (!task.rest && ctx.team.players.some((p) => (p.niggling | 0) > 0)) task.rest = { at: iso, by: "League", rolls: restAndRelaxation(ctx.team, "site", {}, deps.rollD6 ?? d6) };
              commitDraft(seasons, league.id, source, ctx, currentRosterInput(ctx), "League", iso, { auto: true, apply: false });
              // The team's own season (an earlier one for an inactive team) holds the teamUid minted at the redraft.
              if (ctx.source.id !== source.id) write(ctx.source);
            } catch (e) {
              const reason = e instanceof RedraftError ? e.message : "The current roster could not be rebuilt.";
              task.needsRedraft = { at: iso, reason };
              state.log.unshift({ at: iso, by: "League", text: `${task.name} needs a redraft: ${reason}`, teamId: task.teamId });
            }
          }
          state.revision += 1;
          write(source);
        }
        // 2. apply the journalled lists to the receiving season (resumes after an interrupted tick).
        const closing = w.closing;
        const target = redraftTarget(seasons, source);
        const waiting = state.teams.filter((x) => x.auto && x.status === "submitted" && x.draft && !x.appliedTo);
        if (target && waiting.length) {
          // A journalled rebuild is never expired here: the team stayed blocked from play since the journal (applyingRebuild),
          // so whatever the receiving season holds for it is an earlier attempt of this same roster (placed again).
          for (const task of waiting) applyDraftTeam(target, task.draft!.team);
          write(target);
          for (const task of waiting) task.appliedTo = target.id;
        }
        // 3. mark processed (only now that the receiving season is durable); people are told after the write below.
        const rebuilt = state.teams.filter((x) => x.auto && x.submittedAt === closing && x.status === "submitted").map((x) => x.teamId);
        const needs = state.teams.filter((x) => x.status === "pending" && x.needsRedraft?.at === closing).map((x) => x.teamId);
        w.processedAt = iso;
        state.log.unshift({ at: iso, by: "League", text: `The redraft window closed: ${rebuilt.length} team${rebuilt.length === 1 ? "" : "s"} rebuilt from their current roster, ${needs.length} need${needs.length === 1 ? "s" : ""} a redraft.` });
        for (const task of state.teams) {
          if (rebuilt.includes(task.teamId)) coachNote(task.coachId, task.teamId, "Redraft closed: team rebuilt", `the redraft window closed, so ${task.name} was rebuilt from its current roster within its budget.`);
          else if (needs.includes(task.teamId)) coachNote(task.coachId, task.teamId, "Redraft needed", `the redraft window closed and ${task.name}'s current roster does not fit (${task.needsRedraft!.reason}). The team cannot play until you submit a draft list.`);
        }
        for (const coach of organisersOf(league)) {
          notices.push({ coach, input: { type: "league-broadcast", title: "Redraft window closed", body: `${league.name}: ${rebuilt.length} rebuilt from their current roster, ${needs.length} need a redraft.`, link: redraftBoardLink(league.id), from: league.name } });
        }
        out.closed.push({ leagueId: league.id, seasonId: source.id, rebuilt, needsRedraft: needs });
        changed = true;
      }
      if (changed) {
        state.revision += 1;
        // Written before anyone is told: a restart finds the step done.
        write(source);
      }
    } catch (e) {
      if (e instanceof WriteFailed) { out.failed.push(league.id); continue; }
      throw e;
    }
    if (deps.notify) {
      const send = draftAwareNotify(deps.store, league.id, deps.notify, deps.isAdmin ?? (() => false));
      for (const n of notices) { try { send(n.coach, n.input); } catch { /* fire-and-forget */ } }
    }
  }
  return out;
}
