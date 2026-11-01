/**
 * Team Captain replacement in league play (owner ruling 10-30, spec-main-landing-nav-2026-10-29 §8; rules anchor
 * https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain): when the Team Captain is killed or otherwise
 * leaves the roster, the coach appoints a new one. Same eligibility as the draft-time nomination (a roster player, not
 * a Big Guy, not a Star); the new captain gains the Team Captain trait and Pro "without increasing their cost"; the old
 * captain's trait and Pro stay on the departed player's record.
 *
 * Pure helpers shared by the three team stores (league seasons: leagues/captain.ts; fork library team XML:
 * teamMutation.ts appointCaptain + teamManageView.ts; tabletop team files: tabletop/postMatch.ts). No I/O.
 *
 * Choice (the rules page is silent): a new captain who ALREADY owns Pro gains only the trait, never a second Pro. Which
 * skills the captaincy granted free is RECORDED on the player (league: LeaguePlayer.captainGrants; library XML: a
 * <captainGrants> element), never inferred from list order. Records without it keep the old reading
 * (withoutCaptainGrants: the trait and one Pro).
 *
 * Vacancy follows the captain's PLAYER ID leaving the roster (died, defected, fired / retired, not re-hired); missing
 * skill data on a re-import never implies a departure, and an existing vacancy carries over until a roster player
 * carries the trait again.
 */
import { normName, TEAM_CAPTAIN, TEAM_CAPTAIN_FREE_SKILL, withoutCaptainGrants } from "@bb/validator";

const isTrait = (s: string): boolean => normName(s) === normName(TEAM_CAPTAIN);
const isPro = (s: string): boolean => normName(s) === normName(TEAM_CAPTAIN_FREE_SKILL);

/** Does this skill list carry the Team Captain trait? */
export const hasTeamCaptain = (skills: readonly string[] | undefined): boolean => (skills ?? []).some(isTrait);

/** The skills a newly appointed captain gains: the trait, and Pro unless the player already has it. */
export function captainGrantsFor(skills: readonly string[]): string[] {
  return [TEAM_CAPTAIN, ...(skills.some(isPro) ? [] : [TEAM_CAPTAIN_FREE_SKILL])];
}

/** The player's skill list after the appointment (the grants appended, in the order every writer lists them). */
export function appointedSkills(skills: readonly string[]): string[] {
  return hasTeamCaptain(skills) ? [...skills] : [...skills, ...captainGrantsFor(skills)];
}

/** Why a player cannot be appointed ("" = eligible). Client-safe text. */
export function captainIneligibility(p: { star?: boolean; bigGuy?: boolean; positionKnown?: boolean; name?: string }): string {
  const who = p.name?.trim() || "This player";
  if (p.star) return "A Star Player cannot be Team Captain.";
  if (p.positionKnown === false) return `${who}'s position could not be checked, so they cannot be appointed.`;
  if (p.bigGuy) return "A Big Guy cannot be Team Captain.";
  return "";
}

/** A skill list without the captaincy's free grants: the recorded ones when known, else the trait and one Pro. */
export function withoutRecordedCaptainGrants(skills: readonly string[], grants: readonly string[] | undefined): string[] {
  if (!grants) return withoutCaptainGrants(skills);
  const left = grants.map(normName);
  const out: string[] = [];
  // Remove from the END: the grants are appended after anything the player already owned.
  for (let i = skills.length - 1; i >= 0; i -= 1) {
    const at = left.indexOf(normName(skills[i]!));
    if (at >= 0) left.splice(at, 1);
    else out.unshift(skills[i]!);
  }
  return out;
}

export interface CaptainVacancyPlayer {
  /** Every id this player is known by (league: playerId plus previousIds, so a redraft's fresh id still matches). */
  ids: readonly string[];
  skills: readonly string[];
}

/**
 * The vacancy after a roster change: `false` when a player on the roster after carries the trait; `true` when a captain
 * of the roster before is no longer on the roster after (by id); otherwise the prior vacancy stands.
 */
export function nextCaptainVacancy(
  before: ReadonlyArray<CaptainVacancyPlayer> | undefined,
  after: ReadonlyArray<CaptainVacancyPlayer>,
  priorVacant: boolean,
): boolean {
  if (after.some((p) => hasTeamCaptain(p.skills))) return false;
  const present = new Set(after.flatMap((p) => p.ids));
  if (before?.some((p) => hasTeamCaptain(p.skills) && !p.ids.some((id) => present.has(id)))) return true;
  return priorVacant;
}

// ---- fork library team XML (teamMutation.ts appointCaptain, teamDetail.ts) ----

const decodeXml = (value: string): string =>
  value.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const teamOpening = (xml: string): string => xml.match(/<team\b[^>]*>/i)?.[0] ?? "";
/** The skills listed in one stored player block (in order). */
export const blockSkills = (block: string): string[] => [...block.matchAll(/<skill\b[^>]*>([^<]*)<\/skill>/gi)].map((m) => decodeXml(m[1]!).trim()).filter(Boolean);
const statusOf = (block: string): string => decodeXml(block.match(/<(?:fired)?player\b[^>]*\bstatus="([^"]*)"/i)?.[1] ?? "");
/** A stored player who is off the roster for good: a dead player left in the team file (the fork's own banking). */
const deadStatus = (status: string): boolean => /\b(?:dead|rip|deceased)\b/i.test(status);
const rosterBlock = (b: string): boolean => !deadStatus(statusOf(b)) && !/journeyman/i.test(statusOf(b));
const playerBlocks = (xml: string): string[] => [...xml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)].map((m) => m[0]!);

/** Does a player on the library roster (not dead, not a journeyman, not fired) carry the trait? */
export function xmlRosterHasCaptain(teamXml: string): boolean {
  return playerBlocks(teamXml).some((b) => rosterBlock(b) && hasTeamCaptain(blockSkills(b)));
}

/** The captaincy's recorded free grants on a player block (<captainGrants>Team Captain|Pro</captainGrants>), if recorded. */
export function blockCaptainGrants(block: string): string[] | undefined {
  const raw = block.match(/<captainGrants\b[^>]*>([^<]*)<\/captainGrants>/i)?.[1];
  return raw === undefined ? undefined : decodeXml(raw).split("|").map((s) => s.trim()).filter(Boolean);
}

/** The <captainGrants> element an appointment writes into the player block (an unknown tag the Java team parser skips, like <pendingAdvancement>). */
export const captainGrantsNode = (grants: readonly string[]): string =>
  `<captainGrants>${grants.map((g) => g.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("|")}</captainGrants>`;

/**
 * Library team XML: the captaincy is vacant when a departed player (a <firedPlayer>: fired / retired through team
 * management, or a dead <player>) carries the trait and no player still on the roster does. Derived from the stored
 * file on every read, so every path that removes the captain (team management, the fork's result banking) counts.
 */
export function xmlCaptainVacant(teamXml: string): boolean {
  const players = playerBlocks(teamXml);
  if (xmlRosterHasCaptain(teamXml)) return false;
  // Result banking deletes a dead player's block, so it leaves this mark on <team> (markXmlCaptainVacant).
  if (/^true$/i.test(teamOpening(teamXml).match(/\bcaptainVacant="([^"]*)"/i)?.[1] ?? "")) return true;
  const departed = [...players.filter((b) => deadStatus(statusOf(b))), ...[...teamXml.matchAll(/<firedPlayer\b[^>]*>[\s\S]*?<\/firedPlayer>/gi)].map((m) => m[0]!)];
  return departed.some((b) => hasTeamCaptain(blockSkills(b)));
}

/** Leaves (or removes) the `captainVacant="true"` mark on the team's opening tag. The Java team parser ignores it. */
export function setXmlCaptainVacantMark(teamXml: string, vacant: boolean): string {
  const opening = teamOpening(teamXml);
  if (!opening) return teamXml;
  const bare = opening.replace(/\s+captainVacant="[^"]*"/i, "");
  const next = vacant ? bare.replace(/^<team\b/i, '<team captainVacant="true"') : bare;
  return next === opening ? teamXml : teamXml.replace(opening, next);
}

/** After a roster write that removed `removedBlocks`: marks the team vacant when one carried the trait and no player left does. */
export function markXmlCaptainVacant(teamXml: string, removedBlocks: readonly string[]): string {
  if (!removedBlocks.some((b) => hasTeamCaptain(blockSkills(b)))) return teamXml;
  if (xmlRosterHasCaptain(teamXml)) return teamXml;
  return setXmlCaptainVacantMark(teamXml, true);
}
