// League "Message members" (organiser area of the league page) and the Account page Email panel: the API calls and the
// small display helpers. The server answers with counts only; no address or skipped name ever reaches the browser.

import type { Fetcher } from "../session";
import type { SeasonRecord } from "./types";

export const LEAGUE_SUBJECT_MAX = 120;
export const LEAGUE_BODY_MAX = 5000;

export type MessageScope = "all" | "team" | "coach";

export interface LeagueMessageInput { scope: MessageScope; teamId?: string; coach?: string; subject: string; body: string; requestId: string }

/**
 * Delivery counts the server discloses: null for one-coach / team / small messages; otherwise the notified count only.
 * No email figure is ever disclosed (comparing two sends would reveal one member's email status).
 */
export interface LeagueMessageCounts {
  notified: number;
}

export interface LeagueMessageSent {
  id: string;
  emailEnabled: boolean;
  counts: LeagueMessageCounts | null;
  summary?: string;
}

export interface LeagueMessageLog { id: string; sender: string; at: string; scope: MessageScope; counts: LeagueMessageCounts | null }
export interface LeagueMessagesView { emailEnabled: boolean; recent: LeagueMessageLog[] }

/** Teams of the season with a coach account (the "one team" picker). */
export function messageTeams(season: Pick<SeasonRecord, "teams">, me: string): Array<{ id: string; label: string }> {
  const self = me.trim().toLowerCase();
  return season.teams
    .filter((t) => t.coachId?.trim() && t.coachId.trim().toLowerCase() !== self)
    .map((t) => ({ id: t.id, label: `${t.name} (${t.coachId!.trim()})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Coach accounts of the season (teams then participants), once each, without the sender. */
export function messageCoaches(season: Pick<SeasonRecord, "teams" | "participants">, me: string): string[] {
  const seen = new Set<string>([me.trim().toLowerCase()]);
  const out: string[] = [];
  const ids = [...season.teams.map((t) => t.coachId), ...season.participants.map((p) => (p as { coachId?: string }).coachId)];
  for (const id of ids) {
    const c = id?.trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const PRIVATE_SUMMARY = "Sent. Every recipient sees it in their notifications; members who accept league messages also get it by email.";

/** One line for the composer after a send: only what the server disclosed (never an email count). */
export function sentSummary(r: LeagueMessageSent): string {
  const c = r.counts;
  if (!c) return r.emailEnabled ? (r.summary ?? PRIVATE_SUMMARY) : "Sent to the recipients' notifications. Email is not set up on this site yet.";
  const parts = [`Sent to ${plural(c.notified, "member's", "members'")} notifications.`];
  parts.push(r.emailEnabled ? "Members who accept league messages also get it by email." : "Email is not set up on this site yet.");
  return parts.join(" ");
}

/** The "Recent messages" line's delivery part. */
export function logCounts(r: LeagueMessageLog): string {
  return r.counts ? `${r.counts.notified} notified` : "sent";
}

export const newRequestId = (): string => {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

export const sendLeagueMessage = (api: Fetcher, leagueId: string, input: LeagueMessageInput): Promise<LeagueMessageSent> =>
  api<LeagueMessageSent>(`/api/leagues/${encodeURIComponent(leagueId)}/messages`, { method: "POST", body: input });

export const loadLeagueMessages = (api: Fetcher, leagueId: string): Promise<LeagueMessagesView> =>
  api<LeagueMessagesView>(`/api/leagues/${encodeURIComponent(leagueId)}/messages`);

// ---- Account page: Email panel --------------------------------------------------------------------------------------

export interface MyMailStatus {
  emailEnabled: boolean;
  email: string | null;
  verified: boolean;
  suppressed: boolean;
  pending: { email: string; expiresAt: string } | null;
  leagueMailOff: { at: string } | null;
}

export const loadMyMail = (api: Fetcher): Promise<MyMailStatus> => api<MyMailStatus>("/api/me/email");
export const requestEmailVerification = (api: Fetcher, email?: string): Promise<{ sent: boolean }> =>
  api<{ sent: boolean }>("/api/me/email/verify", { method: "POST", body: email ? { email } : {} });
export const turnLeagueMailOn = (api: Fetcher): Promise<MyMailStatus> => api<MyMailStatus>("/api/me/email/league-mail", { method: "POST", body: { on: true } });

export function mailStatusLine(s: MyMailStatus): string {
  if (!s.email) return "No email address for league emails yet.";
  if (s.suppressed) return "Mail to this address bounced or was reported, so we no longer send to it.";
  return s.verified ? "Confirmed for league emails." : "Not confirmed yet: league emails go only to confirmed addresses.";
}
