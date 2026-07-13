import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { devBuildMarker, manifestReleaseTag, type BuildManifest } from "../src/buildAnnounce";

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

describe("devBuildMarker (dev-build deploy tripwire)", () => {
  const withInstaller = (version: string, file: string): BuildManifest => ({
    ...mkManifest("abc1234"),
    version,
    installer: { file, bytes: 1, sha256: "a", present: true },
  });

  it("passes a BARE release (no letter) — version + installer both clean", () => {
    expect(devBuildMarker(withInstaller("0.2.8", "FUMBBL40k_0.2.8_x64-setup.exe"))).toBeUndefined();
  });

  it("flags a lettered version field", () => {
    expect(devBuildMarker(withInstaller("0.2.8d", "FUMBBL40k_0.2.8_x64-setup.exe"))).toBe("0.2.8d");
  });

  it("flags a lettered installer filename even when the version field is bare", () => {
    // The real dev-cut case: package.json version stays bare, only the filename carries the letter.
    expect(devBuildMarker(withInstaller("0.2.8", "FUMBBL40k_0.2.8d_x64-setup.exe"))).toBe("0.2.8d");
  });

  it("does not false-positive on the bare filename's own version or the '40k'/'x64' tokens", () => {
    expect(devBuildMarker(withInstaller("0.2.10", "FUMBBL40k_0.2.10_x64-setup.exe"))).toBeUndefined();
  });

  it("passes a bare 0.3.0 release (the current tester candidate)", () => {
    expect(devBuildMarker(withInstaller("0.3.0", "FUMBBL40k_0.3.0_x64-setup.exe"))).toBeUndefined();
  });

  it("flags an order-66 port build (hyphenated label the lettered check misses)", () => {
    expect(devBuildMarker(withInstaller("0.2.8-o66ar", "FUMBBL40k_0.2.8-o66ar_x64-setup.exe"))).toBe("o66ar");
  });

  it("flags a bare manifest that points at a STALE o66 installer file in the nsis dir", () => {
    // The exact 0.3.0-deploy risk: version bumped bare, but the picked-up installer is a leftover o66 cut.
    expect(devBuildMarker(withInstaller("0.3.0", "FUMBBL40k_0.2.8-o66av_x64-setup.exe"))).toBe("o66av");
  });

  it("flags a Super-FUMBBL pre-migration rename leak (product or filename)", () => {
    const superProduct: BuildManifest = {
      ...mkManifest("abc1234"),
      product: "Super FUMBBL",
      version: "0.3.0",
      installer: { file: "SuperFUMBBL_0.3.0_x64-setup.exe", bytes: 1, sha256: "a", present: true },
    };
    expect(devBuildMarker(superProduct)).toMatch(/Super-FUMBBL/);
  });
});
