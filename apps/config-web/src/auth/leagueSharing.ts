// League acknowledgement (owner 10-31): joining a league carries a notice that its organisers can see the coach's name
// and profile and can send league messages through Super FUMBBL; the email address is never shown to them.
//
// There is no self-service league registration yet: every coach reaches a league through an organiser (import, Assign
// coach account). So the notice is shown to the coach on their next visit for each league they are on and have not
// answered (GET /api/me/leagues/sharing: status "pending"), non-blocking. Sharing needs the required checkbox
// (acknowledged: true) and stores consent.leagues[<leagueId>] = { at, version }; declining or "Stop sharing" removes
// the acknowledgement and records consent.leaguesDeclined[<leagueId>] (not asked again; the coach stays on the team).
// Organisers see a coach's full record only with the acknowledgement (src/auth/contactFor.ts organiserAccess).
// A future self-service join must ask the same notice at join time and store the same acknowledgement.

import { LEAGUE_SHARE_VERSION, leagueShareText, sharesWithLeague } from "./contactSchema.js";
import { ContactValidationError } from "./contactSchema.js";
import { leaguesOf, type MembershipSources } from "./contactFor.js";
import { normalizeFfbCoachId, ownIdentityRecord, upsertIdentity, type CoachIdentityRecord } from "./identitiesStore.js";

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
}

export interface LeagueSharingView { version: string; leagues: LeagueSharingRow[] }

export function leagueSharingView(record: CoachIdentityRecord, sources: MembershipSources): LeagueSharingView {
  const onRoster = leaguesOf(record.ffbCoachId, sources);
  const ids = new Set(onRoster.map((l) => l.id));
  const rows: LeagueSharingRow[] = onRoster.map((l) => row(record, l.id, l.name, true));
  for (const id of Object.keys(record.consent?.leagues ?? {})) {
    if (ids.has(id)) continue;
    rows.push(row(record, id, sources.leagues.league(id)?.name ?? id, false));
  }
  return { version: LEAGUE_SHARE_VERSION, leagues: rows };
}

function row(record: CoachIdentityRecord, id: string, name: string, roster: boolean): LeagueSharingRow {
  const shared = record.consent?.leagues?.[id];
  const declined = record.consent?.leaguesDeclined?.[id];
  return {
    id, name, text: leagueShareText(name), onRoster: roster,
    ...(shared ? { status: "shared" as const, at: shared.at } : declined ? { status: "declined" as const, at: declined.at } : { status: "pending" as const }),
  };
}

/** POST /api/me/leagues/sharing { leagueId, share, acknowledged? }: share (checkbox required) or decline / stop. */
export function setLeagueSharing(coach: string, body: unknown, sources: MembershipSources, now = new Date()): CoachIdentityRecord {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ContactValidationError("A JSON object is required.");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["leagueId", "share", "acknowledged"].includes(k));
  if (extra.length) throw new ContactValidationError(`Unknown field: ${extra[0]}.`);
  const leagueId = typeof b.leagueId === "string" ? b.leagueId.trim() : "";
  if (!leagueId) throw new ContactValidationError("leagueId is required.");
  if (typeof b.share !== "boolean") throw new ContactValidationError("share must be true or false.");
  const previous = ownIdentityRecord(coach);
  const leagues = { ...previous.consent?.leagues };
  const declined = { ...previous.consent?.leaguesDeclined };
  if (b.share) {
    if (b.acknowledged !== true) throw new ContactValidationError("Tick the box to confirm you agree to share your data with this league's organisers.");
    if (!leaguesOf(previous.ffbCoachId, sources).some((l) => l.id === leagueId)) throw new ContactValidationError("You are not on that league.");
    if (!sharesWithLeague(previous, leagueId)) leagues[leagueId] = { at: now.toISOString(), version: LEAGUE_SHARE_VERSION };
    delete declined[leagueId];
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
