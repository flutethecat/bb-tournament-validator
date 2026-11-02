// Privacy coverage for registration records (laws §E 26; registration spec §8.1). The core keeps no store of its own:
// tournament entries live in tournaments.json (entrants) and league registrations in the season files
// (`registrations[]`). These are the stored field names the adapters (L4, L6) must use, and the steps the delete /
// anonymise job and the export run over them (src/privacy/collectors.ts), wired before any record exists so the first
// stored registration is already covered.
//
// Linked by identity only (the coach field, an organiser's `by`); free-text reasons lose the coach's names.

import type { Anonymiser, TextReplacer } from "../privacy/anonymise.js";

/** Where an adapter stores the audited transitions (RegistrationEntry.log) on its record. */
export const REGISTRATION_LOG_FIELD = "registrationLog";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/**
 * The decision and the audit trail of one stored entry (a tournament entrant or a league registration row): every
 * `by` naming the coach becomes the pseudonym, reasons lose the coach's names. Returns whether anything changed.
 */
export function anonymiseRegistrationTrail(an: Pick<Anonymiser, "fields">, tx: Pick<TextReplacer, "texts">, row: unknown): boolean {
  if (!isObj(row)) return false;
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  if (isObj(row.decided)) { mark(an.fields(row.decided, ["by"], [])); mark(tx.texts(row.decided, ["reason"])); }
  mark(an.fields(row, ["decidedBy"], []));
  for (const t of objs(row[REGISTRATION_LOG_FIELD])) { mark(an.fields(t, ["by"], [])); mark(tx.texts(t, ["reason"])); }
  return changed;
}

/** A league registration row (season `registrations[]`): the coach's own row loses its identity, then the trail. */
export function anonymiseLeagueRegistration(an: Pick<Anonymiser, "fields">, tx: Pick<TextReplacer, "texts">, row: unknown): boolean {
  if (!isObj(row)) return false;
  const own = an.fields(row, ["coach", "coachId"], ["discordUserId"]);
  const trail = anonymiseRegistrationTrail(an, tx, row);
  const reason = tx.texts(row, ["reason"]);
  return own || trail || reason;
}

/** The league registration rows of a season that belong to the coach (export). */
export function ownLeagueRegistrations(season: unknown, isMine: (value: unknown) => boolean): Obj[] {
  if (!isObj(season)) return [];
  return objs(season.registrations).filter((r) => isMine(r.coach) || isMine(r.coachId));
}
