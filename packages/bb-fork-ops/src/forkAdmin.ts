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
  opts?: { overtime?: boolean },
): Promise<{ gameId: string }> {
  const challenge = await adminChallenge(cfg);
  const response = adminResponse(challenge, cfg.passwordMd5Hex);
  // OVERTIME is a per-game opt-in on the fork's /admin/schedule (default off server-side):
  // only send it when the caller asked, so a tie only goes to overtime + shootout on request.
  const overtimeParam = opts?.overtime ? "&overtime=true" : "";
  const url = `${cfg.baseUrl}/admin/schedule?response=${encodeURIComponent(response)}&teamHomeId=${encodeURIComponent(teamHomeId)}&teamAwayId=${encodeURIComponent(teamAwayId)}${overtimeParam}`;
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

/**
 * Generic authenticated admin call — challenge → response → `GET /admin/<op>?response=...
 * &<params>`, returning the raw XML. Backs the read/manage ops below (`list`, `cache`,
 * `close`, `delete`, `concede`, `message`) per `ForVeers-admin-schedule-panel-spec.md` §6.
 * Deliberately excludes destructive/irreversible ops (`shutdown`, `redeploy`, `purgetest`)
 * from this module entirely — the spec calls for hard-gating those out of the panel, and
 * the simplest hard gate is "the code to call them doesn't exist here."
 */
async function adminCommand(cfg: ForkAdminConfig, op: string, params: Record<string, string> = {}): Promise<string> {
  const challenge = await adminChallenge(cfg);
  const response = adminResponse(challenge, cfg.passwordMd5Hex);
  const qs = new URLSearchParams({ response, ...params }).toString();
  const res = await fetchWithTimeout(`${cfg.baseUrl}/admin/${op}?${qs}`);
  const xml = await res.text();
  const error = xmlTag(xml, "error");
  if (error) throw new Error(`fork admin/${op}: ${error}`);
  if (!res.ok) throw new Error(`fork admin/${op} failed (HTTP ${res.status}): ${xml.slice(0, 300)}`);
  return xml;
}

/**
 * Authoritative SEAT truth for {gameId, coach}: is this coach the HOME or AWAY coach of the game, in
 * the SERVER/GLOBAL (un-mirrored) frame? Used by the Super Module to normalize presentation coordinates
 * (SM-1/RC-1) — a client can't tell the service its own global seat because its FFB model is
 * perspective-mirrored (self-as-home always), so the service must read the seat from the server.
 *
 * Returns "home" / "away" for a participant, or null when the coach is NOT a participant of the game
 * (⇒ reject the Super handshake — admit-unverified is forbidden).
 *
 * Endpoint contract CONFIRMED against fork source (`GameStateServlet.java` + the game/team JSON model):
 *   - `/gamestate/get` REQUIRES the admin challenge-auth (`checkResponse`, keyed on ADMIN_PASSWORD) — it
 *     is NOT open-read. Flow: GET `/gamestate/challenge` → `<challenge>` → response = the same XOR/MD5
 *     scheme as the /admin ops (`adminResponse`) → GET `/gamestate/get?response=…&gameId=…`.
 *   - The body is JSON (`gameState.toJsonValue()`), NOT XML. Shape (keys confirmed via IJsonOption /
 *     Game/Team.toJsonValue): `{ game: { teamHome: { coach }, teamAway: { coach } } }`, with possible
 *     denormalized `game.teamHomeCoach` / `game.teamAwayCoach` mirrors.
 *
 * ⚠ VERIFY-OWED AT STAGE-5 (live): the coach JSON PATH above is source-grounded but unconfirmed against
 * a live capture — TK captures one `/gamestate/get` JSON from an active game so this exact navigation is
 * proven end-to-end. This function is the single swap point; the Super service depends only on the
 * SeatResolver interface, not on this shape. `includeLog=false` keeps the payload small.
 */
export async function forkGameSeat(cfg: ForkAdminConfig, gameId: string, coach: string): Promise<"home" | "away" | null> {
  const wanted = coach.trim().toLowerCase();
  if (!gameId || !wanted) return null;
  // 1. gamestate-servlet challenge (its OWN /gamestate/challenge, not /admin/challenge) → response.
  const chRes = await fetchWithTimeout(`${cfg.baseUrl}/gamestate/challenge`);
  const chXml = await chRes.text();
  const challenge = xmlTag(chXml, "challenge");
  if (!chRes.ok || !challenge) throw new Error(`fork gamestate/challenge failed (HTTP ${chRes.status})`);
  const response = adminResponse(challenge, cfg.passwordMd5Hex);
  // 2. authenticated get (JSON).
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/gamestate/get?response=${encodeURIComponent(response)}&gameId=${encodeURIComponent(gameId)}&includeLog=false`,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`fork gamestate/get failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`fork gamestate/get returned non-JSON (${text.slice(0, 120)})`); }
  const game = (json as { game?: Record<string, unknown> }).game ?? (json as Record<string, unknown>);
  const teamCoach = (side: "teamHome" | "teamAway", flat: "teamHomeCoach" | "teamAwayCoach"): string => {
    const team = game[side] as { coach?: unknown } | undefined;
    const nested = typeof team?.coach === "string" ? team.coach : undefined;
    const denorm = typeof game[flat] === "string" ? (game[flat] as string) : undefined;
    return (nested ?? denorm ?? "").trim().toLowerCase();
  };
  const homeCoach = teamCoach("teamHome", "teamHomeCoach");
  const awayCoach = teamCoach("teamAway", "teamAwayCoach");
  if (homeCoach && homeCoach === wanted) return "home";
  if (awayCoach && awayCoach === wanted) return "away";
  return null; // not a participant
}

/** Compact, authoritative result payload returned by the finished-game endpoint. */
export interface GamestatePlayerResult {
  playerId: string;
  name: string;
  touchdowns: number;
  casualtiesCaused: number;
  blocks: number;
  fouls: number;
  completions: number;
  interceptions: number;
  deflections: number;
  mvp: number;
}

export interface GamestateTeamResult {
  teamId: string;
  score: number;
  winnings: number;
  penaltyScore: number;
  conceded: boolean;
  casualtiesSuffered: { bh: number; si: number; rip: number };
  players: GamestatePlayerResult[];
}

export interface GamestateResult {
  teams: GamestateTeamResult[];
}

const xmlDecode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const resultAttr = (attributes: string, name: string): string | undefined =>
  attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];

const resultNumber = (xml: string, tag: string): number => {
  const value = Number(xmlTag(xml, tag) ?? 0);
  return Number.isFinite(value) ? value : 0;
};

function parseGamestateResultXml(xml: string): GamestateResult {
  if (!/<gameResult\b/i.test(xml)) throw new Error(`fork gamestate/result returned invalid XML (${xml.slice(0, 120)})`);
  const teams: GamestateTeamResult[] = [];
  for (const teamMatch of xml.matchAll(/<teamResult\b([^>]*)>([\s\S]*?)<\/teamResult>/gi)) {
    const teamId = xmlDecode(resultAttr(teamMatch[1]!, "teamId") ?? "");
    const body = teamMatch[2]!;
    if (!teamId) throw new Error("fork gamestate/result returned a teamResult without teamId");
    const casualtyTag = body.match(/<casualtiesSuffered\b([^>]*)\/?\s*>/i)?.[1] ?? "";
    const casualtyNumber = (name: string): number => {
      const value = Number(resultAttr(casualtyTag, name) ?? 0);
      return Number.isFinite(value) ? value : 0;
    };
    const players: GamestatePlayerResult[] = [];
    for (const playerMatch of body.matchAll(/<playerResult\b([^>]*)>([\s\S]*?)<\/playerResult>/gi)) {
      const playerBody = playerMatch[2]!;
      const spp = playerBody.match(/<starPlayerPoints\b[^>]*>([\s\S]*?)<\/starPlayerPoints>/i)?.[1] ?? "";
      const statistics = playerBody.match(/<statistics\b[^>]*>([\s\S]*?)<\/statistics>/i)?.[1] ?? "";
      players.push({
        playerId: xmlDecode(resultAttr(playerMatch[1]!, "playerId") ?? ""),
        name: xmlDecode(resultAttr(playerMatch[1]!, "name") ?? ""),
        touchdowns: resultNumber(spp, "touchdowns"),
        casualtiesCaused: resultNumber(spp, "casualties"),
        blocks: resultNumber(statistics, "blocks"),
        fouls: resultNumber(statistics, "fouls"),
        completions: resultNumber(spp, "completions"),
        interceptions: resultNumber(spp, "interceptions"),
        deflections: resultNumber(spp, "deflections"),
        mvp: resultNumber(spp, "playerAwards"),
      });
    }
    teams.push({
      teamId,
      score: resultNumber(body, "score"),
      winnings: resultNumber(body, "winnings"),
      // Upstream FumbblResult.addToXml emits <penaltyScore> only when >= 0 (shootout happened);
      // absent means "no penalty score" and MUST stay -1, or every normal game reads as 0-0.
      penaltyScore: xmlTag(body, "penaltyScore") === undefined ? -1 : resultNumber(body, "penaltyScore"),
      conceded: /^(?:true|1)$/i.test(xmlTag(body, "conceded")?.trim() ?? ""),
      casualtiesSuffered: {
        bh: casualtyNumber("badlyHurt"),
        si: casualtyNumber("seriousInjury"),
        rip: casualtyNumber("rip"),
      },
      players,
    });
  }
  if (teams.length !== 2) throw new Error(`fork gamestate/result returned ${teams.length} teamResult blocks; expected 2`);
  return { teams };
}

/** Pull the authoritative, finished-game result XML using a fresh one-shot challenge. */
export async function gamestateResult(cfg: ForkAdminConfig, gameId: string): Promise<GamestateResult> {
  const chRes = await fetchWithTimeout(`${cfg.baseUrl}/gamestate/challenge`);
  const chXml = await chRes.text();
  const challenge = xmlTag(chXml, "challenge");
  if (!chRes.ok || !challenge) throw new Error(`fork gamestate/challenge failed (HTTP ${chRes.status})`);
  const response = adminResponse(challenge, cfg.passwordMd5Hex);
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/gamestate/result?response=${encodeURIComponent(response)}&gameId=${encodeURIComponent(gameId)}`,
  );
  const xml = await res.text();
  const error = xmlTag(xml, "error");
  if (error) throw new Error(`fork gamestate/result: ${error}`);
  if (!res.ok) throw new Error(`fork gamestate/result failed (HTTP ${res.status}): ${xml.slice(0, 200)}`);
  return parseGamestateResultXml(xml);
}

/** `list <status>` — scheduled/active/finished/all games. Raw XML; caller/route normalizes. */
export const adminList = (cfg: ForkAdminConfig, status = "all"): Promise<string> => adminCommand(cfg, "list", { status });

export interface AdminGameEntry {
  gameId: string;
  status: string;
  half: number;
  turn: number;
  started?: string;
  finished?: string;
  lastUpdated?: string;
  homeTeamId: string;
  homeTeamName: string;
  homeCoach: string;
  awayTeamId: string;
  awayTeamName: string;
  awayCoach: string;
}

const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

/**
 * Parse `admin/list`'s `<list><game id=".." status=".." half=".." turn=".."><team
 * home="true" id=".." name=".." coach=".."/><team home="false" .../></game>...</list>`
 * (per upstream `AdminListEntry.addToXml`) into structured entries. Regex-based, not a
 * full XML parser — the servlet's output is flat/attribute-only (no nested text content
 * or entities beyond XML-escaping), so this is a safe, dependency-free match for the
 * shape it actually produces.
 */
export function parseAdminGameList(xml: string): AdminGameEntry[] {
  const entries: AdminGameEntry[] = [];
  const gameRe = /<game\b([^>]*)>([\s\S]*?)<\/game>/g;
  let m: RegExpExecArray | null;
  while ((m = gameRe.exec(xml))) {
    const [, gameAttrs, body] = m;
    const teams = [...body!.matchAll(/<team\b([^>]*)\/>/g)].map((t) => t[1]!);
    const home = teams.find((t) => attr(t, "home") === "true");
    const away = teams.find((t) => attr(t, "home") === "false");
    const gameId = attr(gameAttrs!, "id");
    if (!gameId || !home || !away) continue;
    entries.push({
      gameId,
      status: attr(gameAttrs!, "status") ?? "",
      half: Number(attr(gameAttrs!, "half") ?? 0),
      turn: Number(attr(gameAttrs!, "turn") ?? 0),
      started: attr(gameAttrs!, "started"),
      finished: attr(gameAttrs!, "finished"),
      lastUpdated: attr(gameAttrs!, "lastUpdated"),
      homeTeamId: attr(home, "id") ?? "",
      homeTeamName: attr(home, "name") ?? "",
      homeCoach: attr(home, "coach") ?? "",
      awayTeamId: attr(away, "id") ?? "",
      awayTeamName: attr(away, "name") ?? "",
      awayCoach: attr(away, "coach") ?? "",
    });
  }
  return entries;
}

/**
 * Statuses that represent a game still "in play" (per upstream `GameStatus` — note
 * there is NO "all" status: `admin/list?status=all` resolves to `GameStatusFactory
 * .forName("all")` = null server-side, which silently returns an EMPTY list, not
 * everything — a real trap if you assume "all" means "all"). To see every live game,
 * query each of these statuses and merge.
 */
export const LIVE_GAME_STATUSES = ["scheduled", "starting", "active", "paused"] as const;

/** Fetch + merge `admin/list` across every "in play" status (see `LIVE_GAME_STATUSES`),
 *  parsed into structured entries. This is the correct way to answer "what games are
 *  live right now", since a single `status=all` call returns nothing.
 *  Deduped by gameId: the per-status calls run in parallel, so a game whose status
 *  transitions (e.g. active -> paused) between two of them can legitimately be returned
 *  by both — observed live against the real fork. Last-seen wins (order follows
 *  `LIVE_GAME_STATUSES`), which is an acceptable, harmless race (worst case: the
 *  reported status/half/turn for that one entry is a query or two stale). */
export async function adminListLive(cfg: ForkAdminConfig): Promise<AdminGameEntry[]> {
  const xmls = await Promise.all(LIVE_GAME_STATUSES.map((status) => adminList(cfg, status)));
  const byId = new Map<string, AdminGameEntry>();
  for (const entry of xmls.flatMap(parseAdminGameList)) byId.set(entry.gameId, entry);
  return [...byId.values()];
}

/** `cache` — the admin API's live game-cache dump. Raw XML; caller/route normalizes. */
export const adminCache = (cfg: ForkAdminConfig): Promise<string> => adminCommand(cfg, "cache");

/**
 * `close <gameId>` — end a game cleanly. ⚠ Param name is `gameId`, NOT `id` — the
 * servlet's `_PARAMETER_GAME_ID = "gameId"` (verified against upstream
 * `AdminServlet.handleClose`/`handleDelete`/`handleConcede`, all read `gameId`). The
 * three `adminCommand` calls below previously sent `id`, which the servlet doesn't
 * recognize — every close/delete/concede call has always failed with "Invalid or
 * missing gameId parameter" (thrown, not silent, but never actually worked).
 */
export const adminClose = (cfg: ForkAdminConfig, gameId: string): Promise<string> =>
  adminCommand(cfg, "close", { gameId });

/** `delete <gameId>` — remove a game (irreversible for that game row, but not server-destructive). */
export const adminDelete = (cfg: ForkAdminConfig, gameId: string): Promise<string> =>
  adminCommand(cfg, "delete", { gameId });

/** `concede <gameId> <teamId>` — force a concession for one side of a stuck game. */
export const adminConcede = (cfg: ForkAdminConfig, gameId: string, teamId: string): Promise<string> =>
  adminCommand(cfg, "concede", { gameId, teamId });

/**
 * `refresh` — hot-reload the fork's standalone team/roster caches from disk, so a
 * newly-ingested team/roster becomes joinable WITHOUT a server restart. Safe during live
 * games (the caches are only read at new game create/join; in-progress games are untouched).
 * Returns the post-reload cache counts.
 */
export async function adminRefresh(cfg: ForkAdminConfig): Promise<{ teams: number; rosters: number }> {
  const xml = await adminCommand(cfg, "refresh");
  return {
    teams: Number(/teams="(\d+)"/.exec(xml)?.[1] ?? 0),
    rosters: Number(/rosters="(\d+)"/.exec(xml)?.[1] ?? 0),
  };
}

/** `message <text>` — broadcast an admin message to connected sessions. The servlet reads
 *  the `message` query param (per server-dev.ini's `admin.url.message` + AdminServlet's
 *  _PARAMETER_MESSSAGE = "message") — NOT `msg`, which it silently ignores. */
export const adminMessage = (cfg: ForkAdminConfig, text: string): Promise<string> =>
  adminCommand(cfg, "message", { message: text });
