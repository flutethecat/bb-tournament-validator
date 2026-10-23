import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicArtPath } from "../src/publicArt.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// /sounds/** (the recorder's turn-timer cues) is public static like /icons/, in BOTH auth modes. The files live in the gitignored
// public/sounds/ui/ on the host; this test drops a temp one there and removes it. Sidecar OFF here (ADMIN_PASSWORD set, so the legacy
// Basic gate is live); tabletopSoundsPublicSidecar.test.ts is the same with the auth sidecar ON.
const root = mkdtempSync(join(tmpdir(), "sounds-public-"));
const soundsDir = fileURLToPath(new URL("../public/sounds/ui/", import.meta.url));
const FILE = "r3-public-off.wav";
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
const sidecar = false;

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: sidecar ? "1" : "",
    ADMIN_PASSWORD: sidecar ? "" : "admin-secret",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  mkdirSync(soundsDir, { recursive: true });
  writeFileSync(join(soundsDir, FILE), Buffer.from("RIFF....WAVE"));
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  rmSync(join(soundsDir, FILE), { force: true });
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe(`/sounds/** is public static (${sidecar ? "sidecar on" : "sidecar off"})`, () => {
  it("an anonymous GET and HEAD return the file with an audio content type", async () => {
    const res = await fetch(`${origin}/sounds/ui/${FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^audio\//);
    expect((await res.arrayBuffer()).byteLength).toBe(12);
    expect((await fetch(`${origin}/sounds/ui/${FILE}`, { method: "HEAD" })).status).toBe(200);
  });
  it("matches only plain lower-case audio files under /sounds", () => {
    for (const ok of ["/sounds/ui/x.wav", "/sounds/ui/turn-timer_10.mp3", "/sounds/a.ogg"]) expect(isPublicArtPath(ok)).toBe(true);
    for (const bad of ["/sounds/../team-builder.js", "/sounds/%2e%2e/admin.js", "/sounds/ui/X.wav", "/sounds/ui/x.js", "/sounds/ui/README.md", "/sounds//x.wav", "/soundsx/x.wav"])
      expect(isPublicArtPath(bad)).toBe(false);
  });
  it("does not widen: unknown files 404, traversal and other types are not public", async () => {
    expect((await fetch(`${origin}/sounds/ui/missing.wav`)).status).toBe(404);
    expect((await fetch(`${origin}/sounds/ui/README.md`, { redirect: "manual" })).status).not.toBe(200);
  });
});
