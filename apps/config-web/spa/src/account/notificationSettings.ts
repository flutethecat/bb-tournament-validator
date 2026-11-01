// Account page notification settings (GET/POST /api/me/notification-settings, src/mail/service.ts): the coach's choice
// of Discord DMs for actions they need to take. The server never sends the Discord id, only whether one is linked.
import type { Fetcher } from "../session";

export interface NotificationSettings {
  discordDm: {
    label: string;
    /** The coach's choice (on by default). */
    on: boolean;
    /** A Discord account is linked (DMs need one). */
    linked: boolean;
    /** The site has Discord DMs switched on. */
    available: boolean;
    at: string | null;
    version: string;
  };
  /** A DM that cannot be delivered falls back to one email (only with email consent and a confirmed address). */
  emailFallback: boolean;
}

export const NOTIFICATION_SETTINGS_PATH = "/api/me/notification-settings";

export const loadNotificationSettings = (api: Fetcher): Promise<NotificationSettings> => api<NotificationSettings>(NOTIFICATION_SETTINGS_PATH);
export const saveDiscordDm = (api: Fetcher, on: boolean): Promise<NotificationSettings> =>
  api<NotificationSettings>(NOTIFICATION_SETTINGS_PATH, { method: "POST", body: { discordDm: on } });

/** The help line under the switch. */
export function discordDmHelp(s: NotificationSettings): string {
  if (!s.discordDm.linked) return "Link a Discord account to get these messages.";
  const base = "The Super FUMBBL bot messages you on Discord with a link when a coach proposes, changes or accepts a game time. You need to share a Discord server with the bot.";
  return s.discordDm.available ? base : `${base} Discord messages are not switched on for this site yet.`;
}

export function emailFallbackLine(s: NotificationSettings): string {
  return s.emailFallback
    ? "If a Discord message can't be delivered, we send it once by email instead."
    : "If a Discord message can't be delivered, you still see it in your notifications. Email is used only if you agreed to emails and confirmed an address.";
}
