// Shared section nav (owner 11-02: "a standard Nav Header bar that is shared across all surfaces of the site when inside
// of a section"; spec-section-header-2026-11-02). Leagues, Tournaments and Series each list their tabs here in TourPlay
// order, with the rules for which tabs show (hidden while the section has nothing for them; Board while the viewer may read it;
// organiser-only items), which tab a sub-page belongs to, the breadcrumb under the header, the season switch (keeps the
// tab) and the redirects for old tab URLs. No DOM; SectionHeader.vue renders the result.

import type { RouteLocationRaw } from "vue-router";

export type SectionKind = "league" | "tournament" | "series" | "club";
export type SectionTabId =
  | "overview" | "fixtures" | "standings" | "board" | "calendar" | "honours" | "statistics" | "stars" | "participants" | "draws" | "awards"
  | "events" | "schedule" | "ladder" | "members" | "results";
/** The management sub-panel (the cog): not a tab, but the header shows the cog as current. */
export type SectionActive = SectionTabId | "manage";

export interface SectionTabDef {
  id: SectionTabId;
  label: string;
  /** The URL value (?tab=) when it differs from the id: existing links keep working unchanged ("rounds", "entrants", "teams"). */
  query?: string;
  /** Shown greyed and not a link until the feature ships. */
  soon?: true;
  /** Not built yet: never shown. */
  unbuilt?: true;
}

/** TourPlay's strip (News · Fixtures · Standings · Boards · Calendar · Honors · Statistics · Mercenaries · Participants ·
 *  Draws · Awards) as our tabs. British spelling (Honours). */
export const SECTION_TABS: Readonly<Record<SectionKind, readonly SectionTabDef[]>> = {
  tournament: [
    { id: "overview", label: "Overview" },
    { id: "fixtures", label: "Fixtures", query: "rounds" },
    { id: "standings", label: "Standings" },
    { id: "board", label: "Board" },
    { id: "calendar", label: "Calendar" },
    { id: "honours", label: "Honours" },
    { id: "statistics", label: "Statistics" },
    { id: "stars", label: "Stars" },
    { id: "participants", label: "Participants", query: "entrants" },
    { id: "draws", label: "Draws" },
    { id: "awards", label: "Awards" },
  ],
  league: [
    { id: "overview", label: "Overview" },
    { id: "fixtures", label: "Fixtures" },
    { id: "standings", label: "Standings" },
    // League ladders (lane 8b): shown while the league has a ladder the viewer can see.
    { id: "ladder", label: "Ladder" },
    { id: "board", label: "Board" },
    { id: "calendar", label: "Calendar" },
    { id: "honours", label: "Honours" },
    { id: "statistics", label: "Statistics" },
    { id: "stars", label: "Stars" },
    { id: "participants", label: "Participants", query: "teams" },
    { id: "draws", label: "Draws" },
    { id: "awards", label: "Awards" },
    { id: "events", label: "Events", unbuilt: true },
  ],
  series: [
    { id: "overview", label: "Overview" },
    { id: "schedule", label: "Schedule" },
    { id: "standings", label: "Standings" },
  ],
  // Coach clubs (owner 11-02, Q14): Overview, Members, Results, Stats, Board. The club Board is live (the first Board).
  club: [
    { id: "overview", label: "Overview" },
    { id: "members", label: "Members" },
    { id: "results", label: "Results" },
    { id: "statistics", label: "Stats", query: "stats" },
    { id: "board", label: "Board" },
  ],
};

/** What the section has today, from the data its page already loaded (a missing fact = nothing yet). */
export type SectionFacts = Partial<Record<SectionTabId, boolean>>;

export interface SectionTabView {
  id: SectionTabId;
  label: string;
  /** Absent on a "coming soon" tab (rendered as greyed text). */
  to?: RouteLocationRaw;
  soon?: true;
}

const queryOf = (kind: SectionKind, id: SectionTabId): string => SECTION_TABS[kind].find((t) => t.id === id)?.query ?? id;

/** The tab ids a URL ?tab= value may name, old and new spellings alike (unknown = Overview). */
export function tabFromQuery(kind: SectionKind, value: unknown): SectionTabId {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || !v) return "overview";
  const def = SECTION_TABS[kind].find((t) => (t.query ?? t.id) === v || t.id === v);
  if (!def || def.unbuilt || def.soon) return "overview";
  // League statistics is its own route; a ?tab=statistics on the league page means that route (see legacyRedirect)
  return def.id;
}

/** Where a tab lives. `keep` carries query values that span tabs (a league's ?season=). */
export function tabLocation(kind: SectionKind, id: string, tab: SectionTabId, keep: Record<string, string> = {}): RouteLocationRaw {
  if (kind === "league" && tab === "statistics") return { name: "league-stats", params: { id }, query: { ...keep } };
  const name = kind === "league" ? "league-detail" : kind === "tournament" ? "tournament-detail" : kind === "club" ? "club-detail" : "series-detail";
  const query: Record<string, string> = { ...keep };
  if (tab !== "overview") query.tab = queryOf(kind, tab);
  return { name, params: { id }, query };
}

/** The management sub-panel of a section (the cog). */
export function manageLocation(kind: SectionKind, id: string, keep: Record<string, string> = {}): RouteLocationRaw {
  const name = kind === "league" ? "league-settings" : kind === "tournament" ? "tournament-manage" : kind === "club" ? "club-manage" : "series-manage";
  return { name, params: { id }, query: { ...keep } };
}

/**
 * The tabs to show, in order. A tab shows when the section has something for it (`facts[id]`), Overview always; Board
 * when the viewer may read the board (or moderates it: facts.board from GET .../board/status); unbuilt tabs (league Events) never. `manage` lets organisers see tabs they fill in
 * themselves even while empty (Awards: they give awards there). The tab of the page being shown (`active`) always shows.
 */
export function visibleTabs(kind: SectionKind, id: string, facts: SectionFacts, opts: { manage?: boolean; keep?: Record<string, string>; active?: SectionActive } = {}): SectionTabView[] {
  const out: SectionTabView[] = [];
  for (const t of SECTION_TABS[kind]) {
    if (t.unbuilt) continue;
    if (t.soon) { out.push({ id: t.id, label: t.label, soon: true }); continue; }
    // the page being shown always keeps its tab (a direct link to a sub-route of an otherwise empty tab)
    const show = t.id === "overview" || t.id === opts.active || facts[t.id] === true || (opts.manage === true && t.id === "awards");
    if (show) out.push({ id: t.id, label: t.label, to: tabLocation(kind, id, t.id, opts.keep) });
  }
  return out;
}

// ---- facts per section (from data the pages already load; nothing is fetched for the header) ----

/** Tournament: rounds, the visible fixtures and the entrants from GET /api/tournaments/:id. */
export function tournamentFacts(s: {
  tournament: { status: string; startedAt?: string } | null;
  rounds: readonly unknown[];
  fixtures: readonly unknown[];
  entrants: ReadonlyArray<{ droppedAt?: string }>;
  /** The Board tab shows (shared/board.ts boardTabShows over the board status). */
  board?: boolean;
}): SectionFacts {
  const t = s.tournament;
  const started = Boolean(t && (s.rounds.length > 0 || t.status === "active" || t.status === "completed"));
  return {
    fixtures: s.rounds.length > 0,
    standings: s.rounds.length > 0,
    honours: started,
    statistics: started,
    participants: s.entrants.length > 0,
    // the pairings per round: only from fixtures the server let this viewer see (anonymous visitors get none)
    draws: s.fixtures.length > 0,
    awards: started,
    board: s.board === true,
    // no dated tournament fixtures and no per-tournament star data on the server yet: Calendar and Stars stay hidden
  };
}

/** League: the league's seasons (summaries) and, once loaded, the current season's record. */
export function leagueFacts(s: {
  seasons: ReadonlyArray<{ playedCount: number }>;
  current?: { teamCount: number; fixtureCount: number } | null;
  season?: { teams: readonly unknown[]; phases?: ReadonlyArray<{ standings: readonly unknown[] }>; fixtures: ReadonlyArray<{ date?: string; finishedAt?: string; scheduledTime?: { start: string } }> } | null;
  /** League Events (league-wide): any one puts the Calendar tab up. */
  events?: number;
  /** League ladders (lane 8b): how many the viewer can see, and whether any has a dated fixture (the Calendar). */
  ladders?: number;
  ladderDated?: boolean;
  /** The Board tab shows (shared/board.ts boardTabShows over the board status). */
  board?: boolean;
}): SectionFacts {
  const teams = s.season ? s.season.teams.length : s.current?.teamCount ?? 0;
  const tables = s.season ? (s.season.phases ?? []).some((p) => p.standings.length > 0) : false;
  const fixtures = s.season ? s.season.fixtures.length : s.current?.fixtureCount ?? 0;
  const dated = s.season ? s.season.fixtures.some((f) => Boolean(f.date || f.finishedAt || f.scheduledTime?.start)) : fixtures > 0;
  return {
    fixtures: fixtures > 0,
    standings: teams > 0 || tables || fixtures > 0,
    calendar: dated || (s.events ?? 0) > 0 || s.ladderDated === true,
    ladder: (s.ladders ?? 0) > 0,
    honours: s.seasons.length > 0,
    statistics: s.seasons.some((x) => x.playedCount > 0),
    participants: teams > 0,
    draws: fixtures > 0,
    awards: s.seasons.length > 0,
    board: s.board === true,
    // Stars: no star / mercenary data in league seasons yet; Events: not built
  };
}

/** Club: every tab always shows (an empty one says so). */
export function clubFacts(): SectionFacts {
  return { members: true, results: true, statistics: true, board: true };
}

/** Series: its events and standings rows. */
export function seriesFacts(s: { events: readonly unknown[]; rows: readonly unknown[] }): SectionFacts {
  return { schedule: s.events.length > 0, standings: s.events.length > 0 || s.rows.length > 0 };
}

// ---- which tab is current ----

/**
 * The tab a route belongs to: the section's own tabs by ?tab=, and the sub-pages by their owner (team page →
 * Participants; fixture lobby, fixture summary and game page → Fixtures; statistics route → Statistics; management →
 * the cog).
 */
export function activeTab(kind: SectionKind, route: { name?: unknown; query?: Record<string, unknown> }): SectionActive {
  const name = String(route.name ?? "");
  switch (name) {
    case "league-settings": case "tournament-manage": case "series-manage": case "club-manage": return "manage";
    case "league-stats": return "statistics";
    case "league-fixture-lobby": case "tournament-fixture-lobby": case "game": return "fixtures";
    case "tournament-team": case "roster-builder-redraft": case "tournament-team-builder": return "participants";
    default: return tabFromQuery(kind, route.query?.tab);
  }
}

export interface Crumb { label: string; to?: RouteLocationRaw }

/** The breadcrumb under the header on a sub-page: "<owning tab> › <page>" (nothing on a section's own tab pages). */
export function breadcrumbs(kind: SectionKind, id: string, owner: SectionTabId, page: string, keep: Record<string, string> = {}): Crumb[] {
  const def = SECTION_TABS[kind].find((t) => t.id === owner);
  if (!def || !page) return [];
  return [{ label: def.label, to: tabLocation(kind, id, owner, keep) }, { label: page }];
}

// ---- seasons (leagues) ----

/**
 * The query after picking another season: the season changes, the tab stays (owner Q7), and what belongs to one season
 * (a team, player or fixture) is dropped. The newest season is the default, so it leaves ?season= off.
 */
export function seasonSwitchQuery(query: Record<string, unknown>, seasonId: string, newestId: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === "season" || k === "team" || k === "player" || k === "fixture" || k === "round") continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string") out[k] = s;
  }
  if (seasonId && seasonId !== newestId) out.season = seasonId;
  return out;
}

// ---- roles ----

export type SectionRole = "organiser" | "admin" | "entrant" | "coach" | "member" | "";
export const ROLE_LABEL: Record<Exclude<SectionRole, "">, string> = { organiser: "Organiser", admin: "Admin", entrant: "Entrant", coach: "Coach", member: "Member" };
export const ROLE_TONE: Record<Exclude<SectionRole, "">, string> = { organiser: "soon", admin: "info", entrant: "ok", coach: "ok", member: "ok" };

/** The viewer's role chip: organiser of this section first, then a site admin managing it, then a participant. */
export function sectionRole(o: { organiser: boolean; admin?: boolean; participant?: boolean; participantRole?: "entrant" | "coach" }): SectionRole {
  if (o.organiser) return "organiser";
  if (o.admin) return "admin";
  if (o.participant) return o.participantRole ?? "coach";
  return "";
}

// ---- old URLs ----

/**
 * Old tab links that moved: the tournament's Manage tab is the management sub-panel now (its hash is kept), the old
 * organiser-only league Participants tab opens the public Participants tab, and ?tab= spelled with the new tab names
 * reaches the same page as the old value. Returns the location to go to instead, or null.
 */
export function legacyRedirect(to: { name?: unknown; params: Record<string, unknown>; query: Record<string, unknown>; hash: string }): RouteLocationRaw | null {
  const name = String(to.name ?? "");
  const raw = to.query.tab;
  const tab = Array.isArray(raw) ? raw[0] : raw;
  if (typeof tab !== "string") return null;
  const id = String(to.params.id ?? "");
  const rest = (drop: string[] = []): Record<string, string> => {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(to.query)) {
      if (k === "tab" || drop.includes(k)) continue;
      const s = Array.isArray(v) ? v[0] : v;
      if (typeof s === "string") q[k] = s;
    }
    return q;
  };
  if (name === "tournament-detail") {
    if (tab === "manage") return { name: "tournament-manage", params: { id }, query: rest(), hash: to.hash };
    if (tab === "fixtures") return { name, params: { id }, query: { ...rest(), tab: "rounds" }, hash: to.hash };
    if (tab === "participants") return { name, params: { id }, query: { ...rest(), tab: "entrants" }, hash: to.hash };
  }
  if (name === "league-detail") {
    // award links from before the Awards tab (?tab=honours#award-<id>) open the award where it lives now
    if (tab === "honours" && to.hash.startsWith("#award-")) return { name, params: { id }, query: { ...rest(), tab: "awards" }, hash: to.hash };
    if (tab === "participants") return { name, params: { id }, query: { ...rest(), tab: "teams" }, hash: to.hash };
    if (tab === "statistics" || tab === "stats") return { name: "league-stats", params: { id }, query: rest(["team", "player", "fixture"]), hash: to.hash };
  }
  return null;
}

// ---- the header's view model (SectionHeader.vue renders it; the League / Tournament / Series wrappers build it) ----

export const SECTION_UP: Readonly<Record<SectionKind, { to: string; label: string; noun: string }>> = {
  league: { to: "/leagues", label: "All leagues", noun: "League" },
  tournament: { to: "/tournaments", label: "All tournaments", noun: "Tournament" },
  series: { to: "/series", label: "All series", noun: "Series" },
  club: { to: "/clubs", label: "All clubs", noun: "Club" },
};

export interface SectionChip { label: string; tone: string; to?: RouteLocationRaw; key?: string }

export interface SectionHeaderModel {
  kind: SectionKind;
  id: string;
  name: string;
  /** A safe same-origin logo URL, or "" (the initials badge shows). */
  logo: string;
  initials: string;
  /** A safe same-origin banner URL, or "": the slim strip behind the band on pages other than Overview. */
  banner: string;
  /** The status chip (tournament / series); leagues show the season dropdown instead. */
  status?: SectionChip;
  /** Extra chips after the status (a tournament's series). */
  chips?: SectionChip[];
  /** Leagues: every season, newest first, and the one shown. */
  seasons?: ReadonlyArray<{ id: string; label: string }>;
  seasonId?: string;
  /** The season cannot be switched on this page (Roster Builder league mode): a fixed chip instead of the dropdown. */
  seasonLocked?: boolean;
  tabs: SectionTabView[];
  active: SectionActive;
  role: SectionRole;
  /** Where the cog goes (organisers and admins only), or undefined. */
  manageTo?: RouteLocationRaw;
  /** League organisers: the Announcement megaphone beside the cog. */
  announce?: boolean;
  crumbs: Crumb[];
}

/** The slim banner strip shows on every page of the section except Overview (which shows the full banner). */
export const showsStrip = (m: Pick<SectionHeaderModel, "banner" | "active">): boolean => Boolean(m.banner) && m.active !== "overview";
