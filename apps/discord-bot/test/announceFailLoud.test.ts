import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerFailLoud } from "../src/announcePost";
import type { BuildManifest } from "../src/buildAnnounce";

let dir: string;
const small = () => join(dir, "FUMBBL40k_0.3.2_x64-setup.exe");
const big = () => join(dir, "big.exe");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bbfailloud-"));
  writeFileSync(small(), "MZ small installer");
  writeFileSync(big(), "");
  truncateSync(big(), 46 * 1024 * 1024); // > the 45 MiB attach ceiling
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mk = (o: {
  channel?: string;
  installer: Partial<BuildManifest["installer"]> & { present: boolean };
}): BuildManifest => ({
  schema: "fumbbl40k.build-manifest/2",
  product: "FUMBBL40k",
  version: "0.3.2",
  channel: o.channel ?? "release",
  date: "2026-07-17",
  gitSha: "abc1234",
  highlights: [],
  installer: { file: "FUMBBL40k_0.3.2_x64-setup.exe", bytes: 100, sha256: "a", ...o.installer },
});

describe("installerFailLoud — a green announce can never ship without an expected installer", () => {
  it("PASSES a release whose installer is present and attachable", () => {
    expect(installerFailLoud(mk({ installer: { present: true, absPath: small() } }))).toBeNull();
  });

  it("REFUSES a release that reports no installer (the whole point is to deliver it)", () => {
    const r = installerFailLoud(mk({ installer: { present: false } }));
    expect(r).toMatch(/REFUSED \(fail-loud\)/);
    expect(r).toMatch(/must ship its installer/);
  });

  it("REFUSES when the manifest claims an installer that isn't on disk", () => {
    const r = installerFailLoud(mk({ installer: { present: true, absPath: join(dir, "gone.exe") } }));
    expect(r).toMatch(/not found on this box/);
  });

  it("REFUSES when the installer exceeds the attach ceiling (the 0.3.1 silent drop)", () => {
    const r = installerFailLoud(mk({ installer: { present: true, absPath: big() } }));
    expect(r).toMatch(/exceeds the .* attach ceiling/);
  });

  it("ALLOWS a test/rc build with a legitimately-absent installer (embed flags it)", () => {
    expect(installerFailLoud(mk({ channel: "test", installer: { present: false } }))).toBeNull();
    expect(installerFailLoud(mk({ channel: "rc", installer: { present: false } }))).toBeNull();
  });
});
