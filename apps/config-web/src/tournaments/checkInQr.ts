/**
 * QR check-in (spec-grill-round2-leftovers 11-03 "Round 2 answers" 5): the tokens behind a coach's personal check-in QR
 * and a tournament's venue QR. Pure helpers, no I/O; the store keeps the records, api.ts the routes.
 *
 * A token is `<kind><nonce><signature>` in base64url: kind "p" (personal) or "v" (venue), a random 16-byte nonce and a
 * 16-byte HMAC-SHA256 of the kind, the tournament, the entry (personal) and the nonce under a host key (checkin.key next to
 * the tournament data, like the mail link key). It is unguessable without the key, and tied to its registration.
 *
 * Storage: the record keeps the nonce and the SHA-256 of the token, never the token. The token travels only in the check-in
 * URL's path (/app/tournaments/<id>/check-in/<token>); the scan page POSTs it in the request body, never in an API path or
 * query, and nothing logs it.
 *  - Personal: single use. A check-in by the code marks it used, and a re-scan answers "already checked in". Withdrawing,
 *    being removed, re-entering, an organiser clearing the check-in, or "New code" drop it (a fresh one is issued by the
 *    minute sweep or "New code", never on a read).
 *  - Venue: many coaches, each checks in their own entry. Rotating replaces the nonce (the old code stops working);
 *    switching it off removes it.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How an entry was checked in. "organiser-override": an organiser's one click while check-in was not open (allowed, logged). */
export type CheckInVia = "self" | "organiser" | "organiser-override" | "personal-qr" | "venue-qr";

/** The stored half of a coach's personal code (on the entry). */
export interface PersonalCheckInQr { nonce: string; hash: string; issuedAt: string; usedAt?: string }

/** A tournament's venue code. Off = no nonce (the revision stays, so a stale tab can never switch it back on). */
export interface VenueCheckInQr { enabled: boolean; nonce?: string; hash?: string; revision: number; updatedAt: string; by: string }

const NONCE_BYTES = 16;
const SIG_BYTES = 16;
const B64 = "[A-Za-z0-9_-]";
const TOKEN = new RegExp(`^([pv])(${B64}{22})(${B64}{22})$`);

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

function signature(key: string, kind: "p" | "v", tournamentId: string, entrantId: string, nonce: string): string {
  return createHmac("sha256", key).update(`checkin\0${kind}\0${tournamentId}\0${entrantId}\0${nonce}`).digest().subarray(0, SIG_BYTES).toString("base64url");
}

const newNonce = (): string => randomBytes(NONCE_BYTES).toString("base64url");

export function personalToken(key: string, tournamentId: string, entrantId: string, nonce: string): string {
  return `p${nonce}${signature(key, "p", tournamentId, entrantId, nonce)}`;
}

export function venueToken(key: string, tournamentId: string, nonce: string): string {
  return `v${nonce}${signature(key, "v", tournamentId, "", nonce)}`;
}

/** A fresh personal code for an entry: the record to store (nonce + hash only). */
export function issuePersonal(key: string, tournamentId: string, entrantId: string, now: Date): PersonalCheckInQr {
  const nonce = newNonce();
  return { nonce, hash: hashToken(personalToken(key, tournamentId, entrantId, nonce)), issuedAt: now.toISOString() };
}

/** A fresh venue nonce + hash (rotate, or switch on). */
export function issueVenue(key: string, tournamentId: string): { nonce: string; hash: string } {
  const nonce = newNonce();
  return { nonce, hash: hashToken(venueToken(key, tournamentId, nonce)) };
}

export interface ParsedToken { kind: "personal" | "venue"; nonce: string; token: string }

/** The token's shape, or undefined (anything else is refused before any lookup). */
export function parseToken(raw: unknown): ParsedToken | undefined {
  if (typeof raw !== "string") return undefined;
  const m = TOKEN.exec(raw);
  if (!m) return undefined;
  return { kind: m[1] === "p" ? "personal" : "venue", nonce: m[2]!, token: raw };
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Does this personal token belong to this stored code (signature over this entry, and the stored hash)? */
export function matchesPersonal(key: string, tournamentId: string, entrantId: string, stored: PersonalCheckInQr | undefined, t: ParsedToken): boolean {
  if (!stored || t.kind !== "personal" || !same(stored.nonce, t.nonce)) return false;
  return same(personalToken(key, tournamentId, entrantId, t.nonce), t.token) && same(stored.hash, hashToken(t.token));
}

/** Does this venue token match the tournament's current venue code (on, same nonce, signature, hash)? */
export function matchesVenue(key: string, tournamentId: string, stored: VenueCheckInQr | undefined, t: ParsedToken): boolean {
  if (!stored?.enabled || !stored.nonce || !stored.hash || t.kind !== "venue" || !same(stored.nonce, t.nonce)) return false;
  return same(venueToken(key, tournamentId, t.nonce), t.token) && same(stored.hash, hashToken(t.token));
}

/** The SPA path a code opens (the only place a token is ever put). */
export const checkInPath = (tournamentId: string, token: string): string => `/app/tournaments/${encodeURIComponent(tournamentId)}/check-in/${token}`;

/** Audit trail cap per entry (each check-in, however it was made, is one line). */
export const CHECK_IN_LOG_CAP = 20;
