/**
 * FUMBBL40k fork-join JNLP builder. Pure string logic, no I/O — shared by the
 * Discord bot's `/bbbot 40k launch` and config-web's `/api/fork/jnlp` so both
 * produce byte-identical JNLPs from the same inputs.
 */

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
