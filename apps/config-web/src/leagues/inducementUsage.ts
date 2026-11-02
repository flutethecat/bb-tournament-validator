/**
 * League inducement usage (owner 11-02: "The Inducements list that we're showing on the league screen is supposed to be
 * a list of how often a inducement has been taken in a league").
 *
 *   GET /api/leagues/:id/seasons/:seasonId/inducements/usage[?scope=league]   public read (both gate paths cover every
 *       /api/leagues/ read: requireSession.ts isPublicRequest, server.ts authorized() leaguePath). A draft league answers
 *       exactly as an unknown one to everyone but its organisers (api.ts hides it before this route runs).
 *
 * What counts: every PLAYED fixture of the season (all seasons with scope=league). A played fixture has inducement data
 * only when its result came from the tabletop recorder: the published match whose fixture link (opId) wrote the
 * fixture's result. Its picks are each team's inducements in force (pregame.ts latestInducement: the latest record no
 * undo retracted, so an organiser's replacement counts once), or the fixture lobby's resolved picks when the match has
 * no record for that team. Results from Super FUMBBL games (forkResult.ts: only the gold spent, never what was bought),
 * TourPlay imports (no per-game inducements) and an organiser's own score entry carry no inducement data and are counted
 * as games without data; nothing is guessed (law 15).
 *
 * Standard inducements are keyed by their dataset id; the league's own (custom) types by name (case and spacing folded),
 * so the same custom type in several seasons adds up. GET only reads.
 */
import { bb2025 } from "@bb/validator/dataset";
import type { TabletopEvent } from "../tabletop/events.js";
import { latestInducement } from "../tabletop/pregame.js";
import type { MatchRecord } from "../tabletop/store.js";
import { INDUCEMENT_ICONS, STANDARD_INDUCEMENT_CATEGORY, STANDARD_INDUCEMENT_ICON, type InducementUsageRow, type InducementUsageView } from "./inducementRules.js";
import { leagueFixtureRef } from "./tabletopFixtures.js";
import { fixturePlayed } from "./tourplay.js";
import type { SeasonRecord } from "./types.js";

export type { InducementUsageRow, InducementUsageView };

/** The recorder's matches, read only (server.ts wires the tabletop repository). */
export interface InducementUsageSource {
  listMatches(): Promise<MatchRecord[]>;
  readEvents(matchId: string): Promise<TabletopEvent[]>;
}

/** One pick as recorded (inducement events and lobby picks carry the name priced at the time). */
export interface RecordedPick { id: string; name?: string; qty: number }

const fold = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const isStandard = (id: string): boolean => Object.prototype.hasOwnProperty.call(bb2025.inducements, id);

function picksOf(raw: unknown): RecordedPick[] {
  if (!Array.isArray(raw)) return [];
  const out: RecordedPick[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const { id, name, qty } = p as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) continue;
    out.push({ id, qty, ...(typeof name === "string" && name ? { name } : {}) });
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
        } else {
          const c = customs.get(p.id);
          const name = c?.name ?? p.name ?? p.id;
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

// Published matches are frozen (inducement edits need a recording or submitted match), so a match's picks are kept per
// source until its state or update time changes.
const pickCache = new WeakMap<InducementUsageSource, Map<string, { stamp: string; sides: RecordedPick[][] | undefined }>>();

/** The counted games of these seasons: every played fixture, with the recorder's picks when its result came from there. */
export async function usageGames(seasons: readonly SeasonRecord[], source: InducementUsageSource | undefined): Promise<UsageGame[]> {
  const played = seasons.flatMap((season) => season.fixtures.filter(fixturePlayed).map((f) => ({ season, f })));
  const byRef = new Map<string, MatchRecord[]>();
  if (source && played.some(({ f }) => f.tabletop?.opId)) {
    for (const m of await source.listMatches()) {
      if (m.state !== "published" || !m.fixtureRef || !m.fixtureLink?.opId) continue;
      byRef.set(m.fixtureRef, [...(byRef.get(m.fixtureRef) ?? []), m]);
    }
  }
  let cache = source ? pickCache.get(source) : undefined;
  if (source && !cache) { cache = new Map(); pickCache.set(source, cache); }
  const out: UsageGame[] = [];
  for (const { season, f } of played) {
    const opId = f.tabletop?.opId;
    const match = opId ? byRef.get(leagueFixtureRef(season.leagueId, season.id, f.id))?.find((m) => m.fixtureLink?.opId === opId) : undefined;
    if (!match || !source || !cache) { out.push({ season }); continue; }
    const stamp = `${match.state}|${match.updatedAt}|${match.publishedAt ?? ""}`;
    let hit = cache.get(match.id);
    if (!hit || hit.stamp !== stamp) {
      hit = { stamp, sides: effectiveMatchPicks(match, await source.readEvents(match.id)) };
      cache.set(match.id, hit);
    }
    out.push({ season, ...(hit.sides ? { sides: hit.sides } : {}) });
  }
  return out;
}
