/**
 * Play on Super FUMBBL: the fork team file for one league team (pure; forkPlay.ts writes it through the fork client).
 *
 * The league roster is the record: every player is written as the league has them now (characteristics after
 * injuries and increases, the skills the position does not print, spendable SPP, niggling injuries, a missed next
 * game as a recovering "Seriously Hurt (MNG)" injury so the server keeps the player out of this game), staff,
 * treasury and dedicated fans. The header and the roster's special rules come from the Team Builder composer
 * (composeTeam with no picks), so the file is the same dialect the fork already loads for builder teams.
 *
 * One fork team per league / season / team (forkTeamIdFor); its player ids are derived from the league playerId, so
 * the result of the game maps back to the league players (FixtureForkTeam.players).
 */
import { createHash } from "node:crypto";
import { composeTeam, normName, parseForkRoster, type ForkRoster, type ForkRosterPosition } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import type { FixtureForkTeam, LeaguePlayer, LeagueTeam } from "./types.js";

export class ForkTeamBuildError extends Error {}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The fork team id of a league team in one season: stable, file-name safe, never a builder (tb_) id. */
export const forkTeamIdFor = (leagueId: string, seasonId: string, teamId: string): string => `lg_${sha(`${leagueId}\0${seasonId}\0${teamId}`).slice(0, 16)}`;

/** The fork player id of a league player on that team. */
export const forkPlayerIdFor = (forkTeamId: string, playerId: string): string => `${forkTeamId}_${sha(playerId).slice(0, 10)}`;

/** The fork roster for a league race: same race name (case and spacing tolerant), a `.bb2025` roster id preferred. */
export function forkRosterFor(race: string, rosters: ReadonlyMap<string, string>): { rosterXml: string; roster: ForkRoster } | undefined {
  const want = normName(race);
  let best: { rosterXml: string; roster: ForkRoster } | undefined;
  for (const [, xml] of rosters) {
    let roster: ForkRoster;
    try { roster = parseForkRoster(xml); } catch { continue; }
    if (normName(roster.raceName) !== want) continue;
    if (!best || (/\.bb2025$/i.test(roster.rosterId) && !/\.bb2025$/i.test(best.roster.rosterId))) best = { rosterXml: xml, roster };
  }
  return best;
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
}

function playerXml(p: LeaguePlayer, pos: ForkRosterPosition, nr: number, id: string): string {
  const label = p.name || `${p.position} #${nr}`;
  const printed = new Set((pos.skills ?? []).map(skillBase));
  const extra = p.skills.filter((s) => s.trim() && !isStatIncrease(s) && !printed.has(skillBase(s)));
  const stats: Array<[string, number | null, number | undefined]> = [
    ["movement", p.ma, pos.MA], ["strength", p.st, pos.ST], ["agility", p.ag, pos.AG], ["passing", p.pa, pos.PA], ["armour", p.av, pos.AV],
  ];
  const statXml = stats.filter(([, v, base]) => typeof v === "number" && v !== base).map(([tag, v]) => `<${tag}>${v}</${tag}>`).join("");
  const injuries = [
    ...Array.from({ length: Math.max(0, p.niggling | 0) }, () => "<injury>Serious Injury (NI)</injury>"),
    ...(p.missNextGame ? ['<injury recovering="true">Seriously Hurt (MNG)</injury>'] : []),
  ];
  const spp = Math.max(0, Math.trunc(p.availableSpp || 0));
  return `\t<player nr="${nr}" id="${xmlEscape(id)}"><name>${xmlEscape(label)}</name>` +
    `<gender>${xmlEscape(pos.gender)}</gender><positionId>${xmlEscape(pos.positionId)}</positionId>` +
    `${statXml}<playerStatistics currentSpps="${spp}"></playerStatistics>` +
    `<skillList>${extra.map((s) => skillXml(s, label)).join("")}</skillList>` +
    (injuries.length ? `<injuryList>${injuries.join("")}</injuryList>` : "<injuryList/>") + "</player>";
}

const setTag = (xml: string, tag: string, value: string | number): string => xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`);

/** Builds the fork team file for a league team. Throws ForkTeamBuildError with a coach-readable reason. */
export function buildLeagueForkTeam(input: LeagueForkTeamInput): LeagueForkTeamFile {
  const { team } = input;
  if (!team.players.length) throw new ForkTeamBuildError(`${team.name} has no players on its league roster.`);
  const found = forkRosterFor(team.race, input.rosters);
  if (!found) throw new ForkTeamBuildError(`Super FUMBBL has no ${team.race} roster.`);
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
    blocks.push(playerXml(p, pos, nr, id));
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
    forkTeamId, xml, rosterId: roster.rosterId, raceName: roster.raceName, players,
    library: {
      teamName: team.name, race: roster.raceName, teamValueK: Math.round((team.teamValue ?? 0) / 1000), treasury,
      rerolls: Math.max(0, team.rerolls ?? 0), fanFactor: Math.max(0, team.fans ?? 1), apothecary: team.apothecary,
    },
  };
}
