// League "Message members" (organiser area of the league page):
//
//   GET  /api/leagues/:id/messages   organiser read: recent messages (audit rows: counts only), limits, email on/off
//   POST /api/leagues/:id/messages   { scope: "all" | "team" | "coach", teamId?, coach?, subject, body, requestId? }
//
// Same authz as League settings (anonymous 401, unknown league 404, not an organiser of the league nor a site admin
// 403). Recipients are resolved server-side from the league's newest season (teams' and participants' fork accounts),
// the sender excluded. Every recipient gets an in-portal notification; email goes only to members who acknowledged
// sharing with this league, have league-contact consent and a verified, non-suppressed address (RecipientResolver).
// The response carries counts only: never an address, and never who was skipped.

import { createHash, randomBytes } from "node:crypto";
import type { NotificationInput } from "../notifications.js";
import { seasonCoaches } from "../leagues/events.js";
import { isLeagueOrganiser, type LeagueStore } from "../leagues/store.js";
import type { LeagueRecord } from "../leagues/types.js";
import type { OutboxItem } from "./outbox.js";
import type { RecipientResolver } from "./recipients.js";
import { mailCoachKey, type MailAuditEntry, type MailAuditLog } from "./stores.js";
import { cleanText, oneLine, renderLeagueMessage } from "./templates.js";
import type { MailMessage } from "./transport.js";

export const LEAGUE_SUBJECT_MAX = 120;
export const LEAGUE_BODY_MAX = 5000;
export const LEAGUE_MESSAGES_PER_HOUR = 10;

export interface LeagueMessageAuth { coach: string; admin: boolean }

export interface LeagueMessageDeps {
  store: Pick<LeagueStore, "league" | "seasons">;
  resolver: RecipientResolver;
  isSuppressed(address: string): boolean;
  enqueue(items: OutboxItem[]): { added: number; duplicates: number };
  /** Today's sent + queued for the league (the daily cap). */
  leagueLoad(leagueId: string): { sentToday: number; queued: number };
  leagueDailyCap: number;
  emailEnabled(): boolean;
  unsubscribeUrl(coach: string, leagueId: string): string;
  absolute(path: string): string;
  leagueStream?: string;
  notify(coach: string, input: NotificationInput): void;
  audit: Pick<MailAuditLog, "append" | "forLeague">;
  limiter: LeagueMessageLimiter;
  now?: () => number;
}

export interface LeagueMessageResult { status: number; body: unknown; headers?: Record<string, string> }

/** Sliding one-hour window per organiser per league (in memory). */
export class LeagueMessageLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = LEAGUE_MESSAGES_PER_HOUR, private readonly windowMs = 3_600_000) {}
  take(coach: string, leagueId: string, now = Date.now()): number {
    const key = `${mailCoachKey(coach)}\0${leagueId}`;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return Math.ceil((this.windowMs - (now - recent[0]!)) / 1000); }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) this.hits.delete(this.hits.keys().next().value as string);
    return 0;
  }
}

export const leagueMessagesPath = (path: string): string | undefined => {
  const m = /^\/api\/leagues\/([^/]+)\/messages$/.exec(path);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]!); } catch { return undefined; }
};

const NO_STORE = { "cache-control": "no-store" };
const fail = (status: number, error: string, field?: string): LeagueMessageResult => ({ status, body: { error, ...(field ? { field } : {}) }, headers: NO_STORE });

function gate(league: LeagueRecord | undefined, auth: LeagueMessageAuth | undefined): LeagueMessageResult | undefined {
  if (!auth) return fail(401, "Sign in to message league members.");
  if (!league) return fail(404, "League not found.");
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach)) return fail(403, "Only this league's organisers and site admins can message its members.");
  return undefined;
}

export type Recipients = { ok: true; coaches: string[]; scope: MailAuditEntry["scope"] } | { ok: false; result: LeagueMessageResult };

/** The coaches a message goes to (newest season), sender excluded. */
export function leagueRecipients(store: LeagueMessageDeps["store"], league: LeagueRecord, sender: string, input: Record<string, unknown>): Recipients {
  const season = [...store.seasons(league.id)].sort((a, b) => b.number - a.number)[0];
  if (!season) return { ok: false, result: fail(409, "This league has no season yet, so it has no members to message.") };
  const members = seasonCoaches(season, sender);
  const scope = input.scope;
  if (scope === "all") return { ok: true, coaches: members, scope };
  if (scope === "team") {
    const team = typeof input.teamId === "string" ? season.teams.find((t) => t.id === input.teamId) : undefined;
    if (!team) return { ok: false, result: fail(400, "Pick a team from the current season.", "teamId") };
    const coach = team.coachId?.trim();
    if (!coach) return { ok: false, result: fail(409, "That team has no coach account, so it cannot be messaged.", "teamId") };
    if (mailCoachKey(coach) === mailCoachKey(sender)) return { ok: false, result: fail(400, "That is your own team.", "teamId") };
    return { ok: true, coaches: [coach], scope };
  }
  if (scope === "coach") {
    const want = typeof input.coach === "string" ? mailCoachKey(input.coach) : "";
    const coach = want ? members.find((c) => mailCoachKey(c) === want) : undefined;
    if (!coach) return { ok: false, result: fail(400, "Pick a coach who is a member of the current season.", "coach") };
    return { ok: true, coaches: [coach], scope };
  }
  return { ok: false, result: fail(400, "Choose who gets the message: all members, a team or a coach.", "scope") };
}

const recentRequests = new Map<string, { at: number; result: LeagueMessageResult }>();

export function leagueMessagesRoute(
  method: string, path: string, auth: LeagueMessageAuth | undefined, body: unknown, deps: LeagueMessageDeps,
): LeagueMessageResult | undefined {
  const leagueId = leagueMessagesPath(path);
  if (leagueId === undefined) return undefined;
  const league = deps.store.league(leagueId);
  const refused = gate(league, auth);
  if (refused) return refused;
  const lg = league!;
  const who = auth!;
  const now = deps.now?.() ?? Date.now();

  if (method === "GET" || method === "HEAD") {
    return {
      status: 200, headers: NO_STORE,
      body: {
        emailEnabled: deps.emailEnabled(),
        limits: { subject: LEAGUE_SUBJECT_MAX, body: LEAGUE_BODY_MAX, perHour: LEAGUE_MESSAGES_PER_HOUR, dailyEmails: deps.leagueDailyCap },
        recent: deps.audit.forLeague(lg.id, 20).map((e) => ({ id: e.id, sender: e.sender, at: e.at, scope: e.scope, notified: e.notified, queued: e.queued, skipped: e.skipped })),
      },
    };
  }
  if (method !== "POST") return fail(405, "Use GET or POST.");

  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!input) return fail(400, "Send a JSON object.");
  const subject = typeof input.subject === "string" ? oneLine(input.subject) : "";
  const text = typeof input.body === "string" ? cleanText(input.body).trim() : "";
  if (!subject) return fail(400, "Write a subject.", "subject");
  if ([...subject].length > LEAGUE_SUBJECT_MAX) return fail(400, `A subject is at most ${LEAGUE_SUBJECT_MAX} characters.`, "subject");
  if (!text) return fail(400, "Write a message.", "body");
  if ([...text].length > LEAGUE_BODY_MAX) return fail(400, `A message is at most ${LEAGUE_BODY_MAX} characters.`, "body");
  const requestId = typeof input.requestId === "string" && /^[\w-]{8,64}$/.test(input.requestId) ? input.requestId : undefined;
  const replayKey = requestId ? `${lg.id}\0${mailCoachKey(who.coach)}\0${requestId}` : undefined;
  for (const [k, v] of recentRequests) if (now - v.at > 600_000) recentRequests.delete(k);
  if (replayKey && recentRequests.has(replayKey)) return recentRequests.get(replayKey)!.result;

  const recipients = leagueRecipients(deps.store, lg, who.coach, input);
  if (!recipients.ok) return recipients.result;
  if (!recipients.coaches.length) return fail(409, "No other members have a coach account to message yet.");

  // Who may get email (decided before anything is stored, so the cap check sees the real count).
  const skipped = { noConsent: 0, unverified: 0, suppressed: 0 };
  const emailTo: Array<{ coach: string; address: string }> = [];
  const emailOn = deps.emailEnabled();
  for (const coach of recipients.coaches) {
    const contact = deps.resolver.resolve(coach);
    if (!contact || !contact.canReceiveLeagueMail(lg.id)) { skipped.noConsent += 1; continue; }
    if (!contact.email || !contact.verified) { skipped.unverified += 1; continue; }
    if (deps.isSuppressed(contact.email)) { skipped.suppressed += 1; continue; }
    emailTo.push({ coach, address: contact.email });
  }
  if (emailOn && emailTo.length) {
    const load = deps.leagueLoad(lg.id);
    if (load.sentToday + load.queued + emailTo.length > deps.leagueDailyCap)
      return fail(429, `This league can send at most ${deps.leagueDailyCap} emails a day; try again tomorrow or message fewer members.`);
  }
  const wait = deps.limiter.take(who.coach, lg.id, now);
  if (wait > 0) return { ...fail(429, `At most ${LEAGUE_MESSAGES_PER_HOUR} messages an hour per league; try again later.`), headers: { ...NO_STORE, "retry-after": String(wait) } };

  const id = requestId
    ? `lm-${createHash("sha256").update(replayKey!).digest("hex").slice(0, 16)}`
    : `lm-${now.toString(36)}${randomBytes(4).toString("hex")}`;
  const leaguePath = `/app/leagues/${encodeURIComponent(lg.id)}`;
  let queued = 0;
  if (emailOn && emailTo.length) {
    const items: OutboxItem[] = emailTo.map(({ coach, address }) => {
      const rendered = renderLeagueMessage({
        leagueName: lg.name, senderCoach: who.coach, subject, body: text,
        leagueUrl: deps.absolute(leaguePath), unsubscribeUrl: deps.unsubscribeUrl(coach, lg.id),
      });
      const message: MailMessage = {
        to: address, subject: rendered.subject, text: rendered.text, html: rendered.html, headers: rendered.headers, template: "league-message",
        ...(deps.leagueStream ? { stream: deps.leagueStream } : {}),
        metadata: { league: lg.id, message: id },
      };
      return { key: `league:${lg.id}:${id}:${mailCoachKey(coach)}`, leagueId: lg.id, message };
    });
    queued = deps.enqueue(items).added;
  }

  const notice: NotificationInput = { type: "league-broadcast", title: `${lg.name}: ${subject}`, body: text, link: leaguePath, from: who.coach };
  let notified = 0;
  for (const coach of recipients.coaches) {
    try { deps.notify(coach, notice); notified += 1; } catch { /* fire-and-forget */ }
  }

  const entry: MailAuditEntry = { id, leagueId: lg.id, sender: who.coach, at: new Date(now).toISOString(), scope: recipients.scope, notified, queued, skipped };
  try { deps.audit.append(entry); } catch { /* the audit write must not fail the send */ }
  const result: LeagueMessageResult = { status: 201, headers: NO_STORE, body: { id, notified, queued, skipped, emailEnabled: emailOn } };
  if (replayKey) recentRequests.set(replayKey, { at: now, result });
  return result;
}
