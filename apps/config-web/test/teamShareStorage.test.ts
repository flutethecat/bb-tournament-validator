import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Share-link storage failures (Sol r1 P3): the save file and the per-token index must never disagree after a
// failed write. atomicWriteTextFile is wrapped so a test can make the NEXT write to a matching path throw.
const failures: RegExp[] = [];
vi.mock("@bb/fork-ops", async (importOriginal) => {
  const real = await importOriginal<typeof import("@bb/fork-ops")>();
  return {
    ...real,
    atomicWriteTextFile: (path: string, value: string) => {
      const i = failures.findIndex((re) => re.test(path.replace(/\\/g, "/")));
      if (i >= 0) {
        failures.splice(i, 1);
        throw new Error("EIO: simulated disk failure");
      }
      return real.atomicWriteTextFile(path, value);
    },
  };
});

const { coachSaveKey, createSave, deleteSave, findSharedSave, readSaves, shareSave, unshareSave } = await import("../src/teamBuilderSaves.js");

const root = mkdtempSync(join(tmpdir(), "team-share-storage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const deps = { dir: root, raceNameFor: () => "Dwarf" };
const body = { rosterId: "dwarf.bb2025", teamName: "S", picks: [{ positionId: "1", count: 11 }] };
const indexFiles = () => (existsSync(join(root, "shares")) ? readdirSync(join(root, "shares")).filter((f) => f.endsWith(".json")) : []);
const coachFile = (coach: string) => new RegExp(`/${coachSaveKey(coach)}\\.json$`);

describe("share-link storage failures", () => {
  it("index write fails: no token on the save, no index entry", () => {
    const made = createSave(deps, "Ann", { name: "A", body });
    const id = made.ok ? made.save.id : "";
    failures.push(/\/shares\/[0-9a-f]{32}\.json$/);
    expect(() => shareSave(root, "Ann", id)).toThrow(/simulated/);
    expect(readSaves(root, "Ann")[0]!.shareToken).toBeUndefined();
    expect(indexFiles()).toEqual([]);
  });

  it("save write fails after the index was written: the fresh index entry is removed again", () => {
    const made = createSave(deps, "Ben", { name: "B", body });
    const id = made.ok ? made.save.id : "";
    failures.push(coachFile("Ben"));
    expect(() => shareSave(root, "Ben", id)).toThrow(/simulated/);
    expect(readSaves(root, "Ben")[0]!.shareToken).toBeUndefined();
    expect(indexFiles()).toEqual([]);
    // A retry then succeeds normally.
    const ok = shareSave(root, "Ben", id);
    expect(ok.ok && findSharedSave(root, ok.token)?.save.id).toBe(id);
  });

  it("unshare / delete write fails: the link stays intact (index kept, token kept)", () => {
    const made = createSave(deps, "Cat", { name: "C", body });
    const id = made.ok ? made.save.id : "";
    const shared = shareSave(root, "Cat", id);
    const token = shared.ok ? shared.token : "";
    failures.push(coachFile("Cat"));
    expect(() => unshareSave(root, "Cat", id)).toThrow(/simulated/);
    expect(findSharedSave(root, token)?.save.id).toBe(id);
    failures.push(coachFile("Cat"));
    expect(() => deleteSave(root, "Cat", id)).toThrow(/simulated/);
    expect(findSharedSave(root, token)?.save.id).toBe(id);
    // Then both succeed and clean up.
    expect(unshareSave(root, "Cat", id)).toBe(true);
    expect(findSharedSave(root, token)).toBeUndefined();
    expect(indexFiles().some((f) => f.startsWith(token))).toBe(false);
  });
});
