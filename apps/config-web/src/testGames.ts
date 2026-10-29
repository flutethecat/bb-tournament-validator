/**
 * Fork games that were test runs (league-fork-test rig, harness games): <dataDir>/test-games.json.
 *
 * A finished fork game stays in the fork's finished list forever, and /api/fork/records imports every finished game it
 * has not retained yet (tournamentResults.ts refreshFinishedResults). A game id listed here is marked test on every
 * read and every write of the results store, so it never counts in Elo, Glicko, standings, records or recent results,
 * whoever imported it and whenever. Entries are only added (a test game never becomes a real one).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";

export interface TestGameEntry { at: string; reason: string }
interface TestGameFile { version: 1; games: Record<string, TestGameEntry> }

export const TEST_GAMES_FILE = "test-games.json";

export class TestGameStore {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, TEST_GAMES_FILE);
  }

  private read(): TestGameFile {
    if (!existsSync(this.file)) return { version: 1, games: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TestGameFile>;
      if (raw.version !== 1 || !raw.games || typeof raw.games !== "object" || Array.isArray(raw.games)) return { version: 1, games: {} };
      return { version: 1, games: raw.games };
    } catch {
      return { version: 1, games: {} };
    }
  }

  /** The listed game ids. */
  ids(): Set<string> {
    return new Set(Object.keys(this.read().games));
  }

  has(gameId: string): boolean {
    return Object.hasOwn(this.read().games, gameId);
  }

  /** Lists these game ids as test games (already listed ones keep their first entry). Returns the ids newly added. */
  add(gameIds: string[], reason: string, now = new Date()): string[] {
    const data = this.read();
    const added: string[] = [];
    for (const raw of gameIds) {
      const id = String(raw).trim();
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || Object.hasOwn(data.games, id)) continue;
      data.games[id] = { at: now.toISOString(), reason: reason.slice(0, 200) };
      added.push(id);
    }
    if (added.length) atomicWriteTextFile(this.file, `${JSON.stringify(data, null, 2)}\n`);
    return added;
  }
}
