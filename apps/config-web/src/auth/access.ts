import { isOrganizer as isLegacyOrganizer } from "./organizers.js";
import { normalizeForkName, readIdentities, type CoachIdentityRecord, type CoachLevel } from "./identitiesStore.js";

export const BANNED_ACCOUNT_MESSAGE = "This account is banned from Super FUMBBL. Contact an organizer.";

function recordFor(coach: string): CoachIdentityRecord | undefined {
  return readIdentities().coaches[normalizeForkName(coach)];
}

export function isBanned(coach: string): boolean {
  return recordFor(coach)?.banned === true;
}

export function isSilenced(coach: string): boolean {
  return recordFor(coach)?.silenced === true;
}

export function coachLevel(coach: string): CoachLevel {
  const record = recordFor(coach);
  if (record?.banned === true) return "player";
  const level = record?.level;
  if (level === "admin" || level === "organizer") return level;
  return isLegacyOrganizer(coach) ? "organizer" : "player";
}

export function isAdmin(coach: string): boolean {
  return coachLevel(coach) === "admin";
}

export function isOrganizer(coach: string): boolean {
  return coachLevel(coach) !== "player";
}
