/**
 * League inducement usage (owner 11-02: "The Inducements list that we're showing on the league screen is supposed to be
 * a list of how often a inducement has been taken in a league").
 *
 *   GET /api/leagues/:id/seasons/:seasonId/inducements/usage[?scope=league]   public read (both gate paths cover every
 *       /api/leagues/ read: requireSession.ts isPublicRequest, server.ts authorized() leaguePath). A draft league answers
 *       exactly as an unknown one to everyone but its organisers (api.ts hides it before this route runs).
 *
 * What counts: every PLAYED fixture of the season (all seasons with scope=league). A played fixture has inducement data
 * only when its CURRENT result is the one the tabletop recorder wrote: the published match whose fixture link (opId)
 * matches the fixture's, with the fixture still carrying that publish's time (finishedAt = tabletop.reportedAt; a clear
 * drops finishedAt and a hand entry never sets it) and that match's score and casualties (a hand edit over it changes
 * them). Its picks are each team's inducements in force (pregame.ts latestInducement: the latest record no undo
 * retracted, so an organiser's replacement counts once), or the fixture lobby's resolved picks when the match has no
 * record for that team. Results from Super FUMBBL games (forkResult.ts: only the gold spent, never what was bought),
 * TourPlay imports (no per-game inducements) and an organiser's own score entry carry no inducement data and are counted
 * as games without data; nothing is guessed (law 15).
 *
 * Keys: a standard inducement by its dataset id; a star hire (`star:<name>`, the fixture lobby) by `star:<folded name>`;
 * the league's own (custom) types by `custom:<folded name>`, so the same type in several seasons adds up. A pick's name
 * is the one recorded when it was bought (a later rename never rewrites history); only a pick without one takes the
 * season's current name. GET only reads.
 *
 * Cost: a published match is frozen under its opId (an undo retracts the fixture's opId; a new publish makes a new one),
 * so each opId's picks and recorded result are cached per source. The recorder's match list is scanned only when a
 * played fixture carries an opId not yet seen (a new publish), never on every request.
 */
import { bb2025 } from "@bb/validator/dataset";
import type { TabletopEvent } from "../tabletop/events.js";
import type { PostMatchSummary } from "../tabletop/postMatch.js";
import { latestInducement } from "../tabletop/pregame.js";
import type { MatchRecord } from "../tabletop/store.js";
import { INDUCEMENT_ICONS, STANDARD_INDUCEMENT_CATEGORY, STANDARD_INDUCEMENT_ICON, type InducementUsageRow, type InducementUsageView } from "./inducementRules.js";
import { leagueFixtureRef } from "./tabletopFixtures.js";
import { fixturePlayed } from "./tourplay.js";
import type { LeagueFixture, SeasonRecord } from "./types.js";

export type { InducementUsageRow, InducementUsageView };

/** The recorder's matches, read only (server.ts wires the tabletop repository). */
export interface InducementUsageSource {
  listMatches(): Promise<MatchRecord[]>;
  /** Every match, plus the match files that could not be read (team library lane: entry changes fail closed on them). */
  listMatchesChecked?(): Promise<{ matches: MatchRecord[]; unreadable: string[] }>;
  readEvents(matchId: string): Promise<TabletopEvent[]>;
}

/** One pick as recorded (inducement events and lobby picks carry the name priced at the time). */
export interface RecordedPick { id: string; name?: string; qty: number }

/** The fixture lobby's star hire id prefix (fixtureLobby/core.ts STAR_PREFIX). */
const STAR_PREFIX = "star:";
const fold = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const isStandard = (id: string): boolean => Object.prototype.hasOwnProperty.call(bb2025.inducements, id);

function picksOf(raw: unknown): RecordedPick[] {
  if (!Array.isArray(raw)) return [];
  const out: RecordedPick[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const { id, name, qty } = p as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) continue;
    out.push({ id, qty, ...(typeof name === "string" && name.trim() ? { name } : {}) });
  }
  return out;
}

/**
 * One match's effective picks per team, or undefined when neither team has any record (no inducement data). A team
 * with a record that bought nothing contributes an empty list.
 */
export function effectiveMatchPicks(match: Pick<MatchRecord, "inducements">, events: readonly TabletopEvent[]): RecordedPick[][] | undefined {
  const sides: RecordedPick[][] = [];
  for (const side of ["home", "away"] as const) {
    const e = latestInducement(events, side);
    if (e) sides.push(picksOf(e.payload.picks));
    else if (match.inducements?.[side]) sides.push(picksOf(match.inducements[side].picks));
  }
  return sides.length ? sides : undefined;
}

/** A counted game: its season (names custom ids) and its teams' picks; undefined = a played game without data. */
export interface UsageGame { season: Pick<SeasonRecord, "rules">; sides?: RecordedPick[][] }

const STAR_ICON = INDUCEMENT_ICONS[STANDARD_INDUCEMENT_ICON.star_players ?? "star"]?.src ?? "";

/** THE aggregation: per inducement, total quantity and games; plus the counted / no-data game totals. */
export function aggregateInducementUsage(games: readonly UsageGame[]): Pick<InducementUsageView, "gamesCounted" | "gamesWithoutData" | "rows"> {
  const rows = new Map<string, InducementUsageRow>();
  let counted = 0;
  let without = 0;
  for (const g of games) {
    if (!g.sides) { without += 1; continue; }
    counted += 1;
    const customs = new Map((g.season.rules?.inducements?.custom ?? []).map((c) => [c.id, c]));
    const seen = new Set<string>();
    for (const side of g.sides) {
      for (const p of side) {
        let row: Omit<InducementUsageRow, "taken" | "games" | "share">;
        if (isStandard(p.id)) {
          const icon = STANDARD_INDUCEMENT_ICON[p.id] ?? "star";
          row = { key: p.id, name: bb2025.inducements[p.id]!.name, source: "standard", category: STANDARD_INDUCEMENT_CATEGORY[p.id] ?? "special", iconSrc: INDUCEMENT_ICONS[icon]?.src ?? "" };
        } else if (p.id.startsWith(STAR_PREFIX)) {
          const name = p.name?.trim() || p.id.slice(STAR_PREFIX.length).trim() || "Star player";
          row = { key: `star:${fold(name)}`, name, source: "star", category: "star", iconSrc: STAR_ICON };
        } else {
          const c = customs.get(p.id);
          const name = p.name?.trim() || c?.name || p.id;
          row = { key: `custom:${fold(name)}`, name, source: "custom", category: c?.category ?? "special", iconSrc: (c && INDUCEMENT_ICONS[c.icon]?.src) || "" };
        }
        const hit = rows.get(row.key) ?? { ...row, taken: 0, games: 0, share: 0 };
        hit.taken += p.qty;
        if (!seen.has(row.key)) { hit.games += 1; seen.add(row.key); }
        rows.set(row.key, hit);
      }
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, share: counted ? Math.round((r.games / counted) * 10_000) / 10_000 : 0 }));
  list.sort((a, b) => b.taken - a.taken || b.games - a.games || a.name.localeCompare(b.name));
  return { gamesCounted: counted, gamesWithoutData: without, rows: list };
}

// ---- the recorder side ---------------------------------------------------------------------------------------------

/** What a published match wrote into its fixture (tabletop/api.ts fixtureForPublish), in fixture home/away order. */
interface RecordedResult { home: number; away: number; homeCas: number; awayCas: number }
interface OpEntry { ref: string; result?: RecordedResult; sides?: RecordedPick[][] }

function recordedResult(m: MatchRecord): RecordedResult | undefined {
  const p = m.preview;
  if (!p?.home || !p.away) return undefined;
  const cas = (s: PostMatchSummary): number => (s.players ?? []).reduce((n, x) => n + (x.casualtiesCaused ?? 0), 0);
  const [h, a] = m.fixtureLink?.swapped ? [p.away, p.home] : [p.home, p.away];
  return { home: h.score.for, away: a.score.for, homeCas: cas(h), awayCas: cas(a) };
}

/** Is the fixture's current result still the one this publish wrote? */
function resultFromRecorder(f: LeagueFixture, e: OpEntry): boolean {
  if (!f.tabletop?.reportedAt || f.finishedAt !== f.tabletop.reportedAt) return false;
  if (!e.result) return true; // an older match without its preview: the publish time link alone
  return f.home.score === e.result.home && f.away.score === e.result.away && (f.home.cas ?? 0) === e.result.homeCas && (f.away.cas ?? 0) === e.result.awayCas;
}

// Per source: opId -> the frozen publish (picks + recorded result), least recently used first, at most OP_CACHE_MAX. An
// opId missing from a scan is remembered for a short while only (its match may be mid-publish), so a stray fixture
// never forces a scan on every request; expired misses are dropped on every call, and a miss found later is forgotten.
const opCache = new WeakMap<InducementUsageSource, { ops: Map<string, OpEntry>; missing: Map<string, number> }>();
const MISSING_TTL_MS = 60_000;
export const OP_CACHE_MAX = 5_000;

/** Test hook: the sizes of a source's caches. */
export const usageCacheSize = (source: InducementUsageSource): { ops: number; missing: number } =>
  ({ ops: opCache.get(source)?.ops.size ?? 0, missing: opCache.get(source)?.missing.size ?? 0 });

function capped<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) { if (map.size <= max) break; map.delete(oldest); }
}

/** The counted games of these seasons: every played fixture, with the recorder's picks when its result came from there. */
export async function usageGames(
  seasons: readonly SeasonRecord[], source: InducementUsageSource | undefined, now = Date.now(), max = OP_CACHE_MAX,
): Promise<UsageGame[]> {
  const played = seasons.flatMap((season) => season.fixtures.filter(fixturePlayed).map((f) => ({ season, f })));
  // this request's entries, so an eviction during a large scan never drops a game it just read
  const seen = new Map<string, OpEntry>();
  if (source) {
    let cache = opCache.get(source);
    if (!cache) { cache = { ops: new Map(), missing: new Map() }; opCache.set(source, cache); }
    const { ops, missing } = cache;
    for (const [op, until] of missing) if (until <= now) missing.delete(op);
    const wanted = new Set<string>();
    for (const { f } of played) {
      const op = f.tabletop?.opId;
      if (!op || seen.has(op)) continue;
      const hit = ops.get(op);
      if (hit) { seen.set(op, hit); capped(ops, op, hit, max); } // refresh its place
      else if (!missing.has(op)) wanted.add(op);
    }
    if (wanted.size) {
      const found = (await source.listMatches()).filter((m) => m.state === "published" && m.fixtureRef && m.fixtureLink?.opId && wanted.has(m.fixtureLink.opId));
      for (const m of found) {
        const op = m.fixtureLink!.opId;
        const sides = effectiveMatchPicks(m, await source.readEvents(m.id));
        const result = recordedResult(m);
        const entry: OpEntry = { ref: m.fixtureRef!, ...(result ? { result } : {}), ...(sides ? { sides } : {}) };
        seen.set(op, entry);
        capped(ops, op, entry, max);
        missing.delete(op);
        wanted.delete(op);
      }
      for (const op of wanted) capped(missing, op, now + MISSING_TTL_MS, max);
    }
  }
  return played.map(({ season, f }): UsageGame => {
    const op = f.tabletop?.opId;
    const e = op ? seen.get(op) : undefined;
    if (!e || e.ref !== leagueFixtureRef(season.leagueId, season.id, f.id) || !resultFromRecorder(f, e) || !e.sides) return { season };
    return { season, sides: e.sides };
  });
}
