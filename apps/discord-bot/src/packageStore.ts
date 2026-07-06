/**
 * File-based tournament-package store: a directory of *.json packages
 * (hot-loaded on every access — a TO can drop files in while the bot runs).
 * `extends` is resolved against other packages in the same directory.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPackage, type TournamentPackage } from "@bb/validator";

export class PackageStore {
  constructor(private readonly dir: string) {}

  /** name (from file content) → raw parsed JSON. */
  private readRaw(): Map<string, Partial<TournamentPackage>> {
    const out = new Map<string, Partial<TournamentPackage>>();
    if (!existsSync(this.dir)) return out;
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Partial<TournamentPackage>;
        const name = raw.name ?? basename(file, ".json");
        out.set(name, raw);
        // also resolvable by filename stem (how `extends: "bb2025-default"` refers)
        out.set(basename(file, ".json"), raw);
      } catch {
        // unreadable package files are skipped; `names()` won't show them
      }
    }
    return out;
  }

  names(): string[] {
    const raws = this.readRaw();
    return [...new Set([...raws.values()].map((r) => r.name ?? "(unnamed)"))].sort();
  }

  get(name: string): { pkg: TournamentPackage; problems: string[] } | undefined {
    const raws = this.readRaw();
    const raw =
      raws.get(name) ??
      [...raws.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (!raw) return undefined;
    return loadPackage(raw, { resolveExtends: (n) => raws.get(n) });
  }

  save(pkg: TournamentPackage, fileStem?: string): string {
    mkdirSync(this.dir, { recursive: true });
    const stem = (fileStem ?? pkg.name).replace(/[^\w.-]+/g, "-").toLowerCase();
    const path = join(this.dir, `${stem}.json`);
    writeFileSync(path, JSON.stringify(pkg, null, 2), "utf8");
    return path;
  }
}
