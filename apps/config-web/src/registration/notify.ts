// Registration notifications (registration spec §8.3; laws §E 23c, 24): who hears about which transition, and the words.
// Rows go into the existing notification store (src/notifications.ts) through a fire-and-forget sink. `action: true`
// marks the rows that need the recipient to act; only those DM (src/mail/actionMessages.ts ACTION_DM_WHEN_FLAGGED):
// coach outcomes accepted / declined / promoted, and organiser rows when approval is needed (Q18).
//
// Every registration notifies the organisers except the actor (law 24). Texts never mention the game server (law 23b)
// and never say anything about a coach's email (law 22).

import type { NotificationInput } from "../notifications.js";
import type { CompetitionSnapshot, RegistrationEntry } from "./types.js";

/** Stores one row for one coach. Must not throw (the core also guards it). */
export type RegistrationNotifySink = (coach: string, input: NotificationInput) => void;

export type CoachOutcome = "accepted" | "pending" | "waitlisted" | "declined" | "promoted" | "removed";

const key = (coach: string) => coach.trim().toLowerCase();

export interface NotifyContext {
  competition: CompetitionSnapshot;
  link: (audience: "coach" | "organiser") => string;
  send: RegistrationNotifySink;
}

/** The coach's own outcome. Accepted, declined and promoted are actionable (DM); pending, waitlisted and removed are not. */
export function notifyCoachOutcome(ctx: NotifyContext, entry: RegistrationEntry, outcome: CoachOutcome, extra: { position?: number; reason?: string } = {}): void {
  const name = ctx.competition.name;
  const reason = extra.reason?.trim();
  const text: Record<CoachOutcome, { title: string; body: string }> = {
    accepted: { title: `You're in: ${name}`, body: "Your entry was accepted." },
    pending: { title: `Entry received: ${name}`, body: "The organisers review every entry. You'll hear when they decide." },
    waitlisted: {
      title: `On the waitlist: ${name}`,
      body: extra.position ? `It's full, so you're #${extra.position} on the waitlist. You'll hear if a place opens.` : "You're on the waitlist. You'll hear if a place opens.",
    },
    declined: { title: `Entry declined: ${name}`, body: reason ? `The organisers declined your entry: ${reason}` : "The organisers declined your entry." },
    promoted: { title: `You're in: ${name}`, body: "A place opened and your entry moved off the waitlist." },
    removed: { title: `Entry removed: ${name}`, body: reason ? `The organisers removed your entry: ${reason}` : "The organisers removed your entry." },
  };
  const action = outcome === "accepted" || outcome === "declined" || outcome === "promoted";
  ctx.send(entry.coach, {
    type: "registration-outcome",
    ...text[outcome],
    link: ctx.link("coach"),
    subject: name,
    ...(action ? { action: true } : {}),
  });
}

/** Every manager except the actor. */
function toManagers(ctx: NotifyContext, actor: string, input: NotificationInput): void {
  const seen = new Set<string>();
  for (const m of ctx.competition.managers) {
    const k = key(m);
    if (!k || seen.has(k) || k === key(actor)) continue;
    seen.add(k);
    ctx.send(m, input);
  }
}

/** A new (or renewed) registration: organisers except the actor (law 24). Actionable only when it waits for them. */
export function notifyOrganisersOfRegistration(ctx: NotifyContext, entry: RegistrationEntry, actor: string, extra: { position?: number } = {}): void {
  const name = ctx.competition.name;
  const tail: Partial<Record<RegistrationEntry["state"], string>> = {
    pending: "Accept, waitlist or decline the entry.",
    waitlisted: extra.position ? `It's full, so they're #${extra.position} on the waitlist.` : "It's full, so they're on the waitlist.",
    accepted: "They're in.",
  };
  const byOrganiser = key(actor) !== key(entry.coach);
  toManagers(ctx, actor, {
    type: "registration",
    title: `${entry.coach} registered for ${name}`,
    body: `${byOrganiser ? `${actor} entered ${entry.coach}. ` : ""}${tail[entry.state] ?? ""}`.trim(),
    link: ctx.link("organiser"),
    from: actor,
    subject: name,
    ...(entry.state === "pending" ? { action: true } : {}),
  });
}

/** A place freed while coaches wait and the organisers decide (organiser mode): actionable. */
export function notifyPlaceFreed(ctx: NotifyContext, actor: string, waiting: number): void {
  const name = ctx.competition.name;
  toManagers(ctx, actor, {
    type: "registration",
    title: `A place opened in ${name}`,
    body: `${waiting} ${waiting === 1 ? "coach is" : "coaches are"} on the waitlist. Promote the next in line, or leave the place open.`,
    link: ctx.link("organiser"),
    subject: name,
    action: true,
  });
}

/** The coach withdrew: organisers except the coach (existing `withdrawal` type, never a DM). */
export function notifyWithdrawal(ctx: NotifyContext, entry: RegistrationEntry, actor: string): void {
  toManagers(ctx, actor, {
    type: "withdrawal",
    title: `${entry.coach} withdrew from ${ctx.competition.name}`,
    body: key(actor) === key(entry.coach) ? "The coach withdrew their entry." : `${actor} withdrew the entry.`,
    link: ctx.link("organiser"),
    from: actor,
    subject: ctx.competition.name,
  });
}

/** Check-in opened: every accepted entrant (no DM in this lane; Q18 lists outcome DMs only). */
export function notifyCheckInOpen(ctx: NotifyContext, entries: readonly RegistrationEntry[], closesAt?: string): number {
  let sent = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.state !== "accepted" || seen.has(key(e.coach))) continue;
    seen.add(key(e.coach));
    ctx.send(e.coach, {
      type: "check-in",
      title: `Check-in is open: ${ctx.competition.name}`,
      body: closesAt ? `Check in before ${closesAt.slice(0, 16).replace("T", " ")} UTC.` : "Check in before play starts.",
      link: ctx.link("coach"),
      subject: ctx.competition.name,
    });
    sent += 1;
  }
  return sent;
}
