import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { connectionsView, parseNafLinkInput, resetNafConnectionState, ConnectionError } from "../src/auth/connections.js";
import { parseNafCoachIdentity } from "../src/nafRecords.js";
import { organizerUpdateIdentity, updateOwnAccount, upsertIdentity, withConnections, type CoachIdentityRecord } from "../src/auth/identitiesStore.js";

// Account page Connections: POST/DELETE /api/me/connections/naf over HTTP, the NAF coach page mocked at the global fetch.
// "Verified" = the public coach page exists and its name/number match what the coach entered (the NAF has no OAuth).

const root = mkdtempSync(join(tmpdir(), "server-account-connections-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
type StoredRecord = { identities: Record<string, string>; profile: Record<string, string>; connections?: { naf?: Record<string, string> } };
const identities = () => JSON.parse(readFileSync(join(root, "identities.json"), "utf8")) as { coaches: Record<string, StoredRecord> };
const coachPage = readFileSync(join(import.meta.dirname, "fixtures", "naf-coachpage-34116.html"), "utf8");

const record = (ffbCoachId: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});

// The NAF mock: number -> page (string = 200 body, number = status, "throw" = network error). Every NAF request is counted.
let nafPages: Record<string, string | number> = {};
const nafRequests: string[] = [];
const realFetch = globalThis.fetch;

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
    NAF_SCRAPE_DISABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    nafcoach: record("NafCoach", { identities: { discordUserId: "111", discordUsername: "nc_dc" } }),
    othercoach: record("OtherCoach", { identities: { nafId: "42", nafName: "Other" } }),
    linkedcoach: record("LinkedCoach", { identities: { discordUserId: "333" } }),
    admincoach: record("AdminCoach", { level: "admin" }),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), JSON.stringify([{ id: "r1", discordUserId: "333", fumbblName: "LinkedF", teams: [], updatedAt: "" }]), "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://member.thenaf.net/")) return realFetch(input, init);
    nafRequests.push(url);
    const id = new URL(url).searchParams.get("coach") ?? "";
    const page = nafPages[id];
    if (page === "throw") throw new Error("network down");
    if (page === undefined) return new Response("<html><body><table></table></body></html>", { status: 200 });
    return typeof page === "number" ? new Response("x", { status: page }) : new Response(page, { status: 200 });
  }) as typeof fetch;
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetNafConnectionState();
  nafPages = { "34116": coachPage };
  nafRequests.length = 0;
});

const bearer = (coach: string) => ({ authorization: `Bearer ${createSession(coach, Date.now(), "discord").token}` });
const linkAs = (coach: string, body: unknown) =>
  fetch(`${origin}/api/me/connections/naf`, { method: "POST", headers: { ...bearer(coach), "content-type": "application/json" }, body: JSON.stringify(body) });
const unlinkAs = (coach: string) => fetch(`${origin}/api/me/connections/naf`, { method: "DELETE", headers: bearer(coach) });
const profileAs = async (coach: string) => (await fetch(`${origin}/api/me/profile`, { headers: bearer(coach) })).json() as Promise<{ connections: Array<Record<string, unknown>> }>;
const row = (view: { connections: Array<Record<string, unknown>> }, id: string) => view.connections.find((c) => c.id === id)!;
const patchProfile = (coach: string, body: unknown) =>
  fetch(`${origin}/api/me/profile`, { method: "PATCH", headers: { ...bearer(coach), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("NAF coach page identity parsing", () => {
  it("reads the NAF number and NAF name rows by label", () => {
    expect(parseNafCoachIdentity(coachPage)).toEqual({ nafName: "flutethecat", nafNumber: "34116" });
    expect(parseNafCoachIdentity("<html>maintenance</html>")).toEqual({});
  });
  it("validates the link form body", () => {
    expect(parseNafLinkInput({ nafName: "  flute   the cat ", nafId: " 34116 " })).toEqual({ nafName: "flute the cat", nafId: "34116" });
    for (const bad of [null, [], { nafName: "x" }, { nafName: "", nafId: "1" }, { nafName: "x", nafId: "12a" }, { nafName: "<b>", nafId: "1" }, { nafName: "x", nafId: "1", ffbCoachId: "Other" }])
      expect(() => parseNafLinkInput(bad)).toThrow(ConnectionError);
  });
});

describe("POST/DELETE /api/me/connections/naf", () => {
  it("refuses anonymous requests", async () => {
    expect((await fetch(`${origin}/api/me/connections/naf`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${origin}/api/me/connections/naf`, { method: "DELETE" })).status).toBe(401);
    expect(nafRequests).toHaveLength(0);
  });

  it("a cookie session without X-CW-Auth is refused (CSRF guard)", async () => {
    const { token } = createSession("NafCoach", Date.now(), "discord");
    const res = await fetch(`${origin}/api/me/connections/naf`, { method: "POST", headers: { cookie: `cw_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ nafName: "flutethecat", nafId: "34116" }) });
    expect(res.status).toBe(403);
  });

  it("verifies a matching coach page (name case-insensitive), stores the canonical name, nafId and connections.naf", async () => {
    const res = await linkAs("NafCoach", { nafName: "FluteTheCat", nafId: "34116" });
    expect(res.status).toBe(200);
    const view = await res.json() as { nafName: string; nafId: string; connections: Array<Record<string, unknown>> };
    expect(view).toMatchObject({ nafName: "flutethecat", nafId: "34116" });
    expect(row(view, "naf")).toMatchObject({ status: "verified", identity: "flutethecat · #34116", actions: ["reverify", "unlink"], kind: "lookup" });
    expect(String(row(view, "naf").note)).toMatch(/does not prove the record is yours/);
    const stored = identities().coaches.nafcoach!;
    expect(stored.identities).toMatchObject({ nafName: "flutethecat", nafId: "34116", discordUserId: "111" });
    expect(stored.connections?.naf).toMatchObject({ source: "coachpage", nafId: "34116", nafName: "flutethecat" });
    expect(Date.parse(stored.connections!.naf!.verifiedAt!)).toBeGreaterThan(0);
    expect(nafRequests).toEqual(["https://member.thenaf.net/index.php?module=NAF&type=coachpage&coach=34116"]);
  });

  it("caches the coach page for 10 minutes (re-verify does not refetch)", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    expect(nafRequests).toHaveLength(1);
  });

  it("a name mismatch is a client-safe 422 that never echoes the page's name, and nothing is written", async () => {
    await unlinkAs("NafCoach");
    const res = await linkAs("NafCoach", { nafName: "Someone Else", nafId: "34116" });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; mismatch: string[] };
    expect(body.mismatch).toEqual(["name"]);
    expect(body.error).toMatch(/different NAF name/);
    expect(body.error).not.toContain("flutethecat");
    expect(identities().coaches.nafcoach!.identities.nafId).toBeUndefined();
    expect(identities().coaches.nafcoach!.connections).toBeUndefined();
  });

  it("a number mismatch on the page is a 422", async () => {
    nafPages["999"] = coachPage; // the page served for 999 says 34116
    const res = await linkAs("NafCoach", { nafName: "flutethecat", nafId: "999" });
    expect(res.status).toBe(422);
    expect((await res.json() as { mismatch: string[] }).mismatch).toContain("number");
  });

  it("a missing coach page (404 or an empty page) is a 422; NAF down is a 503", async () => {
    nafPages["404"] = 404;
    for (const id of ["404", "55555"]) {
      const res = await linkAs("NafCoach", { nafName: "flutethecat", nafId: id });
      expect(res.status).toBe(422);
      expect((await res.json() as { error: string }).error).toMatch(/No NAF coach page/);
    }
    nafPages["500"] = 500;
    nafPages["7"] = "throw";
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "500" })).status).toBe(503);
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "7" })).status).toBe(503);
  });

  it("rate-limits to 5 checks a minute per coach, with Retry-After; other coaches are unaffected", async () => {
    for (let i = 0; i < 5; i++) expect((await linkAs("NafCoach", { nafName: "nobody", nafId: "34116" })).status).toBe(422);
    const limited = await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await linkAs("LinkedCoach", { nafName: "nobody", nafId: "34116" })).status).toBe(422);
  });

  it("only the session coach's record is written; a record verified on another account is refused (409)", async () => {
    const before = JSON.stringify(identities().coaches.othercoach);
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    expect(JSON.stringify(identities().coaches.othercoach)).toBe(before);
    expect((await linkAs("LinkedCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(409);
    expect(identities().coaches.linkedcoach!.identities.nafId).toBeUndefined();
  });

  it("editing the NAF name or number through the profile clears the verified flag; other edits keep it", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    expect((await patchProfile("NafCoach", { displayName: "Flute" })).status).toBe(200);
    expect(identities().coaches.nafcoach!.connections?.naf).toBeDefined();
    const res = await patchProfile("NafCoach", { nafId: "34117" });
    expect(res.status).toBe(200);
    expect(row(await res.json() as { connections: Array<Record<string, unknown>> }, "naf")).toMatchObject({ status: "not_linked", identity: "flutethecat · #34117", actions: ["link", "unlink"] });
    expect(identities().coaches.nafcoach!.connections).toBeUndefined();
  });

  it("unlink clears nafName, nafId and the verification", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    const res = await unlinkAs("NafCoach");
    expect(res.status).toBe(200);
    expect(row(await res.json() as { connections: Array<Record<string, unknown>> }, "naf")).toMatchObject({ status: "not_linked", identity: "", actions: ["link"] });
    const stored = identities().coaches.nafcoach!;
    expect(stored.identities.nafId).toBeUndefined();
    expect(stored.identities.nafName).toBeUndefined();
    expect(stored.identities.discordUserId).toBe("111");
    expect(stored.connections).toBeUndefined();
  });

  it("GET /api/me/profile carries the Connections table: Discord (read-only), NAF, FUMBBL (locked by the registry)", async () => {
    const mine = await profileAs("NafCoach");
    expect(mine.connections.map((c) => c.id)).toEqual(["discord", "naf", "fumbbl"]);
    expect(row(mine, "discord")).toMatchObject({ kind: "oauth", status: "linked", identity: "nc_dc", actions: [] });
    expect(row(mine, "fumbbl")).toMatchObject({ status: "not_linked", actions: ["link"], linkVia: { mode: "field", field: "fumbblName" } });
    const linked = await profileAs("LinkedCoach");
    expect(row(linked, "fumbbl")).toMatchObject({ status: "linked", identity: "LinkedF", locked: true, actions: [] });
    expect(String(row(linked, "fumbbl").note)).toMatch(/Locked by the bot registry/);
  });
});

describe("other identity writers drop a stale NAF verification", () => {
  it("connectionsView reports Verified only while the identity still carries the verified pair", () => {
    const base: CoachIdentityRecord = {
      ffbCoachId: "X", level: "player", banned: false, silenced: false, note: "", profile: {}, updatedAt: "", updatedBy: "",
      identities: { nafId: "1", nafName: "A" }, connections: { naf: { verifiedAt: "2026-10-30T00:00:00.000Z", source: "coachpage", nafId: "1", nafName: "A" } },
    };
    expect(connectionsView(base, null)[1]).toMatchObject({ status: "verified", verifiedAt: "2026-10-30T00:00:00.000Z" });
    expect(connectionsView({ ...base, identities: { nafId: "2", nafName: "A" } }, null)[1]).toMatchObject({ status: "not_linked" });
  });

  it("/api/account nafId edits and the organiser NAF route clear it", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    updateOwnAccount("NafCoach", { identities: { nafId: "34116" } });
    expect(identities().coaches.nafcoach!.connections?.naf).toBeDefined();
    updateOwnAccount("NafCoach", { identities: { nafId: "1" } });
    expect(identities().coaches.nafcoach!.connections).toBeUndefined();
    resetNafConnectionState();
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    organizerUpdateIdentity("Org", "NafCoach", { nafName: "Renamed" });
    expect(identities().coaches.nafcoach!.connections).toBeUndefined();
  });
});

// ---------------------------------------------------------------- review fixes (Sol 6.1, 10-30)

describe("NAF verification survives unrelated rewrites; ids are canonical", () => {
  const adminPost = (body: unknown) =>
    fetch(`${origin}/api/admin/identities`, { method: "POST", headers: { ...bearer("AdminCoach"), "content-type": "application/json" }, body: JSON.stringify(body) });

  it("a Discord re-sign-in (record rebuilt without connections, as discordSso.ts writes it) keeps verifiedAt", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    const verifiedAt = identities().coaches.nafcoach!.connections!.naf!.verifiedAt;
    const stored = identities().coaches.nafcoach as unknown as CoachIdentityRecord;
    // discordSso.ts builds a fresh record: the same identities plus refreshed Discord fields, no `connections` key.
    const { connections: _c, ...rebuilt } = stored;
    upsertIdentity({ ...rebuilt, identities: { ...stored.identities, discordUsername: "nc_dc_renamed" }, updatedAt: new Date().toISOString(), updatedBy: "discord-sso" });
    expect(identities().coaches.nafcoach!.connections?.naf?.verifiedAt).toBe(verifiedAt);
    expect(row(await profileAs("NafCoach"), "naf")).toMatchObject({ status: "verified" });
    // ... but a rebuilt record that changes the NAF number drops it
    upsertIdentity({ ...rebuilt, identities: { ...stored.identities, nafId: "1" }, updatedAt: new Date().toISOString(), updatedBy: "discord-sso" });
    expect(identities().coaches.nafcoach!.connections).toBeUndefined();
  });

  it("an unrelated admin identities update keeps verifiedAt; {connections: {naf: null}} clears it (the 409 override)", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    const verifiedAt = identities().coaches.nafcoach!.connections!.naf!.verifiedAt;
    const res = await adminPost({ ffbCoachId: "NafCoach", note: "checked by admin", identities: { tournamentCoachId: "t-1" } });
    expect(res.status).toBe(200);
    expect(identities().coaches.nafcoach!.connections?.naf?.verifiedAt).toBe(verifiedAt);
    // the 409 names the override
    const dup = await linkAs("LinkedCoach", { nafName: "flutethecat", nafId: "34116" });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: string }).error).toMatch(/ask an admin: they can clear the other account's NAF check/);
    expect((await adminPost({ ffbCoachId: "NafCoach", connections: { naf: "x" } })).status).toBe(400);
    expect((await adminPost({ ffbCoachId: "NafCoach", connections: { naf: null } })).status).toBe(200);
    expect(identities().coaches.nafcoach!.connections).toBeUndefined();
    expect(identities().coaches.nafcoach!.identities).toMatchObject({ nafId: "34116", nafName: "flutethecat" });
    expect((await linkAs("LinkedCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    await unlinkAs("LinkedCoach");
  });

  it("a zero-padded number is the same NAF record: canonical when fetched, cached, stored and compared (034116 after 34116 is a 409)", async () => {
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(200);
    expect((await linkAs("LinkedCoach", { nafName: "flutethecat", nafId: "034116" })).status).toBe(409);
    expect((await linkAs("LinkedCoach", { nafName: "flutethecat", nafId: "0034116" })).status).toBe(409);
    expect(nafRequests.every((u) => u.endsWith("coach=34116"))).toBe(true);
    // a zero-padded first link is stored canonically
    await unlinkAs("NafCoach");
    resetNafConnectionState();
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "034116" })).status).toBe(200);
    expect(identities().coaches.nafcoach!.identities.nafId).toBe("34116");
    expect(identities().coaches.nafcoach!.connections!.naf!.nafId).toBe("34116");
    expect(parseNafLinkInput({ nafName: "x", nafId: "000" })).toEqual({ nafName: "x", nafId: "0" });
  });

  it("an old record verified with a zero-padded spelling still collides", async () => {
    await unlinkAs("NafCoach");
    const stored = identities().coaches.othercoach as unknown as CoachIdentityRecord;
    upsertIdentity(withConnections({ ...stored, identities: { ...stored.identities, nafId: "034116", nafName: "flutethecat" } },
      { naf: { verifiedAt: "2026-10-01T00:00:00.000Z", source: "coachpage", nafId: "034116", nafName: "flutethecat" } }));
    expect((await linkAs("NafCoach", { nafName: "flutethecat", nafId: "34116" })).status).toBe(409);
    upsertIdentity(withConnections(stored, undefined));
  });
});
