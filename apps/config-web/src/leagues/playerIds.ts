/**
 * Stable league player ids.
 *
 * Every roster player and every former player of a season gets `playerId`: an opaque `p-<12 hex>` hash of (league id,
 * source season slug, team id, shirt number, name, position), so re-importing the same export gives the same ids.
 * Two players with identical inputs (same team, both without a shirt number, same name and position) are told apart by
 * an ordinal in the hash, in roster order, so ids are unique within the league. The hash inputs are not stored.
 *
 * The same player across seasons (same team lineage + shirt number + name + position) shares a `careerKey`
 * (`c-<12 hex>`); `previousIds` lists that player's ids in earlier seasons. The linking happens once, at import time
 * (linkPlayerCareers), so nothing matches names at query time. A former player has no shirt number: it joins the
 * career of the one roster player of its team lineage with the same name and position, else starts its own.
 */
import { createHash } from "node:crypto";
import { buildCoachAliases, seasonCoachFacets, type CoachAliases } from "./identity.js";
import type { FormerPlayer, LeaguePlayer, LeagueTeam, SeasonRecord } from "./types.js";

export interface PlayerIdContext { leagueId: string; slug: string }

/** Name key for the hash inputs: trimmed, inner whitespace collapsed, lower-case (same rule as tourplay nameKey). */
const key = (v: string): string => v.trim().replace(/\s+/g, " ").toLowerCase();
const digest = (prefix: string, parts: Array<string | number | null | undefined>): string =>
  `${prefix}-${createHash("sha256").update(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0000")).digest("hex").slice(0, 12)}`;

/** The id of a player; `ordinal` is 0 unless an identical player already holds the id. */
export const playerIdFor = (ctx: PlayerIdContext, teamId: string, number: number | "former" | null, name: string, position: string, ordinal = 0): string =>
  digest("p", [ctx.leagueId, ctx.slug, teamId, number, key(name), key(position), ordinal]);

function freshId(ctx: PlayerIdContext, used: Set<string>, teamId: string, number: number | "former" | null, name: string, position: string): string {
  let id = playerIdFor(ctx, teamId, number, name, position, 0);
  for (let n = 1; used.has(id); n += 1) id = playerIdFor(ctx, teamId, number, name, position, n);
  used.add(id);
  return id;
}

/** Ids already held by a team's players (roster and former). */
const teamIds = (team: LeagueTeam): Set<string> =>
  new Set([...team.players, ...team.formerPlayers].map((p) => p.playerId).filter((v): v is string => Boolean(v)));

/** Gives every roster player of the teams an id (existing ids are kept). Needs the final team ids. */
export function assignRosterIds(teams: LeagueTeam[], ctx: PlayerIdContext): void {
  const used = new Set<string>();
  for (const t of teams) for (const id of teamIds(t)) used.add(id);
  for (const t of teams) for (const p of t.players) if (!p.playerId) p.playerId = freshId(ctx, used, t.id, p.number, p.name, p.position);
}

/** The id for a player who left the roster (called as the former player is created). */
export function formerPlayerId(team: LeagueTeam, ctx: PlayerIdContext, name: string, position: string): string {
  const used = teamIds(team);
  return freshId(ctx, used, team.id, "former", name, position);
}

/** The alias table over every season (the coach identity the career lineage is built on). */
const aliasesOf = (seasons: SeasonRecord[]): CoachAliases =>
  buildCoachAliases((function* () { for (const s of seasons) yield* seasonCoachFacets(s); })());

/**
 * Sets careerKey and previousIds on every player of every season (all of the league's seasons, in one call), and
 * fills a missing playerId (data stored before ids existed) with the id the importer would give. Idempotent.
 */
export function linkPlayerCareers(seasons: SeasonRecord[]): void {
  const ordered = [...seasons].sort((a, b) => a.number - b.number);
  const aliases = aliasesOf(ordered);
  const idsByCareer = new Map<string, string[]>();
  const rosterCareers = new Map<string, Set<string>>(); // lineage|name|position -> career keys of roster players
  for (const s of ordered) {
    const ctx: PlayerIdContext = { leagueId: s.leagueId, slug: s.sourceSlug };
    assignRosterIds(s.teams, ctx);
    const seasonIds: Array<[string, string]> = [];
    const settle = (p: LeaguePlayer | FormerPlayer, career: string): void => {
      const earlier = idsByCareer.get(career) ?? [];
      p.careerKey = career;
      if (earlier.length) p.previousIds = [...earlier]; else delete p.previousIds;
      seasonIds.push([career, p.playerId]);
    };
    for (const t of s.teams) {
      const lineage = `${aliases.key(t)}\0${key(t.name)}\0${key(t.race)}`;
      const seen = new Map<string, number>();
      for (const p of t.players) {
        const base = `${lineage}\0${p.number ?? ""}\0${key(p.name)}\0${key(p.position)}`;
        const ordinal = seen.get(base) ?? 0;
        seen.set(base, ordinal + 1);
        const career = digest("c", [s.leagueId, base, ordinal]);
        settle(p, career);
        const nameKey = `${lineage}\0${key(p.name)}\0${key(p.position)}`;
        let set = rosterCareers.get(nameKey);
        if (!set) { set = new Set(); rosterCareers.set(nameKey, set); }
        set.add(career);
      }
      for (const f of t.formerPlayers) {
        if (!f.playerId) f.playerId = freshId(ctx, teamIds(t), t.id, "former", f.name, f.position);
        const candidates = rosterCareers.get(`${lineage}\0${key(f.name)}\0${key(f.position)}`);
        const career = candidates?.size === 1 ? [...candidates][0]! : digest("c", [s.leagueId, lineage, "former", key(f.name), key(f.position)]);
        settle(f, career);
      }
    }
    for (const [career, id] of seasonIds) {
      const list = idsByCareer.get(career) ?? [];
      if (!list.includes(id)) list.push(id);
      idsByCareer.set(career, list);
    }
  }
}

/** True when any player of the seasons lacks an id or career link (stored before ids existed). */
export const needsPlayerIds = (seasons: SeasonRecord[]): boolean =>
  seasons.some((s) => s.teams.some((t) => [...t.players, ...t.formerPlayers].some((p) => !p.playerId || !p.careerKey)));

/** Throws when two players of the league share an id (a hash collision or a duplicated player). */
export function assertUniquePlayerIds(seasons: SeasonRecord[]): void {
  const seen = new Map<string, string>();
  for (const s of seasons) for (const t of s.teams) for (const p of [...t.players, ...t.formerPlayers]) {
    const where = `${s.id}/${t.id}/${p.name}`;
    const prior = seen.get(p.playerId);
    if (prior) throw new Error(`Player id ${p.playerId} is held by both ${prior} and ${where}.`);
    seen.set(p.playerId, where);
  }
}
