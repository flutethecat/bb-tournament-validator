// Account page CONNECTIONS (the Identity panel's provider table): which outside accounts a coach has linked, and how.
//
// A ConnectionProvider is either
// - "oauth": the provider signs the coach in and tells us who they are (Discord, src/auth/discordSso.ts). Ownership is
//   proven by the provider. Discord is read-only here: it is the sign-in itself.
// - "lookup": there is no provider sign-in, so we can only check a PUBLIC record (NAF). "Verified" then means the record
//   exists and matches what the coach entered; it does NOT prove the coach owns it. The NAF (thenaf.net) offers no OAuth,
//   no API and no third-party login (owner told 10-30); members sign in on the NAF's own site only.
//
// Extension point: a future NAF OAuth provider is a new ConnectionProvider with kind "oauth" whose status() returns
// linkVia { mode: "redirect", href } (the start of its OAuth dance, wired like discordSso.ts: state cookie, callback,
// then write record.identities + record.connections). The SPA renders rows from ConnectionView only, so it needs no change.
//
// The FUMBBL row is not a provider: it is the profile's fumbblName claim (src/accountProfile.ts) or the tournament
// registry's link, shown in the same table.

import { fetchNafCoachIdentity, type NafCoachIdentity } from "../nafRecords.js";
import { RateLimiter } from "../translate/guards.js";
import {
  canonicalNafId, normalizeFfbCoachId, ownIdentityRecord, readIdentities, upsertIdentity, withConnections,
  type CoachIdentityRecord,
} from "./identitiesStore.js";

export type ConnectionStatus = "linked" | "not_linked" | "verified";
export type ConnectionAction = "link" | "unlink" | "reverify";

export interface ConnectionField { name: string; label: string; inputmode: "text" | "numeric"; maxlength: number; value: string }

/** How the row's "link" action starts. */
export type ConnectionLinkVia =
  /** An inline form POSTed (JSON, field name -> value) to `endpoint`; DELETE on the same endpoint unlinks. */
  | { mode: "form"; endpoint: string; fields: ConnectionField[] }
  /** A browser redirect into a provider's OAuth flow (none today; the slot for a real NAF provider). */
  | { mode: "redirect"; href: string }
  /** Edit a field of the profile form above (the FUMBBL name claim). */
  | { mode: "field"; field: "fumbblName" };

export interface ConnectionView {
  id: string;
  label: string;
  kind: "oauth" | "lookup" | "claim";
  /** Decorative glyph under /icons/ui. */
  icon: string;
  status: ConnectionStatus;
  /** The linked identity as text ("" = none). */
  identity: string;
  /** One sentence under the row. */
  note: string;
  actions: ConnectionAction[];
  linkVia?: ConnectionLinkVia;
  /** True when something other than the coach owns the link (the bot registry for FUMBBL). */
  locked?: boolean;
  verifiedAt?: string;
}

export class ConnectionError extends Error {
  constructor(readonly status: number, message: string, readonly extra: { mismatch?: Array<"name" | "number">; retryAfter?: number } = {}) {
    super(message);
  }
}

export interface ConnectionContext {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ConnectionProvider {
  id: string;
  label: string;
  kind: "oauth" | "lookup";
  status(record: CoachIdentityRecord): ConnectionView;
  /** Link (or re-verify) the session coach's OWN record; returns the written record. Absent = read-only here. */
  link?(coach: string, input: unknown, ctx?: ConnectionContext): Promise<CoachIdentityRecord>;
  /** Remove the link from the session coach's OWN record; returns the written record. */
  unlink?(coach: string, ctx?: ConnectionContext): CoachIdentityRecord;
}

// ---- Discord (oauth, read-only) ---------------------------------------------------------------------------------------------

export const discordProvider: ConnectionProvider = {
  id: "discord",
  label: "Discord",
  kind: "oauth",
  status(record) {
    const linked = Boolean(record.identities.discordUserId);
    return {
      id: "discord", label: "Discord", kind: "oauth", icon: "/icons/ui/action-pass.png",
      status: linked ? "linked" : "not_linked",
      identity: record.identities.discordUsername ?? (linked ? "Linked" : ""),
      note: linked ? "You sign in with this Discord account. It can't be changed here." : "Sign in with Discord to link it.",
      actions: [],
    };
  },
};

// ---- NAF (lookup against the public coach page) -----------------------------------------------------------------------------

export const NAF_CONNECTION_ENDPOINT = "/api/me/connections/naf";
export const NAF_NAME_MAX = 60;
const NAF_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;
export const NAF_VERIFY_CACHE_MS = 10 * 60_000;
const NAF_VERIFY_CACHE_MAX = 500;

/** 5 verification attempts per coach per minute (each may reach member.thenaf.net). */
const nafLimiter = new RateLimiter({ maxRequests: 5, maxChars: Number.MAX_SAFE_INTEGER, windowMs: 60_000, maxKeys: 5_000 });
const nafCache = new Map<string, { at: number; result: NafCoachIdentity }>();

/** Tests only: forget the rate-limit buckets and the coach-page cache. */
export function resetNafConnectionState(): void {
  nafCache.clear();
  (nafLimiter as unknown as { buckets: Map<string, unknown> }).buckets.clear();
}

const cleanName = (v: string) => v.normalize("NFC").trim().replace(/\s+/g, " ");
const sameName = (a: string, b: string) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
const sameNumber = (a: string, b: string) => canonicalNafId(a) !== undefined && canonicalNafId(a) === canonicalNafId(b);

/** The verified pair, only while the identity still carries exactly that pair. */
export function verifiedNaf(record: CoachIdentityRecord): { verifiedAt: string; nafId: string; nafName: string } | undefined {
  const naf = record.connections?.naf;
  return naf && naf.nafId === record.identities.nafId && naf.nafName === record.identities.nafName ? naf : undefined;
}

export function parseNafLinkInput(body: unknown): { nafName: string; nafId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ConnectionError(400, "A JSON object is required.");
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (key !== "nafName" && key !== "nafId") throw new ConnectionError(400, `${key} is not accepted here.`);
  if (typeof b.nafName !== "string" || typeof b.nafId !== "string") throw new ConnectionError(400, "NAF name and NAF number are required.");
  const nafName = cleanName(b.nafName);
  const nafId = canonicalNafId(b.nafId);
  if (!nafName) throw new ConnectionError(400, "Enter your NAF name.");
  if (nafName.length > NAF_NAME_MAX) throw new ConnectionError(400, `NAF name must be at most ${NAF_NAME_MAX} characters.`);
  if (!NAF_NAME.test(nafName)) throw new ConnectionError(400, "NAF name can use letters, digits, spaces and . _ ' -");
  if (!nafId) throw new ConnectionError(400, "NAF number must be 1 to 10 digits.");
  return { nafName, nafId };
}

async function coachPage(nafId: string, fetchImpl: typeof fetch, now: number): Promise<NafCoachIdentity> {
  const hit = nafCache.get(nafId);
  if (hit && now - hit.at < NAF_VERIFY_CACHE_MS) return hit.result;
  const result = await fetchNafCoachIdentity(nafId, fetchImpl);
  if (result.kind !== "unavailable") {
    nafCache.delete(nafId);
    nafCache.set(nafId, { at: now, result });
    while (nafCache.size > NAF_VERIFY_CACHE_MAX) nafCache.delete(nafCache.keys().next().value as string);
  }
  return result;
}

export const nafProvider: ConnectionProvider = {
  id: "naf",
  label: "NAF",
  kind: "lookup",
  status(record) {
    const verified = verifiedNaf(record);
    const nafName = record.identities.nafName ?? "";
    const nafId = record.identities.nafId ?? "";
    const identity = [nafName, nafId ? `#${nafId}` : ""].filter(Boolean).join(" · ");
    const fields: ConnectionField[] = [
      { name: "nafName", label: "NAF coach name", inputmode: "text", maxlength: NAF_NAME_MAX, value: nafName },
      { name: "nafId", label: "NAF number", inputmode: "numeric", maxlength: 10, value: nafId },
    ];
    const linkVia: ConnectionLinkVia = { mode: "form", endpoint: NAF_CONNECTION_ENDPOINT, fields };
    if (verified) {
      return {
        id: "naf", label: "NAF", kind: "lookup", icon: "/icons/ui/dedicated_fans.png", status: "verified", identity,
        note: "Checked against the public NAF coach page: the record exists and matches. The NAF has no sign-in, so this does not prove the record is yours. Editing your NAF name or number clears the check.",
        actions: ["reverify", "unlink"], linkVia, verifiedAt: verified.verifiedAt,
      };
    }
    return {
      id: "naf", label: "NAF", kind: "lookup", icon: "/icons/ui/dedicated_fans.png", status: "not_linked", identity,
      note: identity
        ? "Entered on your profile but not checked. Link to check it against the public NAF coach page."
        : "Link your NAF record: we check your name and number against the public NAF coach page.",
      actions: identity ? ["link", "unlink"] : ["link"], linkVia,
    };
  },

  async link(coach, input, ctx = {}) {
    const { nafName, nafId } = parseNafLinkInput(input);
    const wait = nafLimiter.take([`naf:${normalizeFfbCoachId(coach)}`], 0);
    if (wait > 0) throw new ConnectionError(429, `Too many NAF checks. Try again in ${wait} s.`, { retryAfter: wait });
    const now = (ctx.now ?? (() => new Date()))();
    const page = await coachPage(nafId, ctx.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)), now.getTime());
    if (page.kind === "unavailable") throw new ConnectionError(503, "The NAF site can't be reached right now. Try again later.");
    if (page.kind === "missing") throw new ConnectionError(422, `No NAF coach page was found for number ${nafId}.`, { mismatch: ["number"] });
    const mismatch: Array<"name" | "number"> = [];
    if (page.nafNumber && !sameNumber(page.nafNumber, nafId)) mismatch.push("number");
    if (!page.nafName || !sameName(page.nafName, nafName)) mismatch.push("name");
    if (mismatch.length) {
      const what = mismatch.includes("number")
        ? `The NAF coach page for number ${nafId} shows a different NAF number.`
        : page.nafName ? `The NAF coach page for number ${nafId} shows a different NAF name. Enter the name exactly as it appears on your NAF membership.`
        : `The NAF coach page for number ${nafId} shows no NAF name to compare.`;
      throw new ConnectionError(422, what, { mismatch });
    }
    const canonicalName = cleanName(page.nafName!);
    const self = normalizeFfbCoachId(coach);
    // Stored ids are canonicalised too, so a record written before canonicalisation ("034116") still collides.
    const taken = Object.entries(readIdentities().coaches).some(([key, r]) => key !== self && canonicalNafId(verifiedNaf(r)?.nafId) === nafId);
    if (taken) throw new ConnectionError(409, "That NAF record is already checked on another Super FUMBBL account. If it is yours, ask an admin: they can clear the other account's NAF check, then you can link it here.");
    const previous = ownIdentityRecord(coach);
    const record = withConnections(
      { ...previous, identities: { ...previous.identities, nafName: canonicalName, nafId }, updatedAt: now.toISOString(), updatedBy: previous.ffbCoachId },
      { ...previous.connections, naf: { verifiedAt: now.toISOString(), source: "coachpage", nafId, nafName: canonicalName } },
    );
    return upsertIdentity(record).coaches[self]!;
  },

  unlink(coach, ctx = {}) {
    const now = (ctx.now ?? (() => new Date()))();
    const previous = ownIdentityRecord(coach);
    const { nafName: _n, nafId: _i, ...identities } = previous.identities;
    const { naf: _naf, ...rest } = previous.connections ?? {};
    const record = withConnections({ ...previous, identities, updatedAt: now.toISOString(), updatedBy: previous.ffbCoachId }, rest);
    return upsertIdentity(record).coaches[normalizeFfbCoachId(coach)]!;
  },
};

/** Every provider, in table order. A new provider (e.g. a real NAF OAuth) is added here. */
export const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = [discordProvider, nafProvider];

export function connectionProvider(id: string): ConnectionProvider | undefined {
  return CONNECTION_PROVIDERS.find((p) => p.id === id);
}

/** The FUMBBL row: the registry's link (locked) or the coach's own claim from the profile form. */
export function fumbblConnection(record: CoachIdentityRecord, registryName: string | null): ConnectionView {
  const base = { id: "fumbbl", label: "FUMBBL", kind: "claim" as const, icon: "/icons/ui/football-helmet.png", linkVia: { mode: "field", field: "fumbblName" } as const };
  if (registryName) return { ...base, status: "linked", identity: registryName, locked: true, note: "Locked by the bot registry (tournament registration); an organiser can change it.", actions: [] };
  const claim = record.profile.fumbblName ?? "";
  return claim
    ? { ...base, status: "linked", identity: claim, note: "Your FUMBBL name claim, set in the FUMBBL name field above.", actions: ["link"] }
    : { ...base, status: "not_linked", identity: "", note: "Add your fumbbl.com account name in the FUMBBL name field above.", actions: ["link"] };
}

/** The whole table for a record: Discord, NAF, FUMBBL. */
export function connectionsView(record: CoachIdentityRecord, registryFumbblName: string | null): ConnectionView[] {
  const [discord, ...rest] = CONNECTION_PROVIDERS.map((p) => p.status(record));
  return [discord!, ...rest, fumbblConnection(record, registryFumbblName)];
}
