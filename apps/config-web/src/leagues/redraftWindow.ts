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
import type { LeagueRecord, RedraftState, RedraftWindow, SeasonRecord } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_MS = DAY_MS;

/** Server links (the SPA base is /app/): the coach's Redraft mode in the Roster Builder, or the organiser's board. */
export const redraftModeLink = (leagueId: string, teamId: string): string =>
  `/app/tournament-team-builder/redraft/${encodeURIComponent(leagueId)}?team=${encodeURIComponent(teamId)}`;
export const redraftBoardLink = (leagueId: string): string => `/app/leagues/${encodeURIComponent(leagueId)}/settings?tab=redraft`;

/** "Nov 9, 2026, 18:00 UTC" (server text; pages show the instant in the viewer's timezone). */
export const whenText = (iso: string): string => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
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
  seasons: SeasonRecord[], leagueId: string, source: SeasonRecord, ctx: DraftContext, input: DraftInput, actor: string, now: string, opts: { auto?: boolean } = {},
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
  if (target) {
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
export function redraftPlayBlock(seasons: SeasonRecord[], team: { teamId?: string; team?: string }, now: Date): string {
  const named = (team.team ?? "").trim().toLowerCase();
  for (const s of seasons) {
    const state = s.redraft;
    if (!state || state.closedAt || !state.window) continue;
    for (const task of state.teams) {
      if (!task.selected || (task.status !== "pending" && task.status !== "submitted")) continue;
      const hit = team.teamId ? task.teamId === team.teamId : Boolean(named) && task.name.trim().toLowerCase() === named;
      if (!hit) continue;
      if (windowOpen(state.window, now)) return `${task.name} is redrafting until ${whenText(state.window.closesAt)}: no games while the redraft window is open.`;
      if (task.status === "pending" && task.needsRedraft) return `${task.name} needs to finish its redraft before it can play.`;
    }
  }
  return "";
}

/** The block for either side of a fixture ("" = both may play). */
export function fixtureRedraftBlock(seasons: SeasonRecord[], f: { home: { teamId?: string; team: string }; away: { teamId?: string; team: string } }, now: Date): string {
  return redraftPlayBlock(seasons, f.home, now) || redraftPlayBlock(seasons, f.away, now);
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

export interface RedraftWindowOutcome { opened: string[]; reminded: string[]; closed: Array<{ leagueId: string; seasonId: string; rebuilt: string[]; needsRedraft: string[] }> }

const organisersOf = (league: LeagueRecord): string[] => {
  const out: string[] = [];
  for (const c of [leagueOwner(league), ...league.organisers]) if (c && !out.some((o) => o.trim().toLowerCase() === c.trim().toLowerCase())) out.push(c.trim());
  return out;
};

/** Seasons with an open redraft that has a window step still to do (cheap pre-check before any write). */
function due(state: RedraftState, now: number): boolean {
  const w = state.window;
  if (!w || state.closedAt) return false;
  if (!w.openNotifiedAt && now >= t(w.opensAt)) return true;
  if (!w.reminderAt && now >= t(w.closesAt) - REMINDER_MS && now < t(w.closesAt)) return true;
  return !w.processedAt && now >= t(w.closesAt);
}

export function runRedraftWindowJob(deps: RedraftWindowDeps): RedraftWindowOutcome {
  const now = deps.now?.() ?? new Date();
  const ms = now.getTime();
  const iso = now.toISOString();
  const out: RedraftWindowOutcome = { opened: [], reminded: [], closed: [] };
  for (const league of deps.store.list()) {
    const seasons = deps.store.seasons(league.id);
    const source = seasons.find((s) => s.redraft && due(s.redraft, ms));
    if (!source) continue;
    const state = source.redraft!;
    const w = state.window!;
    const notices: Array<{ coach: string; input: NotificationInput }> = [];
    const pending = state.teams.filter((x) => x.selected && x.status === "pending");
    const touched = new Set<SeasonRecord>([source]);
    const coachNote = (coach: string | undefined, teamId: string, title: string, body: string): void => {
      if (coach) notices.push({ coach, input: { type: "league-broadcast", title, body: `${league.name}: ${body}`, link: redraftModeLink(league.id, teamId), from: league.name, action: true } });
    };
    if (!w.openNotifiedAt && ms >= t(w.opensAt)) {
      w.openNotifiedAt = iso;
      for (const x of pending) coachNote(x.coachId, x.teamId, "Redraft open", `the redraft for ${x.name} is open until ${whenText(w.closesAt)}. Roll Rest & Relaxation, then build next season's roster in the Roster Builder.`);
      out.opened.push(`${league.id}/${source.id}`);
    }
    if (!w.reminderAt && ms >= t(w.closesAt) - REMINDER_MS && ms < t(w.closesAt)) {
      w.reminderAt = iso;
      for (const x of pending) coachNote(x.coachId, x.teamId, "Redraft closes in 24 hours", `${x.name}'s redraft closes at ${whenText(w.closesAt)}. Submit your draft list, or the team is rebuilt from its current roster if it fits the budget.`);
      out.reminded.push(`${league.id}/${source.id}`);
    }
    if (!w.processedAt && ms >= t(w.closesAt)) {
      w.processedAt = iso;
      const rebuilt: string[] = [];
      const needs: string[] = [];
      for (const task of pending) {
        if (task.needsRedraft) continue;
        const ctx = draftContext(seasons, source, task.teamId);
        if (!ctx) continue;
        try {
          if (!task.rest && ctx.team.players.some((p) => (p.niggling | 0) > 0)) task.rest = { at: iso, by: "League", rolls: restAndRelaxation(ctx.team, "site", {}, deps.rollD6 ?? d6) };
          const done = commitDraft(seasons, league.id, source, ctx, currentRosterInput(ctx), "League", iso, { auto: true });
          if (done.ok) {
            rebuilt.push(task.teamId);
            if (done.target) touched.add(done.target);
            coachNote(task.coachId, task.teamId, "Redraft closed: team rebuilt", `the redraft window closed, so ${task.name} was rebuilt from its current roster within its budget.`);
          }
        } catch (e) {
          const reason = e instanceof RedraftError ? e.message : "The current roster could not be rebuilt.";
          task.needsRedraft = { at: iso, reason };
          needs.push(task.teamId);
          state.log.unshift({ at: iso, by: "League", text: `${task.name} needs a redraft: ${reason}`, teamId: task.teamId });
          coachNote(task.coachId, task.teamId, "Redraft needed", `the redraft window closed and ${task.name}'s current roster does not fit (${reason}). The team cannot play until you submit a draft list.`);
        }
      }
      state.log.unshift({ at: iso, by: "League", text: `The redraft window closed: ${rebuilt.length} team${rebuilt.length === 1 ? "" : "s"} rebuilt from their current roster, ${needs.length} need${needs.length === 1 ? "s" : ""} a redraft.` });
      for (const coach of organisersOf(league)) {
        notices.push({ coach, input: { type: "league-broadcast", title: "Redraft window closed", body: `${league.name}: ${rebuilt.length} rebuilt from their current roster, ${needs.length} need a redraft.`, link: redraftBoardLink(league.id), from: league.name } });
      }
      out.closed.push({ leagueId: league.id, seasonId: source.id, rebuilt, needsRedraft: needs });
    }
    state.revision += 1;
    // Written before anyone is told: a restart finds the step done.
    try { for (const s of touched) deps.store.putSeason(s); } catch { continue; }
    if (deps.notify) {
      const send = draftAwareNotify(deps.store, league.id, deps.notify, deps.isAdmin ?? (() => false));
      for (const n of notices) { try { send(n.coach, n.input); } catch { /* fire-and-forget */ } }
    }
  }
  return out;
}

