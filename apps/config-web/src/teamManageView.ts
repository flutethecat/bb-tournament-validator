/**
 * Team management page model (owner 10-30: "These blocks should be clickable and should surface the team management
 * page"). GET /api/me/teams/<ref> answers the signed-in coach's OWN team in the shared team view's shape
 * (teamShareView.ts SharedTeamView, rendered by public/team-view.js on the public page and the SPA alike), plus a
 * `manage` block and, for fork library teams, per-player progression from the stored team XML (teamDetail.ts /
 * teamAdvancement.ts: SPP, rank, advancement costs, which methods the coach can use now, any pending roll).
 *
 * Refs: `library:<teamId>` (a fork-registered team: advancement applies) or a Tournament Builder save id (`sv_…`,
 * optionally `save:`-prefixed: a sheet only; advancement applies once the team is built and plays on the fork).
 */

import { findPosition, findRoster, isStarName, rosterHasTeamCaptain, type SkillCategory } from "@bb/validator";
import { captainIneligibility } from "./captain.js";
import { bb2025 } from "@bb/validator/dataset";
import type { LibraryTeam } from "@bb/fork-ops";
import { shortPositionName } from "./positionNames.js";
import type { Capability, PlayerCareerStats, TeamDetail, TeamDetailPlayer } from "./teamDetail.js";
import type { AdvancementCosts, PendingAdvancementResponse } from "./teamAdvancement.js";
import type { TeamBuilderSave } from "./teamBuilderSaves.js";
import {
  readManifest,
  resolveCrest,
  resolveSprite,
  safeArt,
  skillCategory,
  type SharedPlayer,
  type SharedTeamView,
  type SpriteManifest,
} from "./teamShareView.js";

export type AdvancementMethodKey = "randomPrimary" | "chosenPrimary" | "chosenSecondary" | "characteristic";

export interface ManagedPlayerProgress {
  /** Stored player id (the advancement endpoint's playerId). */
  id: string;
  /** Spendable SPP (the advancement costs are checked against this). */
  spp: number;
  /** Lifetime earned SPP when the file records it; null for un-audited imports. */
  earnedSpp: number | null;
  advancements: number;
  rank: string;
  costs: AdvancementCosts | null;
  methods: Record<AdvancementMethodKey, Capability>;
  pending: PendingAdvancementResponse | null;
  primaryCategories: string[];
  secondaryCategories: string[];
  /** Legal non-Elite Primary skills (the chosen-Primary list). */
  primarySkills: string[];
  secondarySkills: string[];
  /** "Add Skill": a random or chosen Primary advancement is affordable and available now. */
  canAddSkill: boolean;
  /** "Add Characteristic": a characteristic improvement roll is affordable and available now. */
  canAddCharacteristic: boolean;
  mng: boolean;
  injuries: string[];
}

/** Player value split as the TourPlay roster prints it, e.g. "(115+30)k": the position's cost plus what was added. */
export interface ValueBreakdown {
  base: number;
  added: number;
  total: number;
}

export interface ManagedPlayer extends SharedPlayer {
  /** Player name (fork teams; builder sheets have none). */
  name?: string;
  progress?: ManagedPlayerProgress;
  /** Fork teams: career counters from the team XML (teamDetail.ts playerCareerStats); null = not recorded. */
  careerStats?: PlayerCareerStats;
  /** Fork teams: the injury list as stored (e.g. "Serious Injury (NI)"). */
  injuries?: string[];
  /** Fork teams: base position cost + added value; null when the roster cost is unknown. */
  valueBreakdown?: ValueBreakdown | null;
}

export interface ManagedTeamView extends Omit<SharedTeamView, "players"> {
  players: ManagedPlayer[];
  /** Badge text in place of "Verified" (team-view.js). */
  verdict?: string;
}

export interface TeamManageInfo {
  kind: "library" | "save";
  ref: string;
  /** Fork team id (library teams): POST /api/teams/<teamId>/advancement. */
  teamId?: string;
  /** Team XML revision the advancement actions must quote. */
  revision?: string;
  /** The Tournament Builder save behind the page: the sheet itself, or the sheet a fork team was built from. */
  saveId?: string;
  /** The live share link of that save, when shared. */
  shareToken?: string;
  /** For a save that was built onto the fork: that team's management page ref. */
  libraryRef?: string;
  treasury?: number;
  teamValue?: number;
  advancement: { available: boolean; reason?: string };
  /**
   * Library teams whose Team Captain left (owner 10-30; captain.ts): the captaincy is vacant and these roster players
   * (ManagedPlayerProgress.id) may be appointed with POST /api/team/appointCaptain { teamId, playerId }.
   */
  captain?: { vacant: true; eligible: string[] };
}

export interface TeamManageModel {
  team: ManagedTeamView;
  manage: TeamManageInfo;
}

/** /api/me/teams/<ref> -> the raw (decoded) ref; undefined for anything else. */
export function meTeamPath(pathname: string): string | undefined {
  const match = /^\/api\/me\/teams\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try {
    const ref = decodeURIComponent(match[1]!);
    return /^(?:(?:library|save):)?[\w-]{1,64}$/.test(ref) ? ref : undefined;
  } catch {
    return undefined;
  }
}

const decodeXml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The position's own (printed) skills from the stored fork roster XML. */
function rosterPositionSkills(rosterXml: string | undefined, positionId: string): string[] | undefined {
  if (!rosterXml || !positionId) return undefined;
  const block = rosterXml.match(new RegExp(`<position\\b[^>]*\\bid="${escapeRe(positionId)}"[^>]*>[\\s\\S]*?</position>`, "i"))?.[0];
  if (!block) return undefined;
  const list = block.match(/<skillList\b[^>]*>([\s\S]*?)<\/skillList>/i)?.[1] ?? "";
  return [...list.matchAll(/<skill\b[^>]*>([^<]*)<\/skill>/gi)].map((m) => decodeXml(m[1]!).trim()).filter(Boolean);
}

const STAT_TOKEN = /^\+(MA|ST|AG|PA|AV)$/i;
const target = (n: number | null | undefined, fallback: string): string => (typeof n === "number" && n > 0 ? `${n}+` : fallback);
const humanize = (key: string): string => key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function managedLibraryPlayer(
  p: TeamDetailPlayer,
  ctx: { race: string; rosterXml?: string; sprites: SpriteManifest | null; blocked?: string },
): ManagedPlayer {
  const positionFull = p.position ?? "";
  const star = positionFull ? isStarName(bb2025, positionFull) : false;
  const dsRoster = ctx.race ? findRoster(bb2025, ctx.race) : undefined;
  const ds = dsRoster && positionFull && !star ? (dsRoster.positions.find((x) => x.name === positionFull) ?? findPosition(dsRoster, positionFull)) : undefined;
  const printed = rosterPositionSkills(ctx.rosterXml, p.positionId) ?? ds?.skills ?? [];
  const printedSet = new Set(printed.map((s) => s.toLowerCase()));
  const secondary = new Set(p.secondaryCategories);
  const added = p.skills.filter((s) => !STAT_TOKEN.test(s) && !printedSet.has(s.toLowerCase()));
  const statIncreases = p.skills.filter((s) => STAT_TOKEN.test(s)).map((s) => s.slice(1).toUpperCase());
  const methods = p.advancementMethods;
  const canAdd = (keys: AdvancementMethodKey[]) => !ctx.blocked && keys.some((k) => methods[k].available);
  return {
    number: p.number,
    name: p.name,
    position: shortPositionName({ name: positionFull }, { name: ctx.race }) || positionFull || "Player",
    positionFull,
    isStar: star,
    stats: {
      MA: p.movement ?? ds?.MA ?? 0,
      ST: p.strength ?? ds?.ST ?? 0,
      AG: target(p.agility, ds?.AG ?? "-"),
      PA: target(p.passing, ds?.PA ?? "-"),
      AV: target(p.armour, ds?.AV ?? "-"),
    },
    printed: printed.map((name) => ({ name, category: skillCategory(name) })),
    added: added.map((name) => {
      const category = skillCategory(name);
      return { name, category, access: secondary.has(category as SkillCategory) ? "secondary" as const : "primary" as const };
    }),
    statIncreases,
    cost: p.currentValue > 0 ? p.currentValue : null,
    sprite: safeArt(resolveSprite(ctx.sprites, ctx.race, positionFull)),
    careerStats: p.careerStats,
    injuries: [...p.injuries],
    valueBreakdown: p.baseValue !== null && p.currentValue >= p.baseValue
      ? { base: p.baseValue, added: p.currentValue - p.baseValue, total: p.currentValue }
      : null,
    progress: {
      id: p.id,
      spp: p.spp,
      earnedSpp: p.earnedSpp,
      advancements: p.advancements,
      rank: p.rank,
      costs: p.advancementCosts,
      methods,
      pending: p.pendingAdvancement,
      primaryCategories: p.primaryCategories,
      secondaryCategories: p.secondaryCategories,
      primarySkills: p.primarySkills.filter((s) => bb2025.skills[s]?.elite !== true),
      secondarySkills: p.secondarySkills,
      canAddSkill: canAdd(["randomPrimary", "chosenPrimary"]),
      canAddCharacteristic: canAdd(["characteristic"]),
      mng: p.mng,
      injuries: p.injuries,
    },
  };
}

export interface LibraryManageInput {
  coach: string;
  detail: TeamDetail;
  stored: LibraryTeam;
  rosterXml?: string;
  publicDir: string;
  /** The coach's builder save this team was built from (share + Tournament Builder link). */
  linkedSave?: TeamBuilderSave;
  /** Why advancement cannot run on this host right now (e.g. no fork admin API); undefined = available. */
  advancementBlocked?: string;
  avatarUrl?: string;
}

/** The roster XML's <type> of a position ("Big Guy", "Star", "Regular"), letters only, lower-cased. */
function rosterPositionType(rosterXml: string | undefined, positionId: string): string | undefined {
  if (!rosterXml || !positionId) return undefined;
  const block = rosterXml.match(new RegExp(`<position\\b[^>]*\\bid="${escapeRe(positionId)}"[^>]*>[\\s\\S]*?</position>`, "i"))?.[0];
  const type = block?.match(/<type>([^<]*)<\/type>/i)?.[1];
  return type === undefined ? undefined : decodeXml(type).toLowerCase().replace(/[^a-z]/g, "");
}

/** The roster players a vacant captaincy may go to (same rules as teamMutation.ts appointCaptain). */
function captainCandidates(detail: TeamDetail, race: string, rosterXml: string | undefined): string[] {
  const rules = [...detail.specialRules, ...(findRoster(bb2025, race)?.specialRules ?? [])];
  if (!rosterHasTeamCaptain(rules)) return [];
  return detail.players
    .filter((p) => !p.journeyman && !/dead|rip/i.test(p.status ?? ""))
    .filter((p) => {
      const type = rosterPositionType(rosterXml, p.positionId);
      const star = type === "star" || type === "mercenary" || (p.position ? isStarName(bb2025, p.position) : false);
      return !captainIneligibility({ star, bigGuy: type === "bigguy", positionKnown: type !== undefined });
    })
    .map((p) => p.id);
}

/** A fork library team -> the shared view's shape + per-player progression. */
export function libraryManageView(input: LibraryManageInput): TeamManageModel {
  const { detail, stored } = input;
  const race = detail.race || stored.race;
  const sprites = readManifest<SpriteManifest>(input.publicDir, "sprites/manifest.json");
  const crests = readManifest<{ crests?: Record<string, string> }>(input.publicDir, "crests/manifest.json");
  const icons = readManifest<{ icons?: Record<string, string> }>(input.publicDir, "icons/inducements/manifest.json");
  const retired = stored.retired === true;
  const blocked = retired ? "Retired teams cannot gain advancements." : input.advancementBlocked;
  const players = detail.players
    .filter((p) => !/dead|rip|retired/i.test(p.status ?? ""))
    .map((p) => managedLibraryPlayer(p, { race, rosterXml: input.rosterXml, sprites, blocked }))
    .sort((a, b) => a.number - b.number);
  const sum = players.reduce((n, p) => n + (p.cost ?? 0), 0);
  const team: ManagedTeamView = {
    ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    teamName: detail.name,
    coach: input.coach,
    raceName: race,
    crest: safeArt(resolveCrest(crests, race)),
    ruleset: stored.rulesetPackName ? { name: stored.rulesetPackName, tierLabel: null } : null,
    updatedAt: stored.ingestedAt,
    players,
    sideline: {
      reRolls: detail.rerolls,
      apothecary: detail.apothecary,
      assistantCoaches: detail.assistantCoaches,
      cheerleaders: detail.cheerleaders,
      dedicatedFans: detail.fanFactor,
    },
    inducements: (stored.rosteredInducements ?? []).filter((i) => i.count > 0).map((i) => {
      const icon = icons?.icons && Object.prototype.hasOwnProperty.call(icons.icons, i.key) ? icons.icons[i.key]! : null;
      return { name: humanize(i.key), count: i.count, icon: safeArt(icon) };
    }),
    specialRules: detail.specialRules,
    summary: {
      players: players.length,
      playersCost: sum > 0 ? sum : null,
      starsCost: null,
      skillsCost: null,
      inducementsCost: null,
      sidelineCost: null,
      total: detail.teamValue > 0 ? detail.teamValue * 1000 : null,
      cap: null,
      primarySkills: players.reduce((n, p) => n + p.added.filter((s) => s.access !== "secondary").length, 0),
      secondarySkills: players.reduce((n, p) => n + p.added.filter((s) => s.access === "secondary").length, 0),
    },
    validity: { valid: true, issues: 0, custom: false, findings: [] },
    verdict: retired ? "Retired" : "On the fork",
  };
  return {
    team,
    manage: {
      kind: "library",
      ref: `library:${stored.teamId}`,
      teamId: stored.teamId,
      revision: detail.revision,
      ...(input.linkedSave ? { saveId: input.linkedSave.id, ...(input.linkedSave.shareToken ? { shareToken: input.linkedSave.shareToken } : {}) } : {}),
      treasury: detail.treasury,
      teamValue: detail.teamValue,
      advancement: blocked ? { available: false, reason: blocked } : { available: true },
      ...(detail.captainVacant && !retired ? { captain: { vacant: true as const, eligible: captainCandidates(detail, race, input.rosterXml) } } : {}),
    },
  };
}

/** A Tournament Builder save (already composed by the share route's sharedViewFor) -> the page model. Read-only. */
export function saveManageView(view: SharedTeamView, save: TeamBuilderSave, libraryRef?: string): TeamManageModel {
  const { ownerSaveId: _owner, ...rest } = view;
  return {
    team: rest,
    manage: {
      kind: "save",
      ref: save.id,
      saveId: save.id,
      ...(save.shareToken ? { shareToken: save.shareToken } : {}),
      ...(libraryRef ? { libraryRef } : {}),
      advancement: {
        available: false,
        reason: libraryRef
          ? "This sheet has been created as a team: manage that team to add skills and characteristics."
          : "This is a Roster Builder sheet. Skills and characteristics are added once the team is created and plays its games.",
      },
    },
  };
}
