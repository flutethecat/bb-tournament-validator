// The replay reader wired for config-web: the moments cache under the data store, the background job (only when the
// fork's admin API is configured: the job's guard reads the fork's finished list), the results-store trigger, and the
// game page's view of one game. server.ts creates one and hands `forGame` / `revision` to the game-page loader.

import type { ForkAdminConfig } from "@bb/fork-ops";
import type { ReplayState } from "../gameDetail.js";
import { onResultStored, type StoredTournamentResult } from "../tournamentResults.js";
import { createReplayJob, finishedGameGuards, type ReplayJob } from "./job.js";
import { readReplay, replayOptionsFromEnv, type ReplayReadOptions } from "./reader.js";
import { ReplayMomentStore, type ReplayEntry } from "./store.js";

export interface ReplayServiceDeps {
  dataDir: string;
  adminCfg: ForkAdminConfig | undefined;
  results: { listAll(): StoredTournamentResult[] };
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Off in tests: no timers. */
  start?: boolean;
}

export interface ReplayService {
  store: ReplayMomentStore;
  job: ReplayJob | undefined;
  forGame(gameId: string): { state: ReplayState; entry?: ReplayEntry };
  revision(): string;
  stop(): void;
}

export function createReplayService(deps: ReplayServiceDeps): ReplayService {
  const store = new ReplayMomentStore(deps.dataDir);
  const env = deps.env ?? process.env;
  const off = /^(false|0|no|off)$/i.test((env.FORK_REPLAY_ENABLED ?? "").trim());
  const options: ReplayReadOptions = replayOptionsFromEnv(env);
  const adminCfg = deps.adminCfg;
  const job = adminCfg && !off
    ? createReplayJob({
      store,
      rows: () => deps.results.listAll(),
      guards: () => finishedGameGuards(adminCfg),
      read: (gameId) => readReplay(gameId, options),
      log: deps.log ?? ((line) => console.log(line)),
    })
    : undefined;
  const unsubscribe = job ? onResultStored((row) => job.enqueue(row.gameId)) : () => {};
  if (job && deps.start !== false) job.start();
  return {
    store,
    job,
    forGame(gameId) {
      const entry = store.get(gameId);
      if (entry) return { state: entry.status, entry };
      return { state: job ? job.status(gameId) : "unavailable" };
    },
    revision: () => store.revision(),
    stop() { unsubscribe(); job?.stop(); },
  };
}
