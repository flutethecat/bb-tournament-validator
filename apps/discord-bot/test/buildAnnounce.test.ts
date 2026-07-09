import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { manifestReleaseTag, type BuildManifest } from "../src/buildAnnounce";

const mkManifest = (gitSha: string): BuildManifest => ({
  schema: "fumbbl40k.build-manifest/2",
  product: "FUMBBL40k",
  version: "0.2.2",
  channel: "test",
  date: "2026-07-09",
  gitSha,
  installer: { file: "x.exe", bytes: 1, sha256: "a", present: false },
  highlights: [],
});

// Repo root of THIS repo — has its own tags we can probe deterministically.
const thisRepo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

describe("manifestReleaseTag (tag-gating for the auto-announce poller)", () => {
  it("fails CLOSED (undefined) when the repo root is bogus / git can't run", () => {
    expect(manifestReleaseTag(mkManifest("6c00f3a"), "C:/nope/not/a/repo")).toBeUndefined();
  });

  it("fails CLOSED for an unknown/empty gitSha without even shelling out", () => {
    expect(manifestReleaseTag(mkManifest("unknown"), thisRepo)).toBeUndefined();
    expect(manifestReleaseTag(mkManifest(""), thisRepo)).toBeUndefined();
  });

  it("returns undefined for a commit that isn't a vX.Y.Z release tag", () => {
    // HEAD of this repo is a normal commit, not a version tag.
    const head = execFileSync("git", ["-C", thisRepo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    expect(manifestReleaseTag(mkManifest(head), thisRepo)).toBeUndefined();
  });

  it("returns the tag name when the commit IS a vX.Y.Z release tag (if any exist here)", () => {
    // Find a v-tag in this repo, if present; otherwise this assertion is vacuous (skipped).
    const tags = execFileSync("git", ["-C", thisRepo, "tag", "--list", "v*.*.*"], { encoding: "utf8" })
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tags.length) return; // no version tags in this repo — nothing to assert against
    const tag = tags[0]!;
    const sha = execFileSync("git", ["-C", thisRepo, "rev-list", "-n", "1", "--abbrev-commit", tag], {
      encoding: "utf8",
    }).trim();
    expect(manifestReleaseTag(mkManifest(sha), thisRepo)).toBe(tag);
  });

  // Sanity guard so the "bogus repo" test isn't a false pass because git is missing entirely.
  it("git is available in this environment (guards the fails-closed tests)", () => {
    expect(existsSync(thisRepo)).toBe(true);
  });
});
