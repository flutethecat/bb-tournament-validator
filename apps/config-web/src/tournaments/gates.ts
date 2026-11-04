/**
 * Tournament Registration gate: routes and the minute job (cleanup lane 11-03). The rules and the read model are in
 * ./registrationGate.ts; this mirrors the league gate routes (src/leagues/gates.ts) for one gate per tournament.
 *
 *   GET  /api/tournaments/:id/gates                                 everyone who can see the tournament: the gate and its countdown
 *   PUT  /api/tournaments/:id/gates/registration/tournament         managers: { revision, mode: "off" | "time", opensAt? (an ISO instant;
 *                                                                   the page converts the organiser's local time. A bare wall time
 *                                                                   from an older page answers 409 { code: "reload" }) }
 *   POST /api/tournaments/:id/gates/registration/tournament/open    managers: { revision } ("Open now")
 *
 * Writes are revision-checked (428 missing, 409 stale) and judged against the tournament as it is now; GETs change nothing.
 * Opening (the job at the time, or Open now) is written BEFORE anyone is told, so the one organiser note and the one Discord
 * post go once across restarts. Discord goes through the cleaned sender (postRaw: an unpublished tournament never posts), only
 * when the tournament has a webhook; the observer's own "Registration is open" marker is marked so one opening = one post.
 * The server-side check is the registration core's window (publication.ts tournamentCompetition carries the shut gate), so the
 * entry routes, re-entry and the commit guard all refuse while it is shut.
 */
import type { NotificationInput } from "../notifications.js";
import type { DiscordPayload, WebhookPoster } from "../leagues/discord.js";
import { postWebhook as defaultPoster } from "../leagues/discord.js";
import { simplePost } from "../discord/posts.js";
import { postRaw, tournamentTarget } from "../discord/targets.js";
import type { DiscordStateStore } from "../discord/store.js";
import { canSeeTournament, selfRegistrationStatus } from "./publication.js";
import { isTournamentManager, TournamentStoreError, type TournamentStore } from "./store.js";
import type { TournamentRecord } from "./types.js";
import {
  GATE_ID, gateInstant, gateIsOpen, postedMarker, regopenAnnounced, regopenMarker, gateWallInstant, parseGateWall, parseInstant, storedGate, tournamentGateView, tournamentTimeZone, UTC, utcWhenText, type TournamentGate,
} from "./registrationGate.js";

export interface TournamentGateDeps {
  store: TournamentStore;
  notify?: { managers(tournamentId: string, input: NotificationInput, except?: string): void };
  /** The Discord state (webhooks, options and the observer's ledger) and the poster. Absent = no Discord post. */
  discord?: { state: Pick<DiscordStateStore, "config" | "webhook" | "mark" | "entry">; poster?: WebhookPoster };
  ifMatch?: string;
}

interface Who { coach: string; admin: boolean }
type Result = { status: number; body: unknown; headers?: Record<string, string> };
const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): Result => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => res(status, { error, ...extra });

const GATE_PATH = /^\/api\/tournaments\/([^/]+)\/gates(?:\/(registration)\/(tournament)(?:\/(open))?)?$/;

function revisionOf(input: Record<string, unknown>, ifMatch: string | undefined): number | "missing" | "bad" {
  const raw = input.revision ?? (ifMatch !== undefined ? Number(ifMatch.replace(/"/g, "")) : undefined);
  if (raw === undefined || raw === null) return "missing";
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : "bad";
}

const manages = (t: TournamentRecord, who: Who | undefined): boolean => Boolean(who && (who.admin || isTournamentManager(t, who.coach)));

/** The routes (undefined when the path is not a gate route). */
export async function tournamentGateRoutes(method: string, path: string, auth: Who | undefined, body: unknown, deps: TournamentGateDeps, now: Date): Promise<Result | undefined> {
  const m = GATE_PATH.exec(path);
  if (!m) return undefined;
  let id: string;
  try { id = decodeURIComponent(m[1]!); } catch { return fail(400, "Invalid tournament id."); }
  const read = method === "GET" || method === "HEAD";
  if (!m[2]) {
    if (!read) return fail(405, "Use GET.");
    const t = deps.store.tournament(id);
    if (!t || !canSeeTournament(t, auth ? { coach: auth.coach, admin: auth.admin } : undefined)) return fail(404, "Tournament not found.");
    const manage = manages(t, auth);
    const view = tournamentGateView(t, now);
    return {
      status: 200, headers: auth || t.unpublished ? { ...NO_STORE } : { "cache-control": "no-cache" },
      body: {
        // Instants only (owner 11-04): the page shows them in the viewer's zone. "UTC" for pages that still read a zone.
        timeZone: UTC, now: now.toISOString(), manage, gates: view ? [view] : [],
        ...(manage ? { retired: t.registrationGateRetired !== undefined ? { [GATE_ID]: t.registrationGateRetired } : {}, unreadable: storedGate(t) === "unreadable" } : {}),
      },
    };
  }
  const open = m[4] === "open";
  if (open ? method !== "POST" : method !== "PUT") return fail(405, open ? "Use POST." : "Use PUT.");
  if (!auth) return fail(401, "Sign in to manage this tournament.");
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "A JSON object is required.");
  const input = body as Record<string, unknown>;
  const asked = revisionOf(input, deps.ifMatch);
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  const iso = now.toISOString();
  type Outcome = { result: Result; announce?: number };
  let outcome: Outcome;
  try {
    // One synchronous read-modify-write of the tournament (judged as it is now).
    outcome = deps.store.updateTournamentRecord(id, (t): Outcome => {
      if (!canSeeTournament(t, { coach: auth.coach, admin: auth.admin })) return { result: fail(404, "Tournament not found.") };
      if (!manages(t, auth)) return { result: fail(403, "You are not this tournament's organizer.") };
      if (t.status === "completed" || t.status === "cancelled") return { result: fail(409, `${t.name} is finished.`) };
      const stored = storedGate(t);
      const existing = stored === "unreadable" ? undefined : stored;
      const base = existing?.revision ?? t.registrationGateRetired ?? 0;
      if (asked === "missing") return { result: fail(428, "Name the gate's revision. Reload and try again.", { revision: base }) };
      if (asked !== base) return { result: fail(409, "Someone changed this gate since you opened it. Reload to see the latest.", { revision: base }) };
      const zone = tournamentTimeZone(t);
      if (open) {
        if (!existing) return { result: fail(404, "There is no gate on registration: it is already open.") };
        if (existing.state === "open" || gateIsOpen(existing, gateInstant(existing, zone), now.getTime())) return { result: fail(409, "This gate is already open.") };
        Object.assign(existing, { state: "open", openedBy: "organiser", openedAt: iso, announce: "pending", revision: existing.revision + 1, updatedAt: iso } satisfies Partial<TournamentGate>);
        return { result: res(200, { gate: tournamentGateView(t, now) }), announce: existing.revision };
      }
      if (input.mode === "off") {
        if (!existing && stored !== "unreadable") return { result: res(200, { gate: null, removed: false, revision: base }) };
        const last = existing?.revision ?? base;
        delete t.registrationGate;
        t.registrationGateRetired = last;
        // The arming it had stays the "already announced" cutoff (switching off is never a re-arm).
        if (existing?.armedAt) t.registrationGateRetiredArmedAt = existing.armedAt;
        return { result: res(200, { gate: null, removed: true, revision: last }) };
      }
      if (input.mode !== "time") return { result: fail(400, 'mode must be "off" or "time".', { field: "mode" }) };
      // An instant only. A bare wall time comes from an editor of the previous build, whose zone can't be known (it showed
      // UTC or the tournament's zone depending on when it loaded): refused, never guessed (Sol round 2).
      if (parseInstant(input.opensAt) === undefined && parseGateWall(input.opensAt)) return { result: fail(409, "This page is out of date. Reload to edit the gate.", { code: "reload" }) };
      const at = parseInstant(input.opensAt);
      if (at === undefined) return { result: fail(400, "Opens at must be a date and time.", { field: "opensAt" }) };
      if (at < now.getTime() - 60_000) return { result: fail(400, "Pick a time still to come, or use Open now.", { field: "opensAt" }) };
      if (at > now.getTime() + 366 * 86_400_000) return { result: fail(400, "Opens at must be within a year.", { field: "opensAt" }) };
      t.registrationGate = { opensAt: new Date(at).toISOString(), armedAt: iso, state: "shut", revision: base + 1, createdAt: existing?.createdAt ?? iso, updatedAt: iso };
      delete t.registrationGateRetired;
      return { result: res(existing ? 200 : 201, { gate: tournamentGateView(t, now) }) };
    }, now);
  } catch (e) {
    if (e instanceof TournamentStoreError) return fail(e.status, e.message);
    return fail(500, "Could not save the gate right now.");
  }
  if (outcome.announce !== undefined) await announceOpening(deps, id, outcome.announce, now, auth.coach);
  return outcome.result;
}

/**
 * The opening's announcement, once: "done" is written first (a failed write tells nobody; the job retries), then one note to the
 * organisers (minus the one who opened it) and one Discord post when the tournament has a webhook.
 */
async function announceOpening(deps: TournamentGateDeps, id: string, revision: number, now: Date, actor?: string): Promise<void> {
  let t: TournamentRecord;
  try {
    const claimed = deps.store.updateTournamentRecord(id, (rec) => {
      const g = storedGate(rec);
      if (!g || g === "unreadable" || g.state !== "open" || g.revision !== revision || g.announce !== "pending") return undefined;
      g.announce = "done";
      return structuredClone(rec);
    }, now, { touch: false });
    if (!claimed) return;
    t = claimed;
  } catch { return; }
  // Announced as open only when registration really is open now (the gate AND the window: a gate that opens before the
  // window's opensAt says so, and the Discord observer posts "Registration is open" when the window opens).
  const round1 = deps.store.rounds(id).some((r) => r.number === 1);
  const status = selfRegistrationStatus(t, round1, now);
  const later = !status.open && status.reason === "not-yet-open" && t.registration?.opensAt ? t.registration.opensAt : undefined;
  try {
    deps.notify?.managers(id, status.open ? {
      type: "registration", title: `Registration is open: ${t.name}`.slice(0, 120),
      body: `${t.name}: registration is open${t.registrationGate?.openedBy === "organiser" ? " (opened early by an organiser)" : ""}.`,
      link: `/app/tournaments/${encodeURIComponent(id)}/manage#tn-reg-h`,
    } : {
      type: "registration", title: `Registration gate opened: ${t.name}`.slice(0, 120),
      body: `${t.name}: the registration gate is open. ${later ? `Registration itself opens ${utcWhenText(later)}.` : status.message}`,
      link: `/app/tournaments/${encodeURIComponent(id)}/manage#tn-reg-h`,
    }, actor);
  } catch { /* fire-and-forget */ }
  if (!deps.discord || !status.open) return;
  const target = tournamentTarget(deps.discord.state, t);
  // One opening = one post, whichever timer gets there first: the marker the observer uses too (the window's opensAt plus this
  // gate arming, regopenMarker). Posted only when this call is the one that claimed it; a re-armed gate has a new marker.
  const marker = regopenMarker(t);
  if (!marker) return;
  // Already announced since the gate's last arming (by the observer or an earlier opening): no second post.
  try { if (regopenAnnounced(deps.discord.state.entry(target.key)?.seen, t)) return; } catch { return; }
  let fresh: string[] = [];
  try { fresh = deps.discord.state.mark(target.key, [marker], now.toISOString()); } catch { return; }
  if (!fresh.includes(marker)) return;
  const payload: DiscordPayload = simplePost(t.name, "registrationOpened", "Registration is open: register on the tournament page.", { test: t.test === true });
  let posted = false;
  try { posted = await postRaw(target, payload, deps.discord.poster ?? defaultPoster); } catch { /* best effort */ }
  // Only a post that went out counts as announced (a draft or no webhook claims the marker quietly).
  if (posted) { try { deps.discord.state.mark(target.key, [postedMarker(marker)], now.toISOString()); } catch { /* best effort */ } }
}

/** Every minute (server.ts; never from a GET): due gates open (written first), then each unannounced opening is announced. */
export async function runTournamentGateJob(deps: TournamentGateDeps & { now?: () => Date }): Promise<{ opened: string[]; failed: string[] }> {
  const now = deps.now?.() ?? new Date();
  const out = { opened: [] as string[], failed: [] as string[] };
  let list: TournamentRecord[];
  try { list = Object.values(deps.store.snapshot().tournaments); } catch { return out; }
  for (const listed of list) {
    if (!listed.registrationGate) continue;
    let work: number | undefined;
    try {
      work = deps.store.updateTournamentRecord(listed.id, (t) => {
        const g = storedGate(t);
        if (!g || g === "unreadable") return undefined;
        if (g.state === "shut") {
          const at = gateInstant(g, tournamentTimeZone(t));
          if (at === undefined || at > now.getTime()) return undefined;
          Object.assign(g, { state: "open", openedBy: "schedule", openedAt: now.toISOString(), announce: "pending", revision: g.revision + 1, updatedAt: now.toISOString() } satisfies Partial<TournamentGate>);
          out.opened.push(t.id);
        }
        return g.announce === "pending" ? g.revision : undefined;
      }, now, { touch: false });
    } catch { out.failed.push(listed.id); continue; }
    if (work !== undefined) await announceOpening(deps, listed.id, work, now);
  }
  return out;
}
