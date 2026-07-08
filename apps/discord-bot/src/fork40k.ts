/**
 * FUMBBL40k fork provisioning — the `/bbbot 40k` admin commands. This is the ONLY
 * place the bot touches the fork's MariaDB or writes team files, and it only works
 * when the bot runs on the fork host (DB + teams dir are local there).
 *
 * Config comes from env (see .env.example: FORK_DB_*, FORK_TEAMS_DIR); when unset,
 * the commands report that fork provisioning isn't configured rather than crashing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";

/** hex(md5("12345")) — the fixed test password for provisioned fork coaches. */
const MD5_12345 = "827ccb0eea8a706c4c34a16891f84e7b";

export interface ForkConfig {
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  teamsDir: string;
}

/** Build fork config from env; undefined when FORK_TEAMS_DIR is unset (feature off). */
export function forkConfigFromEnv(): ForkConfig | undefined {
  const teamsDir = process.env.FORK_TEAMS_DIR;
  if (!teamsDir) return undefined;
  return {
    dbHost: process.env.FORK_DB_HOST || "127.0.0.1",
    dbPort: Number(process.env.FORK_DB_PORT || 3316),
    dbUser: process.env.FORK_DB_USER || "ffb",
    dbPassword: process.env.FORK_DB_PASSWORD || "ffb",
    dbName: process.env.FORK_DB_NAME || "ffblive",
    teamsDir,
  };
}

/**
 * Create (or reset) a fork test coach with password "12345". Parameterized — the
 * username is never interpolated into SQL.
 */
export async function createForkAccount(cfg: ForkConfig, username: string): Promise<void> {
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

export interface CopiedTeam {
  teamId: string;
  teamName: string;
  coach: string;
  path: string;
}

/** Pull a FUMBBL team id from a /t/<id> URL (or a bare id / ?id=<id>). */
export function parseTeamId(input: string): string | undefined {
  const s = String(input).trim();
  return (s.match(/\/t\/(\d+)/) ?? s.match(/[?&]id=(\d+)/) ?? s.match(/(\d+)\s*$/) ?? s.match(/^(\d+)$/))?.[1];
}

/** Filesystem-safe token (prevents path traversal from an external coach name). */
const safe = (s: string): string => s.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "unknown";

const xmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export interface ForkTeam {
  teamId: string;
  teamName: string;
  coach: string;
  xml: string;
}

/** Fetch a FUMBBL team from a /t/<id> URL (or id) and pull its coach + name. */
export async function fetchForkTeam(url: string): Promise<ForkTeam> {
  const teamId = parseTeamId(url);
  if (!teamId) throw new Error(`Couldn't find a team id in "${url}" — expected https://fumbbl.com/t/<id>.`);
  const res = await fetch(`https://fumbbl.com/xml:team?id=${teamId}`, { headers: { accept: "application/xml" } });
  if (!res.ok) throw new Error(`FUMBBL xml:team ${teamId}: HTTP ${res.status}.`);
  const xml = await res.text();
  const coach = (xml.match(/<coach>([^<]*)<\/coach>/i)?.[1] ?? "").trim();
  const teamName = (xml.match(/<name>([^<]*)<\/name>/i)?.[1] ?? "").trim();
  if (!coach) throw new Error(`No <coach> found in the team XML for ${teamId} (private team or wrong id?).`);
  return { teamId, teamName, coach, xml };
}

/**
 * Fetch a FUMBBL team's XML and save it into the fork's teams dir as
 * `team_<coach>_<id>.xml`. The FFB game server must restart to load new team files.
 */
export async function copyForkTeam(cfg: ForkConfig, url: string): Promise<CopiedTeam> {
  const t = await fetchForkTeam(url);
  mkdirSync(cfg.teamsDir, { recursive: true });
  const path = join(cfg.teamsDir, `team_${safe(t.coach)}_${t.teamId}.xml`);
  writeFileSync(path, t.xml, "utf8");
  return { teamId: t.teamId, teamName: t.teamName, coach: t.coach, path };
}

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
