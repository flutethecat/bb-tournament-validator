// League acknowledgement = the league registration step (owner 10-31): "You are joining {league}. Its organisers can see
// your coach name and your teams. Choose below what else they can see." followed by the Preferred name / Email / Phone
// boxes (default off). Accepting stores the acknowledgement AND the league:<id> sharing grant together (src/auth/sharing.ts);
// joining and declining both notify the league's organisers (except the coach) through the notifications store.
//
// There is no self-service league registration yet: every coach reaches a league through an organiser (import, Assign
// coach account). So the notice is shown to the coach on their next visit for each league they are on and have not
// answered (GET /api/me/leagues/sharing: status "pending"), non-blocking. Sharing needs the required checkbox
// (acknowledged: true) and stores consent.leagues[<leagueId>] = { at, version }; declining or "Stop sharing" removes
// the acknowledgement and records consent.leaguesDeclined[<leagueId>] (not asked again; the coach stays on the team).
// The acknowledgement gates the league mailer (src/auth/contactFor.ts mailerRecipientFor) and the league organisers' view
// of the coach (sharedContactFor: the coach name plus only the fields of the league:<id> grant).
// A future self-service join must ask the same notice at join time and store the same acknowledgement.
// Leaving the roster (LeagueStore.onRosterExit -> recordLeagueExits) withdraws the acknowledgement and any decline, so a
// coach put back on a team is asked again; their old sharing grant only pre-ticks the boxes until they confirm.
// Answering (share or decline) needs a seat on the league (403 otherwise); withdrawing an acknowledgement does not.

import { contactOf, LEAGUE_SHARE_VERSION, leagueShareText, parseShareFields, sharesWithLeague, type ShareField } from "./contactSchema.js";
import { ContactValidationError } from "./contactSchema.js";
import { leaguesOf, type MembershipSources } from "./contactFor.js";
import { SharingError, withGrant } from "./sharing.js";
import { normalizeFfbCoachId, ownIdentityRecord, readIdentities, upsertIdentity, type CoachIdentityRecord } from "./identitiesStore.js";

export const LEAGUE_SHARING_PATH = "/api/me/leagues/sharing";

export interface LeagueSharingRow {
  id: string;
  name: string;
  /** The notice, with the league's name. */
  text: string;
  status: "pending" | "shared" | "declined";
  /** When the coach shared (status shared) or declined (status declined). */
  at?: string;
  /** False for a league the coach still shares with but is no longer on (they can stop sharing). */
  onRoster: boolean;
  /** The coach's sharing choice for this league (the boxes pre-tick from it, also after leaving and re-joining). */
  fields: ShareField[];
}

export interface LeagueSharingView { version: string; phoneOnFile: boolean; leagues: LeagueSharingRow[] }

export function leagueSharingView(record: CoachIdentityRecord, sources: MembershipSources): LeagueSharingView {
  const onRoster = leaguesOf(record.ffbCoachId, sources);
  const ids = new Set(onRoster.map((l) => l.id));
  const rows: LeagueSharingRow[] = onRoster.map((l) => row(record, l.id, l.name, true));
  for (const id of Object.keys(record.consent?.leagues ?? {})) {
    if (ids.has(id)) continue;
    rows.push(row(record, id, sources.leagues.league(id)?.name ?? id, false));
  }
  return { version: LEAGUE_SHARE_VERSION, phoneOnFile: contactOf(record).phones.length > 0, leagues: rows };
}

function row(record: CoachIdentityRecord, id: string, name: string, roster: boolean): LeagueSharingRow {
  const shared = record.consent?.leagues?.[id];
  const declined = record.consent?.leaguesDeclined?.[id];
  return {
    id, name, text: leagueShareText(name), onRoster: roster, fields: [...(record.consent?.sharing?.[`league:${id}`]?.fields ?? [])],
    ...(shared ? { status: "shared" as const, at: shared.at } : declined ? { status: "declined" as const, at: declined.at } : { status: "pending" as const }),
  };
}

/** POST /api/me/leagues/sharing { leagueId, share, acknowledged?, fields? }: share (checkbox required; fields = what else
 *  the organisers see, default none) or decline / stop. */
export function setLeagueSharing(coach: string, body: unknown, sources: MembershipSources, now = new Date()): CoachIdentityRecord {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ContactValidationError("A JSON object is required.");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["leagueId", "share", "acknowledged", "fields"].includes(k));
  if (extra.length) throw new ContactValidationError(`Unknown field: ${extra[0]}.`);
  const leagueId = typeof b.leagueId === "string" ? b.leagueId.trim() : "";
  if (!leagueId) throw new ContactValidationError("leagueId is required.");
  if (typeof b.share !== "boolean") throw new ContactValidationError("share must be true or false.");
  const fields = parseShareFields(b.fields);
  if (!b.share && b.fields !== undefined) throw new ContactValidationError("fields are sent only when sharing.");
  let previous = ownIdentityRecord(coach);
  const onRoster = leaguesOf(previous.ffbCoachId, sources).some((l) => l.id === leagueId);
  // Declining needs a seat too (or an acknowledgement to withdraw): a stranger cannot answer for a league.
  if (!b.share && !onRoster && !sharesWithLeague(previous, leagueId)) throw new SharingError(403, "You are not on that league.");
  const leagues = { ...previous.consent?.leagues };
  const declined = { ...previous.consent?.leaguesDeclined };
  if (b.share) {
    if (b.acknowledged !== true) throw new ContactValidationError("Tick the box to confirm you agree to share your data with this league's organisers.");
    if (!onRoster) throw new SharingError(403, "You are not on that league.");
    if (!sharesWithLeague(previous, leagueId)) leagues[leagueId] = { at: now.toISOString(), version: LEAGUE_SHARE_VERSION };
    delete declined[leagueId];
    // The league:<id> grant is written with the acknowledgement (same time), so it applies at once.
    previous = withGrant(previous, `league:${leagueId}`, fields, now);
  } else {
    delete leagues[leagueId];
    declined[leagueId] = { at: now.toISOString() };
  }
  const { leagues: _l, leaguesDeclined: _d, ...rest } = previous.consent ?? {};
  return upsertIdentity({
    ...previous,
    consent: {
      ...rest,
      ...(Object.keys(leagues).length ? { leagues } : {}),
      ...(Object.keys(declined).length ? { leaguesDeclined: declined } : {}),
    },
    updatedAt: now.toISOString(),
    updatedBy: previous.ffbCoachId,
  }).coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}

/** A league organiser notice for a registration answer (fire-and-forget; the server passes the notifications store). */
export type LeagueRegistrationNotify = (coach: string, input: { type: "registration"; title: string; body: string; link: string; from: string }) => void;

/**
 * setLeagueSharing, then tell the league's owner and organisers (except the coach) when the answer changed:
 * "{coach} joined {league}" on a share, "{coach} declined to join {league}" on a decline or stop.
 */
export function answerLeagueRegistration(
  coach: string,
  body: unknown,
  sources: MembershipSources,
  notify: LeagueRegistrationNotify | undefined,
  now = new Date(),
): CoachIdentityRecord {
  const before = ownIdentityRecord(coach);
  const after = setLeagueSharing(coach, body, sources, now);
  const leagueId = String((body as Record<string, unknown>).leagueId ?? "").trim();
  const status = (r: CoachIdentityRecord) => (sharesWithLeague(r, leagueId) ? "shared" : r.consent?.leaguesDeclined?.[leagueId] ? "declined" : "pending");
  const was = status(before);
  const is = status(after);
  const league = sources.leagues.league(leagueId);
  // Only a coach on the roster registers or declines; withdrawing from a league they already left tells nobody.
  const onRoster = leaguesOf(after.ffbCoachId, sources).some((l) => l.id === leagueId);
  if (!notify || !league || !onRoster || was === is || is === "pending") return after;
  const key = normalizeFfbCoachId(after.ffbCoachId);
  const organisers = new Map<string, string>();
  for (const o of [league.owner, ...league.organisers]) if (o?.trim()) organisers.set(normalizeFfbCoachId(o), o.trim());
  const text = is === "shared" ? `${after.ffbCoachId} joined ${league.name}` : `${after.ffbCoachId} declined to join ${league.name}`;
  for (const [k, organiser] of organisers) {
    if (k === key) continue;
    try {
      notify(organiser, { type: "registration", title: text, body: `${text}.`, link: `/app/leagues/${encodeURIComponent(league.id)}?tab=teams`, from: after.ffbCoachId });
    } catch { /* fire-and-forget */ }
  }
  return after;
}

/**
 * Coaches who are no longer on any season of a league (LeagueStore.onRosterExit): their acknowledgement and any decline
 * for that league are withdrawn, so a re-joining coach is asked again and nothing is shared until they confirm. The
 * league:<id> sharing grant stays as a record: the notice pre-ticks it, and it is not read until the coach confirms.
 * Coaches without an identity record are skipped (nothing to withdraw).
 */
export function recordLeagueExits(leagueId: string, coaches: readonly string[], now = new Date()): void {
  const known = readIdentities().coaches;
  for (const coach of coaches) {
    const record = known[normalizeFfbCoachId(coach)];
    if (!record?.consent?.leagues?.[leagueId] && !record?.consent?.leaguesDeclined?.[leagueId]) continue;
    const leagues = { ...record.consent.leagues };
    const declined = { ...record.consent.leaguesDeclined };
    delete leagues[leagueId];
    delete declined[leagueId];
    const { leagues: _l, leaguesDeclined: _d, ...rest } = record.consent;
    try {
      upsertIdentity({
        ...record,
        consent: {
          ...rest,
          ...(Object.keys(leagues).length ? { leagues } : {}),
          ...(Object.keys(declined).length ? { leaguesDeclined: declined } : {}),
        },
        updatedAt: now.toISOString(),
        updatedBy: "league-roster",
      });
    } catch { /* a fenced (deleting) account: nothing to keep */ }
  }
}
