/**
 * TourPlay import upload (lane L8; registration spec 2026-11-02 §4 (b), creation wizards v2 "TourPlay import"): an
 * organiser uploads the export they downloaded from TourPlay, previews it, and applies it to their league. Law 20a: the
 * import is completely inert. It reads only the uploaded files (tourplayUpload.ts, in memory) and never contacts
 * the TourPlay site or anything else: no logos, avatars, links or lookups (test/tourplayImport.test.ts stubs the network).
 *
 *   POST /api/leagues/:id/tourplay/preview                { zip | files, decisions? } what would be imported (writes nothing)
 *   POST /api/leagues/:id/tourplay/apply                  { zip | files, decisions? } import through the league store
 *   GET  /api/leagues/:id/tourplay                        the review list: coach rows, suggestions, claims, imports
 *   POST /api/leagues/:id/tourplay/coaches/:row/assign    { coachId: string | null, allSeasons? } the organiser's pick
 *   POST /api/leagues/:id/tourplay/claims/:claim/approve  { allSeasons? }  |  .../decline
 *   GET  /api/leagues/:id/tourplay/claimable              (signed in) imported names nobody is linked to, and my claims
 *   POST /api/leagues/:id/tourplay/claims                 { row } "Is this you?" -> a pending claim for the organisers
 *   POST /api/leagues/:id/tourplay/claims/:claim/withdraw (the claimant)
 *
 * Organisers of the league and site admins run the upload and the review; any signed-in coach may claim. Writes are
 * POSTs (the CSRF guard covers them by method); every GET is read-only. Uploads and claims are rate-limited per coach.
 *
 * Matching (owner 11-02/03): a TourPlay coach links to a site account when its NAF user equals a profile's NAF name
 * (case-insensitive) OR its NAF number equals a profile's NAF number (a number match is strong). When the two point at
 * different accounts, or either points at several, nothing is linked and the row goes to the review list. Likely
 * matches (similar names, similar NAF names, the same team name in an earlier season) are only SUGGESTED: nothing fuzzy
 * is ever assigned without the organiser's pick. An organiser's pick (preview or review list) and an approved claim are
 * remembered and win on every re-import.
 *
 * NAF numbers (owner: "Do not drop the NAF Number"; law 23): parsed from the participants file, used for matching, and
 * kept only in the league's private record (<leagueDir>/tourplay-import.json). The organiser sees the number only on a
 * row linked to a site coach; it never reaches a season record, a public read or export.zip. Payment, CheckedValid and
 * Observations stay dropped. The privacy export and delete cover the record (src/privacy/collectors.ts, leagues).
 *
 * Re-import: a season is replaced by its TourPlay slug; the organiser's coach assignments (carryCoachAssignments), the
 * participant flags (carryParticipantFlags) and every season field the export does not produce (news, registration,
 * stage, podium, log, ...) are kept, so the same upload twice changes nothing but the import time.
 */
import { createHash, randomBytes } from "node:crypto";
import { canonicalNafId } from "../auth/identitiesStore.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { fixtureLockKey, withForkLocks } from "./forkPlay.js";
import { forkPlayLock, forkTeamIdFor } from "./forkTeam.js";
import { readJsonObject } from "./http.js";
import { carryParticipantFlags } from "./participants.js";
import { assertUniquePlayerIds, linkPlayerCareers } from "./playerIds.js";
import { isLeagueOrganiser, LeagueStoreError } from "./store.js";
import { applyTeamCoach } from "./teamCoach.js";
import { refreshTeamValues } from "./teamValue.js";
import { mergeSeason, snapshotOf, type MergeResult } from "./tourplayMerge.js";
import { firstSeason } from "./wizard.js";
import {
  buildSeason, fixturePlayed, nameKey, parseFixtures, parseParticipantNaf, parseRoster, parseStandings, type BuildSeasonResult, type CoachMapper,
} from "./tourplay.js";
import { UPLOAD_MAX_BODY_BYTES, UploadError, uploadEntries, uploadSeasons, type UploadSeason } from "./tourplayUpload.js";
import type { LeagueRecord, LeagueTeam, SeasonRecord, TourplayClaim, TourplayCoachRecord, TourplayImportFile, TourplayMatchBasis, TourplayMatchStatus } from "./types.js";

/** What the import reads of a site coach: the account, display name and the profile's NAF details (identities.json). */
export interface TourplayProfile { coach: string; displayName?: string; nafName?: string; nafId?: string; banned?: boolean }

export interface TourplaySuggestion { coach: string; reasons: string[]; score: number }

const noStore = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown, extra: Partial<LeagueApiResult> = {}): LeagueApiResult => ({ status, headers: noStore, body, ...extra });
const fail = (status: number, error: string, field?: string): LeagueApiResult => res(status, { error, ...(field ? { field } : {}) });
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const rowId = (key: string): string => `tp${sha(`tourplay-coach\0${key}`).slice(0, 12)}`;
const sameCoach = (a: string | undefined, b: string | undefined): boolean => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase() && Boolean((a ?? "").trim());
const uniq = (xs: string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = x.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};

// ---- rate limits ------------------------------------------------------------------------------------------------

export const UPLOAD_LIMIT = 20;
export const UPLOAD_WINDOW_MS = 10 * 60_000;
export const CLAIM_LIMIT = 10;
export const CLAIM_WINDOW_MS = 60 * 60_000;
/** Pending claims one coach may hold in one league. */
export const MAX_PENDING_CLAIMS = 5;
/** Claims kept per league (decided ones beyond this are dropped oldest first). */
export const MAX_CLAIMS = 500;
const buckets = new Map<string, number[]>();
/** Seconds to wait, or 0 (and the call is counted). */
function limited(key: string, limit: number, windowMs: number, now: number): number {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) { buckets.set(key, recent); return Math.max(1, Math.ceil((windowMs - (now - recent[0]!)) / 1000)); }
  recent.push(now);
  buckets.set(key, recent);
  return 0;
}
export function resetTourplayLimits(): void { buckets.clear(); }

// ---- the export's coaches ---------------------------------------------------------------------------------------

/** One TourPlay coach of the upload: the NAF user (when given) is the identity, else the display name. */
export interface ImportCoach {
  key: string;
  id: string;
  name: string;
  /** Display-name keys seen for this coach. */
  names: Set<string>;
  nafUser?: string;
  nafNumbers: Set<string>;
  /** Team names by upload season index. */
  teams: Map<number, Set<string>>;
}

const none: CoachMapper = () => undefined;

/** Every coach the upload names (participants, fixtures, rosters, standings), merged by NAF user, else by display name. */
export function collectImportCoaches(seasons: readonly UploadSeason[]): ImportCoach[] {
  type Row = { season: number; coach: string; nafUser?: string; nafNumber?: string; team: string };
  const rows: Row[] = [];
  seasons.forEach((s, season) => {
    const f = s.files;
    if (f.participants) for (const p of parseParticipantNaf(f.participants)) rows.push({ season, ...p });
    if (f.fixtures) for (const fx of parseFixtures(f.fixtures, none)) for (const side of [fx.home, fx.away]) rows.push({ season, coach: side.coach, ...(side.nafUser ? { nafUser: side.nafUser } : {}), team: side.team });
    for (const r of f.rosters) { const t = parseRoster(r.text, none); if (t) rows.push({ season, coach: t.coach, ...(t.nafUser ? { nafUser: t.nafUser } : {}), team: t.name }); }
    for (const st of f.standings) for (const row of parseStandings(st.text, none).rows) rows.push({ season, coach: row.coach, team: row.team });
  });
  const byKey = new Map<string, ImportCoach>();
  const add = (key: string, r: Row): void => {
    let c = byKey.get(key);
    if (!c) {
      c = { key, id: rowId(key), name: r.coach.trim() || (r.nafUser ?? "").trim(), names: new Set(), nafNumbers: new Set(), teams: new Map(), ...(r.nafUser ? { nafUser: r.nafUser.trim() } : {}) };
      byKey.set(key, c);
    }
    if (!c.name && r.coach.trim()) c.name = r.coach.trim();
    if (r.coach.trim()) c.names.add(nameKey(r.coach));
    if (r.nafNumber) c.nafNumbers.add(r.nafNumber);
    if (r.team.trim()) {
      const set = c.teams.get(r.season) ?? new Set<string>();
      set.add(r.team.trim());
      c.teams.set(r.season, set);
    }
  };
  for (const r of rows) if (r.nafUser?.trim()) add(`naf:${r.nafUser.trim().toLowerCase()}`, r);
  for (const r of rows) {
    if (r.nafUser?.trim() || !r.coach.trim()) continue;
    const nk = nameKey(r.coach);
    const withName = [...byKey.values()].filter((c) => c.key.startsWith("naf:") && c.names.has(nk));
    add(withName.length === 1 ? withName[0]!.key : `name:${nk}`, r);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- matching ---------------------------------------------------------------------------------------------------

export interface ExactMatch {
  status: TourplayMatchStatus;
  basis?: TourplayMatchBasis;
  coachId?: string;
  candidates?: { byName: string[]; byNumber: string[] };
  reason?: string;
}

/** NAF user -> profile NAF name (case-insensitive) OR NAF number -> profile NAF number. Conflicts and duplicates never link. */
export function exactMatch(c: Pick<ImportCoach, "nafUser" | "nafNumbers">, profiles: readonly TourplayProfile[]): ExactMatch {
  const live = profiles.filter((p) => !p.banned && p.coach.trim());
  const nafKey = c.nafUser?.trim().toLowerCase();
  const byName = uniq(nafKey ? live.filter((p) => p.nafName?.trim().toLowerCase() === nafKey).map((p) => p.coach) : []);
  const numbers = [...c.nafNumbers];
  const byNumber = uniq(numbers.length ? live.filter((p) => { const n = canonicalNafId(p.nafId); return n !== undefined && numbers.includes(n); }).map((p) => p.coach) : []);
  const candidates = { byName, byNumber };
  if (numbers.length > 1) return { status: "conflict", candidates, reason: "The export gives this coach more than one NAF number." };
  if (byName.length > 1) return { status: "ambiguous", candidates, reason: "Several site coaches have this NAF name." };
  if (byNumber.length > 1) return { status: "ambiguous", candidates, reason: "Several site coaches have this NAF number." };
  const [n, m] = [byName[0], byNumber[0]];
  if (n && m && !sameCoach(n, m)) return { status: "conflict", candidates, reason: `The NAF name matches ${n} but the NAF number matches ${m}.` };
  // A match is a PROPOSAL (profile NAF details are self-entered, unverified): it links only once the organiser confirms it.
  if (n && m) return { status: "matched", basis: "naf-name+number", coachId: m, candidates };
  if (m) return { status: "matched", basis: "naf-number", coachId: m, candidates };
  if (n) return { status: "matched", basis: "naf-name", coachId: n, candidates };
  return { status: "unmatched" };
}

const norm = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const tokens = (s: string): string[] => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

function levenshtein(a: string, b: string): number {
  const x = a.slice(0, 64);
  const y = b.slice(0, 64);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}

/** 0..1 closeness of two names (accents, case, spacing and punctuation ignored; a bracketed or second word may match). */
export function nameSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  let best = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.includes(short)) best = Math.max(best, 0.85);
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.some((t) => t.length >= 4 && tb.includes(t))) best = Math.max(best, 0.8);
  return best;
}

export const SUGGEST_THRESHOLD = 0.75;

/**
 * Likely site coaches for an unlinked TourPlay coach (never applied on their own): the exact-match candidates, similar
 * account / display names, similar NAF names, and the coach of a team with the same name in an earlier season.
 */
export function suggestCoaches(
  c: { name: string; nafUser?: string; teams: readonly string[] },
  profiles: readonly TourplayProfile[],
  history: ReadonlyArray<{ team: string; coachId: string; season: string }>,
  candidates?: { byName: string[]; byNumber: string[] },
  limit = 3,
): TourplaySuggestion[] {
  const out = new Map<string, TourplaySuggestion>();
  const live = profiles.filter((p) => !p.banned && p.coach.trim());
  const accountOf = (coach: string): string | undefined => live.find((p) => sameCoach(p.coach, coach))?.coach;
  const add = (coach: string, score: number, reason: string): void => {
    const account = accountOf(coach);
    if (!account) return;
    const k = account.toLowerCase();
    const s = out.get(k) ?? { coach: account, reasons: [], score: 0 };
    if (!s.reasons.includes(reason)) s.reasons.push(reason);
    s.score = Math.max(s.score, score) + (s.reasons.length > 1 ? 0.05 : 0);
    out.set(k, s);
  };
  for (const coach of candidates?.byNumber ?? []) add(coach, 2, "NAF number matches");
  for (const coach of candidates?.byName ?? []) add(coach, 1.9, "NAF name matches");
  for (const p of live) {
    const names = [p.coach, p.displayName ?? ""].filter(Boolean);
    const nameScore = Math.max(0, ...names.map((n) => nameSimilarity(c.name, n)));
    if (nameScore >= SUGGEST_THRESHOLD) add(p.coach, nameScore, nameScore === 1 ? "Same name" : "Similar name");
    if (c.nafUser && p.nafName) {
      const nafScore = nameSimilarity(c.nafUser, p.nafName);
      const listed = (candidates?.byName ?? []).some((x) => sameCoach(x, p.coach));
      if (nafScore >= SUGGEST_THRESHOLD && !(nafScore === 1 && listed)) add(p.coach, nafScore, nafScore === 1 ? "Same NAF name" : "Similar NAF name");
    }
  }
  const teamKeys = new Set(c.teams.map(nameKey));
  for (const h of history) if (teamKeys.has(nameKey(h.team))) add(h.coachId, 1.1, `Coached ${h.team} in ${h.season}`);
  return [...out.values()].sort((a, b) => b.score - a.score || a.coach.localeCompare(b.coach)).slice(0, limit).map((s) => ({ ...s, score: Math.round(s.score * 100) / 100 }));
}

/** Teams with a linked account in the league's stored seasons: the "same team name earlier" history. */
function teamHistory(seasons: readonly SeasonRecord[], skip: ReadonlySet<string>): Array<{ team: string; coachId: string; season: string; seasonId: string }> {
  const out: Array<{ team: string; coachId: string; season: string; seasonId: string }> = [];
  for (const s of seasons) {
    if (skip.has(s.id)) continue;
    for (const t of s.teams) if (t.coachId && !t.coachAssigned?.cleared) out.push({ team: t.name, coachId: t.coachId, season: s.name, seasonId: s.id });
  }
  return out;
}

// ---- plan / preview / apply -------------------------------------------------------------------------------------

export const seasonNumberFromSlug = (slug: string): number | undefined => {
  const m = /season-(\d+)/i.exec(slug);
  const n = m ? Number(m[1]) : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n > 0 && n < 10_000 ? n : undefined;
};

/**
 * The wizard's untouched Season 1: exactly what firstSeason made (no custom phases, registration, news, teams, rules).
 * The only season an import may replace that it did not import itself.
 */
export function untouchedFirstSeason(s: SeasonRecord, league: LeagueRecord): boolean {
  if (s.source !== "manual" || s.id !== "season-1") return false;
  const strip = (x: SeasonRecord): string => JSON.stringify({ ...x, revision: undefined, importedAt: undefined });
  try { return strip(s) === strip(firstSeason(league, s.importedAt)); } catch { return false; }
}

export interface PlannedSeason {
  /** The season's position in the upload (ImportCoach.teams keys). */
  index: number;
  folder: string;
  slug: string;
  number: number;
  id: string;
  action: "new" | "update" | "replace-empty";
  /** The TourPlay number was taken by a season made here, so the export lands under another number. */
  renumbered?: { from: number };
  problem?: string;
  prior?: SeasonRecord;
  /** Stored seasons this import removes (the wizard's untouched Season 1 under another id). */
  removes: string[];
  built?: BuildSeasonResult;
  /** A re-import: the merged season, its conflicts and the new snapshot (tourplayMerge.ts). */
  merge?: MergeResult;
  /** Teams the export had no roster for (made from the participants / fixtures). */
  derivedTeams: string[];
}

export interface PlannedCoach {
  coach: ImportCoach;
  match: ExactMatch;
  /** The account the import links: ONLY an organiser's decision (this preview, remembered, the Teams tab, a claim). */
  coachId?: string;
  decision?: TourplayCoachRecord["decision"];
  /** This request's decision (applied over every carried assignment). */
  asked: boolean;
  suggestions: TourplaySuggestion[];
}

export interface ImportPlan { seasons: PlannedSeason[]; coaches: PlannedCoach[]; problems: string[]; file: TourplayImportFile }

/** Teams the fixtures / standings / participants name but no roster file gives: a team record without players, so the
 *  coach can still be seated (review P2). */
function deriveMissingTeams(season: SeasonRecord): Array<{ id: string; name: string }> {
  const added: Array<{ id: string; name: string }> = [];
  const seen = new Set(season.teams.map((t) => t.id));
  const add = (teamId: string | undefined, name: string, race: string, coach: string, nafUser: string | undefined, coachId: string | undefined): void => {
    if (!teamId || seen.has(teamId) || !name.trim()) return;
    seen.add(teamId);
    added.push({ id: teamId, name });
    season.teams.push({
      id: teamId, name, race, coach, ...(coachId ? { coachId } : {}), ...(nafUser ? { nafUser } : {}),
      teamValue: null, importedTeamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null, cheerleaders: null,
      apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [],
    });
  };
  for (const f of season.fixtures) for (const sd of [f.home, f.away]) add(sd.teamId, sd.team, sd.race, sd.coach, sd.nafUser, sd.coachId);
  for (const p of season.phases) for (const r of p.standings) add(r.teamId, r.team, r.race, r.coach, undefined, r.coachId);
  season.teams.sort((a, b) => a.name.localeCompare(b.name) || a.coach.localeCompare(b.coach));
  return added;
}

/**
 * Builds everything an apply would write, writing nothing. `decisions`: row id -> account (null = none), from the
 * organiser; `choices`: merge conflict ids the organiser resolved to the export.
 */
export function planImport(input: {
  league: LeagueRecord;
  stored: SeasonRecord[];
  file: TourplayImportFile;
  upload: UploadSeason[];
  profiles: TourplayProfile[];
  decisions: Record<string, string | null>;
  choices?: readonly string[];
  by: string;
  now: Date;
}): ImportPlan {
  const { league, stored, file, upload, profiles, now } = input;
  const choices = new Set(input.choices ?? []);
  const problems: string[] = [];
  const seasonsOnly = stored.filter((s) => s.competition !== "ladder");
  // Seasons: an earlier upload of the same slug is updated (merged); else the slug's season number when it is free (or
  // the wizard's untouched Season 1), else the next free number. A season made here is never replaced.
  const ordered = upload.map((u, i) => ({ u, i, n: seasonNumberFromSlug(u.files.slug) })).sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.i - b.i);
  const seasons: PlannedSeason[] = [];
  const seenSlug = new Set<string>();
  const usedNumbers = (): Set<number> => new Set([...seasonsOnly.filter((s) => !(untouchedFirstSeason(s, league) && seasons.some((p) => p.removes.includes(s.id) || p.id === s.id))).map((s) => s.number), ...seasons.map((s) => s.number)]);
  const idTaken = (id: string): boolean => stored.some((s) => s.id === id) || seasons.some((s) => s.id === id);
  const nextFree = (): number => { const used = usedNumbers(); let n = 1; while (used.has(n) || idTaken(`season-${n}`)) n += 1; return n; };
  for (const { u, i, n } of ordered) {
    const slug = u.files.slug;
    const prior = stored.find((s) => s.sourceSlug === slug && s.source === "tourplay-export" && s.competition !== "ladder");
    const plan: PlannedSeason = { index: i, folder: u.folder, slug, number: 0, id: "", action: prior ? "update" : "new", removes: [], derivedTeams: [], ...(prior ? { prior } : {}) };
    if (seenSlug.has(slug.toLowerCase())) plan.problem = `The export ${slug} is in the upload twice.`;
    seenSlug.add(slug.toLowerCase());
    if (prior) { plan.number = prior.number; plan.id = prior.id; }
    else {
      const wanted = n ?? nextFree();
      const holders = stored.filter((s) => s.id === `season-${wanted}` || (s.competition !== "ladder" && s.number === wanted));
      const free = !seasons.some((s) => s.number === wanted) && holders.every((s) => untouchedFirstSeason(s, league));
      if (free) {
        plan.number = wanted;
        plan.id = `season-${wanted}`;
        if (holders.length) { plan.action = "replace-empty"; plan.removes = holders.map((s) => s.id).filter((x) => x !== plan.id); }
      } else {
        plan.number = nextFree();
        plan.id = `season-${plan.number}`;
        if (n !== undefined) plan.renumbered = { from: n };
      }
    }
    seasons.push(plan);
  }
  for (const s of seasons) if (s.problem) problems.push(s.problem);

  // Coaches: matches are only proposals; what links is the organiser's decision (this request, else remembered).
  const coachesRaw = collectImportCoaches(upload);
  const skip = new Set(seasons.flatMap((s) => [s.id, ...s.removes]));
  const history = teamHistory(stored, skip);
  const live = profiles.filter((p) => !p.banned);
  const coaches: PlannedCoach[] = coachesRaw.map((coach) => {
    const match = exactMatch(coach, profiles);
    const asked = Object.prototype.hasOwnProperty.call(input.decisions, coach.id) ? input.decisions[coach.id] : undefined;
    const remembered = file.coaches[coach.key]?.obsolete ? undefined : file.coaches[coach.key]?.decision;
    let decision: TourplayCoachRecord["decision"] | undefined = remembered;
    if (asked !== undefined) {
      const account = asked === null ? null : live.find((p) => sameCoach(p.coach, asked))?.coach;
      if (account === undefined) problems.push(`No site coach called "${String(asked).slice(0, 64)}" (for ${coach.name}).`);
      else decision = { coachId: account, by: input.by, at: now.toISOString(), via: "organiser" };
    }
    const coachId = decision?.coachId ?? undefined;
    const teams = [...new Set([...coach.teams.values()].flatMap((x) => [...x]))];
    const suggestions = !decision ? suggestCoaches({ name: coach.name, ...(coach.nafUser ? { nafUser: coach.nafUser } : {}), teams }, profiles, history, match.candidates) : [];
    return { coach, match, ...(coachId ? { coachId } : {}), ...(decision ? { decision } : {}), asked: asked !== undefined && decision !== remembered, suggestions };
  });
  for (const id of Object.keys(input.decisions)) if (!coaches.some((c) => c.coach.id === id)) problems.push("A decision names a coach row that is not in this upload.");

  const byNaf = new Map<string, PlannedCoach>();
  const byName = new Map<string, PlannedCoach[]>();
  for (const c of coaches) {
    if (c.coach.key.startsWith("naf:")) byNaf.set(c.coach.key, c);
    for (const nm of c.coach.names) byName.set(nm, [...(byName.get(nm) ?? []), c]);
  }
  const mapCoach: CoachMapper = (coach, nafUser) => {
    if (nafUser?.trim()) return byNaf.get(`naf:${nafUser.trim().toLowerCase()}`)?.coachId;
    const hits = byName.get(nameKey(coach)) ?? [];
    return hits.length === 1 ? hits[0]!.coachId : undefined;
  };

  const newestStored = Math.max(0, ...seasonsOnly.filter((s) => !skip.has(s.id)).map((s) => s.number));
  const newestUpload = Math.max(0, ...seasons.filter((s) => !s.problem).map((s) => s.number));
  for (const s of seasons) {
    if (s.problem) continue;
    const files = upload.find((u) => u.files.slug === s.slug && u.folder === s.folder)!.files;
    try {
      const built = buildSeason({ leagueId: league.id, number: s.number, files, mapCoach, now });
      built.season.id = s.id;
      const derived = deriveMissingTeams(built.season);
      s.derivedTeams = derived.map((d) => d.name);
      const champion = built.season.awards.some((a) => a.type === "Overall Champion");
      built.season.status = champion || s.number !== newestUpload || newestStored > newestUpload ? "completed" : "active";
      s.built = built;
      if (s.prior) {
        s.merge = mergeSeason(s.prior, built.season, file.snapshots?.[s.prior.id], choices, s.slug, new Set(derived.map((d) => d.id)));
        if (s.prior.status === "completed") s.merge.season.status = "completed";
      }
    } catch (err) {
      s.problem = `${s.slug}: ${err instanceof Error ? err.message : "the export could not be read"}`;
      problems.push(s.problem);
    }
  }
  // A decision for a coach with no team in this upload (no roster, nothing to derive) cannot be applied.
  for (const c of coaches) {
    if (!c.asked || !c.decision?.coachId) continue;
    const anyTeam = seasons.some((s) => (s.merge?.season ?? s.built?.season)?.teams.some((t) => teamOf(c.coach, t)));
    if (!anyTeam) problems.push(`${c.coach.name} has no team in the export to link (upload the roster files).`);
    // A team in a live Super FUMBBL game keeps its owner until the result is in (forkPlayLock, as the Teams tab and the
    // review list enforce; review P2).
    for (const s of seasons) {
      const season = s.merge?.season;
      if (!season) continue;
      for (const t of season.teams.filter((x) => teamOf(c.coach, x))) {
        const locked = forkPlayLock(season, t.id);
        if (locked && !(t.coachAssigned && !t.coachAssigned.cleared && sameCoach(t.coachId, c.decision.coachId))) problems.push(`${c.coach.name}: ${locked}`);
      }
    }
  }
  return { seasons, coaches, problems, file };
}

const PHASE_LABEL = (p: SeasonRecord["phases"][number]): string => `${p.category} ${p.name}${p.groups.filter(Boolean).length ? ` (${p.groups.filter(Boolean).join(", ")})` : ""}`;

/** Does this season team belong to the TourPlay coach? By NAF user, else by display name. */
function teamOf(c: ImportCoach, t: LeagueTeam): boolean {
  if (t.nafUser?.trim()) return c.key === `naf:${t.nafUser.trim().toLowerCase()}`;
  return c.names.has(nameKey(t.coach));
}

/** The preview the SPA shows before Apply. NAF numbers appear only as "on file". Every row shows its match basis. */
export function previewView(plan: ImportPlan) {
  const coaches = plan.coaches.map((c) => ({
    id: c.coach.id,
    name: c.coach.name,
    ...(c.coach.nafUser ? { nafUser: c.coach.nafUser } : {}),
    hasNafNumber: c.coach.nafNumbers.size > 0,
    teams: [...new Set([...c.coach.teams.values()].flatMap((x) => [...x]))].sort(),
    seasons: [...c.coach.teams.keys()].map((i) => plan.seasons.find((s) => s.index === i)?.number).filter((n): n is number => n !== undefined).sort((a, b) => a - b),
    status: c.match.status,
    basis: c.match.basis ?? "none",
    ...(c.match.coachId ? { proposed: c.match.coachId } : {}),
    ...(c.match.candidates && (c.match.candidates.byName.length || c.match.candidates.byNumber.length) ? { candidates: c.match.candidates } : {}),
    ...(c.match.reason ? { reason: c.match.reason } : {}),
    ...(c.coachId ? { coachId: c.coachId } : {}),
    ...(c.decision ? { decision: { coachId: c.decision.coachId, via: c.decision.via } } : {}),
    confirmed: Boolean(c.decision),
    suggestions: c.suggestions,
  }));
  const counts = { matched: 0, unmatched: 0, ambiguous: 0, conflict: 0, linked: 0, proposed: 0 };
  for (const c of plan.coaches) {
    counts[c.match.status] += 1;
    if (c.coachId) counts.linked += 1;
    else if (!c.decision && c.match.status === "matched") counts.proposed += 1;
  }
  return {
    seasons: plan.seasons.map((s) => {
      const season = s.merge?.season ?? s.built?.season;
      return {
        folder: s.folder, slug: s.slug, number: s.number, id: s.id, action: s.action,
        ...(s.renumbered ? { renumbered: s.renumbered } : {}),
        ...(s.problem ? { problem: s.problem } : {}),
        ...(s.removes.length ? { removes: s.removes } : {}),
        ...(s.derivedTeams.length ? { derivedTeams: s.derivedTeams } : {}),
        ...(s.merge ? { merge: s.merge.counts, conflicts: s.merge.conflicts } : {}),
        ...(season ? {
          name: season.name, ruleset: season.ruleset, status: season.status,
          teams: season.teams.length, players: season.teams.reduce((n, t) => n + t.players.length, 0),
          fixtures: season.fixtures.length, played: season.fixtures.filter(fixturePlayed).length,
          phases: season.phases.map(PHASE_LABEL), standings: season.phases.filter((p) => p.standings.length).length,
          honours: season.honours.length, awards: season.awards.length,
          mismatches: s.built!.mismatches.length, ambiguities: s.built!.ambiguities.length,
        } : {}),
      };
    }),
    coaches,
    counts,
    problems: plan.problems,
    canApply: plan.problems.length === 0 && plan.seasons.some((s) => s.built),
  };
}

/**
 * Writes the plan: new seasons as built, re-imported seasons merged (tourplayMerge.ts), the organiser's assignments
 * carried, then every decision applied through teamCoach (this request's last, so it wins), then the private record.
 */
export function applyPlan(plan: ImportPlan, deps: Pick<LeagueApiDeps, "store">, league: LeagueRecord, by: string, now: Date) {
  const { store } = deps;
  const ready = plan.seasons.filter((s) => s.built);
  const at = now.toISOString();
  const target = (s: PlannedSeason): SeasonRecord => s.merge?.season ?? s.built!.season;
  for (const s of ready) {
    const season = target(s);
    if (s.prior) {
      // Participant rows are the export's again: put back their flags and the organiser's seats (teams kept theirs).
      carryParticipantFlags(s.prior, season);
      for (const t of season.teams) {
        const mark = t.coachAssigned;
        if (!mark) continue;
        applyTeamCoach(season, t.id, mark.cleared ? null : t.coachId ?? null, mark.by, mark.at, false);
        t.coachAssigned = { ...mark };
      }
      refreshTeamValues(season, undefined, { fillStoredValues: true, now });
    }
    // Decisions: remembered ones first (no log), this request's last (logged); each seats the row's teams via teamCoach.
    for (const pass of [false, true]) {
      for (const c of plan.coaches) {
        if (!c.decision || c.asked !== pass) continue;
        for (const t of season.teams.filter((x) => teamOf(c.coach, x))) {
          const already = t.coachAssigned && !t.coachAssigned.cleared ? t.coachId : t.coachAssigned?.cleared ? null : undefined;
          if (!pass && already !== undefined) continue; // a seat the organiser set since is newer than a remembered decision
          if (forkPlayLock(season, t.id)) {
            if (pass) throw new LeagueStoreError(409, `${t.name} is playing a Super FUMBBL game; its coach can change once the result is in.`);
            continue;
          }
          applyTeamCoach(season, t.id, c.decision.coachId, c.decision.by, pass ? at : c.decision.at, pass);
        }
      }
    }
  }
  const replacedIds = new Set(ready.flatMap((s) => [...(s.prior ? [s.prior.id] : []), ...s.removes, s.id]));
  const others = store.seasons(league.id).filter((x) => !replacedIds.has(x.id));
  const fresh = ready.map(target);
  linkPlayerCareers([...others, ...fresh]);
  assertUniquePlayerIds([...others, ...fresh]);
  const results: Array<{ id: string; number: number; slug: string; action: string; conflictsKept: number }> = [];
  for (const s of ready) {
    for (const gone of s.removes) store.removeSeason(league.id, gone);
    store.putSeason(target(s));
    results.push({ id: s.id, number: s.number, slug: s.slug, action: s.action, conflictsKept: s.merge?.conflicts.length ?? 0 });
  }

  // The private record: one row per TourPlay coach; rows of this upload's seasons that the export no longer names lose
  // those seasons, and a row left with none is obsolete (not claimable or assignable).
  const file: TourplayImportFile = store.tourplayImport(league.id);
  const uploaded = new Set(fresh.map((x) => x.id));
  const inUpload = new Set(plan.coaches.map((c) => c.coach.key));
  for (const [key, rec] of Object.entries(file.coaches)) {
    if (inUpload.has(key)) continue;
    const kept = rec.seasons.filter((x) => !uploaded.has(x.seasonId));
    if (kept.length === rec.seasons.length) continue;
    rec.seasons = kept;
    if (!kept.length) {
      rec.obsolete = true;
      for (const cl of file.claims) if (cl.row === rec.id && cl.state === "pending") { cl.state = "declined"; cl.decidedBy = by; cl.decidedAt = at; }
    }
  }
  for (const c of plan.coaches) {
    const prev = file.coaches[c.coach.key];
    const seasons = [
      ...(prev?.seasons ?? []).filter((x) => !uploaded.has(x.seasonId)),
      ...ready.filter((s) => c.coach.teams.has(s.index)).map((s) => {
        const season = target(s);
        const teams = season.teams.filter((t) => teamOf(c.coach, t));
        return { seasonId: season.id, number: season.number, teamIds: teams.map((t) => t.id), teams: teams.map((t) => t.name) };
      }),
    ].sort((a, b) => a.number - b.number);
    const numbers = [...c.coach.nafNumbers];
    const linked = [...new Set([...(prev?.linked ?? []), ...(prev?.coachId ? [prev.coachId] : []), ...(c.coachId ? [c.coachId] : [])])];
    file.coaches[c.coach.key] = {
      id: c.coach.id, key: c.coach.key, name: c.coach.name,
      ...(linked.length ? { linked } : {}),
      ...(prev?.seasonLinks ? { seasonLinks: prev.seasonLinks } : {}),
      ...(c.coach.nafUser ? { nafUser: c.coach.nafUser } : {}),
      ...(numbers[0] ? { nafNumber: numbers[0] } : prev?.nafNumber ? { nafNumber: prev.nafNumber } : {}),
      seasons,
      status: c.match.status,
      ...(c.match.basis ? { basis: c.match.basis } : {}),
      ...(c.coachId ? { coachId: c.coachId } : {}),
      ...(c.match.candidates && (c.match.candidates.byName.length || c.match.candidates.byNumber.length) ? { candidates: c.match.candidates } : {}),
      ...(c.match.reason ? { reason: c.match.reason } : {}),
      ...(c.decision ? { decision: c.decision } : {}),
    };
  }
  file.snapshots = { ...(file.snapshots ?? {}) };
  for (const s of ready) {
    for (const gone of s.removes) delete file.snapshots[gone];
    file.snapshots[s.id] = s.merge?.snapshot ?? snapshotOf(s.built!.season);
  }
  file.imports = [{ at, by, seasons: results.map((r) => ({ id: r.id, slug: r.slug, number: r.number, action: r.action })) }, ...file.imports].slice(0, 20);
  store.putTourplayImport(league.id, file);
  const counts = { linked: plan.coaches.filter((c) => c.coachId).length, review: plan.coaches.filter((c) => !c.decision).length };
  return { seasons: results, counts };
}

// ---- review list ------------------------------------------------------------------------------------------------

/** The account an organiser seated on EVERY team of the row outside the review list (Assign coach account), if one. */
export function teamAssigned(r: TourplayCoachRecord, seasons: readonly SeasonRecord[]): string | undefined {
  const accounts = new Map<string, string>();
  let teams = 0;
  for (const w of r.seasons) {
    const s = seasons.find((x) => x.id === w.seasonId);
    if (!s) continue;
    for (const id of w.teamIds) {
      const t = s.teams.find((x) => x.id === id);
      if (!t) continue;
      teams += 1;
      if (!t.coachAssigned || t.coachAssigned.cleared || !t.coachId) return undefined;
      accounts.set(t.coachId.trim().toLowerCase(), t.coachId);
    }
  }
  return teams && accounts.size === 1 ? [...accounts.values()][0] : undefined;
}

/** A row still waiting for the organiser: no decision, no exact match and no account seated on its teams. */
/** Every row needs the organiser (matches are only proposals) until decided, seated on the Teams tab, or obsolete. */
export const needsReview = (r: TourplayCoachRecord, seasons: readonly SeasonRecord[] = []): boolean => !r.obsolete && !r.decision && !teamAssigned(r, seasons);

/** The row's teams that still exist in the stored seasons (all its seasons, or only the newest). */
export function rowTeams(r: TourplayCoachRecord, seasons: readonly SeasonRecord[], allSeasons = true): Array<{ seasonId: string; teamIds: string[] }> {
  const wanted = allSeasons ? r.seasons : r.seasons.slice().sort((a, b) => b.number - a.number).slice(0, 1);
  return wanted.map((w) => {
    const season = seasons.find((x) => x.id === w.seasonId);
    return { seasonId: w.seasonId, teamIds: season ? w.teamIds.filter((id) => season.teams.some((t) => t.id === id)) : [] };
  }).filter((x) => x.teamIds.length);
}

/** The organiser's review list. The NAF number shows only on a row linked to a site coach (law 23). */
export function reviewView(file: TourplayImportFile, profiles: readonly TourplayProfile[], seasons: readonly SeasonRecord[]) {
  const history = teamHistory(seasons, new Set());
  const rows = Object.values(file.coaches).map((r) => {
    const assigned = teamAssigned(r, seasons);
    const linked = r.obsolete ? undefined : r.decision ? r.decision.coachId ?? undefined : assigned;
    const open = needsReview(r, seasons);
    const teams = [...new Set(r.seasons.flatMap((s) => s.teams))];
    // "the same team name earlier" excludes the rows' own seasons
    const own = new Set(r.seasons.map((s) => s.seasonId));
    const hist = history.filter((h) => !own.has(h.seasonId));
    return {
      id: r.id, name: r.name,
      ...(r.nafUser ? { nafUser: r.nafUser } : {}),
      hasNafNumber: Boolean(r.nafNumber),
      ...(linked && r.nafNumber ? { nafNumber: r.nafNumber } : {}),
      seasons: r.seasons.map((s) => ({ seasonId: s.seasonId, number: s.number, teams: s.teams })),
      status: r.status,
      basis: r.basis ?? "none",
      ...(linked ? { coachId: linked } : {}),
      ...(r.obsolete ? { obsolete: true } : {}),
      ...(r.candidates ? { candidates: r.candidates } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.decision ? { decision: { coachId: r.decision.coachId, by: r.decision.by, at: r.decision.at, via: r.decision.via } } : {}),
      ...(assigned && !r.decision ? { assignedOnTeams: true } : {}),
      needsReview: open,
      suggestions: open ? suggestCoaches({ name: r.name, ...(r.nafUser ? { nafUser: r.nafUser } : {}), teams }, profiles, hist, r.candidates) : [],
      claims: file.claims.filter((c) => c.row === r.id && c.state === "pending").map((c) => ({ id: c.id, coach: c.coach, at: c.at })),
    };
  }).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || b.claims.length - a.claims.length || a.name.localeCompare(b.name));
  const claims = file.claims.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100).map((c) => ({
    id: c.id, row: c.row, name: Object.values(file.coaches).find((r) => r.id === c.row)?.name ?? "", coach: c.coach, at: c.at, state: c.state,
    ...(c.decidedBy ? { decidedBy: c.decidedBy, decidedAt: c.decidedAt } : {}),
  }));
  const counts = {
    rows: rows.length, review: rows.filter((r) => r.needsReview).length, linked: rows.filter((r) => r.coachId).length,
    claims: file.claims.filter((c) => c.state === "pending").length,
  };
  return { rows, claims, imports: file.imports, counts };
}

// ---- routes -----------------------------------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();
/** One import / review write per league at a time (the private record and the seasons it touches). */
function withImportLock<T>(leagueId: string, task: () => Promise<T>): Promise<T> {
  const prior = locks.get(leagueId) ?? Promise.resolve();
  const run = prior.then(task, task);
  const tail = run.catch(() => undefined);
  locks.set(leagueId, tail);
  void tail.then(() => { if (locks.get(leagueId) === tail) locks.delete(leagueId); });
  return run;
}

function profilesOf(deps: LeagueApiDeps): TourplayProfile[] {
  try { return deps.coachProfiles?.() ?? []; } catch { return []; }
}

const manages = (league: LeagueRecord, auth: LeagueApiIdentity): boolean => auth.admin || isLeagueOrganiser(league, auth.coach);

function parseDecisions(raw: unknown): Record<string, string | null> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new UploadError("decisions must be an object of row id -> coach (or null).");
  const out: Record<string, string | null> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 2000) throw new UploadError("Too many decisions.");
  for (const [k, v] of entries) {
    if (!/^tp[a-f0-9]{12}$/.test(k)) throw new UploadError("A decision names an unknown coach row.");
    if (v === null) out[k] = null;
    else if (typeof v === "string" && v.trim() && v.length <= 64) out[k] = v.trim();
    else throw new UploadError("Each decision is a coach name, or null for no account.");
  }
  return out;
}

function parseChoices(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 5000 || raw.some((x) => typeof x !== "string" || !/^cf[a-f0-9]{12}$/.test(x))) throw new UploadError("choices must be a list of conflict ids.");
  return raw as string[];
}

const parseAllSeasons = (v: unknown): boolean | undefined => (v === undefined ? true : typeof v === "boolean" ? v : undefined);

/**
 * Seats `coachId` (null clears) on the row's teams through teamCoach (all its seasons, or only the newest), under the
 * fork locks of those teams like Assign coach account. Returns the season ids changed, or an error result.
 */
async function assignRow(league: LeagueRecord, row: TourplayCoachRecord, coachId: string | null, allSeasons: boolean, by: string, deps: LeagueApiDeps, now: Date): Promise<{ ok: true; seasons: string[] } | { ok: false; result: LeagueApiResult }> {
  const wanted = allSeasons ? row.seasons : row.seasons.slice().sort((a, b) => b.number - a.number).slice(0, 1);
  const targets = (): Array<{ season: SeasonRecord; teamIds: string[] }> => wanted.map((w) => {
    const season = deps.store.season(league.id, w.seasonId);
    return season ? { season, teamIds: w.teamIds.filter((id) => season.teams.some((t) => t.id === id)) } : undefined;
  }).filter((x): x is { season: SeasonRecord; teamIds: string[] } => Boolean(x && x.teamIds.length));
  const planned = targets();
  const fixtureKeys = planned.flatMap(({ season, teamIds }) => season.fixtures.filter((f) => teamIds.includes(f.home.teamId ?? "") || teamIds.includes(f.away.teamId ?? "")).map((f) => fixtureLockKey(league.id, season.id, f.id)));
  const forkTeams = planned.flatMap(({ season, teamIds }) => teamIds.map((t) => forkTeamIdFor(league.id, season.id, t)));
  return withForkLocks(fixtureKeys, forkTeams, async () => {
    const fresh = targets();
    for (const { season, teamIds } of fresh) for (const t of teamIds) {
      const locked = forkPlayLock(season, t);
      if (locked) return { ok: false as const, result: fail(409, locked) };
    }
    const at = now.toISOString();
    const changed: string[] = [];
    for (const { season, teamIds } of fresh) {
      let any = false;
      for (const t of teamIds) if (applyTeamCoach(season, t, coachId, by, at)) any = true;
      if (any) { deps.store.putSeason(season); changed.push(season.id); }
    }
    return { ok: true as const, seasons: changed };
  });
}

function notifyOrganisers(league: LeagueRecord, deps: LeagueApiDeps, except: string, input: Parameters<NonNullable<LeagueApiDeps["notify"]>>[1]): void {
  if (!deps.notify) return;
  const to = new Set<string>();
  for (const o of [...(league.owner ? [league.owner] : []), ...league.organisers]) {
    const k = o.trim().toLowerCase();
    if (!k || k === except.trim().toLowerCase() || to.has(k)) continue;
    to.add(k);
    try { deps.notify(o.trim(), input); } catch { /* fire and forget */ }
  }
}

export async function tourplayImportRoutes(
  method: string,
  rest: string[],
  league: LeagueRecord | undefined,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, second, third, fourth, ...extra] = rest;
  if (first !== "tourplay") return undefined;
  if (extra.length) return fail(404, "Not found.");
  const read = method === "GET" || method === "HEAD";
  const now = deps.now?.() ?? new Date();

  // GET .../tourplay/claimable: any signed-in coach (the names are on the public season records already).
  if (second === "claimable" && third === undefined) {
    if (!read) return fail(405, "Use GET.");
    if (!auth) return fail(401, "Sign in to claim an imported name.");
    if (!league) return fail(404, "League not found.");
    let file: TourplayImportFile;
    try { file = deps.store.tourplayImport(league.id); } catch (e) { return fail(e instanceof LeagueStoreError ? e.status : 500, "The import record could not be read."); }
    const seasonName = new Map(deps.store.seasons(league.id).map((s) => [s.id, s.name] as const));
    const stored = deps.store.seasons(league.id);
    const rows = Object.values(file.coaches).filter((r) => needsReview(r, stored)).map((r) => ({
      id: r.id, name: r.name,
      teams: [...new Set(r.seasons.flatMap((s) => s.teams))],
      seasons: r.seasons.map((s) => seasonName.get(s.seasonId) ?? `Season ${s.number}`),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const mine = file.claims.filter((c) => sameCoach(c.coach, auth.coach) && (c.state === "pending" || c.state === "declined"))
      .map((c) => ({ id: c.id, row: c.row, name: Object.values(file.coaches).find((r) => r.id === c.row)?.name ?? "", state: c.state, at: c.at }));
    return res(200, { rows, mine });
  }

  // POST .../tourplay/claims { row }: "Is this you?"
  if (second === "claims" && third === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    if (!auth) return fail(401, "Sign in to claim an imported name.");
    if (!league) return fail(404, "League not found.");
    const wait = limited(`claim:${auth.coach.trim().toLowerCase()}`, CLAIM_LIMIT, CLAIM_WINDOW_MS, now.getTime());
    if (wait) return res(429, { error: "Too many claims. Try again later." }, { headers: { ...noStore, "retry-after": String(wait) } });
    const body = await readJsonObject(deps, 4 * 1024);
    if (!body.ok) return res(body.status, { error: body.error }, body.close ? { close: true } : {});
    const rowRef = body.value.row;
    if (typeof rowRef !== "string" || !/^tp[a-f0-9]{12}$/.test(rowRef)) return fail(400, "Pick the imported name to claim.", "row");
    return withImportLock(league.id, async () => {
      const file = deps.store.tourplayImport(league.id);
      const row = Object.values(file.coaches).find((r) => r.id === rowRef);
      if (!row || !needsReview(row, deps.store.seasons(league.id))) return fail(404, "That name is not open for claims.");
      const mine = file.claims.filter((c) => sameCoach(c.coach, auth.coach) && c.state === "pending");
      if (mine.some((c) => c.row === row.id)) return fail(409, "You have already claimed this name. The organisers will decide.");
      if (mine.length >= MAX_PENDING_CLAIMS) return fail(429, `You can have at most ${MAX_PENDING_CLAIMS} claims waiting in one league.`);
      const claim: TourplayClaim = { id: `tc${randomBytes(6).toString("hex")}`, row: row.id, coach: auth.coach.trim(), at: now.toISOString(), state: "pending" };
      file.claims = [...file.claims, claim];
      if (file.claims.length > MAX_CLAIMS) {
        const decided = file.claims.filter((c) => c.state !== "pending").sort((a, b) => a.at.localeCompare(b.at));
        const drop = new Set(decided.slice(0, file.claims.length - MAX_CLAIMS).map((c) => c.id));
        file.claims = file.claims.filter((c) => !drop.has(c.id));
      }
      deps.store.putTourplayImport(league.id, file);
      notifyOrganisers(league, deps, auth.coach, {
        type: "registration", title: `${claim.coach} says they are ${row.name}`,
        body: `${claim.coach} claimed the imported TourPlay name ${row.name} in ${league.name}. Approve or decline it in the TourPlay import review.`,
        link: `/app/leagues/${encodeURIComponent(league.id)}/settings?tab=tourplay`, from: claim.coach, subject: league.name, action: true,
      });
      return res(201, { ok: true, claim: { id: claim.id, row: claim.row, name: row.name, state: claim.state, at: claim.at } });
    });
  }

  // POST .../tourplay/claims/:id/withdraw (the claimant)
  if (second === "claims" && third && fourth === "withdraw") {
    if (method !== "POST") return fail(405, "Use POST.");
    if (!auth) return fail(401, "Sign in first.");
    if (!league) return fail(404, "League not found.");
    return withImportLock(league.id, async () => {
      const file = deps.store.tourplayImport(league.id);
      const claim = file.claims.find((c) => c.id === third && sameCoach(c.coach, auth.coach));
      if (!claim) return fail(404, "Claim not found.");
      if (claim.state !== "pending") return fail(409, "That claim was already decided.");
      claim.state = "withdrawn";
      claim.decidedAt = now.toISOString();
      deps.store.putTourplayImport(league.id, file);
      return res(200, { ok: true });
    });
  }

  // Everything below: organisers of the league and site admins.
  if (!auth) return fail(401, "Sign in to import from TourPlay.");
  if (!league) return fail(404, "League not found.");
  if (!manages(league, auth)) return fail(403, "Only this league's organisers and site admins can import from TourPlay.");

  if (second === undefined) {
    if (!read) return fail(405, "Use GET.");
    let file: TourplayImportFile;
    try { file = deps.store.tourplayImport(league.id); } catch (e) { return fail(e instanceof LeagueStoreError ? e.status : 500, "The import record could not be read."); }
    return res(200, reviewView(file, profilesOf(deps), deps.store.seasons(league.id)));
  }

  if ((second === "preview" || second === "apply") && third === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    const wait = limited(`upload:${auth.coach.trim().toLowerCase()}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS, now.getTime());
    if (wait) return res(429, { error: "Too many uploads. Try again in a few minutes." }, { headers: { ...noStore, "retry-after": String(wait) } });
    const body = await readJsonObject(deps, UPLOAD_MAX_BODY_BYTES);
    if (!body.ok) return res(body.status, { error: body.status === 413 ? "The upload is too large (zip at most 8 MB)." : body.error }, body.close ? { close: true } : {});
    let upload: UploadSeason[];
    let decisions: Record<string, string | null>;
    let choices: string[];
    try {
      upload = uploadSeasons(uploadEntries(body.value));
      decisions = parseDecisions(body.value.decisions);
      choices = parseChoices(body.value.choices);
    } catch (e) {
      if (e instanceof UploadError) return fail(e.status, e.message);
      throw e;
    }
    const run = async (): Promise<LeagueApiResult> => {
      let file: TourplayImportFile;
      try { file = deps.store.tourplayImport(league.id); } catch (e) { return fail(e instanceof LeagueStoreError ? e.status : 500, "The import record could not be read."); }
      const plan = planImport({ league, stored: deps.store.seasons(league.id).concat(deps.store.ladders(league.id)), file, upload, profiles: profilesOf(deps), decisions, choices, by: auth.coach, now });
      const preview = previewView(plan);
      if (second === "preview") return res(200, preview);
      if (!preview.canApply) return res(409, { error: plan.problems[0] ?? "Nothing to import.", preview });
      try {
        const applied = applyPlan(plan, deps, league, auth.coach, now);
        return res(200, { ok: true, ...applied, preview });
      } catch (e) {
        if (e instanceof LeagueStoreError) return fail(e.status, e.message);
        return fail(422, e instanceof Error ? `The import stopped: ${e.message}` : "The import stopped.");
      }
    };
    if (second === "preview") return run();
    // Apply: under the same fixture and fork-team locks the Teams tab, the review list and a fork launch take, for every
    // season of the league; the plan is made inside them, so a launch can't slip between the check and the write.
    return withImportLock(league.id, () => {
      const seasons = deps.store.seasons(league.id);
      const fixtureKeys = seasons.flatMap((s) => s.fixtures.map((f) => fixtureLockKey(league.id, s.id, f.id)));
      const forkTeams = seasons.flatMap((s) => s.teams.map((t) => forkTeamIdFor(league.id, s.id, t.id)));
      return withForkLocks(fixtureKeys, forkTeams, run);
    });
  }

  // POST .../tourplay/coaches/:row/assign { coachId: string | null, allSeasons? }
  if (second === "coaches" && third && fourth === "assign") {
    if (method !== "POST") return fail(405, "Use POST.");
    const body = await readJsonObject(deps, 4 * 1024);
    if (!body.ok) return res(body.status, { error: body.error }, body.close ? { close: true } : {});
    const allSeasons = parseAllSeasons(body.value.allSeasons);
    if (allSeasons === undefined) return fail(400, "allSeasons must be true or false.", "allSeasons");
    let coachId: string | null;
    if (body.value.coachId === null) coachId = null;
    else if (typeof body.value.coachId === "string" && body.value.coachId.trim()) {
      const found = lookupCoach(deps, body.value.coachId);
      if (!found) return fail(400, `No coach called "${body.value.coachId.trim().slice(0, 64)}".`, "coachId");
      coachId = found;
    } else return fail(400, "Pick a coach account (coachId), or send null for no account.", "coachId");
    return withImportLock(league.id, async () => {
      const file = deps.store.tourplayImport(league.id);
      const row = Object.values(file.coaches).find((r) => r.id === third);
      if (!row) return fail(404, "Coach row not found.");
      if (row.obsolete) return fail(409, `${row.name} is no longer in the latest export.`);
      if (!rowTeams(row, deps.store.seasons(league.id), allSeasons).length) return fail(409, `No team of ${row.name} was found in the imported seasons. Upload the export with its roster files, then link the coach.`);
      const done = await assignRow(league, row, coachId, allSeasons, auth.coach, deps, now);
      if (!done.ok) return done.result;
      const latest = deps.store.tourplayImport(league.id);
      const target = latest.coaches[row.key];
      if (target) {
        target.decision = { coachId, by: auth.coach, at: now.toISOString(), via: "organiser" };
        if (coachId) { target.coachId = coachId; target.linked = [...new Set([...(target.linked ?? []), coachId])]; } else delete target.coachId;
      }
      deps.store.putTourplayImport(league.id, latest);
      return res(200, { ok: true, seasons: done.seasons });
    });
  }

  // POST .../tourplay/claims/:id/approve { allSeasons? } | .../decline
  if (second === "claims" && third && (fourth === "approve" || fourth === "decline")) {
    if (method !== "POST") return fail(405, "Use POST.");
    const body = await readJsonObject(deps, 4 * 1024);
    if (!body.ok) return res(body.status, { error: body.error }, body.close ? { close: true } : {});
    const allSeasons = parseAllSeasons(body.value.allSeasons);
    if (allSeasons === undefined) return fail(400, "allSeasons must be true or false.", "allSeasons");
    return withImportLock(league.id, async () => {
      const file = deps.store.tourplayImport(league.id);
      const claim = file.claims.find((c) => c.id === third);
      if (!claim) return fail(404, "Claim not found.");
      if (claim.state !== "pending") return fail(409, "That claim was already decided.");
      const row = Object.values(file.coaches).find((r) => r.id === claim.row);
      const at = now.toISOString();
      const link = `/app/leagues/${encodeURIComponent(league.id)}`;
      if (fourth === "decline") {
        claim.state = "declined"; claim.decidedBy = auth.coach; claim.decidedAt = at;
        deps.store.putTourplayImport(league.id, file);
        try { deps.notify?.(claim.coach, { type: "registration-outcome", title: `Claim declined: ${row?.name ?? "an imported name"}`, body: `The organisers of ${league.name} declined your claim.`, link, from: auth.coach, subject: league.name, action: true }); } catch { /* fire and forget */ }
        return res(200, { ok: true });
      }
      if (!row) return fail(404, "The claimed name is no longer in the import.");
      const account = lookupCoach(deps, claim.coach);
      if (!account) return fail(409, "The claiming coach no longer has an account.");
      if (row.obsolete) return fail(409, `${row.name} is no longer in the latest export.`);
      if (!rowTeams(row, deps.store.seasons(league.id), allSeasons).length) return fail(409, `No team of ${row.name} was found in the imported seasons. Upload the export with its roster files, then approve.`);
      const done = await assignRow(league, row, account, allSeasons, auth.coach, deps, now);
      if (!done.ok) return done.result;
      const latest = deps.store.tourplayImport(league.id);
      const c = latest.claims.find((x) => x.id === claim.id);
      if (c) { c.state = "approved"; c.decidedBy = auth.coach; c.decidedAt = at; }
      // Other pending claims on the same name are declined with it.
      const others = latest.claims.filter((x) => x.row === row.id && x.state === "pending" && x.id !== claim.id);
      for (const o of others) { o.state = "declined"; o.decidedBy = auth.coach; o.decidedAt = at; }
      const target = latest.coaches[row.key];
      if (target) { target.decision = { coachId: account, by: auth.coach, at, via: "claim" }; target.coachId = account; target.linked = [...new Set([...(target.linked ?? []), account])]; }
      deps.store.putTourplayImport(league.id, latest);
      try {
        deps.notify?.(account, { type: "registration-outcome", title: `Claim approved: ${row.name}`, body: `The organisers of ${league.name} linked ${row.name}'s teams to your account.`, link, from: auth.coach, subject: league.name, action: true });
        for (const o of others) deps.notify?.(o.coach, { type: "registration-outcome", title: `Claim declined: ${row.name}`, body: `The organisers of ${league.name} linked this name to another coach.`, link, from: auth.coach, subject: league.name, action: true });
      } catch { /* fire and forget */ }
      return res(200, { ok: true, seasons: done.seasons });
    });
  }
  return fail(404, "Not found.");
}

function lookupCoach(deps: LeagueApiDeps, name: string): string | undefined {
  const want = name.trim();
  if (!want) return undefined;
  const fromProfiles = profilesOf(deps).find((p) => !p.banned && sameCoach(p.coach, want))?.coach;
  if (fromProfiles) return fromProfiles;
  if (!deps.identities) return deps.coachProfiles ? undefined : want;
  return deps.identities().find((r) => !r.banned && sameCoach(r.coach, want))?.coach;
}
