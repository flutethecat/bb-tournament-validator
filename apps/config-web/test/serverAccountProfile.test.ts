import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { parseProfilePatch } from "../src/accountProfile.js";
import { ONBOARDED_CONSENT } from "./onboardedFixture.js";

// Account page Identity panel: GET/PATCH /api/me/profile over HTTP. Session-gated, own record only, validated, written
// through the identities store; the tournament registry's FUMBBL link stays authoritative.

const root = mkdtempSync(join(tmpdir(), "server-account-profile-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
type StoredRecord = { profile: Record<string, string>; identities: Record<string, string>; level: string };
const identities = () => JSON.parse(readFileSync(join(root, "identities.json"), "utf8")) as { coaches: Record<string, StoredRecord> };

const record = (ffbCoachId: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, consent: ONBOARDED_CONSENT, updatedAt: "", updatedBy: "", ...extra,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    profilecoach: record("ProfileCoach", { identities: { discordUserId: "111", discordUsername: "pc_dc", discordAvatarHash: "abc" } }),
    othercoach: record("OtherCoach", { level: "organizer", profile: { displayName: "Other" }, identities: { nafId: "42" } }),
    linkedcoach: record("LinkedCoach", { identities: { discordUserId: "333" } }),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), JSON.stringify([{ id: "r1", discordUserId: "333", fumbblName: "LinkedF", teams: [], updatedAt: "" }]), "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const patchAs = (coach: string, body: unknown) => {
  const { token } = createSession(coach, Date.now(), "discord");
  return fetch(`${origin}/api/me/profile`, { method: "PATCH", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });
};
const getAs = (coach: string) => {
  const { token } = createSession(coach, Date.now(), "discord");
  return fetch(`${origin}/api/me/profile`, { headers: bearer(token) });
};

describe("profile validation", () => {
  it("accepts the four fields, trims and collapses spaces, clears with an empty string", () => {
    expect(parseProfilePatch({ displayName: "  Grim   Gutrot ", fumbblName: "grim_99", nafName: "Ólafur O'Neil", nafId: " 12345 " }))
      .toEqual({ displayName: "Grim Gutrot", fumbblName: "grim_99", nafName: "Ólafur O'Neil", nafId: "12345" });
    expect(parseProfilePatch({ displayName: "" })).toEqual({ displayName: "" });
  });
  it("refuses unknown keys, wrong types, bad characters, lengths and NAF numbers", () => {
    expect(() => parseProfilePatch({})).toThrow(/Nothing to change/);
    expect(() => parseProfilePatch({ level: "admin" })).toThrow(/not editable/);
    expect(() => parseProfilePatch({ ffbCoachId: "OtherCoach", displayName: "x1" })).toThrow(/not editable/);
    expect(() => parseProfilePatch({ displayName: 5 })).toThrow(/must be a string/);
    expect(() => parseProfilePatch({ displayName: "<script>" })).toThrow(/letters, digits/);
    expect(() => parseProfilePatch({ displayName: "A" })).toThrow(/at least 2/);
    expect(() => parseProfilePatch({ displayName: "x".repeat(33) })).toThrow(/at most 32/);
    expect(() => parseProfilePatch({ fumbblName: "bad'name" })).toThrow(/FUMBBL name can use/);
    expect(() => parseProfilePatch({ nafId: "12a" })).toThrow(/1 to 10 digits/);
    expect(() => parseProfilePatch({ nafId: "12345678901" })).toThrow(/1 to 10 digits/);
  });
});

describe("GET/PATCH /api/me/profile", () => {
  it("needs a session", async () => {
    expect((await fetch(`${origin}/api/me/profile`)).status).toBe(401);
    expect((await fetch(`${origin}/api/me/profile`, { method: "PATCH", body: "{}" })).status).toBe(401);
  });

  it("GET answers the coach's own view: defaults, Discord read-only, the Discord avatar", async () => {
    const res = await getAs("ProfileCoach");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ coach: "ProfileCoach", displayName: "", fumbblName: "", fumbblLinked: false, nafName: "", nafId: "", avatarSource: "discord", discord: { linked: true, username: "pc_dc" } });
    expect(String(body.avatar)).toContain("/avatars/111/abc");
    expect(body).not.toHaveProperty("note");
    expect(body).not.toHaveProperty("level");
  });

  it("PATCH validates, persists through the identity store, and GET reads it back", async () => {
    expect((await patchAs("ProfileCoach", { displayName: "<b>" })).status).toBe(400);
    expect((await patchAs("ProfileCoach", { level: "admin" })).status).toBe(400);
    const ok = await patchAs("ProfileCoach", { displayName: "Grim Gutrot", fumbblName: "grimF", nafName: "Grim", nafId: "777" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ displayName: "Grim Gutrot", fumbblName: "grimF", nafName: "Grim", nafId: "777" });
    const stored = identities().coaches.profilecoach!;
    expect(stored.profile).toMatchObject({ displayName: "Grim Gutrot", fumbblName: "grimF" });
    expect(stored.identities).toMatchObject({ nafName: "Grim", nafId: "777", discordUserId: "111", discordUsername: "pc_dc" });
    expect(stored.level).toBe("player");
    expect(await (await getAs("ProfileCoach")).json()).toMatchObject({ displayName: "Grim Gutrot", nafId: "777" });
    // "" clears a field
    expect((await patchAs("ProfileCoach", { nafId: "" })).status).toBe(200);
    expect(identities().coaches.profilecoach!.identities.nafId).toBeUndefined();
  });

  it("another coach's record is never touched, even when the body names it", async () => {
    const before = JSON.stringify(identities().coaches.othercoach);
    expect((await patchAs("ProfileCoach", { ffbCoachId: "OtherCoach", displayName: "Hijack" })).status).toBe(400);
    expect((await patchAs("ProfileCoach", { displayName: "Mine Only" })).status).toBe(200);
    expect(JSON.stringify(identities().coaches.othercoach)).toBe(before);
    expect(await (await getAs("OtherCoach")).json()).toMatchObject({ coach: "OtherCoach", displayName: "Other", nafId: "42" });
  });

  it("a registry-linked FUMBBL name is shown and locked; the claim is never written over it", async () => {
    expect(await (await getAs("LinkedCoach")).json()).toMatchObject({ fumbblName: "LinkedF", fumbblLinked: true });
    expect((await patchAs("LinkedCoach", { fumbblName: "SomeoneElse" })).status).toBe(400);
    const same = await patchAs("LinkedCoach", { fumbblName: "LinkedF", displayName: "Linky" });
    expect(same.status).toBe(200);
    expect(identities().coaches.linkedcoach!.profile.fumbblName).toBeUndefined();
  });
});
