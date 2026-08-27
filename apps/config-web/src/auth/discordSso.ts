import { randomBytes, timingSafeEqual } from "node:crypto";

export const DISCORD_OAUTH_STATE_COOKIE = "discord_oauth_state";
export const DISCORD_PENDING_COOKIE = "discord_sso_pending";
export const DISCORD_SSO_TTL_MS = 10 * 60 * 1000;

const COOKIE_PATH = "/api/auth/discord";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

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

interface StoredPendingDiscordSso extends PendingDiscordSso {
  expiry: number;
}

interface StoredDiscordOauthState {
  next: string;
  expiry: number;
}

export class DiscordOauthStateStore {
  private readonly states = new Map<string, StoredDiscordOauthState>();

  create(next: unknown, now = Date.now()): string {
    this.prune(now);
    const state = newDiscordOauthState();
    this.states.set(state, { next: validatedNextPath(next), expiry: now + DISCORD_SSO_TTL_MS });
    return state;
  }

  consume(state: string | undefined, now = Date.now()): string | undefined {
    this.prune(now);
    if (!state || !TOKEN_PATTERN.test(state)) return undefined;
    const record = this.states.get(state);
    if (!record) return undefined;
    this.states.delete(state);
    return record.next;
  }

  delete(state: string | undefined): boolean {
    return state ? this.states.delete(state) : false;
  }

  private prune(now: number): void {
    for (const [state, record] of this.states) {
      if (record.expiry <= now) this.states.delete(state);
    }
  }
}

export class PendingSsoStore {
  private readonly pending = new Map<string, StoredPendingDiscordSso>();

  create(record: PendingDiscordSso, now = Date.now()): string {
    this.prune(now);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    this.pending.set(token, { ...record, next: validatedNextPath(record.next), expiry: now + DISCORD_SSO_TTL_MS });
    return token;
  }

  get(token: string | undefined, now = Date.now()): PendingDiscordSso | undefined {
    this.prune(now);
    if (!token || !TOKEN_PATTERN.test(token)) return undefined;
    const record = this.pending.get(token);
    if (!record) return undefined;
    const { expiry: _expiry, ...copy } = record;
    return copy;
  }

  delete(token: string | undefined): boolean {
    return token ? this.pending.delete(token) : false;
  }

  private prune(now: number): void {
    for (const [token, record] of this.pending) {
      if (record.expiry <= now) this.pending.delete(token);
    }
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

export function discordAvatarUrl(discordId: string, avatarHash: string | undefined): string | undefined {
  if (!discordId || !avatarHash) return undefined;
  const extension = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordId)}/${encodeURIComponent(avatarHash)}.${extension}?size=256`;
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
