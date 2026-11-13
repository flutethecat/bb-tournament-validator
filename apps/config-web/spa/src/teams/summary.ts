// Team page v2 (spec-team-management 11-02, league UX pass Q4): ONE team summary for the league team page and the Roster
// Builder's Summary step (components/TeamSummary.vue + TeamRosterTable.vue). This module holds the shared view model, the
// two adapters that fill it (a league team from the season read; the builder's PDF sheet model), the client mirror of the
// server's edit context (src/leagues/teamPage.ts TeamPageView) and the controller that loads it and sends edits. No DOM.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import { ApiError } from "../shared/api";
import type { LeaguePlayer, LeagueTeam, PlayerSeasonStats } from "../leagues/types";
import type { PrintSheetModel } from "./sheetRuleset";
import { progressLine, type TeamManageModel } from "./manage";

// ---- the shared view model --------------------------------------------------------------------------------------------

export type SummaryMode = "view" | "coach" | "organiser" | "builder";
export interface SummarySkill { name: string; added?: boolean; elite?: boolean; access?: "primary" | "secondary" }
export interface SummaryCounter { key: string; label: string; title: string }
export interface SummaryRow {
  /** playerId (league) or the slot index (builder). */
  id: string;
  number: number | null;
  name: string;
  position: string;
  /** The muted line under the name: level, niggles, injuries, MNG, captain. */
  sub: string[];
  ma: number | null;
  st: number | null;
  ag: number | null;
  pa: number | null;
  av: number | null;
  skills: SummarySkill[];
  /** A custom star's traits and rules (special rules rows). */
  specialRules?: Array<{ kind: "trait" | "rule"; name: string; description: string }>;
  td: number | null;
  cas: number | null;
  mvp: number | null;
  spp: number | null;
  avail: number | null;
  value: number | null;
  seasonsPlayed: number | null;
  mng: boolean;
  niggling: number;
  counters: Record<string, number>;
  /** Shared-total lines (an export that could not split two players). */
  shared: string[];
  star: boolean;
  /** The portrait (a "/sprites/..." path from the generated art, "" when there is none: the frame shows initials). */
  sprite?: string;
  /** Cells of the team's extra columns (SummaryTeam.extraColumns), by column key; a missing key shows "-". */
  extra?: Record<string, { text: string; title?: string }>;
}
/** What the roster table lets the viewer change (all off = read only). */
export interface RosterCan { rename?: boolean; renumber?: boolean; fire?: boolean; plus?: boolean; stats?: boolean; numbers?: boolean; mng?: boolean; removeSkill?: "all" | "added"; plusFor?: (id: string) => boolean }
export interface SummaryFact { key: string; label: string; value: string; secondary?: string; edit?: { field: string; kind: "number" | "gold" | "bool"; raw: number | boolean | null } }
export interface SummaryFormer { id: string; name: string; position: string; td: number; cas: number; mvp: number; spp: number; counters: Record<string, number> }
export interface SummaryTeam {
  id: string;
  name: string;
  caption: string;
  facts: SummaryFact[];
  rows: SummaryRow[];
  former: SummaryFormer[];
  counters: SummaryCounter[];
  formerCounters: SummaryCounter[];
  /** League rosters carry season stats (TD / CAS / MVP / SPP / Avail.); a builder roster has none. */
  seasonStats: boolean;
  inactive?: boolean;
  /** The identity block's picture: the team avatar or the race crest ("/crests/..."); absent = initials. */
  crest?: string;
  /** The race's special rules, small text beside the caption (owner 10-27: "not a panel"). */
  specialRules?: string[];
  /** Panels under the roster (the Roster Builder and the share page): what the team spent and its inducements. */
  panels?: SummaryPanels;
  /** Extra roster columns after Skills (the coach's team management page: career TD / CAS / MVP and SPP); absent = none. */
  extraColumns?: SummaryCounter[];
}
export interface SummaryCost { key: string; label: string; value: string; tone?: "total" | "over" }
export interface SummaryInducement { name: string; count: number; icon: string }
export interface SummaryPanels {
  costs?: SummaryCost[];
  inducements?: { items: SummaryInducement[]; total: string | null };
}

// ---- art (the generated public/sprites and public/crests; never a URL from outside) -----------------------------------

/** Only relative paths inside the generated art folders are used (the rule team-view.js and the builder use). */
export const artSrc = (path: string | null | undefined): string =>
  typeof path === "string" && /^\/?(?:sprites|crests|icons)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(path) ? `/${path.replace(/^\//, "")}` : "";
/** Up to two initials (the sprite frame's fallback). */
export const artInitials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

export const kValue = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : `${Math.round(n / 1000).toLocaleString("en-US")}k`);
const stat = (v: number | null): string => (v === null ? "-" : String(v));

export const COUNTERS: ReadonlyArray<SummaryCounter & { key: keyof PlayerSeasonStats }> = [
  { key: "blocks", label: "BLK", title: "Blocks this season (Super FUMBBL results)" },
  { key: "rushing", label: "RUSH", title: "Rushing yards this season (Super FUMBBL results)" },
  { key: "passing", label: "PASS", title: "Passing yards this season (Super FUMBBL results)" },
  { key: "deflections", label: "DEF", title: "Deflections this season (Super FUMBBL results)" },
  { key: "landings", label: "LAND", title: "Landings this season (Super FUMBBL results)" },
  { key: "turnsPlayed", label: "TURNS", title: "Turns played this season (Super FUMBBL results)" },
];
/** The counters at least one of these players has a non-zero value for. */
const countersFor = (players: ReadonlyArray<{ stats: PlayerSeasonStats }>): SummaryCounter[] =>
  COUNTERS.filter((c) => players.some((p) => ((p.stats[c.key] as number | undefined) ?? 0) !== 0)).map(({ key, label, title }) => ({ key, label, title }));
const counterValues = (s: PlayerSeasonStats): Record<string, number> => Object.fromEntries(COUNTERS.map((c) => [c.key, (s[c.key] as number | undefined) ?? 0]));

/** Injury keys -> labels (server teamOps.ts INJURIES). */
export const INJURY_LABEL: Record<string, string> = {
  "badly-hurt": "Badly Hurt", "seriously-hurt": "Seriously Hurt", niggling: "Niggling Injury", "head-injury": "Head Injury", "smashed-knee": "Smashed Knee",
  "broken-arm": "Broken Arm", "neck-injury": "Neck Injury", "dislocated-shoulder": "Dislocated Shoulder", dead: "Dead",
};
/** The lasting injuries a player carries (a Badly Hurt or Seriously Hurt is no lasting mark). */
const lastingInjuries = (p: Pick<LeaguePlayer, "injuries">): string[] =>
  (p.injuries ?? []).map((i) => i.type).filter((t) => t !== "badly-hurt" && t !== "seriously-hurt" && t !== "niggling" && t !== "dead").map((t) => INJURY_LABEL[t] ?? t);

export interface LeagueSummaryOptions {
  /** Shared-total lines for a player (season unattributedStats). */
  shared?: (playerId: string) => string[];
  /** Organiser edit mode: facts carry their raw value for inputs. */
  editable?: boolean;
  /** A player's portrait for this team's race (teams/sprites.ts spriteSrc); none = the initials frame. */
  sprite?: (position: string) => string;
  /** The race crest ("/crests/..."). */
  crest?: string;
}

/** The team value line: CTV with TV beside it when they differ (league.ts teamValueFigures' rule). */
function tvFact(t: Pick<LeagueTeam, "teamValue" | "currentTeamValue">): SummaryFact {
  const cur = t.currentTeamValue;
  if (typeof cur === "number" && typeof t.teamValue === "number" && cur !== t.teamValue) return { key: "ctv", label: "Current team value", value: kValue(cur), secondary: `TV ${kValue(t.teamValue)}` };
  return { key: "tv", label: "Team value", value: kValue(t.teamValue) };
}

/** A league team (season read or the edit context) as the shared summary. */
export function summaryFromLeague(team: LeagueTeam, opts: LeagueSummaryOptions = {}): SummaryTeam {
  const e = opts.editable === true;
  const facts: SummaryFact[] = [
    tvFact(team),
    { key: "treasury", label: "Treasury", value: kValue(team.treasury), ...(e ? { edit: { field: "treasury", kind: "gold" as const, raw: team.treasury } } : {}) },
    { key: "rerolls", label: "Rerolls", value: stat(team.rerolls), ...(e ? { edit: { field: "rerolls", kind: "number" as const, raw: team.rerolls } } : {}) },
    { key: "fans", label: "Fans", value: stat(team.fans), ...(e ? { edit: { field: "fans", kind: "number" as const, raw: team.fans } } : {}) },
    { key: "assistantCoaches", label: "Assistant coaches", value: stat(team.assistantCoaches), ...(e ? { edit: { field: "assistantCoaches", kind: "number" as const, raw: team.assistantCoaches } } : {}) },
    { key: "cheerleaders", label: "Cheerleaders", value: stat(team.cheerleaders), ...(e ? { edit: { field: "cheerleaders", kind: "number" as const, raw: team.cheerleaders } } : {}) },
    { key: "apothecary", label: "Apothecary", value: team.apothecary ? "Yes" : "No", ...(e ? { edit: { field: "apothecary", kind: "bool" as const, raw: team.apothecary } } : {}) },
    ...(team.tier ? [{ key: "tier", label: "Tier", value: team.tier }] : []),
  ];
  const rows: SummaryRow[] = team.players.map((p) => ({
    id: p.playerId, number: p.number, name: p.name, position: p.position,
    sub: [p.level, p.niggling ? `${p.niggling} niggling` : "", ...lastingInjuries(p), p.missNextGame ? "misses next game" : ""].filter(Boolean),
    ma: p.ma, st: p.st, ag: p.ag, pa: p.pa, av: p.av,
    skills: p.skills.map((name) => ({ name })),
    td: p.stats.td, cas: p.stats.cas, mvp: p.stats.mvp, spp: p.stats.spp, avail: p.availableSpp, value: p.value,
    seasonsPlayed: p.seasonsPlayed ?? null, mng: p.missNextGame, niggling: p.niggling, counters: counterValues(p.stats),
    shared: opts.shared?.(p.playerId) ?? [], star: false, sprite: artSrc(opts.sprite?.(p.position)),
  }));
  return {
    id: team.id, name: team.name, caption: [team.race, team.coach, team.coachId && team.coachAssigned && !team.coachAssigned.cleared ? team.coachId : ""].filter(Boolean).join(" · "), facts, rows,
    former: team.formerPlayers.map((p) => ({ id: p.playerId, name: p.name, position: p.position, td: p.stats.td, cas: p.stats.cas, mvp: p.stats.mvp, spp: p.stats.spp, counters: counterValues(p.stats) })),
    counters: countersFor(team.players), formerCounters: countersFor(team.formerPlayers), seasonStats: true, inactive: team.status === "inactive",
    ...(artSrc(opts.crest) ? { crest: artSrc(opts.crest) } : {}),
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? "").replace(/\+$/, ""), 10);
  return Number.isFinite(n) ? n : null;
};

export interface BuilderSummaryExtras {
  coach: string;
  teamValue: number | null;
  treasury: number | null;
  staff: { reRolls: number; assistantCoaches: number; cheerleaders: number; dedicatedFans: number; apothecary: number };
  tier: string;
  /** Per row: whether the added skills may be removed here, and the chosen skills' access. */
  rowAccess?: (index: number, skill: string) => "primary" | "secondary";
  eliteMark?: (skill: string) => boolean;
  /** A row's portrait by its full position name (the builder's spritePath: custom stars wear their own pick). */
  sprite?: (positionFull: string) => string;
  crest?: string;
  /** The inducements bought, with their icons and the total spend (the Summary's Inducements panel). */
  inducements?: { items: SummaryInducement[]; total: number | null };
}

/** The Roster Builder's team (its PDF sheet model, the one both the Sheet tab and the PDF read) as the shared summary. */
export function summaryFromBuilder(model: PrintSheetModel, extras: BuilderSummaryExtras): SummaryTeam {
  const rows: SummaryRow[] = model.rows.map((r, i) => {
    const rules = (r as { specialRules?: SummaryRow["specialRules"] }).specialRules;
    return {
      id: String(i), number: r.number, name: r.name, position: r.position,
      sub: [r.isStar ? "Star player" : "", r.captain ? "Team Captain" : "", r.veteran ? "Veteran" : "", r.statIncreases.length ? r.statIncreases.map((s) => `+${s}`).join(" ") : ""].filter(Boolean),
      ma: num(r.stats.MA?.value), st: num(r.stats.ST?.value), ag: num(r.stats.AG?.value), pa: num(r.stats.PA?.value), av: num(r.stats.AV?.value),
      skills: [
        ...r.printed.map((name) => ({ name, elite: extras.eliteMark?.(name) })),
        ...r.free.map((name) => ({ name })),
        ...r.added.map((a) => ({ name: a.name, added: true, access: (a.access === "secondary" ? "secondary" : "primary") as "primary" | "secondary", elite: extras.eliteMark?.(a.name) })),
      ].filter((s, j, all) => all.findIndex((x) => x.name === s.name) === j),
      ...(rules?.length ? { specialRules: rules } : {}),
      td: null, cas: null, mvp: null, spp: null, avail: null, value: r.cost, seasonsPlayed: null, mng: false, niggling: 0, counters: {}, shared: [], star: r.isStar,
      sprite: artSrc(extras.sprite?.(r.positionFull)),
    };
  });
  const s = extras.staff;
  return {
    id: "builder", name: model.teamName || "Unnamed team", caption: [model.raceName, extras.coach].filter(Boolean).join(" · "),
    facts: [
      { key: "tv", label: "Team value", value: kValue(extras.teamValue) },
      ...(extras.treasury !== null ? [{ key: "treasury", label: "Treasury", value: kValue(extras.treasury) }] : []),
      { key: "rerolls", label: "Rerolls", value: String(s.reRolls) },
      { key: "fans", label: "Fans", value: String(s.dedicatedFans) },
      { key: "assistantCoaches", label: "Assistant coaches", value: String(s.assistantCoaches) },
      { key: "cheerleaders", label: "Cheerleaders", value: String(s.cheerleaders) },
      { key: "apothecary", label: "Apothecary", value: s.apothecary ? "Yes" : "No" },
      ...(extras.tier ? [{ key: "tier", label: "Tier", value: extras.tier }] : []),
    ],
    rows, former: [], counters: [], formerCounters: [], seasonStats: false,
    ...(artSrc(extras.crest) ? { crest: artSrc(extras.crest) } : {}),
    ...(model.specialRules?.length ? { specialRules: model.specialRules.map(String) } : {}),
    ...(extras.inducements ? { panels: { inducements: { items: extras.inducements.items, total: extras.inducements.total === null ? null : kValue(extras.inducements.total) } } } : {}),
  };
}

// ---- the public share page (/t/<token>; server teamShareView.ts SharedTeamView) -----------------------------------------

/** The share page's model as the server sends it (sanitised there: no ids, no coach account data beyond the coach name). */
export interface SharedTeamModel {
  avatarUrl?: string;
  teamName: string;
  coach: string;
  raceName: string;
  crest: string | null;
  ruleset: { name: string; tierLabel: string | null } | null;
  updatedAt: string;
  players: Array<{
    name?: string; number: number; position: string; positionFull: string; isStar: boolean; captain: boolean; veteran?: true;
    stats: { MA: number; ST: number; AG: string; PA: string; AV: string };
    printed: Array<{ name: string }>; free: Array<{ name: string }>; added: Array<{ name: string; access?: "primary" | "secondary" }>;
    statIncreases: string[]; cost: number | null; sprite: string | null;
  }>;
  sideline: { reRolls: number; apothecary: boolean; assistantCoaches: number; cheerleaders: number; dedicatedFans: number };
  inducements: Array<{ name: string; count: number; icon: string | null }>;
  specialRules: string[];
  summary: {
    players: number; playersCost: number | null; starsCost: number | null; skillsCost: number | null; inducementsCost: number | null; sidelineCost: number | null;
    total: number | null; cap: number | null; primarySkills: number; secondarySkills: number;
  };
  /** Present only when the viewer's session coach owns the save. */
  ownerSaveId?: string;
}

/** An uploaded team avatar's public read (src/teamAvatars.ts), the only non-art picture the share page may show. */
const avatarSrc = (url: unknown): string => (typeof url === "string" && /^\/api\/fork\/teams\/[^/?#]+\/avatar(?:\?v=\d+)?$/.test(url) ? url : "");

/** A shared Roster Builder team (the public share page) as the shared summary: read only, exactly the fields the page had. */
export function summaryFromShared(team: SharedTeamModel): SummaryTeam {
  const s = team.sideline;
  const sum = team.summary;
  const ruleset = team.ruleset ? [team.ruleset.name, team.ruleset.tierLabel].filter(Boolean).join(" · ") : "";
  const total = sum.total === null ? "-" : sum.cap !== null ? `${kValue(sum.total)} / ${kValue(sum.cap)}` : kValue(sum.total);
  const over = sum.total !== null && sum.cap !== null && sum.total > sum.cap;
  const rows: SummaryRow[] = team.players.map((p, i) => ({
    id: String(i), number: p.number, name: p.isStar ? "" : p.name ?? "", position: p.position,
    sub: [p.isStar ? "Star player" : "", p.captain ? "Team Captain" : "", p.veteran ? "Veteran" : "", p.statIncreases.length ? p.statIncreases.map((x) => `+${x}`).join(" ") : ""].filter(Boolean),
    ma: num(p.stats.MA), st: num(p.stats.ST), ag: num(p.stats.AG), pa: num(p.stats.PA), av: num(p.stats.AV),
    skills: [
      ...p.printed.map((k) => ({ name: k.name })), ...p.free.map((k) => ({ name: k.name })),
      ...p.added.map((k) => ({ name: k.name, added: true, access: k.access === "secondary" ? "secondary" as const : "primary" as const })),
    ].filter((k, j, all) => all.findIndex((x) => x.name === k.name) === j),
    td: null, cas: null, mvp: null, spp: null, avail: null, value: p.cost, seasonsPlayed: null, mng: false, niggling: 0, counters: {}, shared: [], star: p.isStar,
    sprite: artSrc(p.sprite),
  }));
  const crest = avatarSrc(team.avatarUrl) || artSrc(team.crest);
  return {
    id: "shared", name: team.teamName, caption: [team.raceName, team.coach, ruleset].filter(Boolean).join(" · "),
    facts: [
      { key: "tv", label: "Team value", value: total },
      { key: "rerolls", label: "Rerolls", value: String(s.reRolls) },
      { key: "fans", label: "Dedicated fans", value: String(s.dedicatedFans) },
      { key: "assistantCoaches", label: "Assistant coaches", value: String(s.assistantCoaches) },
      { key: "cheerleaders", label: "Cheerleaders", value: String(s.cheerleaders) },
      { key: "apothecary", label: "Apothecary", value: s.apothecary ? "Yes" : "No" },
    ],
    rows, former: [], counters: [], formerCounters: [], seasonStats: false,
    ...(crest ? { crest } : {}),
    ...(team.specialRules.length ? { specialRules: team.specialRules.map(String) } : {}),
    panels: {
      costs: [
        { key: "players", label: "Players", value: String(sum.players) },
        { key: "playersCost", label: "Players cost", value: kValue(sum.playersCost) },
        ...(sum.starsCost !== null && sum.starsCost > 0 ? [{ key: "stars", label: "Stars", value: kValue(sum.starsCost) }] : []),
        { key: "skills", label: "Skills", value: kValue(sum.skillsCost) },
        { key: "inducements", label: "Inducements", value: kValue(sum.inducementsCost) },
        { key: "sideline", label: "Sideline", value: kValue(sum.sidelineCost) },
        { key: "skillSplit", label: "Primary / Secondary", value: `${sum.primarySkills} / ${sum.secondarySkills}` },
        { key: "total", label: "Total", value: total, tone: over ? "over" : "total" },
      ],
      inducements: { items: team.inducements.map((x) => ({ name: x.name, count: x.count, icon: artSrc(x.icon) })), total: sum.inducementsCost === null ? null : kValue(sum.inducementsCost) },
    },
  };
}

// ---- the coach's own team (/app/teams/:ref; server teamManageView.ts TeamManageModel) ----------------------------------

export interface ManagedSummaryOptions {
  /** The avatar the page shows now (cache-busted after a change on the page); "" or absent = the race crest. */
  avatarUrl?: string;
}

const CAREER: ReadonlyArray<{ key: "td" | "cas" | "mvp"; label: string; title: string }> = [
  { key: "td", label: "TD", title: "Career touchdowns" },
  { key: "cas", label: "CAS", title: "Career casualties caused" },
  { key: "mvp", label: "MVP", title: "Career MVP awards" },
];

/**
 * The coach's own team (the team management page) as the shared summary: the share page's model (summaryFromShared, the
 * same server shape) with what the page adds layered on top. A fork library team's players may carry progression: then
 * the roster gains career TD / CAS / MVP (only the columns someone has a record for) and SPP against the cheapest next
 * advancement ("12/6", the progress line as its title), injuries and Miss Next Game join the row's muted line, and the
 * Team costs panel is left out (its Total repeats the strip's team value; the per-part costs are not known for those
 * teams). A Roster Builder save is exactly the share page's summary. The avatar, when set, is the crest.
 */
export function summaryFromManaged(team: TeamManageModel["team"], opts: ManagedSummaryOptions = {}): SummaryTeam {
  const players = team.players;
  // The manage view types a few lists as optional (a sheet without a captain has no free grants): the share adapter
  // reads them as lists.
  const asShared = {
    ...team, avatarUrl: opts.avatarUrl || undefined, inducements: team.inducements ?? [], specialRules: team.specialRules ?? [],
    players: players.map((p) => ({ ...p, printed: p.printed ?? [], free: p.free ?? [], added: p.added ?? [], statIncreases: p.statIncreases ?? [] })),
  };
  const base = summaryFromShared(asShared as unknown as SharedTeamModel);
  if (!players.some((p) => p.progress)) return base;
  const career = CAREER.filter((c) => players.some((p) => typeof p.careerStats?.[c.key] === "number"));
  const extraColumns: SummaryCounter[] = [
    ...career.map(({ key, label, title }) => ({ key, label, title })),
    { key: "spp", label: "SPP", title: "SPP against the cost of the next advancement" },
  ];
  const rows = base.rows.map((r, i): SummaryRow => {
    const p = players[i];
    const g = p?.progress;
    const extra: NonNullable<SummaryRow["extra"]> = {};
    for (const c of career) {
      const v = p?.careerStats?.[c.key];
      if (typeof v === "number") extra[c.key] = { text: String(v) };
    }
    if (g) {
      const cost = g.costs ? g.costs.randomPrimary : null;
      extra.spp = { text: cost !== null ? `${g.spp}/${cost}` : String(g.spp), title: progressLine(g) };
    }
    const injuries = p?.injuries ?? g?.injuries ?? [];
    const mng = Boolean(g?.mng);
    return { ...r, sub: [...r.sub, ...injuries, mng ? "Misses next game" : ""].filter(Boolean), mng, extra };
  });
  const out: SummaryTeam = { ...base, rows, extraColumns };
  const inducements = base.panels?.inducements;
  if (inducements?.items.length) out.panels = { inducements };
  else delete out.panels;
  return out;
}

/**
 * Load a shared team for the share page: a malformed token never asks; the server's 404 (unknown, unshared or revoked)
 * is "gone"; anything else is an error line.
 */
export async function loadSharedTeam(api: Fetcher | null | undefined, token: string): Promise<{ team: SharedTeamModel } | { gone: true } | { error: string }> {
  if (!api || !/^[0-9a-f]{32}$/.test(token)) return { gone: true };
  try {
    const res = await api<{ team?: SharedTeamModel }>(`/api/fork/team-builder/shared/${token}`);
    return res?.team ? { team: res.team } : { error: "Couldn't load this team." };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { gone: true };
    return { error: `Couldn't load this team (${e instanceof Error && e.message ? e.message : "network error"}).` };
  }
}

// ---- the edit context (server teamPage.ts TeamPageView) --------------------------------------------------------------

export type StaffKey = "rerolls" | "assistantCoaches" | "cheerleaders" | "apothecary" | "fans";
export interface InjuryType { key: string; label: string; text: string; stat?: string; niggling?: true; mng?: "always" | "optional"; dead?: true; recordOnly?: true }
export interface TeamHistoryEntry { at: string; by: string; kind: "coach-edit" | "organiser-edit" | "status" | "fixture-decision" | "forfeit" | "advancement"; changes: Array<{ what: string; from?: string; to?: string }> }
export type FixtureDecision = "cancel" | "forfeit" | "leave";
export interface TeamPageView {
  leagueId: string;
  seasonId: string;
  revision: number;
  ruleset: string;
  role: { coach: boolean; organiser: boolean };
  phase: "pregame" | "inseason";
  gamesPlayed: number;
  coach: { block: string; rerolls: boolean; fire: boolean; staffDown: boolean; fans: boolean; advance: boolean };
  team: LeagueTeam & { history?: TeamHistoryEntry[] };
  hire: {
    positions: Array<{ name: string; cost: number; max: number; count: number; ma: number; st: number; ag: number | null; pa: number | null; av: number | null; skills: string[]; bigGuy: boolean }>;
    staff: Array<{ key: StaffKey; label: string; price: number; count: number; min: number; max: number }>;
    maxBigGuys: number;
    maxPlayers: number;
  };
  limits: { errors: string[]; warnings: string[] };
  injuries: InjuryType[];
  advancement: Record<string, {
    count: number; spp: number; primary: string[]; secondary: string[];
    costs: { randomPrimary: number | null; chosenPrimary: number | null; chosenSecondary: number | null; characteristic: number | null };
    /** Primary categories a Random Primary roll may use. */
    randomCategories: string[];
  }>;
  /** The team's advancement dice log, newest first (coach and organisers). */
  diceLog: AdvanceLogEntry[];
  skills?: string[];
  fixtures?: Array<{ id: string; round: number; phase: string; opponent: string; date?: string; decision?: FixtureDecision; pending: boolean }>;
  needDecision: number;
  history: TeamHistoryEntry[];
}

/** One advancement roll in the team's dice log (server src/dice/log.ts DiceRoll, kinds advance-skill / advance-stat). */
export interface AdvanceLogEntry { id: string; at: string; by: string; kind: string; purpose: string; dice: number[]; result: Record<string, unknown>; admin?: boolean }

export type AdvanceChoice = { type: "skill"; skill: string; access?: "primary" | "secondary" } | { type: "stat"; stat: string };

export type TeamOp =
  | { op: "player"; playerId: string; field: string; value: string | number | boolean }
  | { op: "team"; field: string; value: string | number | boolean }
  | { op: "hire"; position: string }
  | { op: "fire"; playerId: string }
  | { op: "staff"; key: StaffKey; delta: 1 | -1 }
  | { op: "advance"; playerId: string; skill: string; method: "chosenPrimary" | "chosenSecondary" }
  | { op: "addSkill" | "removeSkill"; playerId: string; skill: string }
  | { op: "injury"; playerId: string; injury: string; mng?: boolean }
  | { op: "rollAdvance"; playerId: string; kind: "randomPrimary"; category: string }
  | { op: "rollAdvance"; playerId: string; kind: "characteristic" }
  | { op: "resolveAdvance"; playerId: string; rollId: string; choice: AdvanceChoice };

/** What the coach may do on the page now (the server decides again on every write). */
export function coachCan(v: TeamPageView | null): { edit: boolean; hire: boolean; fire: boolean; staff: boolean; advance: boolean; why: string } {
  if (!v?.role.coach) return { edit: false, hire: false, fire: false, staff: false, advance: false, why: "" };
  const edit = !v.coach.block;
  return { edit, hire: edit, fire: edit && v.coach.fire, staff: edit, advance: edit && v.coach.advance, why: v.coach.block };
}

/** A stat "+" (better) / "−" (worse): MA, ST and AV go up; the AG and PA targets go down. */
export function statStep(field: "ma" | "st" | "ag" | "pa" | "av", value: number | null, better: boolean): number | null {
  if (value === null) return null;
  const up = field === "ma" || field === "st" || field === "av";
  return value + (better === up ? 1 : -1);
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);
const base = (leagueId: string, seasonId: string, teamId: string): string =>
  `/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/teams/${encodeURIComponent(teamId)}`;

/**
 * The team page's edit controller: loads the edit context (coach or organiser only; anyone else gets none and sees the
 * plain summary) and sends writes one at a time with the latest season revision (a quick run of +/- clicks queues).
 * `onSaved` lets the league page refresh its season copy.
 */
export function createTeamPage(api: Fetcher, onSaved?: (view: TeamPageView, kind: "edit" | "status" | "fixtures") => void | Promise<void>) {
  const state = reactive({ view: null as TeamPageView | null, key: "", loading: false, busy: false, error: "", notice: "" });
  let queue: Promise<unknown> = Promise.resolve();
  async function load(leagueId: string, seasonId: string, teamId: string): Promise<void> {
    const key = `${leagueId}|${seasonId}|${teamId}`;
    state.key = key; state.loading = true; state.error = "";
    try {
      const res = await api<{ view: TeamPageView }>(`${base(leagueId, seasonId, teamId)}/manage`);
      if (state.key === key) state.view = res.view;
    } catch {
      if (state.key === key) state.view = null; // not the coach or an organiser (or signed out): the plain summary
    } finally {
      if (state.key === key) state.loading = false;
    }
  }
  function write(kind: "edit" | "status" | "fixtures", body: Record<string, unknown>, notice: string): Promise<string> {
    const run = async (): Promise<string> => {
      const v = state.view;
      if (!v) return "Reload the page.";
      state.busy = true; state.error = ""; state.notice = "";
      try {
        const res = await api<{ view: TeamPageView }>(`${base(v.leagueId, v.seasonId, v.team.id)}/${kind}`, { method: "POST", body: { revision: v.revision, ...body } });
        state.view = res.view;
        state.notice = notice;
        await onSaved?.(res.view, kind);
        return "";
      } catch (err) {
        state.error = errorText(err, "That did not save.");
        return state.error;
      } finally {
        state.busy = false;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    state, load,
    edit: (mode: "coach" | "organiser", ops: TeamOp[], notice = "Saved.") => write("edit", { mode, ops }, notice),
    setStatus: (status: "active" | "inactive", decide?: { decisions?: Array<{ fixtureId: string; decision: FixtureDecision }>; all?: FixtureDecision }) =>
      write("status", { status, ...(decide ?? {}) }, status === "inactive" ? "Team marked inactive." : "Team marked active."),
    decide: (decide: { decisions?: Array<{ fixtureId: string; decision: FixtureDecision }>; all?: FixtureDecision }) => write("fixtures", decide, "Fixture decisions saved."),
  };
}
export type TeamPage = ReturnType<typeof createTeamPage>;
