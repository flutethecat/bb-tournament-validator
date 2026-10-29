// NAF (thenaf.net) ranked games for the coach rating. A coach whose identity record carries a nafId opts in: their NAF game list is scraped (public HTML,
// no API) when one of their tabletop matches is CREATED, cached in <FORK_STATE_DIR>/naf-games.json, and every other read uses that cache as it stands.
// The cached games become result-shaped rows for computeGlicko ONLY (nafResultRows); they never enter TournamentResultStore, so standings, Elo and
// records cannot see them. Everything here fails open: NAF down, slow or re-marked-up means no rows, never an error in match creation or ratings.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { StoredTournamentResult } from "./tournamentResults.js";

export interface NafGame {
  /** YYYY-MM-DD */
  date: string;
  tournament: string;
  variant: string;
  coaches: [string, string];
  races: [string, string];
  score: [number, number];
}

export interface NafCoachRecord { nafId: string; nafName: string; fetchedAt: string; games: NafGame[] }

const NAF_USER_AGENT = "SuperFUMBBL-config-web/1.0 (+https://github.com/flutethecat)";
const NAF_TIMEOUT_MS = 10_000;
/** Re-creating a match must not hammer NAF: a cache younger than this is used as it is. */
export const NAF_REFRESH_MIN_AGE_MS = 10 * 60_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
const cellText = (html: string): string => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const pair = (text: string): [string, string] | undefined => {
  const parts = text.split(/\s+-\s+/);
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0].trim(), parts[1].trim()] : undefined;
};

/** The game rows of a NAF gamelist page; rows that do not parse (header, filters, footers, changed markup) are skipped. */
export function parseNafGameList(html: string): NafGame[] {
  const games: NafGame[] = [];
  try {
    for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]!));
      if (cells.length < 6) continue;
      const [date, tournament, variant, coachesText, racesText, scoreText] = cells as [string, string, string, string, string, string];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const coaches = pair(coachesText);
      const races = pair(racesText);
      const scoreParts = /^(\d+)\s*-\s*(\d+)$/.exec(scoreText);
      if (!coaches || !races || !scoreParts) continue;
      games.push({ date, tournament, variant, coaches, races, score: [Number(scoreParts[1]), Number(scoreParts[2])] });
    }
  } catch { return []; }
  return games;
}

interface NafStoreFile { version: 1; coaches: Record<string, NafCoachRecord> }

export class NafRecordStore {
  private readonly file: string;
  private writes = 0;

  constructor(dataDir: string) { this.file = join(dataDir, "naf-games.json"); }

  private read(): NafStoreFile {
    if (!existsSync(this.file)) return { version: 1, coaches: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<NafStoreFile>;
      if (parsed.version !== 1 || !parsed.coaches || typeof parsed.coaches !== "object" || Array.isArray(parsed.coaches)) return { version: 1, coaches: {} };
      return { version: 1, coaches: parsed.coaches };
    } catch { return { version: 1, coaches: {} }; }
  }

  get(nafId: string): NafCoachRecord | undefined {
    const coaches = this.read().coaches;
    return Object.hasOwn(coaches, nafId) ? coaches[nafId] : undefined;
  }

  listAll(): NafCoachRecord[] { return Object.values(this.read().coaches); }

  /** Changes whenever the cache changes (a write through this store, or the file changing under it): a cheap key for derived ratings. */
  revision(): string {
    let stamp = "none";
    try { const s = statSync(this.file); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* no file yet */ }
    return `${this.writes}:${stamp}`;
  }

  put(nafId: string, nafName: string, games: NafGame[], fetchedAt = new Date().toISOString()): NafCoachRecord {
    const record: NafCoachRecord = { nafId, nafName, fetchedAt, games };
    const current = this.read();
    this.writes += 1;
    atomicWriteTextFile(this.file, `${JSON.stringify({ version: 1, coaches: { ...current.coaches, [nafId]: record } }, null, 2)}\n`);
    return record;
  }
}

export const nafScrapeDisabled = (): boolean => process.env.NAF_SCRAPE_DISABLED === "1";

/** One coach's NAF game list; [] on any failure (non-200, timeout, network, parse), never throws. NAF_SCRAPE_DISABLED=1 makes no request at all. */
export async function fetchNafGames(nafId: string, fetchImpl: typeof fetch = fetch): Promise<NafGame[]> {
  if (nafScrapeDisabled() || !/^\d{1,10}$/.test(nafId.trim())) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAF_TIMEOUT_MS);
  try {
    const url = `https://member.thenaf.net/index.php?module=NAF&type=gamelist&coach=${encodeURIComponent(nafId.trim())}&limit=1000`;
    const res = await fetchImpl(url, { headers: { "User-Agent": NAF_USER_AGENT }, signal: controller.signal });
    if (res.status !== 200) return [];
    return parseNafGameList(await res.text());
  } catch { return []; } finally { clearTimeout(timer); }
}

/** The slice of the identity store this module reads. */
export interface NafIdentities {
  coaches: Record<string, { ffbCoachId: string; identities: { nafId?: string; nafName?: string } }>;
}

const normalizedCoach = (coach: string): string => coach.trim().toLowerCase();
/** The coach's opt-in link (an identity record carrying a nafId), or undefined. */
export function nafLinkOf(identities: NafIdentities, coach: string): { nafId: string; nafName: string } | undefined {
  const record = identities.coaches[normalizedCoach(coach)];
  const nafId = record?.identities.nafId?.trim();
  return record && nafId ? { nafId, nafName: record.identities.nafName?.trim() || "" } : undefined;
}

export interface NafRefreshDeps {
  store: NafRecordStore;
  identities: () => NafIdentities;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  warn?: (message: string) => void;
}

const inFlight = new Map<string, Promise<void>>();

/** Fetch and cache the NAF games of every named coach that has a nafId. Per-nafId in-flight dedupe; a cache under 10 minutes old is left alone. Never throws. */
export async function refreshNafForCoaches(coaches: string[], deps: NafRefreshDeps): Promise<void> {
  try {
    if (nafScrapeDisabled()) return;
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    const now = deps.now ?? (() => new Date());
    const identities = deps.identities();
    const ids = new Map<string, string>();
    for (const coach of coaches) { const link = nafLinkOf(identities, coach); if (link) ids.set(link.nafId, link.nafName); }
    await Promise.all([...ids].map(([nafId, nafName]) => {
      const pending = inFlight.get(nafId);
      if (pending) return pending;
      const job = (async () => {
        try {
          const cached = deps.store.get(nafId);
          if (cached && now().getTime() - Date.parse(cached.fetchedAt) < NAF_REFRESH_MIN_AGE_MS) return;
          const games = await fetchNafGames(nafId, deps.fetchImpl);
          // an empty answer is a failure (or a coach with no games): keep what is cached rather than wiping it
          if (games.length === 0) return;
          deps.store.put(nafId, nafName || cached?.nafName || "", games, now().toISOString());
        } catch (error) {
          warn(`[naf] refresh of ${nafId} failed: ${(error as Error).message}`);
        }
      })().finally(() => { inFlight.delete(nafId); });
      inFlight.set(nafId, job);
      return job;
    }));
  } catch { /* fail open */ }
}

const gameKey = (game: NafGame): string => {
  const a = game.coaches[0].trim().toLowerCase();
  const b = game.coaches[1].trim().toLowerCase();
  const swap = a > b;
  const coaches = swap ? [b, a] : [a, b];
  const score = swap ? [game.score[1], game.score[0]] : game.score;
  return createHash("sha1").update([game.date, game.tournament, coaches.join("|"), score.join("-")].join("|")).digest("hex");
};

/**
 * Every cached NAF game as a result row for computeGlicko (and nothing else). The same game cached from both linked coaches is one row. A NAF name that
 * belongs to a coach with a nafId here is keyed by that coach's ffbCoachId; any other name is keyed `naf:<lowercased name>` so the opponent is rated too.
 * No team values (deltaCtv 0). penaltyScore is -1 (no shoot-out): a 0 would override the score in deriveTeamResult.
 */
export function nafResultRows(store: NafRecordStore, identities: NafIdentities): StoredTournamentResult[] {
  const byName = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const record of Object.values(identities.coaches)) {
    const nafId = record.identities.nafId?.trim();
    if (!nafId) continue; // opt-in: without a nafId the NAF name does not map, the coach stays a plain naf: entry
    byId.set(nafId, record.ffbCoachId);
    const name = record.identities.nafName?.trim().toLowerCase();
    if (name) byName.set(name, record.ffbCoachId);
  }
  const rows = new Map<string, StoredTournamentResult>();
  for (const cached of store.listAll()) {
    const cachedName = cached.nafName.trim().toLowerCase();
    const owner = byId.get(cached.nafId);
    if (owner && cachedName && !byName.has(cachedName)) byName.set(cachedName, owner);
    for (const game of cached.games) {
      const names = [game.coaches[0].trim().toLowerCase(), game.coaches[1].trim().toLowerCase()] as [string, string];
      if (!names[0] || !names[1] || names[0] === names[1]) continue;
      const gameId = `naf:${gameKey(game)}`;
      if (rows.has(gameId)) continue;
      const at = Date.parse(`${game.date}T12:00:00Z`);
      if (!Number.isFinite(at)) continue;
      const side = (i: 0 | 1) => ({ teamId: `naf:${names[i]}`, teamName: game.races[i], coach: byName.get(names[i]) ?? `naf:${names[i]}` });
      const team = (i: 0 | 1) => ({
        teamId: `naf:${names[i]}`, score: game.score[i], winnings: 0, penaltyScore: -1, conceded: false,
        casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [],
      });
      rows.set(gameId, {
        gameId, pulledAt: cached.fetchedAt, playedAt: new Date(at).toISOString(), source: "naf",
        home: side(0), away: side(1), teams: [team(0), team(1)],
      });
    }
  }
  return [...rows.values()];
}

/** How many cached NAF games a linked coach has (0 when unlinked or never fetched). */
export function nafSummaryFor(store: NafRecordStore, identities: NafIdentities, coach: string): { games: number; fetchedAt?: string } {
  const link = nafLinkOf(identities, coach);
  const cached = link ? store.get(link.nafId) : undefined;
  return cached ? { games: cached.games.length, fetchedAt: cached.fetchedAt } : { games: 0 };
}
