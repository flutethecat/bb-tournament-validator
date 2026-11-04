// Global site search (owner 11-04, round 2 item 7): GET /api/search?q=&type=&<filters>. Leagues (and their ladders),
// tournaments, clubs, coaches and teams.
//
// Index: an in-memory list of documents built from the stores, rebuilt lazily on the first query after a write in this
// process (server.ts calls invalidate() when a write request succeeds and when the identities store is written) and at
// most INDEX_TTL_MS old otherwise (writes from other processes: scripts, the Discord bot). Building only reads the stores.
// An unreadable store fails the build and the request answers 503: search never serves a half-built index.
//
// Privacy (every rule is applied at query time against the viewer, from fields fixed at build time):
//  - a draft league, a ladder still in setup and their teams are seen only by the league's organisers and site admins;
//  - an unpublished tournament only by its owner, its organisers and site admins;
//  - archived clubs are not listed (the club directory's own rule);
//  - coaches: never banned, deleted / being deleted (reserved "Deleted coach #n" names, the deletion fence) or never
//    onboarded accounts; a coach result is the account name and the site's own avatar route, nothing else (no email,
//    phone, Discord id or NAF details: those fields are never read into the index);
//  - teams are league teams only (already public on the season pages). Roster Builder saves and Super FUMBBL library teams
//    are never indexed;
//  - the facet lists (rulesets, countries) come from documents the viewer may see.

import { countryByCode } from "../auth/countries.js";
import type { IdentityStore } from "../auth/identitiesStore.js";
import { coachKey } from "../privacy/fence.js";
import { isReservedCoachName } from "../privacy/reservedNames.js";
import { regionLabel, storedRegion, type CompetitionRegion } from "../competition/region.js";
import { artUrl } from "../leagues/api.js";
import { leagueBrowseInfo, leagueLocation } from "../leagues/browse.js";
import { ladderState } from "../leagues/ladder.js";
import { isDraftLeague } from "../leagues/lifecycle.js";
import { seasonWindowStatus } from "../leagues/seasonRegistration.js";
import type { LeagueRecord, SeasonRecord } from "../leagues/types.js";
import type { ClubRecord } from "../clubs/types.js";
import { selfRegistrationStatus } from "../tournaments/publication.js";
import { tournamentOwner } from "../tournaments/store.js";
import type { TournamentDataFileV4, TournamentRecord } from "../tournaments/types.js";
import type { RateLimiter } from "../translate/guards.js";
import {
  competitionFiltersActive, FORMAT_LABEL, parseCompetitionFilters, passesCompetitionFilters, PLAYED_ON_LABEL,
  type CompetitionFacets, type CompetitionFilters,
} from "./filters.js";
import { foldQuery, foldText, matchTier } from "./text.js";

export type SearchType = "leagues" | "tournaments" | "clubs" | "coaches" | "teams";
export const SEARCH_TYPES: readonly SearchType[] = ["leagues", "tournaments", "clubs", "coaches", "teams"];

/** Longest query accepted (characters, after trimming). Longer answers 400. */
export const QUERY_MAX = 100;
/** Quick results (type=all): per group. */
export const QUICK_LIMIT_DEFAULT = 5;
export const QUICK_LIMIT_MAX = 8;
/** One type (the Search page): per page. */
export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 50;
export const OFFSET_MAX = 500;
/** Coaches and teams are never listed without a query of at least this many characters (no browsing every account). */
export const PEOPLE_QUERY_MIN = 2;
export const INDEX_TTL_MS = 30_000;
/** Requests per minute per signed-in coach, else per IP. */
export const SEARCH_RATE = { maxRequests: 120, windowMs: 60_000 } as const;

const TEAMS_PER_LEAGUE_MAX = 2000;

interface DocField { text: string; weight: number; label: string }

export interface SearchDoc {
  type: SearchType;
  id: string;
  title: string;
  subtitle?: string;
  /** SPA path (under /app). */
  url: string;
  /** A same-site image route (league logo, club crest, coach avatar). */
  image?: string;
  /** The text the query is matched against, already folded. */
  fields: DocField[];
  /** Present = restricted: only these coach keys (and site admins) may see the document. */
  managers?: string[];
  facets?: CompetitionFacets;
  chips?: string[];
  draft?: true;
  /** Last activity (ms since epoch): the tie-break after relevance. */
  activity: number;
}

export interface SearchViewer { coach: string; admin?: boolean }

export interface SearchSources {
  leagues: { list(): LeagueRecord[]; seasons(id: string): SeasonRecord[]; ladders(id: string): SeasonRecord[] };
  tournaments: { snapshot(): TournamentDataFileV4 };
  clubs: { list(): ClubRecord[] };
  identities: () => IdentityStore;
  /** The site's own avatar route for a coach, if any. */
  avatarFor?: (coach: string) => string | undefined;
  /** A coach whose deletion is under way. */
  isFenced?: (coach: string) => boolean;
  now?: () => Date;
}

const field = (value: unknown, weight: number, label: string): DocField | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return { text: foldText(value.trim().replace(/\s+/g, " ")), weight, label };
};
const fields = (...list: Array<DocField | undefined>): DocField[] => list.filter((f): f is DocField => Boolean(f));
const time = (...values: Array<string | undefined>): number => Math.max(0, ...values.map((v) => (v ? Date.parse(v) : NaN)).filter((n) => Number.isFinite(n)));
const keys = (...list: Array<string | undefined>): string[] => [...new Set(list.filter((c): c is string => typeof c === "string" && c.trim() !== "").map(coachKey))];
const enc = encodeURIComponent;

const leagueManagers = (l: LeagueRecord): string[] => keys(l.owner, ...(l.organisers ?? []));

function leagueRegion(l: LeagueRecord): { region?: CompetitionRegion; label: string; country?: string; text: string } {
  const region = storedRegion(l.region);
  const location = leagueLocation(l) ?? "";
  const label = regionLabel(region) || location;
  return {
    ...(region ? { region } : {}),
    label,
    ...(region?.country ? { country: region.country } : l.address?.country ? { country: l.address.country } : {}),
    text: [region?.text ?? "", location].filter(Boolean).join(" | "),
  };
}

const rulesetsOf = (...values: Array<string | undefined>): string[] => [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];

function competitionChips(f: CompetitionFacets, draft: boolean): string[] {
  return [...(draft ? ["Draft"] : []), ...f.formats.map((x) => FORMAT_LABEL[x]), PLAYED_ON_LABEL[f.playedOn], ...(f.registrationOpen ? ["Registration open"] : [])];
}

function leagueDocs(sources: SearchSources, now: Date, hidden: ReadonlySet<string>): SearchDoc[] {
  const out: SearchDoc[] = [];
  for (const l of sources.leagues.list()) {
    const draft = isDraftLeague(l);
    const managers = leagueManagers(l);
    const seasons = sources.leagues.seasons(l.id);
    const ladders = sources.leagues.ladders(l.id);
    const where = leagueRegion(l);
    const browse = leagueBrowseInfo(l, seasons, now);
    const newest = [...seasons].sort((a, b) => b.number - a.number)[0];
    const openLadders = ladders.filter((s) => ladderState(s) !== "setup");
    const formats: CompetitionFacets["formats"] = [];
    if (seasons.length || !openLadders.length) formats.push("season");
    if (openLadders.length) formats.push("ladder");
    const playedOn = l.playOnFork === true ? "fork" as const : "tabletop" as const;
    const rulesets = rulesetsOf(l.rulesetPackage, l.ruleset, newest?.ruleset);
    const facets: CompetitionFacets = {
      rulesets, ...(where.country ? { country: where.country } : {}), ...(where.text ? { regionText: where.text } : {}),
      formats, playedOn, registrationOpen: !draft && browse.registrationOpen,
    };
    const logo = artUrl(l, "logo");
    const restricted = draft ? { managers, draft: true as const } : {};
    out.push({
      type: "leagues", id: l.id, title: l.name,
      ...(l.fullName && l.fullName !== l.name ? { subtitle: [l.fullName, where.label].filter(Boolean).join(" · ") } : where.label ? { subtitle: where.label } : {}),
      url: `/leagues/${enc(l.id)}`, ...(logo ? { image: logo } : {}),
      fields: fields(field(l.name, 10, "name"), field(l.fullName, 8, "full name"), field(l.slug || l.id, 6, "address"), field(where.label, 4, "region"),
        field(where.region?.text, 4, "region"), ...rulesets.map((r) => field(r, 2, "ruleset")), field(l.description, 1, "description")),
      ...restricted, facets, chips: competitionChips(facets, draft),
      activity: time(l.updatedAt, l.publishedAt, ...seasons.map((s) => s.resultsChangedAt ?? s.importedAt)),
    });
    // Ladders: their own result (format "ladder"); one still in setup is seen only by the league's managers.
    for (const s of ladders) {
      const setup = ladderState(s) === "setup";
      const ladderFacets: CompetitionFacets = {
        rulesets: rulesetsOf(l.rulesetPackage, s.ruleset), ...(where.country ? { country: where.country } : {}), ...(where.text ? { regionText: where.text } : {}),
        formats: ["ladder"], playedOn, registrationOpen: !draft && !setup && safeOpen(() => seasonWindowStatus(l, s, now).open),
      };
      out.push({
        type: "leagues", id: `${l.id}/${s.id}`, title: s.name, subtitle: `Ladder · ${l.name}`, url: `/leagues/${enc(l.id)}?tab=ladder&ladder=${enc(s.id)}`,
        ...(logo ? { image: logo } : {}),
        fields: fields(field(s.name, 10, "name"), field(l.name, 5, "league"), field(l.fullName, 4, "league"), field(where.label, 4, "region")),
        ...(draft || setup ? { managers, draft: true as const } : {}),
        facets: ladderFacets, chips: competitionChips(ladderFacets, draft || setup),
        activity: time(s.resultsChangedAt ?? s.importedAt, l.updatedAt),
      });
    }
    // Teams of every season and every ladder past setup (newest season first; a team listed once per league).
    const seen = new Set<string>();
    let count = 0;
    const competitions = [...seasons.map((s) => ({ s, ladder: false })), ...ladders.map((s) => ({ s, ladder: true }))]
      .sort((a, b) => time(b.s.resultsChangedAt ?? b.s.importedAt) - time(a.s.resultsChangedAt ?? a.s.importedAt) || b.s.number - a.s.number);
    for (const { s, ladder } of competitions) {
      const setupLadder = ladder && ladderState(s) === "setup";
      for (const t of s.teams ?? []) {
        if (count >= TEAMS_PER_LEAGUE_MAX) break;
        const name = typeof t.name === "string" ? t.name.trim() : "";
        if (!name) continue;
        const coach = typeof t.coach === "string" && !hidden.has(coachKey(t.coach)) && !isReservedCoachName(t.coach) ? t.coach.trim() : "";
        const dedupe = `${foldText(name)}\0${coachKey(coach)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        count += 1;
        const tab = ladder ? `tab=ladder&ladder=${enc(s.id)}` : `season=${enc(s.id)}&tab=participants&team=${enc(t.id)}`;
        out.push({
          type: "teams", id: `${l.id}/${s.id}/${t.id}`, title: name,
          subtitle: [t.race, coach, `${l.name} ${s.name}`.trim()].filter((x) => typeof x === "string" && x.trim()).join(" · "),
          url: `/leagues/${enc(l.id)}?${tab}`,
          fields: fields(field(name, 10, "name"), field(coach, 4, "coach"), field(t.race, 2, "race")),
          ...(draft || setupLadder ? { managers, draft: true as const } : {}),
          activity: time(s.resultsChangedAt ?? s.importedAt),
        });
      }
    }
  }
  return out;
}

function safeOpen(fn: () => boolean): boolean {
  try { return fn(); } catch { return false; }
}

function tournamentDocs(sources: SearchSources, now: Date): SearchDoc[] {
  const data = sources.tournaments.snapshot();
  const round1 = new Set(Object.values(data.rounds ?? {}).filter((r) => r.number === 1).map((r) => r.tournamentId));
  const out: SearchDoc[] = [];
  for (const t of Object.values(data.tournaments ?? {}) as TournamentRecord[]) {
    if (!t || typeof t.id !== "string" || typeof t.name !== "string") continue;
    const draft = t.unpublished === true;
    const region = storedRegion(t.region);
    const label = regionLabel(region);
    const facets: CompetitionFacets = {
      rulesets: rulesetsOf(t.packageName), ...(region?.country ? { country: region.country } : {}), ...(region?.text ? { regionText: region.text } : {}),
      formats: ["tournament"], playedOn: t.playOnFork === true ? "fork" : "tabletop",
      registrationOpen: !draft && safeOpen(() => selfRegistrationStatus(t, round1.has(t.id), now).open),
    };
    const status = t.status === "active" ? "In progress" : t.status === "completed" ? "Finished" : t.status === "cancelled" ? "Cancelled" : "Upcoming";
    out.push({
      type: "tournaments", id: t.id, title: t.name, subtitle: [label, status].filter(Boolean).join(" · "), url: `/tournaments/${enc(t.id)}`,
      ...(t.bannerPath ? { image: `/api/tournaments/${enc(t.id)}/banner` } : {}),
      fields: fields(field(t.name, 10, "name"), field(label, 4, "region"), field(region?.text, 4, "region"), field(t.packageName, 2, "ruleset"), field(t.summary, 1, "summary")),
      ...(draft ? { managers: keys(tournamentOwner(t), t.organizerCoachId, ...(t.organizerCoachIds ?? [])), draft: true as const } : {}),
      facets, chips: competitionChips(facets, draft),
      activity: time(t.updatedAt, t.startedAt, t.startsAt),
    });
  }
  return out;
}

function clubDocs(sources: SearchSources): SearchDoc[] {
  return sources.clubs.list().filter((c) => !c.archivedAt).map((c) => ({
    type: "clubs" as const, id: c.id, title: c.name,
    subtitle: [c.homeRegion, `${c.members.length} ${c.members.length === 1 ? "member" : "members"}`].filter(Boolean).join(" · "),
    url: `/clubs/${enc(c.id)}`,
    ...(c.crestPath ? { image: `/api/clubs/${enc(c.id)}/crest?v=${c.crestPath.slice(7, 15)}` } : {}),
    fields: fields(field(c.name, 10, "name"), field(c.homeRegion, 4, "region"), field(c.description, 1, "description")),
    activity: time(c.updatedAt, c.createdAt),
  }));
}

/** Coaches who never appear: banned, deleted or being deleted, never onboarded (keys). */
function hiddenCoaches(store: IdentityStore, sources: SearchSources): { shown: Array<{ name: string; updatedAt?: string }>; hidden: Set<string> } {
  const shown: Array<{ name: string; updatedAt?: string }> = [];
  const hidden = new Set<string>();
  for (const r of Object.values(store.coaches ?? {})) {
    const name = typeof r?.ffbCoachId === "string" ? r.ffbCoachId.trim() : "";
    if (!name) continue;
    const gone = r.banned === true || isReservedCoachName(name) || sources.isFenced?.(name) === true || !r.consent?.privacy?.acceptedVersion;
    if (gone) hidden.add(coachKey(name));
    else shown.push({ name, updatedAt: r.updatedAt });
  }
  return { shown, hidden };
}

function coachDocs(shown: ReadonlyArray<{ name: string; updatedAt?: string }>, sources: SearchSources): SearchDoc[] {
  return shown.map(({ name, updatedAt }) => {
    let avatar: string | undefined;
    try { avatar = sources.avatarFor?.(name); } catch { avatar = undefined; }
    // Only the site's own avatar route: never a third-party URL that could carry an id.
    const image = avatar && avatar.startsWith("/api/coach-avatars/") ? avatar : undefined;
    return {
      type: "coaches" as const, id: name, title: name, url: `/search?type=teams&q=${enc(name)}`,
      ...(image ? { image } : {}),
      fields: fields(field(name, 10, "name")),
      activity: time(updatedAt),
    };
  });
}

/** Every document (privacy rules applied at query time). Throws when a store cannot be read. */
export function buildSearchDocs(sources: SearchSources): SearchDoc[] {
  const now = sources.now?.() ?? new Date();
  const people = hiddenCoaches(sources.identities(), sources);
  return [
    ...leagueDocs(sources, now, people.hidden),
    ...tournamentDocs(sources, now),
    ...clubDocs(sources),
    ...coachDocs(people.shown, sources),
  ];
}

/** The lazily rebuilt index: fresh after invalidate() and at most ttlMs old. */
export class SearchIndex {
  private cached: { at: number; docs: SearchDoc[] } | undefined;
  private dirty = true;

  constructor(private readonly build: () => SearchDoc[], private readonly opts: { ttlMs?: number; now?: () => number } = {}) {}

  invalidate(): void { this.dirty = true; }

  docs(): SearchDoc[] {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && !this.dirty && now - this.cached.at < (this.opts.ttlMs ?? INDEX_TTL_MS)) return this.cached.docs;
    // A failed build throws and drops the old index (never serve a stale one after a failure).
    this.cached = undefined;
    const docs = this.build();
    this.cached = { at: now, docs };
    this.dirty = false;
    return docs;
  }
}

// ---- query ----------------------------------------------------------------------------------------------------------

export interface SearchItem {
  type: SearchType;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  image?: string;
  chips?: string[];
  draft?: true;
  /** The field that matched when it is not the name ("coach", "region"...). */
  matched?: string;
}

export interface SearchGroup { items: SearchItem[]; total: number; more: boolean }

export interface SearchRequest {
  q: string;
  type: SearchType | "all";
  filters: CompetitionFilters;
  limit: number;
  offset: number;
}

export const canSee = (doc: Pick<SearchDoc, "managers">, viewer: SearchViewer | undefined): boolean =>
  !doc.managers || Boolean(viewer && (viewer.admin === true || doc.managers.includes(coachKey(viewer.coach))));

/** Relevance of a doc for a folded query: the best field's tier x weight; 0 = no match. A multi-word query that matches
 *  no field whole still matches when every word is found in some field (scored lower). */
export function scoreDoc(doc: Pick<SearchDoc, "fields">, q: string): { score: number; label?: string } {
  let best = 0;
  let label: string | undefined;
  for (const f of doc.fields) {
    const s = matchTier(f.text, q) * f.weight;
    if (s > best) { best = s; label = f.label; }
  }
  if (best > 0) return { score: best, label };
  const words = q.split(" ").filter(Boolean);
  if (words.length < 2) return { score: 0 };
  let total = Infinity;
  for (const w of words) {
    let wordBest = 0;
    for (const f of doc.fields) wordBest = Math.max(wordBest, matchTier(f.text, w) * f.weight);
    if (!wordBest) return { score: 0 };
    total = Math.min(total, wordBest);
  }
  return { score: total / 2, label: doc.fields[0]?.label };
}

const COMPETITION = new Set<SearchType>(["leagues", "tournaments"]);

function toItem(doc: SearchDoc, label: string | undefined): SearchItem {
  return {
    type: doc.type, id: doc.id, title: doc.title, ...(doc.subtitle ? { subtitle: doc.subtitle } : {}), url: doc.url,
    ...(doc.image ? { image: doc.image } : {}), ...(doc.chips?.length ? { chips: doc.chips } : {}), ...(doc.draft ? { draft: true as const } : {}),
    ...(label && label !== "name" ? { matched: label } : {}),
  };
}

/** Runs a request over the documents for this viewer. */
export function runSearch(docs: readonly SearchDoc[], req: SearchRequest, viewer: SearchViewer | undefined) {
  const q = foldQuery(req.q);
  const filtering = competitionFiltersActive(req.filters);
  const types = req.type === "all" ? SEARCH_TYPES : [req.type];
  const visible = docs.filter((d) => canSee(d, viewer));
  const groups: Partial<Record<SearchType, SearchGroup>> = {};
  for (const type of types) {
    const people = type === "coaches" || type === "teams";
    // Quick results need a query (or a filter, for competitions); coaches and teams always need PEOPLE_QUERY_MIN characters.
    const blank = !q;
    const allowed = people ? q.length >= PEOPLE_QUERY_MIN : !blank || (req.type !== "all" ? true : filtering && COMPETITION.has(type));
    // Competition filters narrow leagues and tournaments; with filters set, the other groups are left out.
    if (!allowed || (filtering && !COMPETITION.has(type))) { groups[type] = { items: [], total: 0, more: false }; continue; }
    const rows: Array<{ doc: SearchDoc; score: number; label?: string }> = [];
    for (const doc of visible) {
      if (doc.type !== type) continue;
      if (COMPETITION.has(type) && filtering && (!doc.facets || !passesCompetitionFilters(doc.facets, req.filters))) continue;
      if (blank) { rows.push({ doc, score: 0 }); continue; }
      const s = scoreDoc(doc, q);
      if (s.score > 0) rows.push({ doc, score: s.score, ...(s.label ? { label: s.label } : {}) });
    }
    rows.sort((a, b) => b.score - a.score || b.doc.activity - a.doc.activity || a.doc.title.localeCompare(b.doc.title) || a.doc.id.localeCompare(b.doc.id));
    const page = rows.slice(req.offset, req.offset + req.limit);
    groups[type] = { items: page.map((r) => toItem(r.doc, r.label)), total: rows.length, more: req.offset + req.limit < rows.length };
  }
  // The filter options: rulesets and countries of the competitions this viewer may see.
  const rulesets = new Set<string>();
  const countries = new Set<string>();
  for (const d of visible) {
    if (!d.facets) continue;
    for (const r of d.facets.rulesets) rulesets.add(r);
    if (d.facets.country && countryByCode(d.facets.country)) countries.add(d.facets.country);
  }
  return {
    groups,
    facets: {
      rulesets: [...rulesets].sort((a, b) => a.localeCompare(b)),
      countries: [...countries].sort().map((code) => ({ code, name: countryByCode(code)!.name })),
    },
  };
}

// ---- the route ------------------------------------------------------------------------------------------------------

export const SEARCH_PATH = "/api/search";
/** Write requests that can change what search lists (server.ts invalidates the index after a successful one). */
export const SEARCH_SOURCE_PATH = /^\/api\/(?:leagues|tournaments|fork\/tournaments|scheduled-matches|series|clubs|me|account|admin|auth|fork\/register)(?:\/|$)/;

export interface SearchApiDeps {
  index: Pick<SearchIndex, "docs">;
  limiter?: Pick<RateLimiter, "take">;
  /** The caller's IP (rate limit key when not signed in). */
  ip?: string;
}

export interface SearchApiResult { status: number; headers?: Record<string, string>; body: unknown }

const NO_STORE = { "cache-control": "private, no-store" };

const intParam = (raw: string | null, fallback: number, min: number, max: number): number => {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** GET/HEAD /api/search. Never writes. */
export function searchApi(method: string, query: URLSearchParams, viewer: SearchViewer | undefined, deps: SearchApiDeps): SearchApiResult {
  if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { allow: "GET, HEAD", ...NO_STORE }, body: { error: "Use GET." } };
  if (deps.limiter) {
    const key = viewer ? `coach:${coachKey(viewer.coach)}` : `ip:${deps.ip ?? "unknown"}`;
    const wait = deps.limiter.take([key], 0);
    if (wait > 0) return { status: 429, headers: { "retry-after": String(wait), ...NO_STORE }, body: { error: "Too many searches. Try again in a moment." } };
  }
  const rawQ = query.get("q") ?? "";
  const q = rawQ.trim().replace(/\s+/g, " ");
  if (q.length > QUERY_MAX) return { status: 400, headers: NO_STORE, body: { error: `Search text is at most ${QUERY_MAX} characters.` } };
  const rawType = query.get("type") ?? "all";
  if (rawType !== "all" && !(SEARCH_TYPES as readonly string[]).includes(rawType)) return { status: 400, headers: NO_STORE, body: { error: "Unknown search type." } };
  const type = rawType as SearchRequest["type"];
  const quick = type === "all";
  const limit = intParam(query.get("limit"), quick ? QUICK_LIMIT_DEFAULT : PAGE_LIMIT_DEFAULT, 1, quick ? QUICK_LIMIT_MAX : PAGE_LIMIT_MAX);
  const offset = quick ? 0 : intParam(query.get("offset"), 0, 0, OFFSET_MAX);
  const filters = parseCompetitionFilters(query);
  let docs: SearchDoc[];
  try { docs = deps.index.docs(); } catch {
    return { status: 503, headers: NO_STORE, body: { error: "Search is unavailable right now. Try again shortly." } };
  }
  const result = runSearch(docs, { q, type, filters, limit, offset }, viewer);
  return { status: 200, headers: NO_STORE, body: { q, type, limit, offset, ...result } };
}
