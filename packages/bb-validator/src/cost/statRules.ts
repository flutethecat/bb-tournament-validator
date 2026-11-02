/**
 * Granular stat-increase rules (package `special.statIncreaseRules`, edited in the Tournament Creator's "Stat increases"
 * section). Pure and dependency-free: the validator's stat-increases rule, the Roster Builder's Advance dialog (via a
 * relative import) and the Creator all read the same shapes and the same sentences, so a refusal reads alike everywhere.
 * Allow stat increases (`special.statIncreasesAllowed`) and the per-player cap (`statIncreases.maxPerPlayer`) stay where
 * they were; this adds who may not, which stats nobody (or only some) may take, and a per-team cap.
 */

export interface RulePosition { race: string; position: string }
export interface BlockedStat { stat: string; positions?: RulePosition[]; keywords?: string[] }
export interface StatIncreaseRules {
  /** No stat increases at all for these positions (race "*" or "" = any race). */
  excludePositions?: RulePosition[];
  /** ... or for any position carrying one of these dataset keywords / types ("Big Guy", "Lineman"). */
  excludeKeywords?: string[];
  /** A stat nobody can take, or only the listed positions / keywords (none listed = everyone). */
  blockedStats?: BlockedStat[];
  /** Most stat increases the whole team may carry. */
  maxPerTeam?: number | null;
}
export interface RulePlayer { race: string; position: string; aliases?: string[]; keywords?: string[]; type?: string }

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const PREFIX = "Tournament rule: ";
export const STAT_KEYS = ["MA", "ST", "AG", "PA", "AV"] as const;

/** Clean raw package JSON into rules, or null when nothing is set. Bad entries are dropped, never thrown. */
export function cleanStatIncreaseRules(raw: unknown): StatIncreaseRules | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const positions = (v: unknown): RulePosition[] =>
    (Array.isArray(v) ? v : []).filter((p): p is RulePosition => !!p && typeof p === "object" && typeof (p as RulePosition).position === "string" && (p as RulePosition).position.trim() !== "")
      .map((p) => ({ race: typeof p.race === "string" && p.race.trim() ? p.race : "*", position: p.position }));
  const words = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim());
  const out: StatIncreaseRules = {};
  const ep = positions(r.excludePositions);
  if (ep.length) out.excludePositions = ep;
  const ek = words(r.excludeKeywords);
  if (ek.length) out.excludeKeywords = ek;
  const bs = (Array.isArray(r.blockedStats) ? r.blockedStats : []).flatMap((b): BlockedStat[] => {
    if (!b || typeof b !== "object") return [];
    const stat = String((b as BlockedStat).stat ?? "").toUpperCase();
    if (!(STAT_KEYS as readonly string[]).includes(stat)) return [];
    const row: BlockedStat = { stat };
    const p = positions((b as BlockedStat).positions);
    const k = words((b as BlockedStat).keywords);
    if (p.length) row.positions = p;
    if (k.length) row.keywords = k;
    return [row];
  });
  if (bs.length) out.blockedStats = bs;
  const cap = r.maxPerTeam;
  if (typeof cap === "number" && Number.isSafeInteger(cap) && cap >= 0) out.maxPerTeam = cap; // anything else is a load problem and ignored
  return Object.keys(out).length ? out : null;
}

/** Rewrite every race in the rules through `canon` (the dataset roster's name), so "Chaos Renegades" and "Chaos Renegade" are one race.
 *  The validator and the server's builder block both use findRoster for `canon`; the dialog compares the canonical names. */
export function canonicalizeStatRuleRaces(rules: StatIncreaseRules | null, canon: (race: string) => string): StatIncreaseRules | null {
  if (!rules) return rules;
  const fix = (list?: RulePosition[]): RulePosition[] | undefined => list?.map((p) => ({ ...p, race: p.race === "*" || p.race.trim() === "" ? "*" : canon(p.race) }));
  const out: StatIncreaseRules = { ...rules };
  if (rules.excludePositions) out.excludePositions = fix(rules.excludePositions);
  if (rules.blockedStats) out.blockedStats = rules.blockedStats.map((b) => (b.positions ? { ...b, positions: fix(b.positions) } : b));
  return out;
}

const raceMatches = (want: string, race: string): boolean => want === "*" || norm(want) === "" || norm(want) === norm(race);
const positionMatches = (list: RulePosition[] | undefined, p: RulePlayer): RulePosition | undefined =>
  (list ?? []).find((x) => raceMatches(x.race, p.race) && [p.position, ...(p.aliases ?? [])].some((n) => norm(n) === norm(x.position)));
const keywordMatches = (list: string[] | undefined, p: RulePlayer): string | undefined =>
  (list ?? []).find((k) => [...(p.keywords ?? []), p.type ?? ""].some((n) => n !== "" && norm(n) === norm(k)));

/** Why this player may not take ANY stat increase under the rules ("" = may). */
export function playerStatRuleBlock(rules: StatIncreaseRules | null | undefined, p: RulePlayer): string {
  if (!rules) return "";
  const pos = positionMatches(rules.excludePositions, p);
  if (pos) return `${PREFIX}no stat increases for ${pos.position} players.`;
  const kw = keywordMatches(rules.excludeKeywords, p);
  if (kw) return `${PREFIX}no stat increases for ${kw} players.`;
  return "";
}

/** Why this player may not take THIS stat ("" = may): the whole-player exclusions first, then the blocked-stat rows. */
export function statRuleBlock(rules: StatIncreaseRules | null | undefined, p: RulePlayer, stat: string): string {
  if (!rules) return "";
  const whole = playerStatRuleBlock(rules, p);
  if (whole) return whole;
  for (const b of rules.blockedStats ?? []) {
    if (b.stat !== stat) continue;
    const scoped = (b.positions?.length ?? 0) + (b.keywords?.length ?? 0) > 0;
    if (!scoped) return `${PREFIX}no ${stat} increases.`;
    const pos = positionMatches(b.positions, p);
    if (pos) return `${PREFIX}no ${stat} increases for ${pos.position} players.`;
    const kw = keywordMatches(b.keywords, p);
    if (kw) return `${PREFIX}no ${stat} increases for ${kw} players.`;
  }
  return "";
}

/** The per-team cap: "" while `taken` (increases already on the team) leaves room for one more. */
export function teamCapBlock(rules: StatIncreaseRules | null | undefined, taken: number): string {
  const cap = rules?.maxPerTeam;
  if (cap == null || taken < cap) return "";
  return `${PREFIX}max ${cap} stat increase${cap === 1 ? "" : "s"} per team.`;
}
