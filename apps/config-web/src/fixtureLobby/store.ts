/**
 * Fixture lobby store: one JSON file per fixture under <FORK_STATE_DIR>/fixture-lobbies/<sha256(key)>.json (atomic
 * writes). The chat is kept with the lobby (spec §8: kept with the match record, not cleared at start); the privacy
 * collectors (src/privacy/collectors.ts "fixture-lobbies") export and anonymise it.
 *
 * Writes for one lobby run one at a time (withLobby): the read-modify-write never interleaves inside this process.
 * A file that exists but cannot be read is an error (never silently replaced by an empty lobby).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { LobbyRecord } from "./types.js";

export const LOBBY_DIR = "fixture-lobbies";
export const lobbyFileName = (key: string): string => `${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 40)}.json`;

export class FixtureLobbyStore {
  readonly dir: string;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(stateDir: string) {
    this.dir = join(stateDir, LOBBY_DIR);
  }

  private file(key: string): string { return join(this.dir, lobbyFileName(key)); }

  get(key: string): LobbyRecord | undefined {
    const file = this.file(key);
    if (!existsSync(file)) return undefined;
    const rec = JSON.parse(readFileSync(file, "utf8")) as LobbyRecord;
    if (rec.key !== key) throw new Error("fixture lobby file does not match its key");
    return rec;
  }

  put(rec: LobbyRecord): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWriteTextFile(this.file(rec.key), `${JSON.stringify(rec, null, 1)}\n`);
  }

  /** Runs `task` after every earlier task for the same lobby has finished. */
  withLobby<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(task, task);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return run;
  }
}
