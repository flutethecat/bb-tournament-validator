import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoadedOnFork } from "@bb/fork-ops";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-forkstate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isLoadedOnFork", () => {
  it("is false when no reload has ever been recorded (unknown = not loaded, fails safe)", () => {
    expect(isLoadedOnFork(dir, new Date().toISOString())).toBe(false);
  });

  it("is true when the team was ingested BEFORE the last recorded reload", () => {
    writeFileSync(join(dir, "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-07-09T08:00:00.000Z" }));
    expect(isLoadedOnFork(dir, "2026-07-09T07:00:00.000Z")).toBe(true);
    // Exactly-equal timestamps count as loaded too (the reload seed case).
    expect(isLoadedOnFork(dir, "2026-07-09T08:00:00.000Z")).toBe(true);
  });

  it("is false when the team was ingested AFTER the last recorded reload (needs a fresh reload)", () => {
    writeFileSync(join(dir, "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-07-09T08:00:00.000Z" }));
    expect(isLoadedOnFork(dir, "2026-07-09T09:00:00.000Z")).toBe(false);
  });

  it("treats an unreadable/corrupt state file the same as no state (fails safe)", () => {
    writeFileSync(join(dir, "fork-reload-state.json"), "{not json");
    expect(isLoadedOnFork(dir, new Date().toISOString())).toBe(false);
  });
});
