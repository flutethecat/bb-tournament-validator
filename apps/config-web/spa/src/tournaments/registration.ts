// Tournament registration in the SPA (registration spec 2026-11-02 §7, wizards v2; lane L4): the register sheet's team
// choices and request body, the words for an entry's state, places, approval, check-in and the roster deadline. Pure, no
// DOM; the server stays the authority for every rule (window, cap, waitlist, NAF, region, roster deadline).

import type {
  BuilderSaveSummary, EntryState, TournamentCheckIn, TournamentEntrant, TournamentMyRegistration,
  TournamentRegistrationStatus,
} from "../shared/api";
import type { ShareField } from "../account/sharing";

export interface TeamChoice {
  /** "save:<id>" (a saved team) or "later" (register now, roster later). */
  ref: string;
  kind: "save" | "later";
  label: string;
  sub: string;
}

/** The register sheet's team step: the coach's saved teams (Roster Builder saves) for this ruleset, then "Roster later"
 *  when the organiser allows it. Fork library teams are never offered (owner 11-03: teams made in the League Manager are
 *  saved teams; one is a library team only briefly while a "Play on Super FUMBBL" match is declared). */
export function registerChoices(
  saves: readonly BuilderSaveSummary[],
  packageName: string,
  status: Pick<TournamentRegistrationStatus, "rosterLater" | "rosterBy"> | null | undefined,
): TeamChoice[] {
  const pkg = packageName.trim().toLowerCase();
  const forThis = saves.filter((s) => (s.packageName ?? "").trim().toLowerCase() === pkg);
  const out: TeamChoice[] = [
    ...forThis
      .map((s) => ({ ref: `save:${s.id}`, kind: "save" as const, label: s.name, sub: s.raceName ? `${s.raceName} · Saved team` : "Saved team" })),
  ];
  if (status?.rosterLater) {
    out.push({ ref: "later", kind: "later", label: "Roster later", sub: status.rosterBy ? `Submit your roster by ${utcLabel(status.rosterBy)}` : "Submit your roster before the event" });
  }
  return out;
}

export interface RegisterDraft {
  teamRef: string;
  region: string;
  share: ShareField[];
  notNafMember: boolean;
}

/** POST /api/tournaments/:id/entrants: the team (or rosterLater), the share picker (always sent, [] = nothing), the region
 *  when there are regions, notNafMember only when ticked. NAF details are never typed per entry (owner 10-31). */
export function registerBody(draft: RegisterDraft, hasRegions: boolean) {
  return {
    ...(draft.teamRef === "later" ? { rosterLater: true } : { teamRef: draft.teamRef }),
    share: draft.share,
    ...(hasRegions && draft.region ? { region: draft.region } : {}),
    ...(draft.notNafMember ? { notNafMember: true } : {}),
  };
}

export const STATE_LABEL: Record<EntryState, string> = {
  pending: "Pending", accepted: "Accepted", waitlisted: "Waitlist", declined: "Declined", withdrawn: "Withdrawn", dropped: "Removed",
};
export const STATE_TONE: Record<EntryState, string> = {
  pending: "soon", accepted: "ok", waitlisted: "soon", declined: "urgent", withdrawn: "muted", dropped: "muted",
};

/** The chip on the coach's entry: "PENDING", "WAITLIST #2", "ACCEPTED"... */
export function stateChip(reg: Pick<TournamentMyRegistration, "state" | "position">): string {
  return reg.state === "waitlisted" && reg.position ? `Waitlist #${reg.position}` : STATE_LABEL[reg.state];
}

/** A live entry (the coach is in, or waiting for a decision or a place). */
export const isLive = (state: EntryState | undefined): boolean => state === "pending" || state === "waitlisted" || state === "accepted";

/** The approval mode in plain words (Confirm step). */
export function approvalWords(status: Pick<TournamentRegistrationStatus, "approval"> | null | undefined): string {
  return status?.approval === "organiser" ? "The organisers review every entry. You'll hear when they decide." : "Entries are accepted straight away while there are places.";
}

/** What submitting now would give: in, pending, the waitlist, or refused (full, no waitlist). */
export function expectedOutcome(status: TournamentRegistrationStatus | null | undefined): "accepted" | "pending" | "waitlisted" | "full" {
  if (status?.approval === "organiser") return "pending";
  if (status && status.placesLeft !== null && status.placesLeft <= 0) return status.waitlist ? "waitlisted" : "full";
  return "accepted";
}

/** "4 of 16 places left", "Full", "No place limit". */
export function placesLine(status: TournamentRegistrationStatus | null | undefined): string {
  if (!status || status.cap === null || status.placesLeft === null) return "No place limit";
  if (status.placesLeft <= 0) return status.waitlist ? "Full: new entries join the waitlist" : "Full";
  return `${status.placesLeft} of ${status.cap} ${status.cap === 1 ? "place" : "places"} left`;
}

/** "05 Dec 2026, 09:00 UTC" (every time on these pages is UTC, like the forms). */
export function utcLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** The Check in bar shows for an accepted coach while self check-in is open (and until they did). */
export function checkInDue(ci: TournamentCheckIn | null | undefined, mine: Pick<TournamentEntrant, "flags"> | null | undefined, accepted: boolean): boolean {
  return Boolean(ci?.open && ci.self && accepted && mine && !mine.flags?.checkedIn);
}

/** "Check-in closes 05 Dec 2026, 09:00 UTC" / "Check-in opens ..." / "". */
export function checkInLine(ci: TournamentCheckIn | null | undefined): string {
  if (!ci) return "";
  if (ci.open) return ci.closesAt ? `Check-in closes ${utcLabel(ci.closesAt)}` : "Check-in is open";
  if (ci.closed) return "Check-in is closed";
  return `Check-in opens ${utcLabel(ci.opensAt)}`;
}

/** "Roster due by ..." for an entry without a roster under "roster later"; "" otherwise. */
export function rosterDueLine(t: { registration?: { rosterLater: boolean; rosterBy?: string } }, entry: Pick<TournamentEntrant, "submission" | "teamId">, now = Date.now()): string {
  if (entry.submission || entry.teamId) return "";
  const by = t.registration?.rosterLater ? t.registration.rosterBy : undefined;
  if (!by) return "No roster yet. Submit one before the event.";
  return Date.parse(by) <= now ? "The roster deadline has passed." : `Roster due by ${utcLabel(by)}`;
}

/** No roster at or after the roster deadline: the Participants "No roster" chip (nothing is dropped automatically). */
export function noRosterLate(t: { registration?: { rosterLater: boolean; rosterBy?: string } }, entry: Pick<TournamentEntrant, "submission" | "teamId">, now = Date.now()): boolean {
  const by = t.registration?.rosterLater ? t.registration.rosterBy : undefined;
  return !entry.submission && !entry.teamId && by !== undefined && Date.parse(by) <= now;
}

/** "Coach says paid 03 Nov 2026, 10:00 UTC" for the organisers, next to the Paid toggle. */
export function coachSaysPaidLine(e: Pick<TournamentEntrant, "coachSaysPaid" | "flags">): string {
  if (!e.coachSaysPaid || e.flags?.paid) return "";
  return `Coach says paid ${utcLabel(e.coachSaysPaid.at)}`;
}

export type RegistrationSettings = NonNullable<import("../shared/api").TournamentSummary["registration"]>;

/** A tournament's registration settings as stored, or what a tournament without any behaves as (spec §8.1: accepted
 *  while there is room, no waitlist, a team at registration, no self check-in). */
export function currentSettings(t: { registration?: RegistrationSettings }): RegistrationSettings {
  const r = t.registration;
  return r
    ? { ...r, checkIn: { ...r.checkIn } }
    : { approval: "auto", waitlist: false, rosterLater: false, checkIn: { self: false } };
}

/** The settings with one change, ready for PATCH { registration } (the server replaces the object as a whole). */
export function changedSettings(t: { registration?: RegistrationSettings }, change: Partial<Omit<RegistrationSettings, "checkIn">> & { selfCheckIn?: boolean }): RegistrationSettings {
  const base = currentSettings(t);
  const { selfCheckIn, ...rest } = change;
  const out: RegistrationSettings = { ...base, ...rest, checkIn: { ...base.checkIn, ...(selfCheckIn === undefined ? {} : { self: selfCheckIn }) } };
  if (!out.rosterLater) delete out.rosterBy;
  return out;
}

/** "12 / 16 places · 3 pending · 2 waiting" for the Registrations band caption. */
export function registrationsCaption(c: { accepted: number; pending: number; waitlisted: number; cap: number | null }): string {
  return [
    c.cap === null ? `${c.accepted} in` : `${c.accepted} / ${c.cap} places`,
    ...(c.pending ? [`${c.pending} pending`] : []),
    ...(c.waitlisted ? [`${c.waitlisted} waiting`] : []),
  ].join(" · ");
}
