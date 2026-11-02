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
import { oneLine } from "./templates.js";

export interface ActionMessageInput {
  record: Pick<NotificationRecord, "type" | "from" | "title" | "link">;
  subject?: string;
  url: string;
}

export type ActionMessageBuilder = (m: { from: string; subject: string; url: string }) => string;

/** Notification type -> DM text. Only the game-time proposal types are on. */
export const ACTION_DM: Partial<Record<NotificationType, ActionMessageBuilder>> = {
  "proposal-received": ({ from, subject, url }) => `${from} proposed times for ${subject}. Accept or decline: ${url}`,
  "proposal-countered": ({ from, subject, url }) => `${from} suggested other times for ${subject}. Accept or decline: ${url}`,
  "proposal-accepted": ({ from, subject, url }) => `${from} accepted a time for ${subject}. See it on your schedule: ${url}`,
};

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
  const from = oneLine(m.record.from) || "Someone";
  const subject = oneLine(m.subject ?? "") || "your fixture";
  return { text: build({ from: escapeDiscordName(from), subject: escapeDiscordName(subject), url: m.url }), plain: build({ from, subject, url: m.url }) };
}
