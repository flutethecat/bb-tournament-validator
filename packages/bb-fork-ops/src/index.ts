/**
 * Shared FUMBBL40k fork-ops logic — used by BOTH the Discord bot (`/bbbot 40k`) and
 * config-web's `/api/fork/*` routes, so the two apps behave identically instead of
 * duplicating (and silently drifting from) the same fork-account/JNLP contract.
 */

import mysql from "mysql2/promise";

const xmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Filesystem-safe token (prevents path traversal from an external coach/game name). */
const safe = (s: string): string => s.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "unknown";

/**
 * Build a fork-join JNLP for the FFB client (standalone `-fork` join). The fork HOST
 * is deliberately omitted — the client uses its configured fork IP. `coach` must match
 * the team's owner; both coaches join with the SAME `gameName` (2nd join starts the game).
 */
export function buildForkJnlp(opts: { coach: string; teamId: string; gameName: string; password?: string }): string {
  const coach = xmlEscape(opts.coach);
  const gameName = xmlEscape(opts.gameName);
  const password = xmlEscape(opts.password || "12345");
  const teamId = xmlEscape(opts.teamId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<jnlp><information><title>FUMBBL40k fork - ${gameName} (${coach})</title><vendor>FUMBBL40k</vendor></information>
<application-desc>
  <argument>-player</argument><argument>-fork</argument>
  <argument>-coach</argument><argument>${coach}</argument>
  <argument>-password</argument><argument>${password}</argument>
  <argument>-gameName</argument><argument>${gameName}</argument>
  <argument>-teamId</argument><argument>${teamId}</argument>
</application-desc></jnlp>
`;
}

/** A safe download filename for a coach's game JNLP. */
export const jnlpFilename = (gameName: string, coach: string): string =>
  `fork_${safe(gameName)}_${safe(coach)}.jnlp`;

/** hex(md5("12345")) — the fixed test password for provisioned fork coaches. */
const MD5_12345 = "827ccb0eea8a706c4c34a16891f84e7b";

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

/**
 * Create (or reset) a fork test coach with password "12345". Parameterized — the
 * username is never interpolated into SQL.
 */
export async function createForkAccount(cfg: ForkDbConfig, username: string): Promise<void> {
  const name = username.trim();
  if (!name) throw new Error("Username is required.");
  if (name.length > 40) throw new Error("Username must be ≤ 40 characters (ffb_coaches.name).");
  const conn = await mysql.createConnection({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
  });
  try {
    await conn.execute(
      "INSERT INTO ffb_coaches (name, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)",
      [name, MD5_12345],
    );
  } finally {
    await conn.end();
  }
}
