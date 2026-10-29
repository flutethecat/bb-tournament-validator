/**
 * Play on Super FUMBBL: the fork team file for one league team (pure; forkPlay.ts writes it through the fork client).
 *
 * The league roster is the record: every player is written as the league has them now, in the form the fork reads
 * back. The fork resets a player's characteristics to the roster position on load, then applies stat-increase skills
 * and lasting injuries (ffb-common RosterPlayer.updatePosition), so a characteristic that differs from the position is
 * written as canonical "+MA"/"+ST"/"+AG"/"+PA"/"+AV" skills (improvements) or the BB2025 stat injuries (reductions),
 * never as an override. Also written: the skills the position does not print, spendable SPP, niggling injuries, a
 * missed next game as a recovering "Seriously Hurt (MNG)" injury so the server keeps the player out of this game,
 * staff, treasury and dedicated fans. Only BB2025 seasons can be played (the fork's league rosters and the composer
 * are BB2025); any other edition is refused before anything is installed. The header and the roster's special rules come from the Team Builder composer
 * (composeTeam with no picks), so the file is the same dialect the fork already loads for builder teams.
 *
 * One fork team per league / season / team (forkTeamIdFor); its player ids are derived from the league playerId, so
 * the result of the game maps back to the league players (FixtureForkTeam.players).
 */
import { createHash } from "node:crypto";
import { composeTeam, normName, parseForkRoster, type ForkRoster, type ForkRosterPosition } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { bankingValueProblem } from "../site-backend/fumbblResultBanking.js";
import type { FixtureForkTeam, LeaguePlayer, LeagueTeam } from "./types.js";

export class ForkTeamBuildError extends Error {}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The fork team id of a league team in one season: stable, file-name safe, never a builder (tb_) id. */
export const forkTeamIdFor = (leagueId: string, seasonId: string, teamId: string): string => `lg_${sha(`${leagueId}\0${seasonId}\0${teamId}`).slice(0, 16)}`;

/** The fork player id of a league player on that team. */
export const forkPlayerIdFor = (forkTeamId: string, playerId: string): string => `${forkTeamId}_${sha(playerId).slice(0, 10)}`;

/** Rules editions Super FUMBBL can play a league fixture in. */
export const FORK_RULESETS: readonly string[] = ["BB2025"];

/** Why a season's edition cannot be played on Super FUMBBL ("" = it can). */
export const rulesetBlocker = (ruleset: string): string =>
  FORK_RULESETS.includes(ruleset) ? "" : `Super FUMBBL plays BB2025 league fixtures only; this season is ${ruleset || "of an unknown edition"}.`;

/** The fork roster for a league race in the season's edition: same race name (case and spacing tolerant), roster id `<race>.<edition>`. */
export function forkRosterFor(race: string, rosters: ReadonlyMap<string, string>, ruleset = "BB2025"): { rosterXml: string; roster: ForkRoster } | undefined {
  const want = normName(race);
  const suffix = `.${ruleset.toLowerCase()}`;
  for (const [, xml] of rosters) {
    let roster: ForkRoster;
    try { roster = parseForkRoster(xml); } catch { continue; }
    if (normName(roster.raceName) === want && roster.rosterId.toLowerCase().endsWith(suffix)) return { rosterXml: xml, roster };
  }
  return undefined;
}

export type Characteristic = "MA" | "ST" | "AG" | "PA" | "AV";

/** The BB2025 stat injuries, by characteristic (SeriousInjury names the fork parses). */
export const STAT_INJURY: Record<Characteristic, string> = {
  MA: "Smashed Knee (-MA)", ST: "Dislocated Shoulder (-ST)", AG: "Dislocated Hip (-AG)", PA: "Broken Arm (-PA)", AV: "Head Injury (-AV)",
};

/** The characteristic a league stat-advance entry names ("+ST", "+1 ST", "ST"), if it is one. */
export function statAdvanceOf(skill: string): Characteristic | undefined {
  return skill.trim().match(/^\+?\s*\d?\s*(ma|st|ag|pa|av)$/i)?.[1]?.toUpperCase() as Characteristic | undefined;
}

/**
 * How a league player's characteristics are recorded on the fork. Purchased advances (the league's "+X" entries) are
 * kept as "+X" skills, whatever the current value, so an advance offset by a lasting injury keeps both; the injuries
 * are what separates the enhanced value (position + advances) from the league's current one; a current value better
 * than the enhanced one adds the missing "+X" steps. AG and PA are targets (lower is better). A position without a PA
 * (0) or a player without a value records only the purchased advances.
 */
export function statDelta(p: Pick<LeaguePlayer, "ma" | "st" | "ag" | "pa" | "av"> & { skills?: string[] }, pos: Pick<ForkRosterPosition, "MA" | "ST" | "AG" | "PA" | "AV">): { increases: string[]; injuries: string[] } {
  const increases: string[] = [];
  const injuries: string[] = [];
  const rows: Array<[Characteristic, number | null, number | undefined, boolean]> = [
    ["MA", p.ma, pos.MA, false], ["ST", p.st, pos.ST, false], ["AG", p.ag, pos.AG, true], ["PA", p.pa, pos.PA, true], ["AV", p.av, pos.AV, false],
  ];
  for (const [key, value, base, target] of rows) {
    const bought = (p.skills ?? []).filter((s) => statAdvanceOf(s) === key).length;
    for (let i = 0; i < bought; i += 1) increases.push(`+${key}`);
    if (typeof value !== "number" || typeof base !== "number" || base <= 0) continue;
    const enhanced = target ? base - bought : base + bought;
    const better = target ? enhanced - value : value - enhanced;
    for (let i = 0; i < Math.abs(better); i += 1) {
      if (better > 0) increases.push(`+${key}`); else injuries.push(STAT_INJURY[key]);
    }
  }
  return { increases, injuries };
}

/** A fingerprint of everything the fork team file is built from (a changed roster means the team must be rebuilt). */
export function leagueTeamRevision(team: LeagueTeam): string {
  const players = team.players.map((p) => [p.playerId, p.number, p.name, p.position, p.ma, p.st, p.ag, p.pa, p.av, p.skills, p.availableSpp, p.niggling, p.missNextGame]);
  return sha(JSON.stringify([team.name, team.race, team.coachId ?? team.coach, team.teamValue, team.treasury, team.rerolls, team.fans,
    team.assistantCoaches, team.cheerleaders, team.apothecary, players])).slice(0, 16);
}

/** The roster position a league player plays: exact name, else the name without the race words ("Orc Lineman" ~ "Lineman"). */
export function positionFor(roster: ForkRoster, position: string): ForkRosterPosition | undefined {
  const want = normName(position);
  const exact = roster.positions.find((p) => normName(p.name) === want);
  if (exact) return exact;
  const race = new Set(normName(roster.raceName).split(" "));
  const bare = (s: string): string => normName(s).split(" ").filter((w) => !race.has(w)).join(" ");
  const w = bare(position);
  return w ? roster.positions.find((p) => !p.isStar && bare(p.name) === w) : undefined;
}

const skillBase = (s: string): string => normName(s.replace(/\s*\([^)]*\)\s*$/, ""));
const isStatIncrease = (s: string): boolean => /^\+?\s*\d?\s*(ma|st|ag|pa|av)$/i.test(s.trim());
const KNOWN_SKILLS = new Map(Object.keys(bb2025.skills).map((name) => [normName(name), name]));

/** `<skill>` for an acquired skill: the dataset spelling, a parameter as the value ("Hatred (Undead)" -> value="undead", "Loner (4+)" -> value="4"). */
function skillXml(raw: string, player: string): string {
  const name = KNOWN_SKILLS.get(skillBase(raw));
  if (!name) throw new ForkTeamBuildError(`${player} has a skill Super FUMBBL does not know: "${raw}".`);
  const param = raw.match(/\(([^)]*)\)\s*$/)?.[1]?.trim();
  const value = param ? (/^(\d+)\+?$/.test(param) ? param.replace("+", "") : param.toLowerCase()) : "";
  return value ? `<skill value="${xmlEscape(value)}">${xmlEscape(name)}</skill>` : `<skill>${xmlEscape(name)}</skill>`;
}

export interface LeagueForkTeamInput {
  leagueId: string;
  seasonId: string;
  team: LeagueTeam;
  /** The fork coach who owns the team (the fixture side's coachId). */
  coach: string;
  rosters: ReadonlyMap<string, string>;
  /** The season's edition (SeasonRecord.ruleset). */
  ruleset: string;
  /** Result banking runs on this host: refuse any player the banker could not value after a death or a missed game. */
  bankingGuard?: boolean;
  now?: Date;
}

export interface LeagueForkTeamFile {
  forkTeamId: string;
  xml: string;
  rosterId: string;
  raceName: string;
  /** For the coach's team library row. */
  library: { teamName: string; race: string; teamValueK: number; treasury: number; rerolls: number; fanFactor: number; apothecary: boolean };
  players: FixtureForkTeam["players"];
  /** leagueTeamRevision of the roster this file was built from. */
  revision: string;
}

function playerXml(p: LeaguePlayer, pos: ForkRosterPosition, nr: number, id: string): string {
  const label = p.name || `${p.position} #${nr}`;
  const printed = new Set((pos.skills ?? []).map(skillBase));
  // "+MA"-style entries in the league skills are derived from the characteristics, never written twice.
  const extra = p.skills.filter((s) => s.trim() && !isStatIncrease(s) && !printed.has(skillBase(s)));
  const delta = statDelta(p, pos);
  const injuries = [
    ...delta.injuries.map((name) => `<injury>${xmlEscape(name)}</injury>`),
    ...Array.from({ length: Math.max(0, p.niggling | 0) }, () => "<injury>Serious Injury (NI)</injury>"),
    ...(p.missNextGame ? ['<injury recovering="true">Seriously Hurt (MNG)</injury>'] : []),
  ];
  const spp = Math.max(0, Math.trunc(p.availableSpp || 0));
  return `\t<player nr="${nr}" id="${xmlEscape(id)}"><name>${xmlEscape(label)}</name>` +
    `<gender>${xmlEscape(pos.gender)}</gender><positionId>${xmlEscape(pos.positionId)}</positionId>` +
    `<playerStatistics currentSpps="${spp}"></playerStatistics>` +
    `<skillList>${[...extra.map((s) => skillXml(s, label)), ...delta.increases.map((s) => `<skill>${s}</skill>`)].join("")}</skillList>` +
    (injuries.length ? `<injuryList>${injuries.join("")}</injuryList>` : "<injuryList/>") + "</player>";
}

const setTag = (xml: string, tag: string, value: string | number): string => xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`);

/** Builds the fork team file for a league team. Throws ForkTeamBuildError with a coach-readable reason. */
export function buildLeagueForkTeam(input: LeagueForkTeamInput): LeagueForkTeamFile {
  const { team } = input;
  const edition = rulesetBlocker(input.ruleset);
  if (edition) throw new ForkTeamBuildError(edition);
  if (!team.players.length) throw new ForkTeamBuildError(`${team.name} has no players on its league roster.`);
  const found = forkRosterFor(team.race, input.rosters, input.ruleset);
  if (!found) throw new ForkTeamBuildError(`Super FUMBBL has no ${input.ruleset} ${team.race} roster.`);
  const { roster, rosterXml } = found;
  const forkTeamId = forkTeamIdFor(input.leagueId, input.seasonId, team.id);
  let skeleton;
  try {
    skeleton = composeTeam({
      forkRosterXml: rosterXml, coach: input.coach, teamName: team.name, picks: [], reRolls: Math.max(0, team.rerolls ?? 0),
      apothecary: team.apothecary, dedicatedFans: Math.max(0, team.fans ?? 1), assistantCoaches: team.assistantCoaches ?? 0, cheerleaders: team.cheerleaders ?? 0,
      custom: true,
    }, bb2025, (input.now ?? new Date()).getTime());
  } catch (e) {
    throw new ForkTeamBuildError(`The ${team.race} roster could not be prepared: ${(e as Error).message}`);
  }
  const taken = new Set(team.players.map((p) => p.number).filter((n): n is number => typeof n === "number" && n > 0));
  let next = 1;
  const freeNumber = (): number => { while (taken.has(next)) next += 1; taken.add(next); return next; };
  const players: FixtureForkTeam["players"] = [];
  const blocks: string[] = [];
  const seenIds = new Set<string>();
  for (const p of team.players) {
    const pos = positionFor(roster, p.position);
    if (!pos) throw new ForkTeamBuildError(`${p.name || "A player"}: the ${team.race} roster has no "${p.position}" position.`);
    const nr = typeof p.number === "number" && p.number > 0 ? p.number : freeNumber();
    const id = forkPlayerIdFor(forkTeamId, p.playerId);
    if (seenIds.has(id)) throw new ForkTeamBuildError(`${team.name} lists the same player twice.`);
    seenIds.add(id);
    const block = playerXml(p, pos, nr, id);
    // Refuse a player the result banker could not value after a death or a missed game, before any game exists.
    const problem = input.bankingGuard ? bankingValueProblem(block, rosterXml) : undefined;
    if (problem) throw new ForkTeamBuildError(`${p.name || p.position}: Super FUMBBL results could not value this player yet (${problem}).`);
    blocks.push(block);
    players.push({ forkPlayerId: id, playerId: p.playerId });
  }
  const tvUnits = Math.max(0, Math.round((team.teamValue ?? 0) / 10000));
  const treasury = Math.max(0, Math.trunc(team.treasury ?? 0));
  let xml = skeleton.xml.replace(`<team id="${skeleton.teamId}">`, `<team id="${forkTeamId}">`);
  xml = setTag(xml, "treasury", treasury);
  for (const tag of ["teamRating", "currentTeamValue", "teamStrength"]) xml = setTag(xml, tag, tvUnits);
  xml = xml.replace(/\t<custom>true<\/custom>\n/, "");
  const staff = [
    ...((team.assistantCoaches ?? 0) > 0 ? [`\t<assistantCoaches>${team.assistantCoaches}</assistantCoaches>\n`] : []),
    ...((team.cheerleaders ?? 0) > 0 ? [`\t<cheerleaders>${team.cheerleaders}</cheerleaders>\n`] : []),
  ].join("");
  if (staff) xml = xml.replace(/(\t<apothecaries>[^<]*<\/apothecaries>\n)/, `$1${staff}`);
  xml = xml.replace(/\n\n<\/team>\n$/, `${blocks.join("\n")}\n\n</team>\n`);
  if (!xml.includes(`<team id="${forkTeamId}">`) || !xml.includes(blocks[0]!)) throw new ForkTeamBuildError("The team file could not be assembled.");
  return {
    forkTeamId, xml, rosterId: roster.rosterId, raceName: roster.raceName, players, revision: leagueTeamRevision(team),
    library: {
      teamName: team.name, race: roster.raceName, teamValueK: Math.round((team.teamValue ?? 0) / 1000), treasury,
      rerolls: Math.max(0, team.rerolls ?? 0), fanFactor: Math.max(0, team.fans ?? 1), apothecary: team.apothecary,
    },
  };
}

/**
 * Once a Super FUMBBL game has started for a fixture (a coach took a launch file, or the fork runs it), the league
 * rosters of both its teams are locked until the result is in: the result is applied to the roster the fork played
 * with. "" = not locked, else the reason.
 */
export function forkPlayLock(season: { fixtures: Array<{ home: { team: string; teamId?: string }; away: { team: string; teamId?: string }; fork?: { status: string; launched?: object; teams: Partial<Record<"home" | "away", { teamId: string }>> } }> }, teamId: string): string {
  for (const f of season.fixtures) {
    const fork = f.fork;
    if (!fork) continue;
    const started = fork.status === "in_progress" || (fork.status === "scheduled" && Boolean(fork.launched && Object.keys(fork.launched).length));
    if (!started) continue;
    if (fork.teams.home?.teamId === teamId || fork.teams.away?.teamId === teamId)
      return `This team is playing a Super FUMBBL game (${f.home.team} vs ${f.away.team}); its league roster is locked until the result is in.`;
  }
  return "";
}
