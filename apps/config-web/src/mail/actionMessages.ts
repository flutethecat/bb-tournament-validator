// Actionable notifications that also go out as a Discord DM from the bot (owner 11-01, laws §E 23c): which notification
// types DM, and the short plain text each sends. One row per type; a type without a row never DMs. Add a row (and a test)
// to turn another type on: candidates are fixture lobby ready, naf-request, share-request and friend-request.
//
// `subject` is the short name of the thing (a fixture label such as "Round 2 vs Orcs · Spring League"), passed by the
// emitter on NotificationInput.subject (never stored); `url` is the notification's absolute link.
//
// Names are user text (coach, team, competition names): in the Discord text every Markdown character is escaped and any
// URL in a name is broken up, so the action link is the only link in the message (no masked-link phishing).

import type { NotificationRecord, NotificationType } from "../notifications.js";
import { starProfanity } from "../discord/profanity.js";
import { oneLine } from "./templates.js";

export interface ActionMessageInput {
  record: Pick<NotificationRecord, "type" | "from" | "title" | "link">;
  subject?: string;
  /** NotificationInput.action: the row needs the recipient to act (gates the ACTION_DM_WHEN_FLAGGED types). */
  action?: boolean;
  url: string;
}

/** `title` is the notification's own title (Discord-escaped like the names). */
export type ActionMessageBuilder = (m: { from: string; subject: string; url: string; title: string }) => string;

/** Notification type -> DM text. The game-time proposal types, the registration rows of registration spec Q18, and organiser requests. */
export const ACTION_DM: Partial<Record<NotificationType, ActionMessageBuilder>> = {
  "proposal-received": ({ from, subject, url }) => `${from} proposed times for ${subject}. Accept or decline: ${url}`,
  "proposal-countered": ({ from, subject, url }) => `${from} suggested other times for ${subject}. Accept or decline: ${url}`,
  "proposal-accepted": ({ from, subject, url }) => `${from} accepted a time for ${subject}. See it on your schedule: ${url}`,
  // Registration core (src/registration/notify.ts): the coach's accepted / declined / promoted outcome, and the
  // organisers' registrations that wait for their decision (approval mode, or a place freed with a waitlist).
  "registration-outcome": ({ title, url }) => `${title}. See your entry: ${url}`,
  registration: ({ title, url }) => `${title}. Review registrations: ${url}`,
  // Check-in opened for an accepted entrant (spec §7 / §8.3; once per entry per window, src/registration/service.ts).
  "check-in": ({ subject, url }) => `Check-in is open for ${subject}. Check in here: ${url}`,
  // Organiser requests (registration spec 2026-11-02 §8.3): the subject is the whole sentence ("Bob asked to become an
  // organiser." to admins, "Your organiser request was approved." to the coach).
  "organiser-request": ({ subject, url }) => `${subject} Open it: ${url}`,
  // Fixture summary messages (league UX pass 11-02): never the message text, only who wrote and about which fixture.
  "fixture-message": ({ title, url }) => `${title}. Read and reply: ${url}`,
  // Creation wizards v2 Q2: every registered coach hears about a rules change; an invalid roster after it needs changes.
  "ruleset-change": ({ subject, url }) => `The rules of ${subject} changed. Read the organiser's message and what changed: ${url}`,
  "roster-problems": ({ subject, url }) => `Your roster for ${subject} needs changes. See what to fix: ${url}`,
  // League ladders (lane 8b): a challenge to answer, or an accepted challenge / scheduled-round game to propose a time for.
  ladder: ({ title, url }) => `${title}. Open it: ${url}`,
};

/** Types that DM only when the emitter marks the row actionable (NotificationInput.action). Every other emitter of these
 *  types (today's tournament registration notices) stays bell-only. */
export const ACTION_DM_WHEN_FLAGGED: ReadonlySet<NotificationType> = new Set<NotificationType>(["registration-outcome", "registration", "check-in", "roster-problems", "ladder"]);

export const isActionDmType = (type: NotificationType): boolean => Object.hasOwn(ACTION_DM, type);

/** Discord Markdown characters (and `<` / `@` / `:` that start autolinks, mentions and emoji). */
const DISCORD_MARKDOWN = /[\\*_~`|>[\]()#\-<@:!]/g;

/** A name made inert for Discord: URLs broken up (no autolink), every Markdown character backslash-escaped. */
export function escapeDiscordName(name: string): string {
  return name
    .replace(/([a-z][a-z0-9+.-]*):\/\//gi, "$1 //")
    .replace(/\bwww\./gi, "www .")
    .replace(DISCORD_MARKDOWN, (c) => `\\${c}`);
}

/** The DM text for a notification (`text`, Discord-escaped) and the same words unescaped (`plain`, for the email
 *  fallback), or undefined when its type does not DM. */
export function actionDmText(m: ActionMessageInput): { text: string; plain: string } | undefined {
  const build = ACTION_DM[m.record.type];
  if (!build) return undefined;
  if (ACTION_DM_WHEN_FLAGGED.has(m.record.type) && m.action !== true) return undefined;
  // Discord notices always obscure listed words (owner 11-02): names and titles are starred before escaping
  const from = starProfanity(oneLine(m.record.from)) || "Someone";
  const subject = starProfanity(oneLine(m.subject ?? "")) || "your fixture";
  const title = starProfanity(oneLine(m.record.title));
  return {
    text: build({ from: escapeDiscordName(from), subject: escapeDiscordName(subject), url: m.url, title: escapeDiscordName(title) }),
    plain: build({ from, subject, url: m.url, title }),
  };
}
