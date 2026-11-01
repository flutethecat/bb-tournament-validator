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
 * Choice (the rules page is silent): a new captain who ALREADY owns Pro gains only the trait, never a second Pro. The
 * trait is appended AFTER the owned Pro, so splitCaptainGrants (the free Pro = the first Pro after the trait) keeps the
 * owned Pro an earned, valued skill.
 */
import { normName, TEAM_CAPTAIN, TEAM_CAPTAIN_FREE_SKILL } from "@bb/validator";

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

/**
 * The vacancy after a roster change: `true` when the roster before had a captain and the roster after has none (the
 * captain died, defected, was fired / retired, or was not re-hired at a redraft); `false` when the roster after has a
 * captain (an appointment, or the captain came back); otherwise the prior vacancy stands.
 */
export function nextCaptainVacancy(
  before: ReadonlyArray<{ skills: readonly string[] }> | undefined,
  after: ReadonlyArray<{ skills: readonly string[] }>,
  priorVacant: boolean,
): boolean {
  if (after.some((p) => hasTeamCaptain(p.skills))) return false;
  if (before?.some((p) => hasTeamCaptain(p.skills))) return true;
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

/**
 * Library team XML: the captaincy is vacant when a departed player (a <firedPlayer>: fired / retired through team
 * management, or a dead <player>) carries the trait and no player still on the roster does. Derived from the stored
 * file on every read, so every path that removes the captain (team management, the fork's result banking) counts.
 */
export function xmlCaptainVacant(teamXml: string): boolean {
  const players = [...teamXml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)].map((m) => m[0]!);
  const roster = players.filter((b) => !deadStatus(statusOf(b)) && !/journeyman/i.test(statusOf(b)));
  if (roster.some((b) => hasTeamCaptain(blockSkills(b)))) return false;
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
  const players = [...teamXml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)].map((m) => m[0]!);
  if (players.some((b) => !deadStatus(statusOf(b)) && hasTeamCaptain(blockSkills(b)))) return teamXml;
  return setXmlCaptainVacantMark(teamXml, true);
}
