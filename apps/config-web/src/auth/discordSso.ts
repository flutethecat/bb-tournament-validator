import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coachSecretDigest } from "@bb/fork-ops";
import { BANNED_ACCOUNT_MESSAGE } from "./access.js";
import { coachLogin } from "./coachLogin.js";
import type { CoachIdentityRecord, ProvisionalSignup } from "./identitiesStore.js";

export const DISCORD_OAUTH_STATE_COOKIE = "discord_oauth_state";
export const DISCORD_PENDING_COOKIE = "discord_sso_pending";
export const DISCORD_SSO_TTL_MS = 10 * 60 * 1000;

const COOKIE_PATH = "/api/auth/discord";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const STORE_VERSION = 1;
const DEFAULT_STATE_STORE_FILE = fileURLToPath(
  new URL("../../data-store/discord-sso-state.json", import.meta.url),
);
const DEFAULT_PENDING_STORE_FILE = fileURLToPath(
  new URL("../../data-store/discord-sso-pending.json", import.meta.url),
);

export interface DiscordOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface DiscordIdentity {
  discordId: string;
  discordUsername: string;
  discordAvatarHash?: string;
  email?: string;
}

export interface PendingDiscordSso extends DiscordIdentity {
  next: string;
  desktopFlowId?: string;
}

export interface DiscordSsoForkAccountDeps {
  coachExists: (coach: string) => Promise<boolean>;
  verifyCoachDigest: (coach: string, passwordMd5: string) => Promise<boolean>;
  createForkAccountDigestIfAvailable: (coach: string, passwordMd5: string) => Promise<boolean>;
  /** The fork row's stored credential digest (ownership proof for a provisional signup). */
  storedDigest?: (coach: string) => Promise<string | undefined>;
}

/** Durable provisional-signup records (identities store), keyed by Discord user id. */
export interface DiscordSsoProvisionalDeps {
  get: (discordUserId: string) => ProvisionalSignup | undefined;
  put: (record: ProvisionalSignup) => void;
  /** Removes only when the record is still this operation's. */
  remove: (discordUserId: string, operationId: string) => boolean;
  /** ONE durable write: store the confirmed identity link and remove the matching-operation record. */
  confirm?: (record: CoachIdentityRecord, discordUserId: string, operationId: string) => void;
  /** Mark an operation's fork insert in flight (never purged while active). */
  setActive?: (operationId: string, active: boolean) => void;
}

/** In-process serialisation of completions per Discord id + normalised coach name (the durable record is the
 *  dedupe across processes). */
const completionChains = new Map<string, Promise<unknown>>();
async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = completionChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  completionChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (completionChains.get(key) === tail) completionChains.delete(key);
  }
}

export interface DiscordSsoCompletionDeps {
  fork?: DiscordSsoForkAccountDeps;
  identityForCoach: (coach: string) => CoachIdentityRecord | undefined;
  isCoachBanned: (coach: string) => boolean;
  upsertIdentity: (record: CoachIdentityRecord) => void;
  /** The fork coach a Discord id is linked to (re-read inside the completion lock). */
  linkedCoachForDiscord?: (discordUserId: string) => string | undefined;
  /** Durable provisional signups; without it the new-name path cannot resume an unconfirmed insert. */
  provisional?: DiscordSsoProvisionalDeps;
  createSessionToken: (coach: string, now: number) => string;
}

export type DiscordSsoCompletionResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  sessionToken?: string;
};

interface StoredPendingDiscordSso extends PendingDiscordSso {
  expiry: number;
}

interface StoredDiscordOauthState {
  next: string;
  desktopFlowId?: string;
  expiry: number;
}

interface PersistedEntries {
  version: number;
  entries: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadEntries<T>(
  filePath: string,
  decode: (token: string, value: unknown) => T | undefined,
): Map<string, T> {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }

  const parsed = JSON.parse(contents) as PersistedEntries;
  if (!isObject(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error("Invalid Discord SSO store file.");
  }

  const records = new Map<string, T>();
  for (const entry of parsed.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
    const record = TOKEN_PATTERN.test(entry[0]) ? decode(entry[0], entry[1]) : undefined;
    if (record) records.set(entry[0], record);
  }
  return records;
}

function atomicWriteEntries<T>(filePath: string, entries: Map<string, T>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(
      temporaryFile,
      `${JSON.stringify({ version: STORE_VERSION, entries: [...entries] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryFile, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {
      // Best-effort cleanup; preserve the original write/rename error.
    }
    throw error;
  }
}

export class DiscordOauthStateStore {
  private states = new Map<string, StoredDiscordOauthState>();
  private loaded = false;

  constructor(private readonly filePath = DEFAULT_STATE_STORE_FILE) {}

  create(next: unknown, now = Date.now(), desktopFlowId?: string): string {
    this.loadAndPrune(now);
    const state = newDiscordOauthState();
    this.states.set(state, {
      next: validatedNextPath(next),
      ...(desktopFlowId ? { desktopFlowId } : {}),
      expiry: now + DISCORD_SSO_TTL_MS,
    });
    this.persist();
    return state;
  }

  consume(state: string | undefined, now = Date.now()): string | undefined {
    return this.consumeRecord(state, now)?.next;
  }

  consumeRecord(state: string | undefined, now = Date.now()):
    | { next: string; desktopFlowId?: string }
    | undefined {
    this.loadAndPrune(now);
    if (!state || !TOKEN_PATTERN.test(state)) return undefined;
    const record = this.states.get(state);
    if (!record) return undefined;
    this.states.delete(state);
    this.persist();
    return {
      next: record.next,
      ...(record.desktopFlowId ? { desktopFlowId: record.desktopFlowId } : {}),
    };
  }

  has(state: string | null | undefined, now = Date.now()): boolean {
    this.loadAndPrune(now);
    return Boolean(state && TOKEN_PATTERN.test(state) && this.states.has(state));
  }

  delete(state: string | undefined, now = Date.now()): boolean {
    this.loadAndPrune(now);
    const deleted = state ? this.states.delete(state) : false;
    if (deleted) this.persist();
    return deleted;
  }

  private loadAndPrune(now: number): void {
    if (!this.loaded) {
      this.states = loadEntries(this.filePath, (_state, value) => {
        if (!isObject(value) || typeof value.next !== "string" || typeof value.expiry !== "number")
          return undefined;
        return {
          next: validatedNextPath(value.next),
          ...(typeof value.desktopFlowId === "string" && TOKEN_PATTERN.test(value.desktopFlowId)
            ? { desktopFlowId: value.desktopFlowId }
            : {}),
          expiry: value.expiry,
        };
      });
      this.loaded = true;
    }
    if (this.prune(now)) this.persist();
  }

  private prune(now: number): boolean {
    let changed = false;
    for (const [state, record] of this.states) {
      if (record.expiry <= now) {
        this.states.delete(state);
        changed = true;
      }
    }
    return changed;
  }

  private persist(): void {
    atomicWriteEntries(this.filePath, this.states);
  }
}

export class PendingSsoStore {
  private pending = new Map<string, StoredPendingDiscordSso>();
  private loaded = false;

  constructor(private readonly filePath = DEFAULT_PENDING_STORE_FILE) {}

  create(record: PendingDiscordSso, now = Date.now()): string {
    this.loadAndPrune(now);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    this.pending.set(token, {
      discordId: record.discordId,
      discordUsername: record.discordUsername,
      ...(record.discordAvatarHash ? { discordAvatarHash: record.discordAvatarHash } : {}),
      ...(record.email ? { email: record.email } : {}),
      next: validatedNextPath(record.next),
      ...(record.desktopFlowId ? { desktopFlowId: record.desktopFlowId } : {}),
      expiry: now + DISCORD_SSO_TTL_MS,
    });
    this.persist();
    return token;
  }

  get(token: string | undefined, now = Date.now()): PendingDiscordSso | undefined {
    this.loadAndPrune(now);
    if (!token || !TOKEN_PATTERN.test(token)) return undefined;
    const record = this.pending.get(token);
    if (!record) return undefined;
    const { expiry: _expiry, ...copy } = record;
    return copy;
  }

  delete(token: string | undefined, now = Date.now()): boolean {
    this.loadAndPrune(now);
    const deleted = token ? this.pending.delete(token) : false;
    if (deleted) this.persist();
    return deleted;
  }

  private loadAndPrune(now: number): void {
    if (!this.loaded) {
      this.pending = loadEntries(this.filePath, (_token, value) => {
        if (
          !isObject(value) ||
          typeof value.discordId !== "string" ||
          !value.discordId ||
          typeof value.discordUsername !== "string" ||
          !value.discordUsername ||
          typeof value.next !== "string" ||
          typeof value.expiry !== "number"
        )
          return undefined;
        return {
          discordId: value.discordId,
          discordUsername: value.discordUsername,
          ...(typeof value.discordAvatarHash === "string" && value.discordAvatarHash
            ? { discordAvatarHash: value.discordAvatarHash }
            : {}),
          ...(typeof value.email === "string" && value.email ? { email: value.email } : {}),
          next: validatedNextPath(value.next),
          ...(typeof value.desktopFlowId === "string" && TOKEN_PATTERN.test(value.desktopFlowId)
            ? { desktopFlowId: value.desktopFlowId }
            : {}),
          expiry: value.expiry,
        };
      });
      this.loaded = true;
    }
    if (this.prune(now)) this.persist();
  }

  private prune(now: number): boolean {
    let changed = false;
    for (const [token, record] of this.pending) {
      if (record.expiry <= now) {
        this.pending.delete(token);
        changed = true;
      }
    }
    return changed;
  }

  private persist(): void {
    atomicWriteEntries(this.filePath, this.pending);
  }
}

export function discordOauthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordOauthConfig | undefined {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const redirectUri = env.DISCORD_OAUTH_REDIRECT_URI?.trim();
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : undefined;
}

export function discordSsoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return discordOauthConfigFromEnv(env) !== undefined;
}

export function validatedNextPath(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  )
    return "/";
  try {
    const base = new URL("http://config-web.local/");
    const parsed = new URL(candidate, base);
    return parsed.origin === base.origin && parsed.username === "" && parsed.password === "" ? candidate : "/";
  } catch {
    return "/";
  }
}

export function newDiscordOauthState(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function discordOauthStateMatches(expected: string | undefined, submitted: string | null): boolean {
  if (!expected || !submitted || !TOKEN_PATTERN.test(expected) || !TOKEN_PATTERN.test(submitted)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(submitted, "hex"));
}

function transientCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearTransientCookie(name: string, secure: boolean): string {
  return `${name}=; Path=${COOKIE_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function buildDiscordOauthStateCookie(state: string, secure: boolean): string {
  return transientCookie(DISCORD_OAUTH_STATE_COOKIE, state, secure, Math.floor(DISCORD_SSO_TTL_MS / 1000));
}

export function buildClearDiscordOauthStateCookie(secure: boolean): string {
  return clearTransientCookie(DISCORD_OAUTH_STATE_COOKIE, secure);
}

export function buildDiscordPendingCookie(token: string, secure: boolean): string {
  return transientCookie(DISCORD_PENDING_COOKIE, token, secure, Math.floor(DISCORD_SSO_TTL_MS / 1000));
}

export function buildClearDiscordPendingCookie(secure: boolean): string {
  return clearTransientCookie(DISCORD_PENDING_COOKIE, secure);
}

export function discordAuthorizeUrl(config: DiscordOauthConfig, state: string): string {
  // prompt=consent: always show Discord's authorize screen (it names the active Discord account and
  // offers its own account switcher), so a sign-out → sign-in round-trip visibly re-runs the OAuth
  // flow with whatever Discord identity the browser currently holds (owner 08-27).
  return "https://discord.com/api/oauth2/authorize" +
    `?response_type=code&client_id=${encodeURIComponent(config.clientId)}` +
    `&redirect_uri=${encodeURIComponent(config.redirectUri)}` +
    `&scope=identify%20email&prompt=consent&state=${encodeURIComponent(state)}`;
}

export type DiscordStartHostGuard =
  | { kind: "proceed" }
  | { kind: "redirect"; status: 302; location: string };

export function discordStartHostGuard(
  config: DiscordOauthConfig,
  incomingHost: string | undefined,
  query: URLSearchParams,
): DiscordStartHostGuard {
  const redirect = new URL(config.redirectUri);
  const requestHost = incomingHost?.trim().toLowerCase() ?? "";
  const canonicalHost = redirect.host.toLowerCase();
  if (requestHost === canonicalHost) return { kind: "proceed" };

  const target = new URL("/api/auth/discord/start", redirect.origin);
  target.search = query.toString();
  if (target.host.toLowerCase() !== canonicalHost) {
    throw new Error("Discord OAuth canonical-host redirect could not be constructed.");
  }
  return { kind: "redirect", status: 302, location: target.toString() };
}

export function discordCompletionErrorUrl(
  config: DiscordOauthConfig,
  error: "host-browser-mismatch" | "expired" | "invalid-state",
): string {
  const target = new URL("/discord-complete.html", new URL(config.redirectUri).origin);
  target.searchParams.set("error", error);
  return target.toString();
}

export function discordAvatarUrl(discordId: string, avatarHash: string | undefined): string | undefined {
  if (!discordId || !avatarHash) return undefined;
  const extension = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordId)}/${encodeURIComponent(avatarHash)}.${extension}?size=256`;
}

/**
 * Complete the coach-account half of Discord SSO. The caller owns the pending-token
 * lifecycle and response cookies; this helper owns the security-sensitive choice among
 * returning login, proved association, and atomic new-account creation.
 *
 * Credential fields are copied into an explicit allowlist only for coachLogin, which
 * immediately reduces either carrier to a digest and verifies it through ffb_coaches.
 * They are never included in the identity record or returned result.
 */
export async function completeDiscordCoachAssociation(
  req: IncomingMessage,
  pending: PendingDiscordSso,
  rawBody: Record<string, unknown>,
  existingFfbCoachId: string | undefined,
  deps: DiscordSsoCompletionDeps,
  now = Date.now(),
  options: { requiredFfbCoachId?: string; allowCreate?: boolean } = {},
): Promise<DiscordSsoCompletionResult> {
  const named = (options.requiredFfbCoachId || existingFfbCoachId
    || (typeof rawBody.ffbCoachId === "string" ? rawBody.ffbCoachId : "")).trim().toLowerCase();
  // Serialised independently by Discord id AND by normalised coach name, always acquired in the same order.
  const [first, second] = [`discord:${pending.discordId}`, `coach:${named}`].sort();
  return serialised(first!, () => serialised(second!, () => {
    // Re-read the Discord association inside the locks: a sibling may have just confirmed it.
    const linked = existingFfbCoachId ?? deps.linkedCoachForDiscord?.(pending.discordId);
    return completeDiscordCoachAssociationNow(req, pending, rawBody, linked, deps, now, options);
  }));
}

/** Constant-time comparison of two hex digests (equal-length buffers only). */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), "utf8");
  const y = Buffer.from(b.toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

async function completeDiscordCoachAssociationNow(
  req: IncomingMessage,
  pending: PendingDiscordSso,
  rawBody: Record<string, unknown>,
  existingFfbCoachId: string | undefined,
  deps: DiscordSsoCompletionDeps,
  now: number,
  options: { requiredFfbCoachId?: string; allowCreate?: boolean },
): Promise<DiscordSsoCompletionResult> {
  const submittedFfbCoachId = typeof rawBody.ffbCoachId === "string" ? rawBody.ffbCoachId.trim() : "";
  const requiredFfbCoachId = options.requiredFfbCoachId?.trim() ?? "";
  if (
    requiredFfbCoachId && existingFfbCoachId &&
    requiredFfbCoachId.toLocaleLowerCase() !== existingFfbCoachId.trim().toLocaleLowerCase()
  ) {
    return {
      status: 409,
      body: { error: "That Discord identity is already linked to a different fork coach." },
    };
  }
  if (
    requiredFfbCoachId && submittedFfbCoachId &&
    requiredFfbCoachId.toLocaleLowerCase() !== submittedFfbCoachId.toLocaleLowerCase()
  ) {
    return { status: 400, body: { error: "The fork coach does not match the desktop sign-in request." } };
  }
  const requestedFfbCoachId = requiredFfbCoachId || existingFfbCoachId || submittedFfbCoachId;
  if (!requestedFfbCoachId)
    return { status: 400, body: { error: "ffbCoachId is required." } };
  if (requestedFfbCoachId.length > 40)
    return { status: 400, body: { error: "ffbCoachId must be at most 40 characters." } };

  const previous = deps.identityForCoach(requestedFfbCoachId);
  const ffbCoachId = previous?.ffbCoachId ?? requestedFfbCoachId;
  const linkedDiscordId = previous?.identities.discordUserId;
  if (linkedDiscordId && linkedDiscordId !== pending.discordId) {
    return {
      status: 409,
      body: { error: "That fork coach is already linked to another Discord account." },
    };
  }
  if (deps.isCoachBanned(ffbCoachId))
    return { status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } };

  const identities = {
    ...(previous?.identities ?? {}),
    discordUserId: pending.discordId,
    discordUsername: pending.discordUsername,
  };
  if (pending.discordAvatarHash) identities.discordAvatarHash = pending.discordAvatarHash;
  else delete identities.discordAvatarHash;
  if (pending.email) identities.email = pending.email;
  else delete identities.email;
  const newProfile = {
    displayName: pending.discordUsername,
    avatar: discordAvatarUrl(pending.discordId, pending.discordAvatarHash) ?? "",
  };
  const identityRecord: CoachIdentityRecord = {
    ffbCoachId,
    level: previous?.level ?? "player",
    banned: previous?.banned ?? false,
    silenced: previous?.silenced ?? false,
    note: previous?.note ?? "",
    profile: { ...(previous?.profile ?? newProfile) },
    ...(previous?.scheduling ? { scheduling: previous.scheduling } : {}),
    identities,
    updatedAt: new Date(now).toISOString(),
    updatedBy: "discord-sso",
  };

  let sessionToken: string;
  // A confirmed link for THIS Discord id (also when a serialised sibling request just confirmed it).
  if (existingFfbCoachId || linkedDiscordId === pending.discordId) {
    // Returning Discord identity (a CONFIRMED link): no fork credential lookup or password-row write.
    sessionToken = deps.createSessionToken(ffbCoachId, now);
  } else {
    if (!deps.fork) {
      return {
        status: 503,
        body: { error: "Fork DB not configured on this host (set FORK_DB_HOST)." },
      };
    }
    const fork = deps.fork;

    // A provisional signup for this Discord user resumes here (never through the returning-user path).
    const provisional = deps.provisional?.get(pending.discordId);
    if (provisional && provisional.coachName.toLowerCase() !== ffbCoachId.toLowerCase()) {
      // An ACTIVE signup (insert in flight, or its outcome unknown) is never discarded by choosing another name.
      return {
        status: 409,
        body: { error: `Finish or recover the pending signup for ${provisional.coachName} first.`, pendingCoach: provisional.coachName },
      };
    }
    const resuming = provisional && provisional.coachName.toLowerCase() === ffbCoachId.toLowerCase() ? provisional : undefined;

    /** Ownership of a fork row for a provisional signup: it exists AND carries exactly the generated digest. */
    const owns = async (rec: ProvisionalSignup): Promise<boolean> => {
      if (!fork.storedDigest) return false;
      const stored = await fork.storedDigest(rec.coachName);
      return !!stored && sameDigest(stored, rec.generatedDigest);
    };
    const insertProvisional = async (rec: ProvisionalSignup): Promise<"confirmed" | "taken" | "unknown"> => {
      let created: boolean;
      deps.provisional?.setActive?.(rec.operationId, true);
      try {
        created = await fork.createForkAccountDigestIfAvailable(rec.coachName, rec.generatedDigest);
      } catch {
        return "unknown"; // the record stays: the next sign-in resumes from it
      } finally {
        deps.provisional?.setActive?.(rec.operationId, false);
      }
      if (created) return "confirmed";
      try {
        return (await owns(rec)) ? "confirmed" : "taken";
      } catch {
        return "unknown";
      }
    };
    /** The confirmed link and the removal of its recovery record, in one durable write, BEFORE any session. */
    const confirmLink = (rec: ProvisionalSignup): void => {
      if (deps.provisional?.confirm) deps.provisional.confirm(identityRecord, rec.discordUserId, rec.operationId);
      else {
        deps.upsertIdentity(identityRecord);
        deps.provisional?.remove(rec.discordUserId, rec.operationId);
      }
    };
    const settle = (rec: ProvisionalSignup, outcome: "confirmed" | "taken" | "unknown"): DiscordSsoCompletionResult | undefined => {
      if (outcome === "unknown") {
        return { status: 503, body: { error: "Your account could not be confirmed yet. Sign in with Discord again to finish." } };
      }
      if (outcome === "taken") {
        deps.provisional?.remove(rec.discordUserId, rec.operationId);
        return { status: 409, body: { error: "That fork coach name was taken. Pick another name." } };
      }
      return undefined;
    };

    if (resuming) {
      let outcome: "confirmed" | "taken" | "unknown";
      try {
        outcome = (await fork.coachExists(resuming.coachName))
          ? ((await owns(resuming)) ? "confirmed" : "taken")
          : await insertProvisional(resuming);
      } catch {
        outcome = "unknown";
      }
      const stop = settle(resuming, outcome);
      if (stop) return stop;
      confirmLink(resuming);
      sessionToken = deps.createSessionToken(ffbCoachId, now);
      return { status: 200, body: { ok: true, coach: ffbCoachId, next: pending.next }, sessionToken };
    }

    if (await fork.coachExists(ffbCoachId)) {
      const hasCredential = Object.prototype.hasOwnProperty.call(rawBody, "passwordMd5")
        || Object.prototype.hasOwnProperty.call(rawBody, "password");
      if (!hasCredential) {
        return {
          status: 409,
          body: {
            error: "That coach already exists. Enter its fork password to link it without changing the account.",
            canLink: true,
          },
        };
      }

      // Reuse the shared digest normalization and coach/IP lockout counters. Only the
      // credential allowlist reaches coachLogin; no request-body spread can persist it.
      const login = await coachLogin(req, {
        body: {
          coach: ffbCoachId,
          passwordMd5: rawBody.passwordMd5,
          password: rawBody.password,
        },
        authenticationAvailable: true,
        verifyCoachDigest: deps.fork.verifyCoachDigest,
      }, now);
      if (login.status !== 200) {
        if (login.status === 401) {
          return {
            status: 403,
            body: { error: "The fork password for that coach is incorrect." },
          };
        }
        return {
          status: login.status,
          body: login.body && typeof login.body === "object"
            ? login.body as Record<string, unknown>
            : { error: "Fork coach authentication failed." },
          ...(login.headers ? { headers: login.headers } : {}),
        };
      }
      const token = login.body && typeof login.body === "object"
        && typeof (login.body as { token?: unknown }).token === "string"
        ? (login.body as { token: string }).token
        : undefined;
      if (!token) throw new Error("Fork credential exchange did not return a session token.");
      sessionToken = token;
    } else {
      if (options.allowCreate === false) {
        return {
          status: 404,
          body: { error: "That fork coach account does not exist. Create it before signing in." },
        };
      }
      // New-name path: a generated credential and an atomic insert. A durable provisional record (Discord id,
      // name, generated digest, operation id) is written FIRST, so an unconfirmed insert or a restart resumes from
      // it above. The Discord link itself is written only once the account is confirmed ours.
      const digest = coachSecretDigest({ password: randomBytes(32).toString("hex") }).digest;
      if (!digest) throw new Error("Could not generate a fork credential.");
      const rec: ProvisionalSignup = {
        discordUserId: pending.discordId,
        coachName: ffbCoachId,
        generatedDigest: digest.toLowerCase(),
        operationId: randomBytes(9).toString("base64url"),
        state: "provisional",
        createdAt: new Date(now).toISOString(),
      };
      deps.provisional?.put(rec);
      const outcome = await insertProvisional(rec);
      if (!deps.provisional && outcome === "unknown") {
        return { status: 503, body: { error: "Your account could not be confirmed yet. Try again." } };
      }
      const stop = settle(rec, outcome);
      if (stop) return outcome === "taken" ? { status: 409, body: { error: "That fork coach name already exists." } } : stop;
      confirmLink(rec);
      sessionToken = deps.createSessionToken(ffbCoachId, now);
      return { status: 200, body: { ok: true, coach: ffbCoachId, next: pending.next }, sessionToken };
    }
  }

  deps.upsertIdentity(identityRecord);

  return {
    status: 200,
    body: { ok: true, coach: ffbCoachId, next: pending.next },
    sessionToken,
  };
}

export async function coachNameAvailable(
  coach: string,
  exists: (name: string) => Promise<boolean>,
): Promise<boolean> {
  return !(await exists(coach.trim()));
}

export function sessionOwnsCoach(sessionCoach: string | undefined, requestedCoach: string): boolean {
  return sessionCoach?.trim().toLowerCase() === requestedCoach.trim().toLowerCase();
}

export async function fetchDiscordIdentity(
  config: DiscordOauthConfig,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<DiscordIdentity> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const tokenResponse = await fetchFn("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tokenResponse.ok) throw new Error("Discord OAuth token exchange failed.");
  const tokenBody = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token)
    throw new Error("Discord OAuth token exchange failed.");

  const userResponse = await fetchFn("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!userResponse.ok) throw new Error("Discord user lookup failed.");
  const user = (await userResponse.json()) as {
    id?: unknown;
    username?: unknown;
    avatar?: unknown;
    email?: unknown;
    verified?: unknown;
  };
  if (typeof user.id !== "string" || !user.id || typeof user.username !== "string" || !user.username)
    throw new Error("Discord user lookup returned an invalid identity.");
  const email = user.verified === true && typeof user.email === "string" && user.email.trim()
    ? user.email.trim()
    : undefined;
  const discordAvatarHash = typeof user.avatar === "string" && user.avatar
    ? user.avatar
    : undefined;
  return {
    discordId: user.id,
    discordUsername: user.username,
    ...(discordAvatarHash ? { discordAvatarHash } : {}),
    ...(email ? { email } : {}),
  };
}

export function shouldBlockExistingRegistration(input: {
  exists: boolean;
  requestedCoach: string;
  sessionCoach?: string;
  adminAuthed: boolean;
}): boolean {
  if (!input.exists || input.adminAuthed) return false;
  return input.sessionCoach?.trim().toLowerCase() !== input.requestedCoach.trim().toLowerCase();
}
