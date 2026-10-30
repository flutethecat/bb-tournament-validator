// Game pages, the read side (GET /api/games/:source/:id is public, so every read here is bounded):
//   - targeted lookups only: one fixture by id, one results-store row by game id, one tabletop match by id; tabletop
//     matches recorded for a fixture come from a fixtureRef index rebuilt at most once per `indexTtlMs`;
//   - an ineligible tabletop match (test, still recording) is rejected from its match record, BEFORE its event log or
//     team chains are read;
//   - answers (404s included) are cached per (source, id) while the stores' cheap revision stamp is unchanged, for at
//     most `ttlMs`, in a bounded LRU; concurrent loads of one key share a single read.
// It also answers who played (participants) and who manages the tournament, for the player-lines privacy flag.

import { gameDetail, type GameDetail, type GameInputs, type GameTournament } from "./gameDetail.js";
import { TABLETOP_LISTED, type GameSource, type RecentInputs, type TeamInfo } from "./recentResults.js";
import type { StoredTournamentResult } from "./tournamentResults.js";
import type { MatchRecord } from "./tabletop/store.js";
import type { TabletopEvent } from "./tabletop/events.js";
import type { LeagueGameDigest } from "./leagues/store.js";

export interface GameTabletopReader {
  getMatch(id: string): Promise<MatchRecord | undefined>;
  listMatches(): Promise<MatchRecord[]>;
  readEvents(matchId: string): Promise<TabletopEvent[]>;
  getChain(coach: string, saveId: string): Promise<{ head: number; revisions: Array<{ revision: number; teamFile: { race?: string } }> } | undefined>;
}

/** A public tournament holding just the one fixture asked for, plus the coach ids that manage it. */
export interface GameFixture extends GameTournament { managers: string[] }

export interface GameStores {
  /** Cheap stamp that changes whenever any store this page reads changes (file stats, write counters). */
  revision(): string;
  /** The fixture by id when its tournament is public (active / completed / cancelled). */
  fixture(matchId: string): GameFixture | undefined;
  /** The public fixture that launched this fork game, if any. */
  fixtureForGame(gameId: string): GameFixture | undefined;
  /** One results-store row by game id. */
  result(gameId: string): StoredTournamentResult | undefined;
  forkMeta?: RecentInputs["forkMeta"];
  teamInfo?: (ref: string, coach: string) => TeamInfo | undefined;
  /** Legal-concession verdicts a league fixture banked for this fork game, by fork team id (absent = none known). */
  concededLegally?: (gameId: string) => Record<string, boolean> | undefined;
  /** The league fixture's public digest of this fork game (positions, banked SPP / injuries / winnings / fans), from the same cached index. */
  leagueGame?: (gameId: string) => LeagueGameDigest | undefined;
  tabletop(): Promise<GameTabletopReader | undefined>;
}

export interface GameAccess {
  /** Coaches who played the game (lower-cased). */
  coaches: string[];
  /** Coaches who manage the tournament the game counted in (lower-cased). */
  managers: string[];
}

export interface LoadedGame { detail: GameDetail; access: GameAccess }

export interface GameLoaderOptions { ttlMs?: number; max?: number; indexTtlMs?: number; maxRecorded?: number; now?: () => number }

const lc = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const listed = (m: MatchRecord) => !m.test && TABLETOP_LISTED.has(m.state);

export function createGameDetailLoader(stores: GameStores, opts: GameLoaderOptions = {}) {
  const ttlMs = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 256;
  const indexTtlMs = opts.indexTtlMs ?? 60_000;
  const maxRecorded = opts.maxRecorded ?? 3;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; stamp: string; value: LoadedGame | undefined }>();
  const inflight = new Map<string, Promise<LoadedGame | undefined>>();
  let index: { at: number; byFixture: Map<string, string[]> } | undefined;
  let indexLoad: Promise<Map<string, string[]>> | undefined;

  async function fixtureIndex(reader: GameTabletopReader): Promise<Map<string, string[]>> {
    if (index && now() - index.at < indexTtlMs) return index.byFixture;
    indexLoad ??= (async () => {
      try {
        const byFixture = new Map<string, string[]>();
        for (const m of await reader.listMatches()) {
          if (!m.fixtureRef || !listed(m)) continue;
          byFixture.set(m.fixtureRef, [...(byFixture.get(m.fixtureRef) ?? []), m.id]);
        }
        index = { at: now(), byFixture };
        return byFixture;
      } finally { indexLoad = undefined; }
    })();
    return indexLoad;
  }

  async function tabletopRow(reader: GameTabletopReader, match: MatchRecord): Promise<GameInputs["tabletop"][number]> {
    const raceOf = async (coach: string, saveId: string) => {
      try {
        const chain = await reader.getChain(coach, saveId);
        return chain?.revisions.find((r) => r.revision === chain.head)?.teamFile.race ?? undefined;
      } catch { return undefined; }
    };
    return {
      match,
      events: await reader.readEvents(match.id),
      race: { home: await raceOf(match.home.coach, match.home.teamSaveId), away: await raceOf(match.away.coach, match.away.teamSaveId) },
    };
  }

  async function read(source: GameSource, id: string): Promise<LoadedGame | undefined> {
    const inputs: GameInputs = { results: [], tournaments: [], tabletop: [], forkMeta: stores.forkMeta, teamInfo: stores.teamInfo };
    const coaches = new Set<string>();
    let fixture: GameFixture | undefined;
    if (source === "tournament") {
      fixture = stores.fixture(id);
      const m = fixture?.matches.find((x) => x.id === id);
      if (!fixture || !m?.away || !m.result) return undefined;
      coaches.add(lc(m.home.coach.ffbCoachId)).add(lc(m.away.coach.ffbCoachId));
      const gameId = m.launch?.gameId;
      const row = gameId ? stores.result(gameId) : undefined;
      if (row) inputs.results = [row];
      const reader = await stores.tabletop().catch(() => undefined);
      if (reader) {
        try {
          const ids = ((await fixtureIndex(reader)).get(id) ?? []).slice(0, maxRecorded);
          for (const matchId of ids) {
            const match = await reader.getMatch(matchId).catch(() => undefined);
            if (!match || !listed(match) || match.fixtureRef !== id) continue; // re-checked: the index may be a minute old
            inputs.tabletop = [await tabletopRow(reader, match)];
            coaches.add(lc(match.home.coach)).add(lc(match.away.coach));
            break;
          }
        } catch { /* recorder unavailable: the fixture alone */ }
      }
    } else if (source === "tabletop") {
      const reader = await stores.tabletop().catch(() => undefined);
      const match = reader ? await reader.getMatch(id).catch(() => undefined) : undefined;
      if (!reader || !match || !listed(match)) return undefined; // nothing more is read for an ineligible match
      fixture = match.fixtureRef ? stores.fixture(match.fixtureRef) : undefined;
      inputs.tabletop = [await tabletopRow(reader, match)];
      coaches.add(lc(match.home.coach)).add(lc(match.away.coach));
    } else {
      const row = stores.result(id);
      if (!row || row.test === true || (row.source !== undefined && row.source !== "fork")) return undefined;
      inputs.results = [row];
      fixture = stores.fixtureForGame(id);
      coaches.add(lc(row.home.coach)).add(lc(row.away.coach));
      if (Array.isArray(row.teams) && row.teams.some((t) => t.conceded)) {
        let verdicts: Record<string, boolean> | undefined;
        try { verdicts = stores.concededLegally?.(id); } catch { verdicts = undefined; }
        if (verdicts) inputs.concededLegally = verdicts;
      }
      let digest: LeagueGameDigest | undefined;
      try { digest = stores.leagueGame?.(id); } catch { digest = undefined; }
      if (digest) inputs.leagueGame = digest;
    }
    if (fixture) inputs.tournaments = [fixture];
    const detail = gameDetail(source, id, inputs);
    if (!detail) return undefined;
    coaches.delete("");
    return { detail, access: { coaches: [...coaches], managers: (fixture?.managers ?? []).map(lc).filter(Boolean) } };
  }

  return {
    async load(source: GameSource, id: string): Promise<LoadedGame | undefined> {
      const key = `${source}\u0000${id}`;
      const stamp = stores.revision();
      const hit = cache.get(key);
      if (hit && hit.stamp === stamp && now() - hit.at < ttlMs) {
        cache.delete(key); cache.set(key, hit); // most recently used last
        return hit.value;
      }
      const running = inflight.get(key);
      if (running) return running;
      const p = (async () => {
        try {
          const value = await read(source, id);
          cache.delete(key);
          cache.set(key, { at: now(), stamp, value });
          while (cache.size > max) cache.delete(cache.keys().next().value!);
          return value;
        } finally { inflight.delete(key); }
      })();
      inflight.set(key, p);
      return p;
    },
    /** Entries held (tests). */
    size: () => cache.size,
  };
}

/** GAME_PAGES_PUBLIC_PLAYER_LINES: default true; "false" / "0" / "no" / "off" turns public player lines off. */
export function publicPlayerLinesFromEnv(value: string | undefined): boolean {
  return !/^(false|0|no|off)$/i.test((value ?? "").trim());
}

export const PLAYER_LINES_PRIVATE_NOTE = "Player stats for this game are shown to the coaches who played it and to organisers.";

/** May this viewer see player lines? Public flag on, or a signed-in participant, tournament manager or site organiser. */
export function maySeePlayerLines(publicLines: boolean, access: GameAccess, viewer: string | undefined, siteOrganiser: (coach: string) => boolean): boolean {
  if (publicLines) return true;
  const me = lc(viewer);
  if (!me) return false;
  return access.coaches.includes(me) || access.managers.includes(me) || siteOrganiser(viewer!);
}

/**
 * The game without player lines: scores, casualties, concession and MVP names stay; scorers, casualty-makers, player
 * tables, the reporter's player lines and deaths go, and key moments name the team instead of the player.
 */
export function withoutPlayerLines(d: GameDetail): GameDetail {
  const team = (t: GameDetail["summary"]["home"]) => {
    if (!t) return t;
    const { squad: _squad, ...rest } = t;
    return { ...rest, scorers: [], casualtyMakers: [], players: [] };
  };
  const hadLines = d.summary.perPlayer;
  const label = { touchdown: "Touchdown", casualty: "Casualty caused", sendOff: "Sent off" } as const;
  return {
    ...d,
    summary: {
      ...d.summary,
      perPlayer: false,
      note: hadLines ? PLAYER_LINES_PRIVATE_NOTE : d.summary.note,
      home: team(d.summary.home),
      away: team(d.summary.away),
    },
    ...(d.reporter ? {
      reporter: {
        ...d.reporter,
        summaries: d.reporter.summaries
          ? { home: { ...d.reporter.summaries.home, players: [], deaths: [] }, away: { ...d.reporter.summaries.away, players: [], deaths: [] } }
          : null,
        moments: d.reporter.moments.map(({ player: _p, victim: _v, ...m }) => ({ ...m, text: `${label[m.kind]}: ${d.card[m.side].name}` })),
      },
    } : {}),
  };
}
