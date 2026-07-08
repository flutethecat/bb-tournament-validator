/**
 * FUMBBL40k fork provisioning helpers for the `/bbbot 40k` admin commands.
 *
 * The implementations now live in the shared `@bb/fork-ops` package (lifted there once
 * config-web's `/api/fork/*` routes needed the same fork-team fetching/ingest logic, so
 * the two apps can't drift). This module stays as the bot's import surface — re-exporting
 * exactly what the commands use — so the rest of the bot keeps importing from "./fork40k".
 */

export {
  buildForkJnlp,
  copyForkTeam,
  createForkAccount,
  fetchForkTeam,
  forkConfigFromEnv,
  forkRosterNames,
  forkSupportsRace,
  ingestForkTeam,
  jnlpFilename,
  parseTeamId,
  queryCoaches,
  readLibrary,
  upsertLibraryTeam,
  type CopiedTeam,
  type ForkConfig,
  type ForkTeam,
  type LibraryTeam,
} from "@bb/fork-ops";
