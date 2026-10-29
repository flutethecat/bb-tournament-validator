// Left nav trees (League / Tournament / Coach page) for the signed-in coach. Reads:
// GET /api/fork/tournaments?coach=me (active, upcoming and the last finished, every format, most recent first),
// GET /api/tournaments/:id (entrants + fixtures) and GET /api/tabletop/fixtures (the coach's unresolved fixtures),
// plus the coach-page GET /api/me/deadlines for the Deadlines count. No DOM; rendered by ShellNav.vue.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";
import type { TournamentDetailResponse, TournamentEntrant, TournamentFixture, TournamentListPage, TournamentSummary } from "../shared/api";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { rosterState } from "../tournaments/detail";
import { chipFor, type DeadlineChip, type DeadlineView } from "./deadlines";

export type ChipTone = "ok" | "soon" | "urgent" | "overdue" | "info" | "muted";

export interface TreeTeam {
  name: string;
  race: string;
  /** Race crest from our crest pack ("" = none). */
  crest: string;
  /** Uploaded team logo (http(s) only; rendered through Crest.vue). */
  logoUrl: string;
  validity: { label: string; tone: ChipTone };
  to: string;
}

export interface TreeTournament {
  id: string;
  name: string;
  status: { label: string; tone: ChipTone };
  to: string;
  team: TreeTeam | null;
  /** null = "No fixture yet". */
  fixture: { label: string; to: string } | null;
}

export interface CoachTreeState {
  coach: string;
  tournaments: TreeTournament[];
  deadlines: DeadlineView[];
  timezone: string;
  loading: boolean;
  loaded: boolean;
}

/** Cap on how many live / upcoming entries are expanded (one detail read each). */
export const MAX_TREE_TOURNAMENTS = 12;
/** Finished entries kept in the tree: the most recent few. */
export const MAX_FINISHED_TOURNAMENTS = 5;
/** A route change or window focus refetches the trees at most this often; invalidate() skips the wait. */
export const TREE_REFRESH_MS = 60_000;

interface TabletopFixtureRow {
  fixtureRef: string;
  tournament: { id: string; name: string } | null;
  round: number | null;
  home: { coach: string; teamName?: string };
  away: { coach: string; teamName?: string };
}

const same = (a: string | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
const enc = encodeURIComponent;

/** Status chip of a tournament row: Pending (registered, roster not valid yet) · Open · Live · Finished. "Valid" follows the
 *  tournament page's rosterState(): an organiser's roster verification (or rejection) wins over the validator. */
export function tournamentStatus(t: Pick<TournamentSummary, "status">, mine: TournamentEntrant | undefined): { label: string; tone: ChipTone } {
  if (t.status === "active") return { label: "Live", tone: "ok" };
  if (t.status === "completed") return { label: "Finished", tone: "muted" };
  if (t.status === "cancelled") return { label: "Cancelled", tone: "muted" };
  return mine && rosterState(mine) === "valid" ? { label: "Open", tone: "info" } : { label: "Pending", tone: "soon" };
}

/** Validity chip with the tournament page's rosterState() semantics; the problem count shows only when the validator's
 *  verdict stands (no organiser decision). */
export function validityChip(e: TournamentEntrant | undefined): { label: string; tone: ChipTone } {
  const roster = e ? rosterState(e) : "none";
  if (roster === "none") return { label: "No team", tone: "muted" };
  if (roster === "valid") return { label: "Valid", tone: "ok" };
  const n = e?.submission?.problemCount ?? 0;
  const validatorVerdict = e?.rosterVerifiedOverride === undefined && e?.submission?.valid === false;
  return { label: validatorVerdict && n > 0 ? `${n} problem${n === 1 ? "" : "s"}` : "Invalid", tone: "urgent" };
}

/** The coach's open fixture in a tournament: the latest unplayed one (highest round). */
export function openFixture(fixtures: TournamentFixture[], entrantId: string): TournamentFixture | undefined {
  return fixtures
    .filter((f) => (f.home.entrantId === entrantId || f.away?.entrantId === entrantId) && !f.result && f.status !== "completed" && f.status !== "cancelled" && f.status !== "dismissed")
    .sort((a, b) => b.roundNumber - a.roundNumber)[0];
}

/** One tree row from a tournament, its detail read and the coach's tabletop fixtures. */
export function treeTournament(
  t: TournamentSummary, detail: TournamentDetailResponse | undefined, coach: string, tabletop: TabletopFixtureRow[], art: ArtManifests,
): TreeTournament {
  const to = `/tournaments/${enc(t.id)}`;
  const entrants = detail?.entrants ?? [];
  const mine = entrants.find((e) => (t.myEntrantId && (e.id === t.myEntrantId || e.entrantId === t.myEntrantId)) || same(e.coachId, coach));
  const myId = mine?.entrantId ?? mine?.id ?? t.myEntrantId ?? "";
  const nameOf = (entrantId: string | undefined, coachName: string | undefined) => {
    const e = entrants.find((x) => x.id === entrantId || x.entrantId === entrantId);
    return e?.coachId || coachName || "";
  };
  let fixture: TreeTournament["fixture"] = null;
  const f = myId ? openFixture(detail?.scheduledMatches ?? [], myId) : undefined;
  if (f) {
    const home = f.home.entrantId === myId;
    const opp = home ? (f.away ? nameOf(f.away.entrantId, f.away.coach.ffbCoachId) : "") : nameOf(f.home.entrantId, f.home.coach.ffbCoachId);
    fixture = { label: `Round ${f.roundNumber} · ${opp ? `vs ${opp}` : "Bye"}`, to: `${to}?tab=rounds` };
  } else {
    const tf = tabletop.find((x) => x.tournament?.id === t.id);
    if (tf) {
      const opp = same(tf.home.coach, coach) ? tf.away.coach : tf.home.coach;
      fixture = { label: `${tf.round ? `Round ${tf.round} · ` : ""}vs ${opp}`, to: `${to}?tab=rounds` };
    }
  }
  const teamName = mine?.teamName || mine?.submission?.teamName || "";
  const race = mine?.race || mine?.submission?.race || "";
  const team: TreeTeam | null = mine
    ? {
        name: teamName || "Team not chosen",
        race,
        crest: resolveCrest(art, race),
        logoUrl: mine.logoUrl ?? "",
        validity: validityChip(mine),
        to: myId ? `${to}/team/${enc(myId)}` : `${to}?tab=entrants`,
      }
    : null;
  return { id: t.id, name: t.name, status: tournamentStatus(t, mine), to, team, fixture };
}

export function createCoachTree(deps: { api: Fetcher; now?: () => number }) {
  const clock = deps.now ?? Date.now;
  const state = reactive<CoachTreeState>({ coach: "", tournaments: [], deadlines: [], timezone: "", loading: false, loaded: false });
  let gen = 0;
  let art: ArtManifests | undefined;
  let inflight: Promise<void> | undefined;
  let loadedAt = 0;
  /** invalidate() during a fetch: fetch again once it lands (its data may predate the change). */
  let again = false;

  /** The coach's own entries in one status, most recent first, filtered and limited on the server (?coach=me), so a long
   *  alphabetical list never pushes them off the first pages. */
  async function mineIn(statusParam: string, limit: number): Promise<TournamentSummary[]> {
    const res = await deps.api<TournamentListPage>(`/api/fork/tournaments?${statusParam}coach=me&limit=${limit}`);
    return Array.isArray(res?.tournaments) ? res.tournaments : [];
  }

  async function load(coach: string, force = false): Promise<void> {
    if (!coach) {
      gen++;
      Object.assign(state, { coach: "", tournaments: [], deadlines: [], timezone: "", loading: false, loaded: false });
      return;
    }
    if (!force && state.coach === coach && state.loading && inflight) return inflight;
    if (!force && state.coach === coach && state.loaded) return;
    inflight = fetchFor(coach);
    return inflight;
  }

  async function fetchFor(coach: string): Promise<void> {
    const mine = ++gen;
    state.coach = coach;
    state.loading = true;
    const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
    const [active, upcoming, finished, tabletop, deadlines, crests] = await Promise.all([
      settle(mineIn("", MAX_TREE_TOURNAMENTS), [] as TournamentSummary[]),
      settle(mineIn("status=draft&", MAX_TREE_TOURNAMENTS), [] as TournamentSummary[]),
      settle(mineIn("status=completed&", MAX_FINISHED_TOURNAMENTS), [] as TournamentSummary[]),
      settle(deps.api<{ fixtures?: TabletopFixtureRow[] }>("/api/tabletop/fixtures").then((r) => (Array.isArray(r?.fixtures) ? r.fixtures : [])), [] as TabletopFixtureRow[]),
      settle(deps.api<{ timezone?: string; deadlines?: DeadlineView[] }>("/api/me/deadlines"), {} as { timezone?: string; deadlines?: DeadlineView[] }),
      art ? Promise.resolve(art.crests) : settle(deps.api<ArtManifests["crests"]>("/crests/manifest.json"), undefined),
    ]);
    art = { crests };
    const seen = new Set<string>();
    const mineOnly = (t: TournamentSummary) => Boolean(t && typeof t.id === "string" && t.myEntrantId && !t.myDroppedAt && !seen.has(t.id) && seen.add(t.id));
    const recent = (t: TournamentSummary) => t.endsAt ?? t.startedAt ?? t.startsAt ?? "";
    const entered = [
      ...[...active, ...upcoming].filter(mineOnly).slice(0, MAX_TREE_TOURNAMENTS),
      ...finished.filter(mineOnly).sort((a, b) => recent(b).localeCompare(recent(a))).slice(0, MAX_FINISHED_TOURNAMENTS),
    ];
    const details = await Promise.all(entered.map((t) => settle(deps.api<TournamentDetailResponse>(`/api/tournaments/${enc(t.id)}`), undefined)));
    if (mine !== gen) return;
    state.tournaments = entered.map((t, i) => treeTournament(t, details[i], coach, tabletop, art!));
    state.deadlines = Array.isArray(deadlines.deadlines) ? deadlines.deadlines : [];
    state.timezone = typeof deadlines.timezone === "string" ? deadlines.timezone : "";
    state.loading = false;
    state.loaded = true;
    loadedAt = clock();
    if (again) { again = false; inflight = fetchFor(coach); }
  }

  /** Bounded refresh (route change, window focus): refetches the signed-in coach's trees when the last read is older than
   *  TREE_REFRESH_MS. */
  function refresh(): Promise<void> {
    if (!state.coach || state.loading || !state.loaded || clock() - loadedAt < TREE_REFRESH_MS) return inflight ?? Promise.resolve();
    inflight = fetchFor(state.coach);
    return inflight;
  }

  /** Something the trees show just changed (register / withdraw / submit / confirm, availability saved): refetch now. */
  function invalidate(): Promise<void> {
    if (!state.coach) return Promise.resolve();
    if (state.loading) { again = true; return inflight ?? Promise.resolve(); }
    inflight = fetchFor(state.coach);
    return inflight;
  }

  return {
    state,
    load,
    refresh,
    invalidate,
    /** The nearest deadline's chip (recomputed against now), or undefined when there is none. */
    nearestChip(now = new Date()): DeadlineChip | undefined {
      const first = state.deadlines[0];
      return first ? chipFor(first.at, now) : undefined;
    },
  };
}

export type CoachTree = ReturnType<typeof createCoachTree>;
export const COACH_TREE_KEY: InjectionKey<CoachTree> = Symbol("coach-tree");

/** Which of the given row targets is the active one for a route's fullPath: an exact match first, else a row whose
 *  path (query and hash stripped) equals the route's path and carries no query or hash of its own. */
export function pickActive(targets: readonly string[], fullPath: string): string | undefined {
  if (targets.includes(fullPath)) return fullPath;
  const bare = (s: string) => s.split(/[?#]/)[0]!;
  return targets.find((t) => t === bare(t) && t === bare(fullPath));
}
