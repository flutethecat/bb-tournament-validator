/**
 * FUMBBL40k build announcer — reads the client's build manifest (contract
 * "fumbbl40k.build-manifest/1", see fumbbl40k-client/docs/build-announce-contract.md)
 * and drives a Discord announcement. We consume `highlights` verbatim — we do NOT
 * parse changelogs. Pure I/O + typing here; the embed + posting live in index.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BuildManifest {
  schema: string;
  product: string;
  version: string;
  channel: string; // "test" | "rc" | "release"
  date: string;
  generatedAt?: string;
  gitSha: string;
  installer: {
    file: string;
    relPath?: string;
    absPath?: string;
    bytes: number;
    sha256: string;
    present: boolean;
  };
  highlights: string[];
  notes?: string;
}

/** Where the client writes latest-build.json (both repos live on this box). Env-overridable. */
export function manifestPath(): string {
  return (
    process.env.FORK_BUILD_MANIFEST ||
    "C:\\Users\\Jay\\Documents\\Claude\\fumbbl40k-client\\dist-manifest\\latest-build.json"
  );
}

/** Read + minimally validate the manifest; undefined if missing/unreadable/wrong schema. */
export function readManifest(path = manifestPath()): BuildManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as BuildManifest;
    if (!m?.version || !m?.gitSha || !String(m.schema || "").startsWith("fumbbl40k.build-manifest/")) return undefined;
    return m;
  } catch {
    return undefined;
  }
}

/** Persisted last-announced marker (version+gitSha) so re-cuts don't double-post. */
export class AnnounceState {
  constructor(private readonly filePath: string) {}

  private read(): { version?: string; gitSha?: string } {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as { version?: string; gitSha?: string };
    } catch {
      return {};
    }
  }

  private write(d: { version?: string; gitSha?: string }): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  /** True when nothing has been announced/seeded yet (very first run). */
  isEmpty(): boolean {
    return !this.read().version;
  }

  /** True when this manifest differs from the last announced version+gitSha. */
  isNew(m: BuildManifest): boolean {
    const d = this.read();
    return d.version !== m.version || d.gitSha !== m.gitSha;
  }

  mark(m: BuildManifest): void {
    this.write({ version: m.version, gitSha: m.gitSha });
  }
}

export const fmtBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
};
