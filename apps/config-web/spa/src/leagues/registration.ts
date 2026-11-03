// League registration in the SPA (registration spec 2026-11-02 §5 (c), lane L6): the join sheet's team choices and request
// body, the words for an entry's state and the season's places, and two small controllers: the coach's join block
// (GET .../join, join / withdraw / "I've paid") and the organisers' Registrations tab (GET .../registrations, decisions).
// The server stays the authority for every rule (window, cap, per-race, existing teams, region, the season's rules).

import { reactive, type InjectionKey } from "vue";
import { ApiError, type BuilderSaveSummary, type EntryState, type LibraryTeam } from "../shared/api";
import type { ShareField } from "../account/sharing";
import { STATE_LABEL, STATE_TONE, utcLabel } from "../tournaments/registration";

export { STATE_LABEL, STATE_TONE, utcLabel };

type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** GET .../seasons/:seasonId/join: status (public facts). */
export interface LeagueJoinStatus {
  open: boolean;
  reason?: string;
  message?: string;
  approval: "auto" | "organiser";
  waitlist: boolean;
  allowExistingTeams: boolean;
  allowMidSeason: boolean;
  cap: number | null;
  perRace: number | null;
  entryFee: string;
  opensAt?: string;
  closesAt?: string;
  stage: "setup" | "registration" | "active" | "completed";
  midSeason: boolean;
  accepted: number;
  placesLeft: number | null;
  raceCounts: Record<string, number>;
  regions: string[];
  packageName: string;
  shareText: string;
  links?: { payPal?: string; venmo?: { handle: string; url: string } };
}

/** The coach's own entry (only they see it). */
export interface LeagueMyEntry {
  id: string;
  state: EntryState;
  teamName: string;
  race: string;
  kind: "new" | "existing";
  enteredAt: string;
  region?: string;
  position?: number;
  teamId?: string;
  midSeason?: boolean;
  refCode?: string;
  coachSaysPaid?: { at: string };
  paid?: boolean;
  reason?: string;
}

/** One row of the organisers' Registrations tab. Decided rows carry the decision only. */
export interface LeagueRegistrationRowView {
  id: string;
  coachId: string;
  state: EntryState;
  teamName: string;
  race: string;
  enteredAt: string;
  decided?: { by: string; at: string; reason?: string };
  kind?: "new" | "existing";
  submittedAt?: string;
  region?: string;
  players?: number;
  cost?: number;
  validation?: { ok: boolean; problems: string[] };
  shared?: { coach: string; preferredName?: string; email?: string; phones?: Array<{ number: string; label?: string }> };
  refCode?: string;
  coachSaysPaid?: { at: string };
  paid?: boolean;
  teamId?: string;
  midSeason?: boolean;
  position?: number;
  nextInLine?: boolean;
}

export interface LeagueRegistrationsView {
  counts: { accepted: number; pending: number; waitlisted: number; cap: number | null; placesLeft: number | null };
  settings: { approval: "auto" | "organiser"; waitlist: boolean; allowExistingTeams: boolean; allowMidSeason: boolean; cap: number | null; perRace: number | null; entryFee: string; stage: string; open: boolean; test: boolean };
  raceCounts: Record<string, number>;
  entries: LeagueRegistrationRowView[];
}

export interface JoinChoice {
  /** "save:<id>" or "library:<teamId>". */
  ref: string;
  kind: "new" | "existing";
  label: string;
  sub: string;
}

/**
 * The join sheet's team step: saves built in the Roster Builder's league mode for THIS season first (always allowed,
 * "new"), then, only when the organisers allow existing teams, the coach's other saves and library teams ("existing";
 * the server checks each against the season's rules at join).
 */
export function joinChoices(saves: readonly BuilderSaveSummary[], library: readonly LibraryTeam[], packageName: string, allowExisting: boolean): JoinChoice[] {
  const built = saves.filter((s) => s.packageName === packageName && !s.teamId);
  const out: JoinChoice[] = built.map((s) => ({ ref: `save:${s.id}`, kind: "new", label: s.name, sub: s.raceName ? `${s.raceName} · built for this season` : "Built for this season" }));
  if (!allowExisting) return out;
  const builtIds = new Set(built.map((s) => s.id));
  const linked = new Set(saves.map((s) => s.teamId).filter((id): id is string => Boolean(id)));
  for (const s of saves) {
    if (builtIds.has(s.id)) continue;
    out.push({ ref: `save:${s.id}`, kind: "existing", label: s.name, sub: s.raceName ? `${s.raceName} · Roster Builder save` : "Roster Builder save" });
  }
  for (const t of library) {
    if (linked.has(t.teamId) && saves.some((s) => s.teamId === t.teamId)) continue;
    out.push({ ref: `library:${t.teamId}`, kind: "existing", label: t.teamName, sub: t.race ? `${t.race} · Library team` : "Library team" });
  }
  return out;
}

export interface JoinDraft { teamRef: string; region: string; share: ShareField[]; acknowledged: boolean }

/** POST .../registrations: the team, the share picker (always sent, [] = nothing), the acknowledgement, the region. */
export function joinBody(draft: JoinDraft, hasRegions: boolean) {
  return {
    teamRef: draft.teamRef,
    share: draft.share,
    acknowledged: draft.acknowledged,
    ...(hasRegions && draft.region ? { region: draft.region } : {}),
  };
}

/** The Roster Builder in league mode for this season (lane L7). */
export const leagueBuilderHref = (leagueId: string, seasonId: string): string =>
  `/app/tournament-team-builder?league=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(seasonId)}`;

/** "PENDING", "WAITLIST #2", "ACCEPTED"... */
export function entryChip(e: Pick<LeagueMyEntry, "state" | "position">): string {
  return e.state === "waitlisted" && e.position ? `Waitlist #${e.position}` : STATE_LABEL[e.state];
}

export const isLiveEntry = (state: EntryState | undefined): boolean => state === "pending" || state === "waitlisted" || state === "accepted";

/** The approval mode in plain words (Confirm step). */
export function leagueApprovalWords(s: Pick<LeagueJoinStatus, "approval"> | null | undefined): string {
  return s?.approval === "auto" ? "Teams are accepted straight away while there are places." : "The organisers review every team. You'll hear when they decide.";
}

/** What joining now would give: pending (approval), in, the waitlist, or refused (full, no waitlist). */
export function joinOutcome(s: LeagueJoinStatus | null | undefined, race?: string): "accepted" | "pending" | "waitlisted" | "full" {
  if (!s || s.approval === "organiser") return "pending";
  const raceFull = Boolean(race && s.perRace !== null && (s.raceCounts[race] ?? 0) >= s.perRace);
  if ((s.placesLeft !== null && s.placesLeft <= 0) || raceFull) return s.waitlist ? "waitlisted" : "full";
  return "accepted";
}

/** "4 of 16 places left", "Full", "No team limit". */
export function leaguePlacesLine(s: LeagueJoinStatus | null | undefined): string {
  if (!s || s.cap === null || s.placesLeft === null) return "No team limit";
  if (s.placesLeft <= 0) return s.waitlist ? "Full: new teams join the waitlist" : "Full";
  return `${s.placesLeft} of ${s.cap} ${s.cap === 1 ? "place" : "places"} left`;
}

/** "Orc: 2 / 2, full" for the per-race limit ("" without one). */
export function raceLine(s: LeagueJoinStatus | null | undefined, race: string | undefined): string {
  if (!s || s.perRace === null || !race) return "";
  const n = s.raceCounts[race] ?? 0;
  return `${race}: ${n} / ${s.perRace}${n >= s.perRace ? ", full" : ""}`;
}

/** "12 / 16 teams · 3 pending · 2 waiting" for the Registrations band caption. */
export function leagueRegistrationsCaption(c: LeagueRegistrationsView["counts"]): string {
  return [
    c.cap === null ? `${c.accepted} ${c.accepted === 1 ? "team" : "teams"}` : `${c.accepted} / ${c.cap} teams`,
    ...(c.pending ? [`${c.pending} pending`] : []),
    ...(c.waitlisted ? [`${c.waitlisted} waiting`] : []),
  ].join(" · ");
}

/** The shared contact lines of a row (only what the coach granted). */
export function sharedLines(r: Pick<LeagueRegistrationRowView, "shared">): string[] {
  const s = r.shared;
  if (!s) return [];
  return [...(s.preferredName ? [s.preferredName] : []), ...(s.email ? [s.email] : []), ...(s.phones ?? []).map((p) => (p.label ? `${p.number} (${p.label})` : p.number))];
}

const errorText = (err: unknown, fallback: string): string => {
  if (err instanceof ApiError) {
    const body = err.data as { problems?: unknown } | undefined;
    const problems = Array.isArray(body?.problems) ? body!.problems.filter((p): p is string => typeof p === "string") : [];
    return problems.length ? `${err.message} ${problems.join(" ")}` : err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
};

const seasonPath = (leagueId: string, seasonId: string) => `/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`;

/** The coach's join block: the season's facts, their own entry, and their team options for the sheet. */
export function createLeagueJoin(deps: { api: Fetcher }) {
  const state = reactive({
    leagueId: "", seasonId: "", loaded: false, status: null as LeagueJoinStatus | null, mine: null as LeagueMyEntry | null,
    busy: "" as "" | "join" | "withdraw" | "claim", error: "", notice: "",
    options: { status: "idle" as "idle" | "loading" | "ok", saves: [] as BuilderSaveSummary[], library: [] as LibraryTeam[] },
  });
  let seq = 0;
  async function load(leagueId: string, seasonId: string): Promise<void> {
    const mine = ++seq;
    state.leagueId = leagueId;
    state.seasonId = seasonId;
    try {
      const res = await deps.api<{ status: LeagueJoinStatus; mine?: LeagueMyEntry }>(`${seasonPath(leagueId, seasonId)}/join`);
      if (mine !== seq) return;
      state.status = res.status;
      state.mine = res.mine ?? null;
    } catch {
      if (mine !== seq) return;
      state.status = null;
      state.mine = null;
    } finally {
      if (mine === seq) state.loaded = true;
    }
  }
  async function loadOptions(coach: string): Promise<void> {
    if (!coach) return;
    state.options.status = "loading";
    const [library, saves] = await Promise.all([
      deps.api<{ teams?: LibraryTeam[] }>(`/api/fork/library?coach=${encodeURIComponent(coach)}`).then((r) => r.teams ?? []).catch(() => [] as LibraryTeam[]),
      deps.api<{ saves?: BuilderSaveSummary[] }>("/api/fork/team-builder/saves").then((r) => r.saves ?? []).catch(() => [] as BuilderSaveSummary[]),
    ]);
    state.options = { status: "ok", library, saves };
  }
  async function run<T>(what: "join" | "withdraw" | "claim", task: () => Promise<T>): Promise<T | undefined> {
    state.busy = what;
    state.error = "";
    state.notice = "";
    try {
      return await task();
    } catch (err) {
      state.error = errorText(err, "That didn't work. Try again.");
      return undefined;
    } finally {
      state.busy = "";
    }
  }
  async function join(body: ReturnType<typeof joinBody>): Promise<boolean> {
    const out = await run("join", () => deps.api<{ registration?: LeagueMyEntry }>(`${seasonPath(state.leagueId, state.seasonId)}/registrations`, { method: "POST", body }));
    if (!out) return false;
    const s = out.registration?.state;
    state.notice = s === "pending" ? "Registration received. The organisers review every team."
      : s === "waitlisted" ? `It's full, so your team is on the waitlist${out.registration?.position ? ` (#${out.registration.position})` : ""}.`
        : "You're in.";
    await load(state.leagueId, state.seasonId);
    return true;
  }
  async function withdraw(): Promise<void> {
    const id = state.mine?.id;
    if (!id) return;
    const ok = await run("withdraw", () => deps.api(`${seasonPath(state.leagueId, state.seasonId)}/registrations/${encodeURIComponent(id)}/withdraw`, { method: "POST", body: {} }));
    if (ok !== undefined) { state.notice = "Your registration was withdrawn."; await load(state.leagueId, state.seasonId); }
  }
  async function claimPaid(paid: boolean): Promise<void> {
    const id = state.mine?.id;
    if (!id) return;
    const out = await run("claim", () => deps.api<{ registration?: LeagueMyEntry }>(`${seasonPath(state.leagueId, state.seasonId)}/registrations/${encodeURIComponent(id)}/paid-claim`, { method: "POST", body: { paid } }));
    if (out?.registration) state.mine = out.registration;
  }
  return { state, load, loadOptions, join, withdraw, claimPaid };
}
export type LeagueJoin = ReturnType<typeof createLeagueJoin>;
export const LEAGUE_JOIN_KEY: InjectionKey<LeagueJoin> = Symbol("league-join");

/** The organisers' Registrations tab. */
export function createLeagueRegistrations(deps: { api: Fetcher }) {
  const state = reactive({
    leagueId: "", seasonId: "", status: "idle" as "idle" | "loading" | "ok" | "error", error: "", data: null as LeagueRegistrationsView | null,
    busy: "", actionError: "", notice: "",
  });
  async function load(leagueId: string, seasonId: string): Promise<void> {
    state.leagueId = leagueId;
    state.seasonId = seasonId;
    state.status = "loading";
    try {
      state.data = await deps.api<LeagueRegistrationsView>(`${seasonPath(leagueId, seasonId)}/registrations`);
      state.status = "ok";
      state.error = "";
    } catch (err) {
      state.status = "error";
      state.error = errorText(err, "Can't load the registrations.");
    }
  }
  async function decide(id: string, verb: "accept" | "waitlist" | "decline" | "promote" | "remove", opts: { reason?: string; promote?: boolean } = {}): Promise<boolean> {
    state.busy = `${verb}:${id}`;
    state.actionError = "";
    state.notice = "";
    try {
      const out = await deps.api<{ midSeason?: boolean; changed?: boolean; promoted?: unknown[] }>(
        `${seasonPath(state.leagueId, state.seasonId)}/registrations/${encodeURIComponent(id)}/${verb}`,
        { method: "POST", body: { ...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}), ...(opts.promote ? { promote: true } : {}) } },
      );
      state.notice = out?.midSeason
        ? "Accepted. The season is in progress, so no fixtures were made: add them in the Fixtures editor."
        : verb === "accept" || verb === "promote" ? "Accepted. The team is in the season."
          : verb === "waitlist" ? "Moved to the waitlist." : verb === "decline" ? "Declined. The coach was told." : "Removed from the season.";
      await load(state.leagueId, state.seasonId);
      return true;
    } catch (err) {
      state.actionError = errorText(err, "That didn't work. Try again.");
      return false;
    } finally {
      state.busy = "";
    }
  }
  return { state, load, decide };
}
export type LeagueRegistrations = ReturnType<typeof createLeagueRegistrations>;
export const LEAGUE_REGISTRATIONS_KEY: InjectionKey<LeagueRegistrations> = Symbol("league-registrations");
