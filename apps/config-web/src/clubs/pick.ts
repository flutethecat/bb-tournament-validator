// The club pick at join (owner 11-02, round 3): at each league / ladder / tournament join a coach picks which of their clubs
// they represent, or none. The choice is stored on the entry (tournament entrant clubId, league registration row clubId) and
// is fixed once the entry has been accepted: that competition's results count for that club. Players are not required to
// join as a club.
//
// A hook, so the registration routes stay unaware of the clubs store: server.ts installs the directory at start
// (setClubDirectory); without one (unit tests of the registration routes, a host without clubs) a pick is refused and no
// pick means "no club".

import { clubCoachKey } from "./types.js";

export interface ClubDirectory {
  /** The clubs the coach is a member of now (not archived). */
  membershipsOf(coach: string): Array<{ id: string; name: string }>;
  /** A club's name by id (any club, archived included), for organiser views. */
  nameOf(id: string): string | undefined;
}

let directory: ClubDirectory | undefined;

export function setClubDirectory(d: ClubDirectory | undefined): void {
  directory = d;
}

export function clubDirectory(): ClubDirectory | undefined {
  return directory;
}

export type ClubPick =
  | { ok: true; clubId?: string }
  | { ok: false; status: number; error: string; code: "club" | "club-fixed" };

/** An entry the coach already has in this competition: its stored club and whether it was ever accepted. */
export interface PriorEntry {
  clubId?: string | null;
  everAccepted: boolean;
}

/** Was this entry ever accepted: its state now, any transition into OR out of accepted (a legacy entry's log can start
 *  after its acceptance), or a sign the caller knows (a tournament entry in the field, a league row that made its team). */
export function everAccepted(state: string | undefined, log: ReadonlyArray<{ to?: string; from?: string | null }> | undefined, accepted = false): boolean {
  return accepted || state === "accepted" || (log ?? []).some((t) => t?.to === "accepted" || t?.from === "accepted");
}

/**
 * The club an entry carries, from the request's `clubId` (absent, null or "" = none). The club must be one the coach is a
 * member of now. Once an entry was accepted its club is fixed: a re-entry keeps it, and asking for a different one is
 * refused (409 club-fixed).
 */
export function resolveClubPick(coach: string, raw: unknown, prior?: PriorEntry): ClubPick {
  const asked = raw === undefined || raw === null || raw === "" ? undefined : raw;
  if (asked !== undefined && typeof asked !== "string") return { ok: false, status: 400, error: "clubId must be a club id or empty.", code: "club" };
  const fixed = prior?.everAccepted === true;
  const stored = prior?.clubId ? prior.clubId : undefined;
  if (fixed) {
    if (raw !== undefined && (asked ?? undefined) !== stored) {
      const name = stored ? directory?.nameOf(stored) ?? "your club" : "no club";
      return { ok: false, status: 409, error: `Your club for this competition is fixed (${name}).`, code: "club-fixed" };
    }
    return { ok: true, ...(stored ? { clubId: stored } : {}) };
  }
  if (asked === undefined) return { ok: true };
  const id = asked.trim();
  const mine = directory?.membershipsOf(coach) ?? [];
  if (!mine.some((c) => c.id === id)) return { ok: false, status: 400, error: "Pick one of your clubs, or No club.", code: "club" };
  return { ok: true, clubId: id };
}

/** The club an entry shows to organisers: { clubId, clubName } or nothing. */
export function clubLabel(clubId: string | null | undefined): { clubId: string; clubName: string } | Record<string, never> {
  if (!clubId) return {};
  return { clubId, clubName: directory?.nameOf(clubId) ?? "Club" };
}

/** True when `coach` (identity key) is a member of club `id` now. */
export function isClubMember(coach: string, id: string): boolean {
  const k = clubCoachKey(coach);
  return Boolean(k) && (directory?.membershipsOf(coach) ?? []).some((c) => c.id === id);
}

/** The coach's newest league registration row in a season or ladder, as a prior entry (its club and whether it was ever
 *  accepted), or undefined. */
export function priorClubEntry(
  rows: ReadonlyArray<{ coach: string; clubId?: string; state: string; enteredAt?: string; teamId?: string; registrationLog?: ReadonlyArray<{ to?: string; from?: string | null }> }> | undefined,
  coach: string,
): PriorEntry | undefined {
  const k = clubCoachKey(coach);
  const mine = (rows ?? []).filter((r) => clubCoachKey(r.coach) === k).sort((a, b) => (b.enteredAt ?? "").localeCompare(a.enteredAt ?? ""));
  if (!mine.length) return undefined;
  // Any of the coach's rows that was accepted fixes the club (the core keys entries by coach: normally one row).
  // A row that made its league team was accepted (the team id stays after a removal).
  const accepted = mine.find((r) => everAccepted(r.state, r.registrationLog, Boolean(r.teamId)));
  const row = accepted ?? mine[0]!;
  return { clubId: row.clubId ?? null, everAccepted: Boolean(accepted) };
}
