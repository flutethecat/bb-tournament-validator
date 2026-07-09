/**
 * The fork's HTTP admin API (`AdminServlet`, upstream `christerk/ffb`) — used here only
 * for `schedule`, which creates a real game row server-side and returns an authoritative
 * `gameId` *before* either client connects. This replaces the "both coaches guess the
 * same gameName" scheme with a server-native one, matching how Tarkin/the owner scheduled
 * a match by hand via the admin controls.
 *
 * Auth is a challenge/response scheme documented in upstream `PasswordChallenge.java`:
 *   1. GET /admin/challenge -> a single-use hex challenge string.
 *   2. response = MD5(OPAD + MD5(IPAD + challenge)), OPAD = MD5(password) XOR 0x5c,
 *      IPAD = MD5(password) XOR 0x36 -- applied byte-for-byte over the 16-byte MD5
 *      digest of the password. This is NOT standard HMAC-MD5: textbook HMAC zero-pads
 *      the key to a 64-byte block before XORing; this scheme XORs the bare 16-byte
 *      digest. `crypto.createHmac` would silently compute a different, wrong value —
 *      hence the hand-rolled implementation below. Verified against the live fork's
 *      /admin/challenge + /admin/cache (a safe, read-only, same-auth op) before trusting
 *      this in code.
 *   3. GET /admin/<op>?response=<hex>&... — the challenge is consumed on first use.
 *
 * ⚠ `/admin/schedule` can HANG rather than error: `AdminServlet.handleSchedule` waits on a
 * `CountDownLatch` with NO TIMEOUT for the scheduled game's id, counted down only from a
 * listener the scheduling command invokes on success. If anything throws in the fork's
 * standalone-mode team-loading path before that listener fires (observed live 2026-07-09;
 * root cause not fully confirmed — a rules-initialization gap on this admin-only code path
 * is suspected, since it skips the `initRulesDependentMembers`/`initializeRules` step the
 * normal join path always does before parsing a roster), the request never completes and
 * the underlying Jetty thread is stuck indefinitely. Every fetch below carries its own
 * timeout so a fork-side hang degrades into a normal thrown error instead of hanging this
 * server too — `Matchmaker.pair()` already falls back to the gameName-only scheme on ANY
 * throw here, so a timeout is a clean, safe failure mode, not a special case.
 */

import { createHash } from "node:crypto";

const ADMIN_FETCH_TIMEOUT_MS = 5_000;

/** `fetch` with a hard timeout — aborts and throws rather than hanging on a stuck fork request. */
async function fetchWithTimeout(url: string, timeoutMs = ADMIN_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`fork admin request timed out after ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface ForkAdminConfig {
  /** e.g. http://127.0.0.1:22227 — the fork's HTTP admin API, same port as the game WS. */
  baseUrl: string;
  /** The fork's `admin.password` value (server-dev.ini) — already an MD5 hex, not cleartext. */
  passwordMd5Hex: string;
}

/** Gated on `FORK_ADMIN_PASSWORD` (opt-in, mirrors the other forkConfigFromEnv helpers). */
export function forkAdminConfigFromEnv(): ForkAdminConfig | undefined {
  const passwordMd5Hex = process.env.FORK_ADMIN_PASSWORD;
  if (!passwordMd5Hex) return undefined;
  const port = Number(process.env.FORK_GAME_PORT || 22227);
  const baseUrl = process.env.FORK_ADMIN_URL || `http://127.0.0.1:${port}`;
  return { baseUrl, passwordMd5Hex };
}

const xorBytes = (buf: Buffer, mask: number): Buffer => {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]! ^ mask;
  return out;
};
const md5 = (buf: Buffer): Buffer => createHash("md5").update(buf).digest();

/** Replicates upstream `PasswordChallenge.createResponse` exactly — see file header. */
export function adminResponse(challengeHex: string, passwordMd5Hex: string): string {
  const challenge = Buffer.from(challengeHex, "hex");
  const password = Buffer.from(passwordMd5Hex, "hex");
  const opad = xorBytes(password, 0x5c);
  const ipad = xorBytes(password, 0x36);
  const inner = md5(Buffer.concat([ipad, challenge]));
  const outer = md5(Buffer.concat([opad, inner]));
  return outer.toString("hex");
}

const xmlTag = (xml: string, tag: string): string | undefined => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"))?.[1];

/** Fetch a fresh, single-use admin challenge. */
export async function adminChallenge(cfg: ForkAdminConfig): Promise<string> {
  const res = await fetchWithTimeout(`${cfg.baseUrl}/admin/challenge`);
  const xml = await res.text();
  const challenge = xmlTag(xml, "challenge");
  if (!res.ok || !challenge) throw new Error(`fork admin/challenge failed (HTTP ${res.status}): ${xml.slice(0, 300)}`);
  return challenge;
}

/**
 * Schedule a game between two fork-loadable teams (by FUMBBL team id) directly on the
 * fork — server-native equivalent of the owner/Tarkin using the admin controls by hand.
 * Returns the authoritative gameId. Throws with the servlet's own `<error>` text on
 * failure (e.g. a team whose roster isn't loaded yet will surface here, since the
 * fork's ServerCommandHandlerScheduleGame calls the same getTeamById path ingest uses).
 */
export async function scheduleForkGame(
  cfg: ForkAdminConfig,
  teamHomeId: string,
  teamAwayId: string,
): Promise<{ gameId: string }> {
  const challenge = await adminChallenge(cfg);
  const response = adminResponse(challenge, cfg.passwordMd5Hex);
  const url = `${cfg.baseUrl}/admin/schedule?response=${encodeURIComponent(response)}&teamHomeId=${encodeURIComponent(teamHomeId)}&teamAwayId=${encodeURIComponent(teamAwayId)}`;
  // Longer budget than the default: this is the call known to hang server-side (see file
  // header) rather than error quickly, so give a real scheduling attempt a fair chance
  // before treating it as failed.
  const res = await fetchWithTimeout(url, 10_000);
  const xml = await res.text();
  const error = xmlTag(xml, "error");
  if (error) throw new Error(`fork admin/schedule: ${error}`);
  const gameId = xmlTag(xml, "gameId");
  if (!res.ok || xmlTag(xml, "status") !== "ok" || !gameId) {
    throw new Error(`fork admin/schedule failed (HTTP ${res.status}): ${xml.slice(0, 300)}`);
  }
  return { gameId };
}
