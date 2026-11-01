// Actionable notifications that also go out as a Discord DM from the bot (owner 11-01, laws §E 23c): which notification
// types DM, and the short plain text each sends. One row per type; a type without a row never DMs. Add a row (and a test)
// to turn another type on: candidates are fixture lobby ready, naf-request, share-request and friend-request.
//
// `subject` is the short name of the thing (a fixture label such as "Round 2 vs Orcs · Spring League"), passed by the
// emitter on NotificationInput.subject (never stored); `url` is the notification's absolute link.

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

/** The DM text for a notification, or undefined when its type does not DM. */
export function actionDmText(m: ActionMessageInput): string | undefined {
  const build = ACTION_DM[m.record.type];
  if (!build) return undefined;
  const from = oneLine(m.record.from) || "Someone";
  const subject = oneLine(m.subject ?? "") || "your fixture";
  return build({ from, subject, url: m.url });
}
