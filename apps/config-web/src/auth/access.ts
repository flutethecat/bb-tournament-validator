import { normalizeFfbCoachId, readIdentities, type CoachIdentityRecord, type CoachLevel } from "./identitiesStore.js";

export const BANNED_ACCOUNT_MESSAGE = "This account is banned from Super FUMBBL. Contact an organizer.";

function recordFor(coach: string): CoachIdentityRecord | undefined {
  return readIdentities().coaches[normalizeFfbCoachId(coach)];
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
  // Identity levels only: organizers.json was imported once at startup and is no longer read (src/auth/organizers.ts).
  return level === "admin" || level === "organizer" ? level : "player";
}

export function isAdmin(coach: string): boolean {
  return coachLevel(coach) === "admin";
}

export function isOrganizer(coach: string): boolean {
  return coachLevel(coach) !== "player";
}
