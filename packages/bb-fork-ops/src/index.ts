/**
 * Shared FUMBBL40k fork-ops logic — used by BOTH the Discord bot (`/bbbot 40k`) and
 * config-web's `/api/fork/*` routes, so the two apps behave identically instead of
 * duplicating (and silently drifting from) the same fork-account/JNLP contract.
 */

import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { xmlEscape, safe } from "./util.js";

// Team fetching / library / matchmaking / fork-reload / admin API live in submodules;
// re-exported here so consumers keep importing everything from "@bb/fork-ops".
export * from "./teams.js";
export * from "./library.js";
export * from "./matchmaking.js";
export * from "./forkReload.js";
export * from "./forkAdmin.js";

/**
 * Build a fork-join JNLP for the FFB client (standalone `-fork` join). The fork HOST
 * is deliberately omitted — the client uses its configured fork IP. `coach` must match
 * the team's owner. Without `gameId`: both coaches join with the SAME `gameName` (2nd
 * join starts the game — the original scheme). With `gameId` (from `scheduleForkGame`,
 * a real server-scheduled game): the client's `-fork` join reads `-gameId` as the
 * authoritative join target once it supports it (per `ServerCommandHandlerJoinApproved`,
 * gameId always takes priority over gameName server-side, so including both is safe —
 * this is additive, not a replacement, until the client picks it up).
 */
export function buildForkJnlp(opts: {
  coach: string;
  teamId: string;
  gameName: string;
  password?: string;
  gameId?: string | number;
}): string {
  const coach = xmlEscape(opts.coach);
  const gameName = xmlEscape(opts.gameName);
  const password = xmlEscape(opts.password || "12345");
  const teamId = xmlEscape(opts.teamId);
  const gameIdArg =
    opts.gameId != null && String(opts.gameId).trim() !== "" && String(opts.gameId) !== "0"
      ? `\n  <argument>-gameId</argument><argument>${xmlEscape(String(opts.gameId))}</argument>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<jnlp><information><title>FUMBBL40k fork - ${gameName} (${coach})</title><vendor>FUMBBL40k</vendor></information>
<application-desc>
  <argument>-player</argument><argument>-fork</argument>
  <argument>-coach</argument><argument>${coach}</argument>
  <argument>-password</argument><argument>${password}</argument>
  <argument>-gameName</argument><argument>${gameName}</argument>
  <argument>-teamId</argument><argument>${teamId}</argument>${gameIdArg}
</application-desc></jnlp>
`;
}

/** A safe download filename for a coach's game JNLP. */
export const jnlpFilename = (gameName: string, coach: string): string =>
  `fork_${safe(gameName)}_${safe(coach)}.jnlp`;

/** hex(md5(pw)) — FFB stores coach passwords as an md5 hex digest. */
const md5hex = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

/** hex(md5("12345")) — the default test password when a coach doesn't choose one. */
const MD5_12345 = md5hex("12345");

export interface ForkDbConfig {
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
}

const DB_DEFAULTS: ForkDbConfig = {
  dbHost: "127.0.0.1",
  dbPort: 3316,
  dbUser: "ffb",
  dbPassword: "ffb",
  dbName: "ffblive",
};

/**
 * DB-only fork config from env, gated on `FORK_DB_HOST` being explicitly set (the
 * "yes, this host means to talk to the fork DB" opt-in signal) — unlike
 * `forkConfigFromEnv`, this does NOT require `FORK_TEAMS_DIR`, since account
 * provisioning never touches the teams directory. Used by config-web's
 * `/api/fork/register`, which has no reason to know about team files.
 */
export function forkDbConfigFromEnv(): ForkDbConfig | undefined {
  const dbHost = process.env.FORK_DB_HOST;
  if (!dbHost) return undefined;
  return {
    dbHost,
    dbPort: Number(process.env.FORK_DB_PORT || DB_DEFAULTS.dbPort),
    dbUser: process.env.FORK_DB_USER || DB_DEFAULTS.dbUser,
    dbPassword: process.env.FORK_DB_PASSWORD || DB_DEFAULTS.dbPassword,
    dbName: process.env.FORK_DB_NAME || DB_DEFAULTS.dbName,
  };
}

export interface ForkConfig extends ForkDbConfig {
  teamsDir: string;
}

/**
 * Full fork config from env (DB + the teams directory), gated on `FORK_TEAMS_DIR`
 * being set — the bot's existing opt-in signal for team-file-writing operations
 * (`copyteam`). DB fields default even when `FORK_DB_HOST` is unset, preserving the
 * bot's original behavior exactly.
 */
export function forkConfigFromEnv(): ForkConfig | undefined {
  const teamsDir = process.env.FORK_TEAMS_DIR;
  if (!teamsDir) return undefined;
  return { ...(forkDbConfigFromEnv() ?? DB_DEFAULTS), teamsDir };
}

async function withConn<T>(cfg: ForkDbConfig, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

/**
 * Create (or reset) a fork test coach. Uses the coach's chosen `password` (md5-hashed)
 * when given, else the fixed test password "12345" (the bot's `createaccount` has no
 * password prompt). Parameterized — the username is never interpolated into SQL.
 */
export async function createForkAccount(cfg: ForkDbConfig, username: string, password?: string): Promise<void> {
  const name = username.trim();
  if (!name) throw new Error("Username is required.");
  if (name.length > 40) throw new Error("Username must be ≤ 40 characters (ffb_coaches.name).");
  const hash = password && password.length > 0 ? md5hex(password) : MD5_12345;
  await withConn(cfg, (conn) =>
    conn.execute(
      "INSERT INTO ffb_coaches (name, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)",
      [name, hash],
    ),
  );
}

/**
 * Case-insensitive prefix/substring search over fork coach names for opponent
 * autocomplete. LIKE wildcards in `q` are escaped so a "%"/"_" can't broaden the match;
 * `limit` is clamped to a bounded integer and inlined (LIKE ? placeholders are fine, but
 * a validated integer LIMIT avoids mysql2's prepared-LIMIT quirks). `exclude` drops the
 * requesting coach (you can't challenge yourself).
 */
/**
 * Verify a coach's password against `ffb_coaches` (md5 hex comparison, same hash the
 * fork itself uses). Used to authenticate `/api/fork/challenge` — without this, anyone
 * can issue BOTH sides of a "mutual" challenge under someone else's name and make
 * config-web fire admin `schedule` on their behalf (Yularen's #admin-gate-security
 * amendment §4b). Returns false (not a throw) for an unknown coach or wrong password —
 * callers should treat both identically to avoid leaking which one it was.
 */
export async function verifyCoachPassword(cfg: ForkDbConfig, username: string, password: string): Promise<boolean> {
  const name = username.trim();
  if (!name || !password) return false;
  const hash = md5hex(password);
  const rows = await withConn(cfg, async (conn) => {
    const [r] = await conn.execute("SELECT password FROM ffb_coaches WHERE name = ?", [name]);
    return r as Array<{ password: string }>;
  });
  return rows.length > 0 && rows[0]!.password === hash;
}

/**
 * Verify a coach's Super-channel challenge-response WITHOUT the plaintext ever crossing the wire
 * (Super Module SM-5/RC-2). `ffb_coaches.password` is already stored as `md5(pw)`, so the server can
 * recompute the expected response `md5(nonce + ts + md5(pw))` from the stored digest and compare it to
 * what the client sent — the password AND its md5 both stay server-side. Returns false (never throws)
 * for an unknown coach or a wrong response; callers treat both identically (no which-one leak, same as
 * `verifyCoachPassword`). The stored digest is NEVER returned out of this function.
 */
export async function verifyCoachChallenge(
  cfg: ForkDbConfig,
  username: string,
  nonce: string,
  ts: string,
  response: string,
): Promise<boolean> {
  const name = username.trim();
  if (!name || !nonce || !ts || !response) return false;
  const rows = await withConn(cfg, async (conn) => {
    const [r] = await conn.execute("SELECT password FROM ffb_coaches WHERE name = ?", [name]);
    return r as Array<{ password: string }>;
  });
  if (rows.length === 0) return false;
  const storedMd5 = rows[0]!.password; // md5(pw) hex — stays here
  return response === challengeResponseHex(nonce, ts, storedMd5);
}

/** Pure Super challenge-response hash: `md5(nonce + ts + md5(pw))`. Extracted from
 *  {@link verifyCoachChallenge} so the security-sensitive compare is unit-testable without a DB. */
export function challengeResponseHex(nonce: string, ts: string, storedMd5Hex: string): string {
  return md5hex(`${nonce}${ts}${storedMd5Hex}`);
}

export async function queryCoaches(cfg: ForkDbConfig, q: string, limit = 10, exclude?: string): Promise<string[]> {
  const needle = (q ?? "").trim();
  const lim = Math.min(50, Math.max(1, Math.floor(limit) || 10));
  // Escape LIKE metachars so "%"/"_" in the query can't broaden the match. Uses "!" as
  // the ESCAPE char (not backslash) to avoid backslash-doubling ambiguity between the JS
  // string literal and MariaDB's own string parsing.
  const escaped = needle.replace(/[!%_]/g, (c) => `!${c}`);
  const rows = await withConn(cfg, async (conn) => {
    const [r] = await conn.execute(
      `SELECT name FROM ffb_coaches
       WHERE LOWER(name) LIKE LOWER(?) ESCAPE '!'${exclude ? " AND LOWER(name) <> LOWER(?)" : ""}
       ORDER BY name LIMIT ${lim}`,
      exclude ? [`%${escaped}%`, exclude] : [`%${escaped}%`],
    );
    return r as Array<{ name: string }>;
  });
  return rows.map((row) => row.name);
}

/** Every registered fork account name — backs the users control panel's master table. */
export async function listForkCoaches(cfg: ForkDbConfig): Promise<string[]> {
  const rows = await withConn(cfg, async (conn) => {
    const [r] = await conn.execute("SELECT name FROM ffb_coaches ORDER BY name");
    return r as Array<{ name: string }>;
  });
  return rows.map((row) => row.name);
}
