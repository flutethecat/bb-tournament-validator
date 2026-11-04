/**
 * Gates (league ladder spec, "Gates (11-02) — grill closed"; lane 8c). Owner: "An 'Opens at' gate on an online step:
 * countdown, auto-open with an inbox note and Discord post; organisers can open it early." Gateable steps (all off by
 * default): the redraft (window, rest rolls, submissions), season start / fixture release, ladder challenges, registration
 * opening and the end-of-period honours reveal. A gate opens at a date and time in the league's zone, or with a League Event
 * (+ an offset), and then moves with the event.
 *
 *   GET  /api/leagues/:id/gates                          everyone who can see the league: the gates and their countdowns
 *   PUT  /api/leagues/:id/gates/:kind/:target            organisers: { revision, mode: "off" | "time" | "event", opensAt?, eventId?, offsetMinutes?, autoStart? }
 *   POST /api/leagues/:id/gates/:kind/:target/open       organisers: { revision } ("Open now")
 *   GET  /api/leagues/:id/redraft-rolls                  organisers: the live "Redraft rolls" page data + its share link
 *   POST /api/leagues/:id/redraft-rolls/link             organisers: { action: "create" | "revoke" } the page's share link
 *   GET  /api/leagues/:id/redraft-rolls/:token           anyone holding the organisers' link: the page data (read only)
 *
 * Rules:
 *  - One shared shape (LeagueGate) in <leagueDir>/gates.json with a file revision and a revision per gate (writes name it:
 *    428 / 409 like the other league writes). Only organisers of the league and site admins write. GETs change nothing.
 *  - Open = stored state "open" OR the effective time has passed (gateTime): a step is allowed from the minute it is due even
 *    before the job has flipped the state. A gate whose League Event was deleted has no time: it stays shut until an
 *    organiser picks a time or opens it.
 *  - Every gated step checks its gate SERVER-side: redraft rest rolls and submissions (redraftApi.ts), Start season
 *    (wizard.ts), ladder challenges and registration (direct checks with countdown data, plus the projections below so every
 *    other read and check agrees), the honours reveal (ladderTitles.ts periodHonours holds the periods back: nothing is
 *    written, so no read and no Discord post can show them).
 *  - Projections (syncGateTargets): a shut registration gate is mirrored on the competition (season.gates.registration), a
 *    shut ladder-challenge gate on ladder.gates.challenges, a shut honours gate on ladder.gates.honours, and the redraft
 *    window gate moves the confirmed window's Opens at (until it has opened). Re-run after every gate write, every League
 *    Event write and on the minute job, so an event that moves takes its gates with it.
 *  - Opening (the minute job at the time, or an organiser's "Open now") is written BEFORE anyone is told, so each inbox note
 *    and Discord post goes once, across restarts. Notes go through the draft-aware notifier (a draft league tells only its
 *    organisers and admins); Discord posts through the cleaned sender postTo (drafts never post).
 *  - No coach data is stored here: openedBy is "schedule" or "organiser" only.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { buildRedraftPost, postWebhook as defaultPoster, type WebhookPoster } from "./discord.js";
import { postLeagueEvent, seasonCoaches } from "./events.js";
import { readJsonObject, requestRevision, type BodyDeps } from "./http.js";
import { isLadder, isLadderId, ladderVisible } from "./ladder.js";
import { periodHonours } from "./ladderTitles.js";
import { leagueCoaches, occurrences, parseWall, wallInstant } from "./leagueEvents.js";
import { canMoveStage, draftAwareNotify, isDraftLeague, managesLeague, MIN_TEAMS_TO_START, seasonStage } from "./lifecycle.js";
import { redraftSource } from "./redraft.js";
import { gateWhen } from "./seasonRegistration.js";
import { seasonTarget } from "../discord/targets.js";
import { LeagueStoreError, type LeagueStore } from "./store.js";
import { leagueTimeZone } from "./timeZone.js";
import type { DiscordEventKey, LeagueCalendarEvent, LeagueRecord } from "./types.js";

// ---- the shape --------------------------------------------------------------------------------------------------------

export const GATE_KINDS = ["redraft-window", "redraft-rest", "redraft-submit", "season-start", "ladder-challenges", "registration", "honours-reveal"] as const;
export type GateKind = (typeof GATE_KINDS)[number];
export const isGateKind = (v: unknown): v is GateKind => typeof v === "string" && (GATE_KINDS as readonly string[]).includes(v);

/** What a gate's target names: the league (its one redraft at a time), a season, a ladder, or either competition. */
type TargetScope = "league" | "season" | "ladder" | "competition";

interface GateMeta {
  /** "Redraft rest rolls" (editor, schedule, banner). */
  label: string;
  scope: TargetScope;
  /** The step as a subject: "Redraft rest rolls open" / "Registration opens". */
  opens: string;
  /** The announcement title: "Redraft is open!". */
  opened: string;
  /** The Discord toggle the announcement posts under; null = no post of its own (the honours post is the announcement). */
  discord: DiscordEventKey | null;
}

export const GATE_META: Readonly<Record<GateKind, GateMeta>> = {
  "redraft-window": { label: "Redraft window", scope: "league", opens: "The redraft window opens", opened: "Redraft is open!", discord: "milestones" },
  "redraft-rest": { label: "Redraft rest rolls", scope: "league", opens: "Rest & Relaxation rolls open", opened: "Redraft rest rolls are open!", discord: "milestones" },
  "redraft-submit": { label: "Redraft submissions", scope: "league", opens: "Redraft submissions open", opened: "Redraft submissions are open!", discord: "milestones" },
  "season-start": { label: "Season start", scope: "season", opens: "The season starts", opened: "The season is starting!", discord: "seasonStarted" },
  "ladder-challenges": { label: "Ladder challenges", scope: "ladder", opens: "Challenges open", opened: "Ladder challenges are open!", discord: "milestones" },
  registration: { label: "Registration", scope: "competition", opens: "Registration opens", opened: "Registration is open", discord: "registrationOpened" },
  "honours-reveal": { label: "Period honours reveal", scope: "ladder", opens: "Period honours are revealed", opened: "Period honours revealed", discord: null },
};

export interface LeagueGate {
  /** `${kind}:${target}`: one gate per step and target. */
  id: string;
  kind: GateKind;
  /** "league" (redraft gates), a season id or a ladder id. */
  target: string;
  /** "At a time": a wall-clock time in the league zone ("2026-11-05T19:00"). */
  opensAt?: string;
  /** "With a League Event": the event, and minutes after (negative = before) its start. */
  eventId?: string;
  offsetMinutes?: number;
  /** When the gate was last set: an event gate opens with the first occurrence (+ offset) after this; the honours gate holds the
   *  periods that end from here. */
  armedAt: string;
  /** Honours reveal: the earliest time this gate has been shut since it last opened. Every period ending from here stays held,
   *  however often the reveal is rescheduled (a re-arm never moves it later). */
  holdFrom?: string;
  /** Season start: start the season by itself when the gate opens (otherwise the organiser starts it, from then on). */
  autoStart?: boolean;
  state: "shut" | "open";
  openedBy?: "schedule" | "organiser";
  openedAt?: string;
  /** What the opening still has to do, each retried until done (written before any is tried): start the season, reveal held
   *  honours, tell coaches and Discord. "failed" is retried on later ticks; "done" never runs again. */
  actions?: Partial<Record<GateAction, GateActionState>>;
  /** Organisers already told that an action failed (told once). */
  actionNoted?: GateAction[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type GateAction = "start" | "reveal" | "announce";
export type GateActionState = "pending" | "done" | "failed";

/** retired: the last revision of each gate that was switched off, so a re-created gate never reuses a revision (a stale tab
 *  can never Open now or overwrite it). */
export interface LeagueGatesFile { revision: number; gates: LeagueGate[]; retired?: Record<string, number> }

export const gateId = (kind: GateKind, target: string): string => `${kind}:${target}`;

export const OFFSET_MAX_MIN = 7 * 24 * 60;
const BODY_MAX = 8 * 1024;
const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown, headers: Record<string, string> = NO_STORE): LeagueApiResult => ({ status, body, headers: { ...headers } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

// ---- time -------------------------------------------------------------------------------------------------------------

/**
 * The instant a gate opens (undefined = no time: an event gate whose event is gone). An event gate takes the first
 * occurrence whose start + offset falls after armedAt (the next league night when it was set, and the same night after the
 * event is moved); when every occurrence is before that (the event moved earlier), the last one, so it opens.
 */
export function gateTime(g: Pick<LeagueGate, "opensAt" | "eventId" | "offsetMinutes" | "armedAt">, events: readonly LeagueCalendarEvent[], zone: string): number | undefined {
  if (g.eventId) {
    const ev = events.find((e) => e.id === g.eventId);
    if (!ev) return undefined;
    const off = (g.offsetMinutes ?? 0) * 60_000;
    const armed = Date.parse(g.armedAt);
    const occ = occurrences(ev, zone);
    const pick = occ.find((o) => o.start + off > armed) ?? occ.at(-1);
    return pick ? pick.start + off : undefined;
  }
  if (g.opensAt && parseWall(g.opensAt)) return wallInstant(g.opensAt, zone);
  return undefined;
}

export const gateOpenAt = (g: LeagueGate, at: number | undefined, now: number): boolean => g.state === "open" || (at !== undefined && at <= now);

// ---- reads ------------------------------------------------------------------------------------------------------------

interface GateWorld { gates: LeagueGate[]; events: LeagueCalendarEvent[]; zone: string; revision: number }

/** The league's gates and events (throws when the gates file is unreadable; events unreadable = none, so event gates read as
 *  having no time and stay shut). */
function world(store: LeagueStore, league: LeagueRecord): GateWorld {
  const file = store.leagueGates(league.id);
  let events: LeagueCalendarEvent[] = [];
  try { events = store.leagueEvents(league.id).events; } catch { /* no time for event gates: they stay shut */ }
  return { gates: file.gates.filter((g) => g && isGateKind(g.kind) && typeof g.target === "string"), events, zone: leagueTimeZone(league), revision: file.revision };
}

export interface GateView {
  id: string;
  kind: GateKind;
  target: string;
  targetName: string;
  label: string;
  /** "Season 7: Registration opens". */
  title: string;
  state: "shut" | "open";
  /** The effective opening (ISO), null = no time yet. */
  opensAt: string | null;
  /** Seconds to go (0 when due, null without a time); the page counts down from opensAt. */
  secondsLeft: number | null;
  mode: "time" | "event";
  /** "At a time": the wall-clock value in the league zone. */
  wall?: string;
  eventId?: string;
  eventTitle?: string;
  /** The linked League Event was deleted: the gate has no time until an organiser fixes it. */
  eventMissing?: boolean;
  offsetMinutes?: number;
  autoStart?: boolean;
  openedAt?: string;
  openedBy?: "schedule" | "organiser";
  revision: number;
}

function targetName(store: LeagueStore, leagueId: string, target: string): string {
  if (target === "league") return "League";
  return store.season(leagueId, target)?.name ?? target;
}

export function gateView(g: LeagueGate, w: Pick<GateWorld, "events" | "zone">, name: string, now: number): GateView {
  const at = gateTime(g, w.events, w.zone);
  const open = gateOpenAt(g, at, now);
  const ev = g.eventId ? w.events.find((e) => e.id === g.eventId) : undefined;
  const meta = GATE_META[g.kind];
  return {
    id: g.id, kind: g.kind, target: g.target, targetName: name, label: meta.label, title: g.target === "league" ? meta.opens : `${name}: ${meta.opens}`,
    state: open ? "open" : "shut", opensAt: at === undefined ? null : new Date(at).toISOString(),
    secondsLeft: open ? 0 : at === undefined ? null : Math.max(0, Math.ceil((at - now) / 1000)),
    mode: g.eventId ? "event" : "time",
    ...(g.opensAt && !g.eventId ? { wall: g.opensAt } : {}),
    ...(g.eventId ? { eventId: g.eventId, ...(ev ? { eventTitle: ev.title } : { eventMissing: true }), offsetMinutes: g.offsetMinutes ?? 0 } : {}),
    ...(g.kind === "season-start" ? { autoStart: g.autoStart === true } : {}),
    ...(g.openedAt ? { openedAt: g.openedAt } : {}), ...(g.openedBy ? { openedBy: g.openedBy } : {}),
    revision: g.revision,
  };
}

/** Every gate the viewer may see (a ladder still in setup only to its managers). */
export function leagueGateViews(store: LeagueStore, league: LeagueRecord, now: number, manage: boolean): GateView[] {
  const w = world(store, league);
  const out: GateView[] = [];
  for (const g of w.gates) {
    if (g.target !== "league") {
      const c = store.season(league.id, g.target);
      if (!c) continue;
      if (isLadder(c) && !ladderVisible(c, manage)) continue;
    }
    out.push(gateView(g, w, targetName(store, league.id, g.target), now));
  }
  return out.sort((a, b) => (a.opensAt ?? "9999").localeCompare(b.opensAt ?? "9999") || a.id.localeCompare(b.id));
}

// ---- the server-side check --------------------------------------------------------------------------------------------

export interface GateRefusal { id: string; kind: GateKind; target: string; label: string; opensAt: string | null; secondsLeft: number | null }

/**
 * Why this step is shut now (undefined = it may go ahead): the step's gate exists and has not opened. Fails closed: an
 * unreadable gates file refuses the step. The answer carries the countdown data the page shows.
 */
export function gateRefusal(store: LeagueStore, league: LeagueRecord, kind: GateKind, target: string, now: Date): { message: string; gate: GateRefusal | null } | undefined {
  let w: GateWorld;
  try { w = world(store, league); } catch { return { message: "The schedule for this step can't be read right now. Try again shortly.", gate: null }; }
  const g = w.gates.find((x) => x.kind === kind && x.target === target);
  if (!g) return undefined;
  const at = gateTime(g, w.events, w.zone);
  if (gateOpenAt(g, at, now.getTime())) return undefined;
  const meta = GATE_META[kind];
  const message = at === undefined ? `${meta.opens} when the organisers open it.` : `${meta.opens} ${gateWhen(new Date(at).toISOString(), w.zone)}.`;
  return {
    message,
    gate: { id: g.id, kind, target, label: meta.label, opensAt: at === undefined ? null : new Date(at).toISOString(), secondsLeft: at === undefined ? null : Math.max(0, Math.ceil((at - now.getTime()) / 1000)) },
  };
}

/** The refusal as a route answer: 409 { error, code: "gate-shut", gate }. */
export function gateBlock(store: LeagueStore, league: LeagueRecord, kind: GateKind, target: string, now: Date): LeagueApiResult | undefined {
  const r = gateRefusal(store, league, kind, target, now);
  return r ? fail(r.gate ? 409 : 503, r.message, { code: "gate-shut", gate: r.gate }) : undefined;
}

// ---- projections ------------------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A shut redraft window gate with no time (its League Event was deleted): the window projects as not opening at all. */
export const NO_TIME_ISO = "2199-12-31T00:00:00.000Z";

/** The honours gate's hold start: the earliest time it has been shut since it last opened (a re-arm never moves it later). */
const holdStart = (g: Pick<LeagueGate, "holdFrom" | "armedAt">): string => g.holdFrom ?? g.armedAt;

/**
 * Mirrors the shut gates onto what the existing checks read (see the header), and moves a confirmed redraft window with its
 * gate until the window has opened (a gate with no time projects the window as not opening: NO_TIME_ISO). Writes only what
 * changed. `failed` names the competitions (or "gates" when the file is unreadable) that could not be written: the caller
 * reports it, and the minute job retries.
 */
export function syncGateTargets(store: LeagueStore, leagueId: string, now: Date): { written: string[]; failed: string[] } {
  const league = store.league(leagueId);
  if (!league) return { written: [], failed: [] };
  let w: GateWorld;
  try { w = world(store, league); } catch { return { written: [], failed: ["gates"] }; } // unreadable: every projection stays as it is
  const t = now.getTime();
  const shut = (g: LeagueGate | undefined): { at: number | undefined } | undefined => {
    if (!g) return undefined;
    const at = gateTime(g, w.events, w.zone);
    return gateOpenAt(g, at, t) ? undefined : { at };
  };
  const find = (kind: GateKind, target: string) => w.gates.find((g) => g.kind === kind && g.target === target);
  const iso = (at: number | undefined) => (at === undefined ? {} : { opensAt: new Date(at).toISOString() });
  const written: string[] = [];
  const failed: string[] = [];
  for (const c of store.competitions(leagueId)) {
    let changed = false;
    // registration (a season or a ladder)
    const reg = shut(find("registration", c.id));
    const wantReg = reg ? iso(reg.at) : undefined;
    if (!same(c.gates?.registration, wantReg)) {
      if (wantReg) c.gates = { ...(c.gates ?? {}), registration: wantReg };
      else if (c.gates) { delete c.gates.registration; if (!Object.keys(c.gates).length) delete c.gates; }
      changed = true;
    }
    if (isLadder(c)) {
      const rec = c.ladder;
      const chG = find("ladder-challenges", c.id);
      const ch = shut(chG);
      const current = rec.gates?.challenges;
      // A challenge gate stored before gates had an editor (no source) is left alone unless the league's gate replaces it.
      if (chG || current?.source === "gate") {
        const want = ch ? { ...iso(ch.at), ...(chG?.eventId ? { eventId: chG.eventId } : {}), source: "gate" as const } : undefined;
        if (!same(current, want)) {
          if (want) rec.gates = { ...(rec.gates ?? {}), challenges: want };
          else if (rec.gates) { delete rec.gates.challenges; if (!Object.keys(rec.gates).length) delete rec.gates; }
          changed = true;
        }
      }
      const hoG = find("honours-reveal", c.id);
      const ho = shut(hoG);
      const wantHo = ho && hoG ? { from: holdStart(hoG), ...iso(ho.at) } : undefined;
      if (!same(rec.gates?.honours, wantHo)) {
        if (wantHo) rec.gates = { ...(rec.gates ?? {}), honours: wantHo };
        else if (rec.gates) { delete rec.gates.honours; if (!Object.keys(rec.gates).length) delete rec.gates; }
        changed = true;
      }
    }
    // the redraft window: an open redraft whose window has not opened yet follows its gate
    const rd = c.redraft;
    const win = rd?.window;
    const wg = find("redraft-window", "league");
    if (rd && win && wg && !rd.closedAt && !win.openNotifiedAt) {
      const length = Math.max(60_000, Date.parse(win.closesAt) - Date.parse(win.opensAt));
      const at = gateTime(wg, w.events, w.zone);
      let opens: number | undefined;
      if (wg.state === "open") {
        // Opened early during this redraft (a gate opened for an earlier one does not count).
        if (wg.openedAt && Date.parse(wg.openedAt) >= Date.parse(rd.startedAt)) opens = Math.min(Date.parse(win.opensAt), Date.parse(wg.openedAt));
      } else opens = at ?? Date.parse(NO_TIME_ISO);
      if (opens !== undefined && opens !== Date.parse(win.opensAt)) {
        win.opensAt = new Date(opens).toISOString();
        win.closesAt = new Date(opens + length).toISOString();
        rd.revision += 1;
        changed = true;
      }
    }
    if (changed) {
      try { store.putSeason(c); written.push(c.id); } catch { failed.push(c.id); }
    }
  }
  return { written, failed };
}

/**
 * The honours hold read from gates.json at publish time (ladderTitles.ts periodHonours), so a projection that failed to write
 * can never publish held honours. Per ladder: { from } while the reveal gate is shut, "unreadable" when the file cannot be read
 * (fail closed: everything is held), undefined when nothing is held.
 */
export function honoursHoldFor(store: LeagueStore, leagueId: string, now: Date): (ladderId: string) => { from: number } | "unreadable" | undefined {
  return (ladderId) => {
    const league = store.league(leagueId);
    if (!league) return undefined;
    let w: GateWorld;
    try { w = world(store, league); } catch { return "unreadable"; }
    const g = w.gates.find((x) => x.kind === "honours-reveal" && x.target === ladderId);
    if (!g || gateOpenAt(g, gateTime(g, w.events, w.zone), now.getTime())) return undefined;
    const from = Date.parse(holdStart(g));
    return { from: Number.isFinite(from) ? from : 0 };
  };
}

/** The season start gate of a season (never a ladder) while shut: its fixtures cannot be played (playBlock.ts). */
export function seasonStartRefusal(store: LeagueStore, leagueId: string, seasonId: string, now: Date): { message: string; gate: GateRefusal | null } | undefined {
  if (isLadderId(seasonId)) return undefined;
  const league = store.league(leagueId);
  if (!league) return undefined;
  const r = gateRefusal(store, league, "season-start", seasonId, now);
  return r ? { message: r.gate ? `${r.message} No games until then.` : r.message, gate: r.gate } : undefined;
}

// ---- opening: actions (start, reveal, announce), each retried until done ------------------------------------------------------

export interface GateOpenDeps {
  store: LeagueStore;
  notify?: (coach: string, input: NotificationInput) => void;
  isAdmin?: (coach: string) => boolean;
  postWebhook?: WebhookPoster;
  /** The Discord observer's ledger (src/discord/store.ts): a registration gate marks the observer's own "regopen" marker, so
   *  one opening gives one post. */
  discordLedger?: { mark(key: string, markers: readonly string[], at: string): string[] };
}

/** Start a season by itself (the season-start gate with "start automatically"): the same checks as Start season. "" = started
 *  (or already started: idempotent). */
export function startSeasonByGate(store: LeagueStore, league: LeagueRecord, seasonId: string, now: Date): string {
  const s = store.season(league.id, seasonId);
  if (!s || isLadder(s)) return "The season is gone.";
  const from = seasonStage(s);
  if (from === "active") return "";
  if (!canMoveStage(from, "active")) return `${s.name} is finished.`;
  if (s.teams.length < MIN_TEAMS_TO_START) return `Start season needs at least ${MIN_TEAMS_TO_START} teams; ${s.name} has ${s.teams.length}.`;
  s.stage = "active";
  if (!s.startedAt) s.startedAt = now.toISOString();
  store.putSeason(s);
  return "";
}

/** The honours-reveal gate opened: every held period's honours are written now (and their champion notes returned). Idempotent:
 *  periods already written are skipped. */
export function revealLadderHonours(store: LeagueStore, league: LeagueRecord, ladderId: string, now: Date): Array<{ coach: string; title: string; body: string }> {
  const ladder = store.season(league.id, ladderId);
  if (!ladder || !isLadder(ladder)) return [];
  const notes: Array<{ coach: string; title: string; body: string }> = [];
  const before = JSON.stringify([ladder.awards.length, ladder.ladder.periodHonours ?? []]);
  const held = Boolean(ladder.ladder.gates?.honours);
  if (ladder.ladder.gates?.honours) { delete ladder.ladder.gates.honours; if (!Object.keys(ladder.ladder.gates).length) delete ladder.ladder.gates; }
  periodHonours({ league, ladder, competitions: store.competitions(league.id).map((c) => (c.id === ladder.id ? ladder : c)), now, notes, revealAll: true });
  if (held || JSON.stringify([ladder.awards.length, ladder.ladder.periodHonours ?? []]) !== before) store.putSeason(ladder);
  return notes;
}

/** Who is told when a gate opens: the coaches of the step's competition, the redrafting coaches, or the league's coaches. */
function recipients(store: LeagueStore, league: LeagueRecord, g: LeagueGate): string[] {
  const comps = store.competitions(league.id);
  if (g.kind.startsWith("redraft-")) {
    const source = redraftSource(store.seasons(league.id));
    const tasks = source?.redraft && !source.redraft.closedAt ? source.redraft.teams.filter((x) => x.selected && (x.status === "pending" || x.status === "submitted")) : [];
    const coaches = [...new Set(tasks.map((x) => x.coachId?.trim()).filter((c): c is string => Boolean(c)))];
    return coaches.length ? coaches : leagueCoaches(store.seasons(league.id));
  }
  if (g.kind === "registration") return leagueCoaches(store.seasons(league.id));
  const c = comps.find((x) => x.id === g.target);
  return c ? seasonCoaches(c) : [];
}

const gateLink = (league: LeagueRecord, g: LeagueGate): string => {
  const id = encodeURIComponent(league.id);
  if (g.kind.startsWith("redraft-")) return `/app/leagues/${id}/redraft-rolls`;
  if (g.kind === "ladder-challenges" || g.kind === "honours-reveal") return `/app/leagues/${id}?tab=ladder&ladder=${encodeURIComponent(g.target)}`;
  return `/app/leagues/${id}`;
};

/** What an opening has to do (start / reveal first, then the announcement). */
const actionsFor = (g: LeagueGate): Partial<Record<GateAction, GateActionState>> => ({
  ...(g.kind === "season-start" && g.autoStart ? { start: "pending" as const } : {}),
  ...(g.kind === "honours-reveal" ? { reveal: "pending" as const } : {}),
  announce: "pending",
});

/** Marks a gate open (in memory): a new revision, and its actions pending. The caller writes the file before any action runs. */
function markOpen(g: LeagueGate, by: "schedule" | "organiser", iso: string): void {
  g.state = "open";
  g.openedBy = by;
  g.openedAt = iso;
  g.revision += 1;
  g.updatedAt = iso;
  g.actions = actionsFor(g);
  delete g.actionNoted;
}

const ACTION_ORDER: readonly GateAction[] = ["start", "reveal", "announce"];

/** The gate as stored now, if it is still the opening `revision` (an organiser who re-armed it since stops every action). */
function currentGate(store: LeagueStore, leagueId: string, id: string, revision: number): { file: LeagueGatesFile; gate: LeagueGate } | undefined {
  let file: LeagueGatesFile;
  try { file = store.leagueGates(leagueId); } catch { return undefined; }
  const gate = file.gates.find((g) => g.id === id);
  return gate && gate.revision === revision && gate.state === "open" ? { file, gate } : undefined;
}

/**
 * Runs what an opened gate still has to do, in order, each re-reading the gate first (skipped when the gate changed or is no
 * longer open): start the season (idempotent: a season that already started is a no-op), reveal held honours (idempotent),
 * then announce: the announcement is marked done and written BEFORE anyone is told, so it goes once across restarts. A start or
 * reveal that throws or refuses is marked failed (organisers told once) and retried on later ticks.
 */
export async function runGateActions(deps: GateOpenDeps, leagueId: string, id: string, revision: number, now: Date): Promise<void> {
  const { store } = deps;
  const send = deps.notify ? draftAwareNotify(store, leagueId, deps.notify, deps.isAdmin ?? (() => false)) : undefined;
  const tell = (coach: string, input: NotificationInput) => { try { send?.(coach, input); } catch { /* fire-and-forget */ } };
  for (const action of ACTION_ORDER) {
    const cur = currentGate(store, leagueId, id, revision);
    if (!cur) return;
    const league = store.league(leagueId);
    if (!league) return;
    const g = cur.gate;
    const st = g.actions?.[action];
    if (!st || st === "done") continue;
    const name = targetName(store, league.id, g.target);
    if (action === "announce") {
      g.actions = { ...(g.actions ?? {}), announce: "done" };
      cur.file.revision += 1;
      try { store.putLeagueGates(leagueId, cur.file); } catch { return; } // not written: nobody is told (retried next tick)
      await announce(deps, league, g, name, tell, now);
      continue;
    }
    let why = "";
    let notes: Array<{ coach: string; title: string; body: string }> = [];
    try {
      if (action === "start") why = startSeasonByGate(store, league, g.target, now);
      else notes = revealLadderHonours(store, league, g.target, now);
    } catch (e) {
      why = (e as Error)?.message || "it could not be written";
      console.error(`[leagues] gate ${leagueId}/${id} ${action} failed: ${why}`);
    }
    for (const n of notes) if (n.coach) tell(n.coach, { type: "league-broadcast", title: n.title, body: n.body, link: gateLink(league, g), from: league.name });
    const after = currentGate(store, leagueId, id, revision);
    if (!after) return;
    after.gate.actions = { ...(after.gate.actions ?? {}), [action]: why ? "failed" : "done" };
    const noteIt = Boolean(why) && !(after.gate.actionNoted ?? []).includes(action);
    if (noteIt) after.gate.actionNoted = [...(after.gate.actionNoted ?? []), action];
    after.file.revision += 1;
    try { store.putLeagueGates(leagueId, after.file); } catch { return; }
    if (noteIt) {
      const organisers = [...new Set([league.owner, ...league.organisers].map((c) => c?.trim()).filter((c): c is string => Boolean(c)))];
      const what = action === "start" ? `${name} could not start by itself` : `${name}'s period honours could not be revealed`;
      for (const o of organisers) tell(o, { type: "league-broadcast", title: `${league.name}: ${what}`.slice(0, 120), body: `The gate opened, but ${what}: ${why} It is tried again every minute.`, link: `/app/leagues/${encodeURIComponent(league.id)}/settings`, from: league.name, action: true });
    }
  }
}

/** One inbox note per coach of the step and one Discord post (a registration gate also marks the observer's "regopen"). */
async function announce(deps: GateOpenDeps, league: LeagueRecord, g: LeagueGate, name: string, tell: (coach: string, input: NotificationInput) => void, now: Date): Promise<void> {
  const { store } = deps;
  const meta = GATE_META[g.kind];
  const started = g.kind === "season-start" && g.actions?.start === "done";
  const extra = started ? " Fixtures are out: good luck!" : "";
  const subject = g.target === "league" ? meta.opened : `${name}: ${meta.opened}`;
  for (const c of recipients(store, league, g)) tell(c, { type: "league-broadcast", title: `${league.name}: ${subject}`.slice(0, 120), body: `${league.name}: ${subject}${extra}`, link: gateLink(league, g), from: league.name });
  if (!meta.discord) return;
  const competition = g.target !== "league" ? { seasonId: g.target } : {};
  if (g.kind === "registration" && g.target !== "league" && !isLadderId(g.target)) {
    // The observer posts its own "Registration ... is open" once per season (marker "regopen"): mark it, so one opening = one post.
    try { deps.discordLedger?.mark(seasonTarget(store, league, g.target).key, ["regopen"], now.toISOString()); } catch { /* best effort */ }
  }
  try { await postLeagueEvent(store, league, meta.discord, buildRedraftPost(league, subject, `${subject}${extra}`), deps.postWebhook ?? defaultPoster, competition); } catch { /* best effort */ }
}

// ---- the minute job ----------------------------------------------------------------------------------------------------

export interface GateJobDeps extends GateOpenDeps { now?: () => Date }

/**
 * Every minute (server.ts, never from a GET; the first run comes before the ladder and redraft jobs): projections follow moved
 * events (and failed writes are retried), every shut gate that is due opens (written first: a restart finds it open), and every
 * opened gate's unfinished actions run (re-reading the gate before each one).
 */
export async function runGateJob(deps: GateJobDeps): Promise<{ opened: string[]; failed: string[] }> {
  const now = deps.now?.() ?? new Date();
  const out = { opened: [] as string[], failed: [] as string[] };
  for (const league of deps.store.list()) {
    let file: LeagueGatesFile;
    try { file = deps.store.leagueGates(league.id); } catch { out.failed.push(league.id); continue; }
    if (!file.gates.length) continue;
    let w: GateWorld;
    try { w = world(deps.store, league); } catch { out.failed.push(league.id); continue; }
    const due = file.gates.filter((g) => isGateKind(g.kind) && g.state !== "open" && (() => { const at = gateTime(g, w.events, w.zone); return at !== undefined && at <= now.getTime(); })());
    if (due.length) {
      const iso = now.toISOString();
      for (const g of due) markOpen(g, "schedule", iso);
      file.revision += 1;
      try { deps.store.putLeagueGates(league.id, file); } catch { out.failed.push(league.id); continue; } // not written: nobody is told
      for (const g of due) out.opened.push(`${league.id}/${g.id}`);
    }
    const synced = syncGateTargets(deps.store, league.id, now);
    if (synced.failed.length) out.failed.push(`${league.id}:projections`);
    const work = file.gates.filter((g) => g.state === "open" && Object.values(g.actions ?? {}).some((x) => x !== "done")).map((g) => ({ id: g.id, revision: g.revision }));
    for (const x of work) await runGateActions(deps, league.id, x.id, x.revision, now);
  }
  return out;
}

// ---- routes -----------------------------------------------------------------------------------------------------------

export interface GateRouteDeps extends BodyDeps, GateOpenDeps {
  ifMatch?: string;
  now?: () => Date;
}

function manageGate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can set its gates.");
  return undefined;
}

/** The target is one this kind can gate in this league ("" = fine). */
function targetProblem(store: LeagueStore, leagueId: string, kind: GateKind, target: string): string {
  const scope = GATE_META[kind].scope;
  if (scope === "league") return target === "league" ? "" : "The redraft gates belong to the league: use the target \"league\".";
  const c = store.season(leagueId, target);
  if (!c) return "That season or ladder is not in this league.";
  if (scope === "season" && (isLadder(c) || isLadderId(target))) return "Pick a season.";
  if (scope === "ladder" && !isLadder(c)) return "Pick a ladder.";
  if (c.status === "completed" && kind !== "honours-reveal") return `${c.name} is finished.`;
  return "";
}

function parseSetting(input: Record<string, unknown>, events: readonly LeagueCalendarEvent[], kind: GateKind, zone: string, now: number):
  { mode: "off" } | { mode: "time"; opensAt: string } | { mode: "event"; eventId: string; offsetMinutes: number } | { error: string; field: string } {
  const mode = input.mode;
  if (mode === "off") return { mode };
  if (mode === "time") {
    const wall = parseWall(input.opensAt);
    if (!wall) return { error: "Opens at must be a date and time (2026-11-05T19:00).", field: "opensAt" };
    const at = wallInstant(wall, zone);
    if (at < now - 60_000) return { error: "Pick a time still to come, or use Open now.", field: "opensAt" };
    if (at > now + 366 * 86_400_000) return { error: "Opens at must be within a year.", field: "opensAt" };
    return { mode, opensAt: wall };
  }
  if (mode === "event") {
    if (typeof input.eventId !== "string" || !events.some((e) => e.id === input.eventId)) return { error: "Pick one of this league's events.", field: "eventId" };
    const off = input.offsetMinutes === undefined || input.offsetMinutes === null ? 0 : input.offsetMinutes;
    if (typeof off !== "number" || !Number.isInteger(off) || Math.abs(off) > OFFSET_MAX_MIN) return { error: "The offset must be whole minutes, at most 7 days either way.", field: "offsetMinutes" };
    return { mode, eventId: input.eventId, offsetMinutes: off };
  }
  void kind;
  return { error: 'mode must be "off", "time" or "event".', field: "mode" };
}

export async function leagueGateRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: GateRouteDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, second, third, fourth, ...more] = rest;
  if (first === "redraft-rolls") return redraftRollsRoutes(method, [second, third, fourth, ...more].filter((x): x is string => x !== undefined), league, auth, deps);
  if (first !== "gates") return undefined;
  const read = method === "GET" || method === "HEAD";
  const now = deps.now?.() ?? new Date();
  if (second === undefined) {
    if (!read) return fail(405, "Use GET.");
    if (!league) return fail(404, "League not found.");
    const manage = managesLeague(league, auth);
    let gates: GateView[];
    try { gates = leagueGateViews(deps.store, league, now.getTime(), manage); } catch { return fail(500, "The league's gates could not be read."); }
    let events: Array<{ id: string; title: string; next: string | null }> | undefined;
    if (manage) {
      try {
        const zone = leagueTimeZone(league);
        events = deps.store.leagueEvents(league.id).events.map((e) => ({ id: e.id, title: e.title, next: (() => { const o = occurrences(e, zone).find((x) => x.start > now.getTime()); return o ? new Date(o.start).toISOString() : null; })() }));
      } catch { events = []; }
    }
    let retired: Record<string, number> | undefined;
    if (manage) { try { retired = deps.store.leagueGates(league.id).retired ?? {}; } catch { retired = {}; } }
    const headers = auth || isDraftLeague(league) ? NO_STORE : { "cache-control": "no-cache" };
    return res(200, { timeZone: leagueTimeZone(league), now: now.toISOString(), manage, gates, ...(events ? { events } : {}), ...(retired ? { retired } : {}) }, headers);
  }
  if (!isGateKind(second) || !third || (fourth !== undefined && fourth !== "open") || more.length) return fail(404, "Not found.");
  const kind = second;
  const target = third;
  const open = fourth === "open";
  if (open ? method !== "POST" : method !== "PUT") return fail(405, open ? "Use POST." : "Use PUT.");
  const early = manageGate(league, auth);
  if (early) return early;
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league as it is now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  const refused = manageGate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const at = (deps.now?.() ?? new Date());
  const problem = targetProblem(deps.store, lg.id, kind, target);
  if (problem) return fail(400, problem, { field: "target" });
  let w: GateWorld;
  try { w = world(deps.store, lg); } catch { return fail(500, "The league's gates could not be read."); }
  let file: LeagueGatesFile;
  try { file = deps.store.leagueGates(lg.id); } catch { return fail(500, "The league's gates could not be read."); }
  const id = gateId(kind, target);
  const existing = file.gates.find((g) => g.id === id);
  // Revisions only ever go up per gate: a gate switched off keeps its last revision in `retired`, and a re-created one continues.
  const base = existing?.revision ?? file.retired?.[id] ?? 0;
  const rev = requestRevision(input, deps.ifMatch);
  if (rev === "missing") return fail(428, "Name the gate's revision. Reload and try again.", { revision: base });
  if (rev === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (rev !== base) return fail(409, "Someone changed this gate since you opened it. Reload to see the latest.", { revision: base });
  const iso = at.toISOString();
  const name = targetName(deps.store, lg.id, target);

  if (open) {
    if (!existing) return fail(404, "There is no gate on this step: it is already open.");
    const view = gateView(existing, w, name, at.getTime());
    if (view.state === "open" && existing.state === "open") return fail(409, "This gate is already open.");
    markOpen(existing, "organiser", iso);
    file.revision += 1;
    try { deps.store.putLeagueGates(lg.id, file); } catch (e) { return fail(e instanceof LeagueStoreError ? e.status : 500, "Could not open the gate right now."); }
    const synced = applyProjections(deps.store, lg.id, at);
    await runGateActions(deps, lg.id, id, existing.revision, at);
    const saved = deps.store.leagueGates(lg.id).gates.find((g) => g.id === id) ?? existing;
    if (synced) return fail(503, synced, { gate: gateView(saved, w, name, at.getTime()) });
    return res(200, { gate: gateView(saved, w, name, at.getTime()) });
  }

  const setting = parseSetting(input, w.events, kind, w.zone, at.getTime());
  if ("error" in setting) return fail(400, setting.error, { field: setting.field });
  if (input.autoStart !== undefined && typeof input.autoStart !== "boolean") return fail(400, "autoStart must be true or false.", { field: "autoStart" });
  if (setting.mode === "off") {
    if (!existing) return res(200, { gate: null, removed: false, revision: base });
    file.gates = file.gates.filter((g) => g.id !== id);
    file.retired = { ...(file.retired ?? {}), [id]: existing.revision };
    file.revision += 1;
    try { deps.store.putLeagueGates(lg.id, file); } catch { return fail(500, "Could not save the gate right now."); }
    const synced = applyProjections(deps.store, lg.id, at);
    if (synced) return fail(503, synced, { gate: null, removed: true, revision: existing.revision });
    return res(200, { gate: null, removed: true, revision: existing.revision });
  }
  // The honours hold covers every period that ended while the gate was shut: re-arming a gate that is still shut keeps the
  // earliest hold start (a reschedule can never let an ended period through).
  const stillShut = existing && existing.state !== "open";
  const holdFrom = kind === "honours-reveal" ? (stillShut ? holdStart(existing!) : iso) : undefined;
  const next: LeagueGate = {
    id, kind, target,
    ...(setting.mode === "time" ? { opensAt: setting.opensAt } : { eventId: setting.eventId, offsetMinutes: setting.offsetMinutes }),
    armedAt: iso,
    ...(holdFrom ? { holdFrom } : {}),
    ...(kind === "season-start" && (input.autoStart ?? existing?.autoStart) === true ? { autoStart: true } : {}),
    state: "shut", revision: base + 1, createdAt: existing?.createdAt ?? iso, updatedAt: iso,
  };
  file.gates = [...file.gates.filter((g) => g.id !== id), next];
  if (file.retired?.[id] !== undefined) { delete file.retired[id]; if (!Object.keys(file.retired).length) delete file.retired; }
  file.revision += 1;
  try { deps.store.putLeagueGates(lg.id, file); } catch { return fail(500, "Could not save the gate right now."); }
  const warning = redraftCloseWarning(deps.store, lg, next, w);
  const synced = applyProjections(deps.store, lg.id, at);
  const view = gateView(next, w, name, at.getTime());
  if (synced) return fail(503, synced, { gate: view });
  return res(existing ? 200 : 201, { gate: view, ...(warning ? { warning } : {}) });
}

/** Projections after a gate write, retried once; a failure is answered as an error (the minute job keeps retrying). "" = done. */
function applyProjections(store: LeagueStore, leagueId: string, now: Date): string {
  if (!syncGateTargets(store, leagueId, now).failed.length) return "";
  if (!syncGateTargets(store, leagueId, now).failed.length) return "";
  return "The gate was saved, but the season or ladder it controls could not be updated yet. It is retried every minute; the gate itself is already in force.";
}

/** A rest-roll or submission gate opening after the open redraft's window closes: the window close waits for it (say so). */
function redraftCloseWarning(store: LeagueStore, league: LeagueRecord, g: LeagueGate, w: GateWorld): string {
  if (g.kind !== "redraft-rest" && g.kind !== "redraft-submit") return "";
  const source = redraftSource(store.seasons(league.id));
  const win = source?.redraft && !source.redraft.closedAt ? source.redraft.window : undefined;
  if (!win || win.processedAt) return "";
  const at = gateTime(g, w.events, w.zone);
  if (at !== undefined && at < Date.parse(win.closesAt)) return "";
  return `This gate opens after the redraft window closes (${gateWhen(win.closesAt, w.zone)}). The window close, and its automatic rebuilds, wait until it opens.`;
}

// ---- the live "Redraft rolls" page ----------------------------------------------------------------------------------------

export interface RedraftRollRow {
  key: string;
  at: string;
  teamId: string;
  team: string;
  race: string;
  player: string;
  position: string;
  roll: number;
  target: number;
  recovered: boolean;
  source: "site" | "entered";
}

export interface RedraftRollsView {
  leagueName: string;
  timeZone: string;
  redraft: { seasonName: string; closed: boolean; window: { opensAt: string; closesAt: string } | null } | null;
  /** The rest-roll gate's countdown (null when there is none). */
  gate: GateView | null;
  rolls: RedraftRollRow[];
  /** Teams in the redraft that still have to roll (players with a niggling injury, no rolls yet). */
  waiting: number;
  /** Changes whenever a roll is added (the page polls and redraws on change). */
  version: string;
}

/**
 * The rolls of the league's current redraft (else its latest), newest first. Shows only what a public team page already shows
 * (team, race, player name or position) plus the roll itself; never a coach name, budget or roster choice.
 */
export function redraftRollsView(store: LeagueStore, league: LeagueRecord, now: Date): RedraftRollsView {
  const seasons = store.seasons(league.id);
  const source = seasons.find((s) => s.redraft && !s.redraft.closedAt) ?? seasons.find((s) => s.redraft);
  const st = source?.redraft;
  const rolls: RedraftRollRow[] = [];
  let waiting = 0;
  for (const task of st?.teams ?? []) {
    if (!task.selected) continue;
    const team = (seasons.find((s) => s.id === task.sourceSeasonId) ?? source)?.teams.find((t) => t.id === task.teamId);
    if (!task.rest) {
      if (task.status === "pending" && team?.players.some((p) => (p.niggling | 0) > 0)) waiting += 1;
      continue;
    }
    task.rest.rolls.forEach((r, i) => {
      const p = team?.players.find((x) => x.playerId === r.playerId);
      rolls.push({
        key: `${task.teamId}:${i}`, at: task.rest!.at, teamId: task.teamId, team: task.name, race: task.race,
        player: p?.name || p?.position || "A player", position: p?.position ?? "", roll: r.roll, target: r.target, recovered: r.recovered, source: r.source,
      });
    });
  }
  rolls.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  let gate: GateView | null = null;
  try {
    const w = world(store, league);
    const g = w.gates.find((x) => x.kind === "redraft-rest" && x.target === "league");
    if (g) gate = gateView(g, w, "League", now.getTime());
  } catch { /* no countdown */ }
  return {
    leagueName: league.name, timeZone: leagueTimeZone(league),
    redraft: source && st ? { seasonName: source.name, closed: Boolean(st.closedAt), window: st.window ? { opensAt: st.window.opensAt, closesAt: st.window.closesAt } : null } : null,
    gate, rolls, waiting, version: `${st?.revision ?? 0}:${rolls.length}:${gate?.state ?? ""}`,
  };
}

const rollsLink = (leagueId: string, token: string): string => `/app/leagues/${encodeURIComponent(leagueId)}/redraft-rolls/${token}`;

function tokenMatches(stored: string | undefined, given: string): boolean {
  if (!stored || !/^[A-Za-z0-9_-]{20,64}$/.test(given)) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function redraftRollsRoutes(method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: GateRouteDeps): Promise<LeagueApiResult> {
  const read = method === "GET" || method === "HEAD";
  const now = deps.now?.() ?? new Date();
  const [first, ...more] = rest;
  if (more.length) return fail(404, "Not found.");
  if (first === undefined) {
    // The organisers' own view (and the share link).
    if (!read) return fail(405, "Use GET.");
    const early = manageGate(league, auth);
    if (early) return early;
    const token = deps.store.secrets(league!.id).redraftRollsToken;
    return res(200, { rolls: redraftRollsView(deps.store, league!, now), link: token ? rollsLink(league!.id, token) : null });
  }
  if (first === "link") {
    if (method !== "POST") return fail(405, "Use POST.");
    const early = manageGate(league, auth);
    if (early) return early;
    const body = await readJsonObject(deps, BODY_MAX);
    if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
    const lg = deps.store.league(league!.id);
    const refused = manageGate(lg, auth);
    if (refused || !lg) return refused ?? fail(404, "League not found.");
    const action = body.value.action;
    if (action !== "create" && action !== "revoke") return fail(400, 'action must be "create" or "revoke".', { field: "action" });
    const secrets = deps.store.secrets(lg.id);
    if (action === "revoke") delete secrets.redraftRollsToken;
    else secrets.redraftRollsToken = randomBytes(24).toString("base64url");
    deps.store.setSecrets(lg.id, secrets);
    return res(200, { link: secrets.redraftRollsToken ? rollsLink(lg.id, secrets.redraftRollsToken) : null });
  }
  // The shared link: anyone holding it, read only. A draft league is not there for them (api.ts visibility gate: 404).
  if (!read) return fail(405, "Use GET.");
  if (!league || !tokenMatches(deps.store.secrets(league.id).redraftRollsToken, first)) return fail(404, "This Redraft rolls link is not valid (the organisers may have replaced it).");
  return res(200, { rolls: redraftRollsView(deps.store, league, now) });
}

// ---- schedule (leagueEvents.ts gateScheduleSource) ----------------------------------------------------------------------

/** Gate entries of the organiser Schedule timeline: every gate with a time that has not opened yet. */
export function gateTimeline(store: LeagueStore, league: LeagueRecord, events: readonly LeagueCalendarEvent[], now: number): Array<{ id: string; kind: GateKind; title: string; detail: string; at: number; eventId?: string }> {
  let file: LeagueGatesFile;
  try { file = store.leagueGates(league.id); } catch { return []; }
  const zone = leagueTimeZone(league);
  const out: Array<{ id: string; kind: GateKind; title: string; detail: string; at: number; eventId?: string }> = [];
  for (const g of file.gates) {
    if (!isGateKind(g.kind)) continue;
    const at = gateTime(g, events, zone);
    if (at === undefined || gateOpenAt(g, at, now)) continue;
    const name = targetName(store, league.id, g.target);
    const ev = g.eventId ? events.find((e) => e.id === g.eventId) : undefined;
    const meta = GATE_META[g.kind];
    const off = g.offsetMinutes ?? 0;
    const offText = off ? ` (${off > 0 ? "+" : "-"}${Math.abs(off) >= 60 && Math.abs(off) % 60 === 0 ? `${Math.abs(off) / 60} h` : `${Math.abs(off)} min`})` : "";
    out.push({
      id: g.id, kind: g.kind, title: g.target === "league" ? meta.opens : `${name}: ${meta.opens}`,
      detail: ev ? `With ${ev.title}${offText}` : `${meta.label} gate`, at, ...(g.eventId ? { eventId: g.eventId } : {}),
    });
  }
  return out;
}

