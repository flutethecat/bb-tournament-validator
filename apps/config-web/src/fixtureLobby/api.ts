/**
 * Fixture lobby routes, source-agnostic: a source adapter (league.ts) resolves the fixture and hands over the parsed body.
 *
 *   GET  .../lobby                 the lobby view (public read; spectators get no chat and no unrevealed picks)
 *   POST .../lobby/presence        heartbeat (the two coaches and organisers; signed in only)
 *   POST .../lobby/chat            { text }  plain text, at most 500 characters, rate-limited (coaches + organisers)
 *   POST .../lobby/roster          { locked, teamRef?, side? }  lock / unlock the roster (tabletop: with the recorder team)
 *   POST .../lobby/ready           { ready, side? }
 *   POST .../lobby/inducements     { side, picks[], autoBuy?, lock? }  own side only; organisers any side (but never
 *                                  the underdog's lock, §9.3); 409 once locked unless an organiser unlocks (lock: false)
 *   POST .../lobby/start           { force? }  either coach; the organiser may force past the Ready presses only
 *
 * Writes need a session (the server's CSRF and onboarding gates run first). Every write for one lobby is serialised
 * (store.withLobby); START is idempotent (a second START returns the first match).
 */
import { plainText } from "../leagues/inducementRules.js";
import {
  budgetFor, CHAT_KEEP, CHAT_MAX_CHARS, fixedTeamStale, gateOf, holdBanner, inducementStep, kGold, menuFor, newLobby, parsePicks, picksVisible, planSide,
  prefilledLines, priceSide, resolveStart, sideHasStep, tvRoles, type LobbyViewer,
} from "./core.js";
import type { LobbyPresence } from "./presence.js";
import type { FixtureLobbyStore } from "./store.js";
import { LOBBY_SIDES, otherSide, type LobbyChatMessage, type LobbyFixture, type LobbyRecord, type LobbySide, type ResolvedSide } from "./types.js";
import { randomBytes } from "node:crypto";

export interface LobbyAuth { coach: string; admin: boolean }
export interface LobbyResult { status: number; body: unknown; headers?: Record<string, string> }

export interface StartTabletopInput {
  actor: string;
  organiser: boolean;
  fixtureRef: string;
  home: { coach: string; team: string };
  away: { coach: string; team: string };
  /** The resolved lists by coach (lower-cased): createMatch seats them after its own seat draw. */
  inducementsByCoach: Record<string, ResolvedSide>;
  extra: Record<string, unknown>;
}

export interface LobbyDeps {
  store: FixtureLobbyStore;
  presence: LobbyPresence;
  /** Chat limiter (translate/guards RateLimiter); undefined = unlimited (tests). */
  chatLimiter?: { take(keys: string[], chars: number): number };
  now?: () => Date;
  /** The teams a coach may play in the recorder (tabletop fixtures): library teams and Roster Builder saves. */
  recorderTeams?: (coach: string) => Array<{ ref: string; name: string; race?: string; tv?: number | null }>;
  /** Creates the tabletop match (createMatch); 201 { match: { id } } on success. */
  startTabletop?: (input: StartTabletopInput) => Promise<{ status: number; body: unknown }>;
  /**
   * The unfinished recorder match for this fixtureRef (recovery of an interrupted or refused START), adopted only when
   * its coaches and teams are the fixture's current ones (`{ error }` otherwise); missing lobby submissions are re-added.
   * undefined = there is none.
   */
  adoptMatch?: (input: StartTabletopInput) => Promise<{ matchId: string } | { error: string } | undefined>;
}

/** What START sends to the recorder (and what a recovery checks an open match against): the fixture's current coaches,
 *  the locked recorder teams and the resolved lists by coach. */
function startInput(fx: LobbyFixture, rec: LobbyRecord, actor: string, organiser: boolean, resolution: LobbyRecord["resolved"]): StartTabletopInput {
  const team = (s: LobbySide) => ({ coach: fx.sides[s].coachId, team: rec.sides[s].teamRef ?? "" });
  return {
    actor, organiser, fixtureRef: fx.start.fixtureRef, home: team("home"), away: team("away"), extra: fx.start.extra,
    inducementsByCoach: resolution ? {
      [fx.sides.home.coachId.trim().toLowerCase()]: resolution.home,
      [fx.sides.away.coachId.trim().toLowerCase()]: resolution.away,
    } : {},
  };
}

export const LOBBY_ACTIONS = ["presence", "chat", "roster", "ready", "inducements", "start"] as const;
export type LobbyAction = (typeof LOBBY_ACTIONS)[number];
export const isLobbyAction = (v: unknown): v is LobbyAction => typeof v === "string" && (LOBBY_ACTIONS as readonly string[]).includes(v);

const NO_STORE = { "cache-control": "private, no-store" };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LobbyResult => ({ status, headers: NO_STORE, body: { error, ...extra } });
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

const onlineOf = (fx: LobbyFixture, deps: Pick<LobbyDeps, "presence">): Record<LobbySide, boolean> =>
  ({ home: deps.presence.online(fx.key, fx.sides.home.coachId), away: deps.presence.online(fx.key, fx.sides.away.coachId) });

export function viewerOf(fx: LobbyFixture, auth: LobbyAuth | undefined): LobbyViewer {
  if (!auth) return { kind: "spectator" };
  const side = LOBBY_SIDES.find((s) => same(fx.sides[s].coachId, auth.coach));
  if (side) return { kind: "side", side };
  return fx.isOrganiser(auth.coach) ? { kind: "organiser" } : { kind: "spectator" };
}

// ---- the view -----------------------------------------------------------------------------------------------------

export function lobbyView(fx: LobbyFixture, stored: LobbyRecord | undefined, auth: LobbyAuth | undefined, deps: LobbyDeps) {
  const now = deps.now?.() ?? new Date();
  const rec = stored ?? newLobby(fx, now);
  const viewer = viewerOf(fx, auth);
  const insider = viewer.kind !== "spectator";
  const organiser = Boolean(auth && fx.isOrganiser(auth.coach));
  const step = inducementStep(fx);
  const roles = tvRoles(fx);
  const gate = gateOf(fx, rec, onlineOf(fx, deps));
  const side = (s: LobbySide) => {
    const f = fx.sides[s];
    const st = rec.sides[s];
    const { file: _file, stars: _stars, ...team } = f.team;
    const visible = picksVisible(fx, rec, viewer, s);
    const priced = visible ? priceSide(fx, s, st.picks) : undefined;
    const own = viewer.kind === "side" && viewer.side === s;
    // a private roster (tournament snapshot): the mini roster and the Builder-bought list are for insiders only
    const shown = insider || !fx.rosterPrivate;
    return {
      coach: f.coach, coachId: f.coachId, team: shown ? team : { ...team, roster: [] }, standing: f.standing ?? null, stats: f.stats,
      ...(fx.teamLinks?.[s] ? { teamLink: fx.teamLinks[s] } : {}),
      online: deps.presence.online(fx.key, f.coachId),
      rosterLocked: st.rosterLocked, ready: st.ready,
      // the recorder team is the coach's own business (and the organisers')
      ...(own || organiser ? { teamRef: st.teamRef ?? null } : {}),
      inducements: {
        hasStep: sideHasStep(fx, s),
        role: s === roles.underdog ? "underdog" : s === roles.overdog ? "overdog" : "equal",
        locked: st.locked,
        ...(insider ? { autoBuy: st.autoBuy } : {}),
        budget: budgetFor(fx, rec, s),
        visible,
        picks: visible ? (priced && !("error" in priced) ? priced.lines : st.picks.map((p) => ({ id: p.id, name: p.id, qty: p.qty, cost: 0 }))) : null,
        total: priced && !("error" in priced) ? priced.total : null,
        // without the snapshot, the menu carries no Builder counts either (caps as the ruleset sets them)
        menu: menuFor(shown ? fx : { ...fx, prefilled: undefined }, s),
        prefilled: shown ? prefilledLines(fx, s) : null,
      },
    };
  };
  const fixed = viewer.kind === "side" && fx.mode === "tabletop" && fx.fixedTeams ? fx.fixedTeams[viewer.side] : undefined;
  const recorderTeams = fixed ? ("error" in fixed ? [] : [{ ref: fixed.ref, name: fixed.name, race: fixed.race, tv: fx.sides[(viewer as { side: LobbySide }).side].team.tv }])
    : viewer.kind === "side" && fx.mode === "tabletop" && auth
    ? (deps.recorderTeams?.(auth.coach) ?? []).filter((t) => fx.recorderTeamAllowed(viewer.side, t)).map((t) => ({ ref: t.ref, name: t.name, race: t.race ?? "", tv: t.tv ?? null }))
    : undefined;
  return {
    key: fx.key, source: fx.source, mode: fx.mode, open: fx.open, ...(fx.closedReason ? { closedReason: fx.closedReason } : {}),
    revision: rec.revision,
    header: fx.header, links: fx.links,
    viewer: {
      role: viewer.kind === "side" ? viewer.side : viewer.kind,
      signedIn: Boolean(auth),
      organiser,
      canChat: insider && Boolean(auth),
      canStart: insider && Boolean(auth) && gate.armed && !rec.started,
      canForce: organiser && gate.forceArmed && !gate.armed && !rec.started,
    },
    sides: { home: side("home"), away: side("away") },
    inducements: {
      step: !step, reason: step, rules: fx.rules, gap: roles.gap, underdog: roles.underdog ?? null, overdog: roles.overdog ?? null,
      overdogFinal: rec.overdogFinal === true,
    },
    gate,
    hold: rec.hold ? { ...rec.hold, banner: holdBanner(fx, rec.hold) } : null,
    started: rec.started ? { ...rec.started, to: rec.started.matchId ? `/tabletop/${encodeURIComponent(rec.started.matchId)}` : fx.links.fixture } : null,
    resolved: rec.started && rec.resolved ? rec.resolved : null,
    chat: insider && auth ? rec.chat.slice(-200).map((m) => (m.system ? { ...m, text: renderSystem(fx, m) } : m)) : null,
    headToHead: fx.headToHead,
    organisers: fx.organisers,
    ...(recorderTeams ? { recorderTeams } : {}),
    // a fixed team (tournaments): the roster lock plays it; `error` says why it cannot be locked
    ...(fixed ? { fixedTeam: "error" in fixed ? { error: fixed.error } : { ref: fixed.ref, name: fixed.name, race: fixed.race } } : {}),
  };
}
export type LobbyView = ReturnType<typeof lobbyView>;

// ---- routes -------------------------------------------------------------------------------------------------------

/** One lobby request. `input` is the parsed JSON body of a POST ({} for a GET). */
export async function lobbyRoute(
  method: string, action: string | undefined, fx: LobbyFixture, auth: LobbyAuth | undefined, input: Record<string, unknown>, deps: LobbyDeps,
): Promise<LobbyResult> {
  if (action === undefined) {
    if (method !== "GET" && method !== "HEAD") return fail(405, "Use GET.");
    let rec: LobbyRecord | undefined;
    try { rec = deps.store.get(fx.key); } catch { return fail(500, "Could not read this lobby right now."); }
    return { status: 200, headers: NO_STORE, body: lobbyView(fx, rec, auth, deps) };
  }
  if (!isLobbyAction(action)) return fail(404, "Not found.");
  if (method !== "POST") return fail(405, "Use POST.");
  if (!auth) return fail(401, "Sign in first.");
  const viewer = viewerOf(fx, auth);
  if (viewer.kind === "spectator") return fail(403, "Only the two coaches and the organisers can use this lobby.");
  const organiser = fx.isOrganiser(auth.coach);
  if (action === "presence") {
    deps.presence.beat(fx.key, auth.coach);
    return { status: 200, headers: NO_STORE, body: { ok: true } };
  }
  if (action === "chat") {
    const text = plainText(input.text, false);
    if (!text) return fail(400, "Write a message (plain text, one line).");
    if ([...text].length > CHAT_MAX_CHARS) return fail(400, `A message can be at most ${CHAT_MAX_CHARS} characters.`);
    const wait = deps.chatLimiter?.take([`lobby:${fx.key}:${auth.coach.trim().toLowerCase()}`], 0) ?? 0;
    if (wait > 0) return { ...fail(429, "You are sending messages too fast. Try again in a moment."), headers: { ...NO_STORE, "retry-after": String(wait) } };
  }
  return write(fx, auth, deps, async (rec, now) => {
    const at = now.toISOString();
    const whoSide = viewer.kind === "side" ? viewer.side : undefined;
    const target = (): LobbySide | LobbyResult => {
      const asked = input.side;
      if (asked === undefined) return whoSide ?? fail(400, 'side must be "home" or "away".');
      if (asked !== "home" && asked !== "away") return fail(400, 'side must be "home" or "away".');
      if (asked !== whoSide && !organiser) return fail(403, "You can only change your own side.");
      return asked;
    };
    const stamp = (s: LobbySide) => {
      const st = rec.sides[s];
      st.by = auth.coach;
      st.at = at;
      if (s !== whoSide) st.admin = true; else delete st.admin;
    };
    const closed = rec.started ? "The match has started." : !fx.open ? (fx.closedReason || "This fixture is closed.") : "";
    switch (action) {
      case "chat": {
        say(rec, { from: auth.coach, text: plainText(input.text, false)!, at, role: whoSide ?? "organiser" });
        return ok();
      }
      case "roster": {
        if (closed) return fail(409, closed);
        const s = target();
        if (typeof s !== "string") return s;
        if (typeof input.locked !== "boolean") return fail(400, "locked must be true or false.");
        const st = rec.sides[s];
        if (input.locked) {
          const fixedTeam = fx.mode === "tabletop" ? fx.fixedTeams?.[s] : undefined;
          if (fixedTeam) {
            // the competition plays a fixed team (tournaments: the submitted roster): no free choice
            if ("error" in fixedTeam) return fail(409, fixedTeam.error);
            if (typeof input.teamRef === "string" && input.teamRef !== fixedTeam.ref) return fail(400, `This fixture plays your submitted team (${fixedTeam.name}).`);
            st.teamRef = fixedTeam.ref;
          } else if (fx.mode === "tabletop") {
            const ref = typeof input.teamRef === "string" ? input.teamRef : st.teamRef;
            const teams = (deps.recorderTeams?.(fx.sides[s].coachId) ?? []).filter((t) => fx.recorderTeamAllowed(s, t));
            if (!ref || !teams.some((t) => t.ref === ref))
              return fail(400, `Lock the roster with your ${fx.sides[s].team.name} team (${fx.sides[s].team.race}). Add it to My teams if it is not listed.`);
            st.teamRef = ref;
          }
          if (!st.rosterLocked) system(rec, fx, s, `{${s}} locked their roster.`, at);
          st.rosterLocked = true;
        } else {
          if (st.rosterLocked) system(rec, fx, s, `{${s}} unlocked their roster.`, at);
          st.rosterLocked = false;
          st.ready = false;
        }
        stamp(s);
        return ok();
      }
      case "ready": {
        if (closed) return fail(409, closed);
        const s = target();
        if (typeof s !== "string") return s;
        if (typeof input.ready !== "boolean") return fail(400, "ready must be true or false.");
        const st = rec.sides[s];
        if (input.ready && !st.rosterLocked) return fail(409, "Lock the roster first.");
        if (st.ready !== input.ready) system(rec, fx, s, `{${s}} is ${input.ready ? "ready" : "no longer ready"}.`, at);
        st.ready = input.ready;
        stamp(s);
        return ok();
      }
      case "inducements": return inducementsWrite(fx, rec, auth, organiser, whoSide, input, at, closed, target, stamp);
      case "start": return startWrite(fx, rec, auth, organiser, input, now, deps, closed);
      default: return fail(404, "Not found.");
    }
  });
}

type Mutation = (rec: LobbyRecord, now: Date) => Promise<LobbyResult | "ok" | { ok: true; extra: Record<string, unknown> }>;
const ok = (): "ok" => "ok";

/** Read, mutate, save (when the mutation succeeded) and answer with the fresh view, one lobby at a time. */
async function write(fx: LobbyFixture, auth: LobbyAuth, deps: LobbyDeps, mutate: Mutation): Promise<LobbyResult> {
  return deps.store.withLobby(fx.key, async () => {
    const now = deps.now?.() ?? new Date();
    let rec: LobbyRecord;
    try { rec = deps.store.get(fx.key) ?? newLobby(fx, now); } catch { return fail(500, "Could not read this lobby right now."); }
    for (const s of LOBBY_SIDES) if (fx.sides[s].coachId && !rec.coaches.some((c) => same(c, fx.sides[s].coachId))) rec.coaches.push(fx.sides[s].coachId);
    // a locked fixed team that no longer holds (tournaments: the submitted save was edited) is unlocked first, with the
    // reason, so neither Ready nor START ever runs on another roster than the one that was locked
    const unlocked: string[] = [];
    for (const s of LOBBY_SIDES) {
      const why = rec.started ? "" : fixedTeamStale(fx, rec, s);
      if (!why) continue;
      Object.assign(rec.sides[s], { rosterLocked: false, ready: false });
      delete rec.sides[s].teamRef;
      system(rec, fx, s, `{${s}}'s roster was unlocked: ${why}`, now.toISOString());
      unlocked.push(why);
    }
    const out = await mutate(rec, now);
    if (out !== "ok" && !("ok" in out)) {
      if (!unlocked.length) return out;
      rec.revision += 1;
      rec.updatedAt = now.toISOString();
      try { deps.store.put(rec); } catch { /* re-derived on the next write */ }
      return fail(409, unlocked[0]!); // the cause, not its consequence ("has not locked their roster")
    }
    rec.revision += 1;
    rec.updatedAt = now.toISOString();
    if (rec.chat.length > CHAT_KEEP) rec.chat = rec.chat.slice(-CHAT_KEEP);
    try { deps.store.put(rec); } catch { return fail(500, "Could not save this lobby right now."); }
    return { status: 200, headers: NO_STORE, body: { ok: true, ...(out !== "ok" ? out.extra : {}), lobby: lobbyView(fx, rec, auth, deps) } };
  });
}

function say(rec: LobbyRecord, m: Omit<LobbyChatMessage, "id">): void {
  rec.chat.push({ id: randomBytes(6).toString("hex"), ...m });
}
/**
 * A system line, stored as a template (privacy finding 11-01): coach names are never written into the text. Tokens
 * {home} / {away} render as that seat's coach and {actor} as `actor`, at read time (renderSystem), so deletion only has
 * to anonymise the structured fields (from, actor) and the league fixture's own coach names.
 */
function system(rec: LobbyRecord, fx: LobbyFixture, about: LobbySide | undefined, template: string, at: string, actor?: string): void {
  say(rec, { from: about ? fx.sides[about].coachId : "", text: template, at, system: true, ...(about ? { role: about } : {}), ...(actor ? { actor } : {}) });
}

export function renderSystem(fx: Pick<LobbyFixture, "sides">, m: LobbyChatMessage): string {
  return m.text.replace(/\{(home|away|actor)\}/g, (_x, k: string) => (k === "actor" ? m.actor ?? "Someone" : fx.sides[k as LobbySide].coach || `The ${k} coach`));
}

async function inducementsWrite(
  fx: LobbyFixture, rec: LobbyRecord, auth: LobbyAuth, organiser: boolean, whoSide: LobbySide | undefined, input: Record<string, unknown>, at: string,
  closed: string, target: () => LobbySide | LobbyResult, stamp: (s: LobbySide) => void,
): Promise<LobbyResult | "ok"> {
  if (closed) return fail(409, closed);
  const reason = inducementStep(fx);
  if (reason) return fail(409, reason);
  const s = target();
  if (typeof s !== "string") return s;
  const st = rec.sides[s];
  const roles = tvRoles(fx);
  const coach = fx.sides[s].coach;
  if (!sideHasStep(fx, s)) return fail(409, `${fx.sides[s].team.name} buys no inducements before kick-off in this fixture (no treasury spending allowed or no treasury).`);
  // An organiser unlocks (any side). Unlocking the overdog reopens its list: a hold built on its spend is dropped.
  if (input.lock === false && st.locked) {
    if (!organiser) return fail(409, "Your inducements are locked. Ask an organiser to unlock them.");
    st.locked = false;
    delete st.lockedAt;
    if (s === roles.overdog) { delete rec.hold; delete rec.overdogFinal; }
    system(rec, fx, s, `An organiser unlocked {${s}}'s inducements.`, at);
    stamp(s);
    if (input.picks === undefined) return "ok";
  } else if (st.locked) {
    return fail(409, organiser ? "These inducements are locked: unlock them first (lock: false)." : "Your inducements are locked. Ask an organiser to unlock them.");
  }
  if (input.picks !== undefined) {
    const picks = parsePicks(input.picks);
    if ("error" in picks) return fail(400, picks.error);
    const priced = priceSide(fx, s, picks);
    if ("error" in priced) return fail(400, priced.error);
    st.picks = picks;
  }
  if (input.autoBuy !== undefined) {
    if (typeof input.autoBuy !== "boolean") return fail(400, "autoBuy must be true or false.");
    if (input.autoBuy && s !== roles.underdog) return fail(400, "Only the underdog (the lower team value) has Auto-Buy.");
    if (input.autoBuy && rec.hold) return fail(409, "START is already held for your pick: lock your list.");
    if (st.autoBuy !== input.autoBuy) system(rec, fx, s, `{${s}} ${input.autoBuy ? "armed" : "turned off"} Auto-Buy.`, at);
    st.autoBuy = input.autoBuy;
  }
  if (input.lock === true) {
    if (s === roles.underdog) {
      // §9.3: the underdog must lock their own list; nobody bypasses it.
      if (s !== whoSide) return fail(403, "The underdog locks their own inducements.");
      if (!rec.hold && !st.autoBuy) return fail(409, "Turn on Auto-Buy to lock before the start, or pick when START is pressed.");
    }
    const plan = planSide(fx, rec, s, st.picks);
    if ("error" in plan) return fail(409, plan.error);
    st.locked = true;
    st.lockedAt = at;
    // never the amount: the picks (and their total) stay hidden until both sides lock
    system(rec, fx, s, rec.hold && s === roles.underdog ? `{${s}} locked inducements. START is armed again.` : `{${s}} locked inducements.`, at);
  } else if (input.lock !== undefined && input.lock !== false) {
    return fail(400, "lock must be true or false.");
  }
  stamp(s);
  return "ok";
}

async function startWrite(
  fx: LobbyFixture, rec: LobbyRecord, auth: LobbyAuth, organiser: boolean, input: Record<string, unknown>, now: Date, deps: LobbyDeps, closed: string,
): Promise<LobbyResult | "ok" | { ok: true; extra: Record<string, unknown> }> {
  const startedBody = () => ({ ok: true as const, extra: { started: true, to: rec.started?.matchId ? `/tabletop/${encodeURIComponent(rec.started.matchId)}` : fx.links.fixture } });
  if (rec.started) return startedBody(); // idempotent: a second START answers with the first match
  if (closed) return fail(409, closed);
  const force = input.force === true;
  if (force && !organiser) return fail(403, "Only an organiser can force the start.");
  const at = now.toISOString();
  // An interrupted START (crash after the match was made): adopt that match instead of making another.
  if (rec.starting) {
    const prior = rec.starting;
    const res = prior.resolution;
    let found: { matchId: string } | { error: string } | undefined;
    try { found = await deps.adoptMatch?.(startInput(fx, rec, auth.coach, organiser, res)); } catch { return fail(500, "Could not check the recorder right now. Press START again."); }
    if (found && "error" in found) return fail(409, found.error);
    if (found) {
      rec.started = { at, by: prior.by, mode: "tabletop", matchId: found.matchId };
      if (res) rec.resolved = res;
      delete rec.starting;
      return startedBody();
    }
    delete rec.starting;
  }
  deps.presence.beat(fx.key, auth.coach); // the coach pressing START is here
  const outcome = resolveStart(fx, rec, { force, now, online: onlineOf(fx, deps) });
  if (outcome.kind === "refused") return fail(outcome.status, outcome.error);
  if (outcome.kind === "held") {
    const under = outcome.hold.underdog;
    rec.hold = outcome.hold;
    rec.overdogFinal = true;
    // the underdog's list stays pre-filled; it unlocks so they can adjust and lock again
    rec.sides[under].locked = false;
    delete rec.sides[under].lockedAt;
    rec.sides[under].autoBuy = false;
    const over = otherSide(under);
    system(rec, fx, over, outcome.hold.overdogSpend > 0
      ? `{${over}} spent ${kGold(outcome.hold.overdogSpend)} · {${under}} gets ${kGold(outcome.hold.overdogSpend)} more petty cash.`
      : `START held: {${under}} picks inducements now.`, at);
    return { ok: true, extra: { held: true, banner: outcome.banner } };
  }
  const resolution = outcome.resolution;
  const admin = force || (organiser && !LOBBY_SIDES.some((s) => same(fx.sides[s].coachId, auth.coach)));
  if (fx.mode === "fork") {
    rec.resolved = resolution;
    rec.started = { at, by: auth.coach, mode: "fork", ...(admin ? { admin: true as const } : {}) };
    system(rec, fx, undefined, `{actor} started the match${admin ? " (organiser)" : ""}. Launch it from the fixture page.`, at, auth.coach);
    return startedBody();
  }
  if (!deps.startTabletop) return fail(503, "The match recorder is not available on this server.");
  // written first (with the resolution), so a crash between the match and the lobby save never makes a second match
  // and the recovery can re-add the lobby submissions
  rec.starting = { opId: randomBytes(6).toString("hex"), at, by: auth.coach, resolution };
  try { deps.store.put({ ...rec }); } catch { return fail(500, "Could not save this lobby right now."); }
  let made: { status: number; body: unknown };
  try {
    made = await deps.startTabletop(startInput(fx, rec, auth.coach, organiser, resolution));
  } catch {
    // unknown outcome (the match may exist): the starting marker stays, and the next START adopts the match if there is one
    return fail(500, "Could not create the match right now. Press START again.");
  }
  let matchId = (made.body as { match?: { id?: unknown } } | null)?.match?.id;
  if (made.status !== 201 || typeof matchId !== "string") {
    // the recorder allows one unfinished match per fixture: a refusal because one exists means an earlier START made it
    const existing = await deps.adoptMatch?.(startInput(fx, rec, auth.coach, organiser, resolution)).catch(() => undefined);
    if (existing && "matchId" in existing) matchId = existing.matchId;
    else if (existing) {
      delete rec.starting; // createMatch made nothing; the open match belongs to other coaches or teams
      try { deps.store.put({ ...rec }); } catch { /* the marker is checked again on the next START */ }
      return fail(409, existing.error);
    } else {
      delete rec.starting; // a clean refusal: createMatch made nothing
      try { deps.store.put({ ...rec }); } catch { /* the marker is checked again on the next START */ }
      const error = (made.body as { error?: unknown } | null)?.error;
      return fail(made.status >= 400 ? made.status : 500, typeof error === "string" ? error : "Could not create the match.");
    }
  }
  if (typeof matchId !== "string") return fail(500, "Could not create the match.");
  delete rec.starting;
  rec.resolved = resolution;
  rec.started = { at, by: auth.coach, mode: "tabletop", matchId, ...(admin ? { admin: true as const } : {}) };
  const removed = resolution.stars.map((c) => `${c.name} (${c.kept ? `kept by {${c.kept}}` : "plays for neither team"})`);
  system(rec, fx, undefined, `{actor} started the match${admin ? " (organiser)" : ""}.${removed.length ? ` Star picked by both: ${removed.join(", ")}.` : ""}`, at, auth.coach);
  return startedBody();
}
