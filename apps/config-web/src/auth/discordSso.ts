import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coachSecretDigest } from "@bb/fork-ops";
import { BANNED_ACCOUNT_MESSAGE } from "./access.js";
import { coachLogin } from "./coachLogin.js";
import type { CoachIdentityRecord } from "./identitiesStore.js";

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
}

export interface DiscordSsoForkAccountDeps {
  coachExists: (coach: string) => Promise<boolean>;
  verifyCoachDigest: (coach: string, passwordMd5: string) => Promise<boolean>;
  createForkAccountDigestIfAvailable: (coach: string, passwordMd5: string) => Promise<boolean>;
}

export interface DiscordSsoCompletionDeps {
  fork?: DiscordSsoForkAccountDeps;
  identityForCoach: (coach: string) => CoachIdentityRecord | undefined;
  isCoachBanned: (coach: string) => boolean;
  upsertIdentity: (record: CoachIdentityRecord) => void;
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

  create(next: unknown, now = Date.now()): string {
    this.loadAndPrune(now);
    const state = newDiscordOauthState();
    this.states.set(state, { next: validatedNextPath(next), expiry: now + DISCORD_SSO_TTL_MS });
    this.persist();
    return state;
  }

  consume(state: string | undefined, now = Date.now()): string | undefined {
    this.loadAndPrune(now);
    if (!state || !TOKEN_PATTERN.test(state)) return undefined;
    const record = this.states.get(state);
    if (!record) return undefined;
    this.states.delete(state);
    this.persist();
    return record.next;
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
        return { next: validatedNextPath(value.next), expiry: value.expiry };
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
  return "https://discord.com/api/oauth2/authorize" +
    `?response_type=code&client_id=${encodeURIComponent(config.clientId)}` +
    `&redirect_uri=${encodeURIComponent(config.redirectUri)}` +
    `&scope=identify%20email&state=${encodeURIComponent(state)}`;
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
): Promise<DiscordSsoCompletionResult> {
  const submittedFfbCoachId = typeof rawBody.ffbCoachId === "string" ? rawBody.ffbCoachId.trim() : "";
  const requestedFfbCoachId = existingFfbCoachId ?? submittedFfbCoachId;
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

  let sessionToken: string;
  if (existingFfbCoachId) {
    // Returning Discord identity: no fork credential lookup or password-row write.
    sessionToken = deps.createSessionToken(ffbCoachId, now);
  } else {
    if (!deps.fork) {
      return {
        status: 503,
        body: { error: "Fork DB not configured on this host (set FORK_DB_HOST)." },
      };
    }

    if (await deps.fork.coachExists(ffbCoachId)) {
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
      // New-name path: preserve the existing generated-password + atomic insert behavior.
      const digest = coachSecretDigest({ password: randomBytes(32).toString("hex") }).digest;
      if (!digest) throw new Error("Could not generate a fork credential.");
      if (!(await deps.fork.createForkAccountDigestIfAvailable(ffbCoachId, digest))) {
        return { status: 409, body: { error: "That fork coach name already exists." } };
      }
      sessionToken = deps.createSessionToken(ffbCoachId, now);
    }
  }

  const identities = {
    ...(previous?.identities ?? {}),
    discordUserId: pending.discordId,
    discordUsername: pending.discordUsername,
  };
  if (pending.email) identities.email = pending.email;
  else delete identities.email;

  const newProfile = {
    displayName: pending.discordUsername,
    avatar: discordAvatarUrl(pending.discordId, pending.discordAvatarHash) ?? "",
  };
  deps.upsertIdentity({
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
  });

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
