// Leagues (/app/leagues, /app/leagues/:id, /app/leagues/:id/stats): controllers over the public league API and pure
// display helpers. No DOM; rendered by LeagueListView / LeagueDetailView / LeagueStatsView.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import { resolveCrest } from "../tabletop/art";
import type { Fetcher } from "../session";
import type {
  FormerPlayer, HonourTable, HonourValue, LeagueFixture, LeaguePhase, LeaguePlayer, LeagueStats, LeagueSummary, LeagueTeam, SeasonRecord, SeasonSummary, StatsScope,
} from "./types";

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

// ---- list ----

export function createLeagueList(deps: { api: Fetcher }) {
  const state = reactive({ leagues: [] as LeagueSummary[], loaded: false, loading: false, error: "" });
  async function load(): Promise<void> {
    state.loading = true;
    try {
      const res = await deps.api<{ leagues?: LeagueSummary[] }>("/api/leagues");
      state.leagues = Array.isArray(res?.leagues) ? res.leagues : [];
      state.error = "";
    } catch (err) {
      state.leagues = [];
      state.error = errorText(err, "Can't load leagues.");
    } finally {
      state.loaded = true;
      state.loading = false;
    }
  }
  return { state, load };
}
export type LeagueList = ReturnType<typeof createLeagueList>;
export const LEAGUE_LIST_KEY: InjectionKey<LeagueList> = Symbol("league-list");

// ---- detail ----

export type LeagueTab = "overview" | "standings" | "fixtures" | "teams" | "honours";
export const LEAGUE_TABS: ReadonlyArray<{ id: LeagueTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "standings", label: "Standings" },
  { id: "fixtures", label: "Fixtures" },
  { id: "teams", label: "Teams" },
  { id: "honours", label: "Honours" },
];
export const isLeagueTab = (v: unknown): v is LeagueTab => typeof v === "string" && LEAGUE_TABS.some((t) => t.id === v);

export interface LeagueDetailState {
  id: string;
  league: LeagueSummary | null;
  seasons: SeasonSummary[];
  loaded: boolean;
  error: string;
  /** Full seasons by id, loaded on demand. */
  season: Record<string, SeasonRecord>;
  seasonLoading: string;
  seasonError: string;
  /** Race crest manifest (key -> path), best effort. */
  crests: Record<string, string>;
  /** Artwork write in flight ("logo" | "banner") and its outcome. */
  artBusy: string;
  artError: string;
  artNotice: string;
}

export type RawUploader = (path: string, body: Blob) => Promise<unknown>;

const fetchUpload: RawUploader = async (path, body) => {
  const res = await fetch(path, {
    method: "PUT", credentials: "same-origin", headers: { "x-cw-auth": "1", "content-type": body.type || "application/octet-stream" }, body,
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Upload failed (${res.status}).`);
  return data;
};

export function createLeagueDetail(deps: { api: Fetcher; upload?: RawUploader }) {
  const state = reactive<LeagueDetailState>({
    id: "", league: null, seasons: [], loaded: false, error: "", season: {}, seasonLoading: "", seasonError: "", crests: {},
    artBusy: "", artError: "", artNotice: "",
  });
  async function load(id: string): Promise<void> {
    state.id = id;
    try {
      const res = await deps.api<{ league: LeagueSummary; seasons: SeasonSummary[] }>(`/api/leagues/${encodeURIComponent(id)}`);
      state.league = res.league;
      state.seasons = [...(res.seasons ?? [])].sort((a, b) => b.number - a.number);
      state.error = "";
    } catch (err) {
      state.league = null;
      state.seasons = [];
      state.error = err instanceof ApiError && err.status === 404 ? "League not found." : errorText(err, "Can't load this league.");
    } finally {
      state.loaded = true;
    }
    try {
      const m = await deps.api<{ crests?: Record<string, string> }>("/crests/manifest.json");
      state.crests = m?.crests ?? {};
    } catch { /* no crests: initials badges */ }
  }
  async function ensureSeason(seasonId: string): Promise<void> {
    if (!seasonId || state.season[seasonId]) return;
    state.seasonLoading = seasonId;
    try {
      const res = await deps.api<{ season: SeasonRecord }>(`/api/leagues/${encodeURIComponent(state.id)}/seasons/${encodeURIComponent(seasonId)}`);
      state.season[seasonId] = res.season;
      state.seasonError = "";
    } catch (err) {
      state.seasonError = errorText(err, "Can't load this season.");
    } finally {
      if (state.seasonLoading === seasonId) state.seasonLoading = "";
    }
  }
  async function refreshLeague(): Promise<void> {
    try { state.league = (await deps.api<{ league: LeagueSummary }>(`/api/leagues/${encodeURIComponent(state.id)}`)).league; } catch { /* keep */ }
  }
  async function art(kind: "logo" | "banner", task: () => Promise<unknown>, done: string): Promise<void> {
    state.artBusy = kind; state.artError = ""; state.artNotice = "";
    try {
      await task();
      await refreshLeague();
      state.artNotice = done;
    } catch (err) {
      state.artError = errorText(err, "That did not save.");
    } finally {
      state.artBusy = "";
    }
  }
  const base = (): string => `/api/leagues/${encodeURIComponent(state.id)}`;
  const label = (kind: "logo" | "banner"): string => (kind === "logo" ? "Logo" : "Header bar");
  return {
    state, load, ensureSeason,
    uploadArt: (kind: "logo" | "banner", image: Blob) => art(kind, () => (deps.upload ?? fetchUpload)(`${base()}/${kind}`, image), `${label(kind)} updated.`),
    removeArt: (kind: "logo" | "banner") => art(kind, () => deps.api(`${base()}/${kind}`, { method: "DELETE" }), `${label(kind)} removed.`),
  };
}

/** Organisers (trimmed, case-insensitive coach id) and admins may change the league artwork. */
export function canManageLeague(league: Pick<LeagueSummary, "organisers"> | null, coach: string, admin: boolean): boolean {
  if (!league || !coach) return false;
  const me = coach.trim().toLowerCase();
  return admin || league.organisers.some((o) => o.trim().toLowerCase() === me);
}
export type LeagueDetail = ReturnType<typeof createLeagueDetail>;
export const LEAGUE_DETAIL_KEY: InjectionKey<LeagueDetail> = Symbol("league-detail");

/** The season the page shows: the asked id when the league has it, else the newest. */
export function pickSeason(seasons: SeasonSummary[], asked: unknown): SeasonSummary | undefined {
  const id = Array.isArray(asked) ? asked[0] : asked;
  return seasons.find((s) => s.id === id) ?? [...seasons].sort((a, b) => b.number - a.number)[0];
}

// ---- stats ----

export const STATS_SCOPES: ReadonlyArray<{ id: StatsScope; label: string }> = [
  { id: "bb2020", label: "BB2020" },
  { id: "bb2025", label: "BB2025" },
  { id: "all", label: "All time" },
];
export const isStatsScope = (v: unknown): v is StatsScope => v === "bb2020" || v === "bb2025" || v === "all";

export function createLeagueStats(deps: { api: Fetcher }) {
  const state = reactive({ id: "", scope: "all" as StatsScope, byScope: {} as Partial<Record<StatsScope, LeagueStats>>, league: null as LeagueSummary | null, loading: false, error: "" });
  async function load(id: string, scope: StatsScope): Promise<void> {
    if (state.id !== id) { state.byScope = {}; state.league = null; }
    state.id = id;
    state.scope = scope;
    if (!state.league) {
      try { state.league = (await deps.api<{ league: LeagueSummary }>(`/api/leagues/${encodeURIComponent(id)}`)).league; } catch { /* the stats call reports */ }
    }
    if (state.byScope[scope]) return;
    state.loading = true;
    try {
      state.byScope[scope] = await deps.api<LeagueStats>(`/api/leagues/${encodeURIComponent(id)}/stats?scope=${scope}`);
      state.error = "";
    } catch (err) {
      state.error = err instanceof ApiError && err.status === 404 ? "League not found." : errorText(err, "Can't load the statistics.");
    } finally {
      state.loading = false;
    }
  }
  return { state, load };
}
export type LeagueStatsCtl = ReturnType<typeof createLeagueStats>;
export const LEAGUE_STATS_KEY: InjectionKey<LeagueStatsCtl> = Symbol("league-stats");

// ---- display helpers ----

export const RULESET_TONE: Record<string, string> = { BB2020: "info", BB2025: "ok" };
export const SEASON_STATUS_LABEL: Record<string, string> = { active: "In progress", completed: "Finished" };

/** Only same-origin API paths render as images (the server sends /api/leagues/<id>/logo?v=...). */
export function safeArtUrl(url: unknown): string {
  return typeof url === "string" && /^\/api\/leagues\/[\w-]+\/(?:logo|banner)(?:\?v=[a-f0-9]{1,64})?$/.test(url) ? url : "";
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** "2026-05-29" or "". */
export function day(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function seasonDates(s: Pick<SeasonSummary, "startedAt" | "endedAt">): string {
  const a = day(s.startedAt);
  const b = day(s.endedAt);
  if (!a) return "Dates not recorded";
  return b && b !== a ? `${a} to ${b}` : a;
}

const PHASE_LABEL: Record<string, string> = { PreSeason: "Pre-season", PlayOffs: "Playoffs", Interdivision: "Interdivision" };
export const phaseLabel = (name: string): string => PHASE_LABEL[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
export function phaseTitle(p: Pick<LeaguePhase, "category" | "name">): string {
  return p.category && p.category !== "Season" ? `${p.category} ${phaseLabel(p.name)}` : phaseLabel(p.name);
}

export type SideOutcome = "win" | "draw" | "loss";

/**
 * The server's outcome rule (src/leagues/identity.ts fixtureOutcome): no result when unscored or a suspended 0-0
 * with no concession; a concession decides (the conceding side loses, whatever the recorded score); else the score.
 */
export function fixtureOutcome(f: Pick<LeagueFixture, "home" | "away" | "suspended">): { home: SideOutcome; away: SideOutcome } | undefined {
  if (f.home.score === null || f.away.score === null) return undefined;
  const hc = f.home.conceded;
  const ac = f.away.conceded;
  if (f.suspended && f.home.score === 0 && f.away.score === 0 && !hc && !ac) return undefined;
  if (hc && ac) return { home: "loss", away: "loss" };
  if (hc) return { home: "loss", away: "win" };
  if (ac) return { home: "win", away: "loss" };
  const d = f.home.score - f.away.score;
  return d > 0 ? { home: "win", away: "loss" } : d < 0 ? { home: "loss", away: "win" } : { home: "draw", away: "draw" };
}

/** A fixture with a result (see fixtureOutcome). */
export const fixturePlayed = (f: Pick<LeagueFixture, "home" | "away" | "suspended">): boolean => fixtureOutcome(f) !== undefined;

export const fixtureTime = (f: Pick<LeagueFixture, "finishedAt" | "startedAt">): string => f.finishedAt ?? f.startedAt ?? "";

/** Most recent finished fixtures, newest first. */
export function latestResults(season: SeasonRecord, limit = 9): LeagueFixture[] {
  return season.fixtures
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => fixturePlayed(f))
    .sort((a, b) => fixtureTime(b.f).localeCompare(fixtureTime(a.f)) || b.f.round - a.f.round || b.i - a.i)
    .slice(0, limit)
    .map(({ f }) => f);
}

/** "TABBL · Season 6 · Regular · Klickitat · Round 3". */
export function fixtureContext(league: Pick<LeagueSummary, "name">, season: Pick<SeasonRecord, "name">, f: LeagueFixture): string {
  const phase = f.category && f.category !== "Season" ? `${f.category} ${phaseLabel(f.phase)}` : phaseLabel(f.phase);
  return [league.name, season.name, phase, f.group, `Round ${f.round}`].filter(Boolean).join(" · ");
}

export interface RoundGroup { round: number; fixtures: LeagueFixture[]; played: number }
export interface PhaseGroup { phase: LeaguePhase; title: string; rounds: RoundGroup[] }

/** Fixtures by phase (season order) then round (ascending), tables in order. */
export function fixturesByPhase(season: SeasonRecord): PhaseGroup[] {
  return season.phases
    .map((phase) => {
      const rounds = new Map<number, LeagueFixture[]>();
      for (const f of season.fixtures) if (f.phaseId === phase.id) rounds.set(f.round, [...(rounds.get(f.round) ?? []), f]);
      return {
        phase,
        title: phaseTitle(phase),
        rounds: [...rounds].sort((a, b) => a[0] - b[0]).map(([round, fixtures]) => ({
          round,
          fixtures: fixtures.sort((a, b) => a.group.localeCompare(b.group) || a.table - b.table),
          played: fixtures.filter(fixturePlayed).length,
        })),
      };
    })
    .filter((g) => g.rounds.length);
}

/** Standings tables: one per phase + group, phases with no table left out. */
export function standingsTables(season: SeasonRecord): Array<{ key: string; title: string; note: string; rows: LeaguePhase["standings"] }> {
  const out: Array<{ key: string; title: string; note: string; rows: LeaguePhase["standings"] }> = [];
  for (const p of season.phases) {
    if (!p.standings.length || p.standings.every((r) => r.played === 0)) continue;
    const includes = (p.includes ?? []).map((id) => season.phases.find((x) => x.id === id)).filter(Boolean).map((x) => phaseLabel(x!.name));
    const note = includes.length ? `Includes ${includes.join(" and ")} games.` : "";
    const groups = [...new Set(p.standings.map((r) => r.group))];
    for (const g of groups) out.push({ key: `${p.id}:${g}`, title: g ? `${phaseTitle(p)} · ${g}` : phaseTitle(p), note, rows: p.standings.filter((r) => r.group === g) });
  }
  return out;
}

/** The team a ?team= value names: its id (exact), else a team name only when exactly one team has it. */
export function teamByRef(season: SeasonRecord, ref: string): LeagueTeam | undefined {
  const byId = season.teams.find((t) => t.id === ref);
  if (byId) return byId;
  const named = season.teams.filter((t) => t.name.trim().toLowerCase() === ref.trim().toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

/** Totals the export could not split between players, recorded once on this team. */
export const teamUnattributed = (season: SeasonRecord, team: LeagueTeam) => (season.unattributedStats ?? []).filter((u) => u.teamId === team.id);

/** The roster or former player a ?player= value names: its playerId, else an id the player held in an earlier season. */
export function playerByRef(season: SeasonRecord, ref: string): { team: LeagueTeam; player: LeaguePlayer | FormerPlayer } | undefined {
  if (!ref) return undefined;
  for (const exact of [true, false]) {
    for (const team of season.teams) {
      for (const player of [...team.players, ...team.formerPlayers]) {
        if (exact ? player.playerId === ref : player.previousIds?.includes(ref)) return { team, player };
      }
    }
  }
  return undefined;
}

/** Combined honour totals this player is one of the candidates for (the export could not split them). */
export const sharedTotalsFor = (season: SeasonRecord, playerId: string) => (season.unattributedStats ?? []).filter((u) => (u.candidates ?? []).includes(playerId));

/** Where a player's id opens: that season's Teams tab with the player highlighted. */
export const playerQuery = (seasonId: string, playerId: string): Record<string, string> => ({ season: seasonId, tab: "teams", player: playerId });

/** 885000 -> "885k", 1205000 -> "1,205k". */
export function kValue(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
}

const STAT_LABEL: Record<string, string> = {
  mosttouchdowns: "Most touchdowns", mostcasualties: "Most casualties", mostmvp: "Most MVPs", mostinterceptions: "Most interceptions",
  mostpass: "Most completions", mostdirtyplay: "Most fouls", mostinjuries: "Most injuries caused", mostsentoffs: "Most sent off",
  mostexperienced: "Most SPP", bestperformance: "Best performance", mostvaluebigguy: "Most valuable big guy", mostvalueblitzer: "Most valuable blitzer",
  mostvalueblocker: "Most valuable blocker", mostvaluecatcher: "Most valuable catcher", mostvaluelineman: "Most valuable lineman",
  mostvaluerunner: "Most valuable runner", mostvaluespecial: "Most valuable special", mostvaluestunty: "Most valuable stunty", mostvaluethrower: "Most valuable thrower",
  bestdefenseteam: "Best defence", bestperformanceteam: "Best performance", bestrun: "Best run", worstrun: "Worst run",
  mostcasualtiesagainstteam: "Most casualties suffered", mostcasualtiesfavorteam: "Most casualties caused", mostdeathsfavorteam: "Most kills",
  mostdirtyplayteam: "Most fouls", mostexperienceteam: "Most SPP", mostfanfactorteam: "Most fans", mostinjuriesagainstteam: "Most injuries suffered",
  mostinterceptionsteam: "Most interceptions", mostmatchresulthattricksteam: "Most hat-tricks", mostmatchresultmassacresteam: "Most massacres",
  mostmatchresultshutoutsteam: "Most shutouts", mostpassteam: "Most completions", mostsecretobjectives: "Most secret objectives",
  mostsentoffsteam: "Most sent off", mosttouchdownfavorteam: "Most touchdowns", mostvalueteam: "Highest team value",
  bestrace: "Best coach", beststunty: "Best stunty coach", coachraceexperience: "Most experienced coach", rankingposition: "Ranking position",
  bestbadlandsbrawl: "Best Badlands Brawl coach", bestchaosclash: "Best Chaos Clash coach", bestelvenkingdomsleague: "Best Elven Kingdoms League coach",
  bestfavouredof: "Best Favoured of... coach", besthalflingthimblecup: "Best Halfling Thimble Cup coach", bestlustriansuperleague: "Best Lustrian Superleague coach",
  bestoldworldclassic: "Best Old World Classic coach", bestsylvanianspotlight: "Best Sylvanian Spotlight coach", bestunderworldchallenge: "Best Underworld Challenge coach",
  bestwoodlandleague: "Best Woodland League coach", bestworldsedgesuperleague: "Best Worlds Edge Superleague coach",
};
export const honourLabel = (stat: string): string => STAT_LABEL[stat] ?? stat.replace(/^(most|best|worst)/, "$1 ").replace(/^./, (c) => c.toUpperCase());

/** The order honour boards appear in: player stat boards first (TD, CAS, MVP...), then team, then coach. */
const STAT_ORDER = ["mosttouchdowns", "mostcasualties", "mostmvp", "mostexperienced", "mostpass", "mostinterceptions", "mostdirtyplay", "mostinjuries", "mostsentoffs", "bestperformance"];
export function honourBoards(season: SeasonRecord): Array<{ title: string; kind: HonourTable["kind"]; tables: HonourTable[] }> {
  const rank = (t: HonourTable): number => { const i = STAT_ORDER.indexOf(t.stat); return i < 0 ? 100 : i; };
  const kinds: Array<[HonourTable["kind"], string]> = [["player", "Players"], ["team", "Teams"], ["coach", "Coaches"]];
  return kinds.map(([kind, title]) => ({
    title,
    kind,
    tables: season.honours
      .filter((t) => t.kind === kind && t.rows.length)
      .sort((a, b) => a.category.localeCompare(b.category) * -1 || rank(a) - rank(b) || honourLabel(a.stat).localeCompare(honourLabel(b.stat))),
  })).filter((b) => b.tables.length);
}

/** A coach honour brace record reads as "4-0-0 · 16 pts"; other records as "k v" pairs; numbers as themselves. */
export function honourValue(v: HonourValue): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  if ("Wins" in v || "Draws" in v || "Defeats" in v) {
    const wdl = `${v.Wins ?? 0}-${v.Draws ?? 0}-${v.Defeats ?? 0}`;
    return v.Points !== undefined ? `${wdl} · ${v.Points} pts` : wdl;
  }
  return Object.entries(v).map(([k, x]) => `${k} ${x}`).join(", ");
}

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const seasonsLine = (list: number[]): string => (list.length ? `S${list.join(", S")}` : "");

/**
 * The race crest path from the crest manifest, resolved as the Past Games strip does (home/recent.ts: tabletop/art
 * resolveCrest over the manifest), with TourPlay's singular "Underworld Denizen" spelling mapped to the manifest key.
 */
export function crestFor(crests: Record<string, string>, race: string): string {
  const art = { crests: { crests } };
  const found = resolveCrest(art, race) || (/^underworld\s*denizen$/i.test(race.trim()) ? resolveCrest(art, "Underworld Denizens") : "");
  return /^\/crests\/[a-z]+\.png$/.test(found) ? found : "";
}

/** The side that conceded, by the shared outcome rule (the side that lost by conceding), or null. */
export function concedeOf(f: LeagueFixture): "home" | "away" | null {
  const o = fixtureOutcome(f);
  if (!o) return null;
  if (f.home.conceded && o.home === "loss" && o.away === "win") return "home";
  if (f.away.conceded && o.away === "loss" && o.home === "win") return "away";
  return null;
}

/** ResultCard props for a fixture (the shared components/ResultCard.vue contract; each side names its coach). */
export function resultCardProps(league: Pick<LeagueSummary, "name">, season: Pick<SeasonRecord, "name">, f: LeagueFixture, crests: Record<string, string>) {
  const side = (s: LeagueFixture["home"]) => ({ name: s.team, race: s.race, coach: s.coach, crestUrl: crestFor(crests, s.race) || null, score: s.score, cas: s.cas });
  return {
    context: fixtureContext(league, season, f),
    home: side(f.home),
    away: side(f.away),
    ...(fixtureTime(f) ? { playedAt: fixtureTime(f) } : {}),
    concede: concedeOf(f),
    // TourPlay marks a concession "suspended" as well; the card shows the concession (naming the coach) instead.
    suspended: f.suspended && !concedeOf(f),
  };
}
