// Organiser requests over HTTP, and the organizers.json import at server start (registration spec 2026-11-02 Q1, Q14).
// Isolated state: every store points into this suite's temp root. Invented names only.
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, ONBOARDED_CONSENT } from "./onboardedFixture.js";

const root = mkdtempSync(join(tmpdir(), "server-organiser-requests-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const rec = (ffbCoachId: string, level: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level, banned: false, silenced: false, note: "", profile: {}, identities: {}, consent: ONBOARDED_CONSENT, updatedAt: "", updatedBy: "", ...extra,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    FORK_ADMIN_PASSWORD: "",
    FORK_STATE_DIR: join(root, "state"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "teams", "log", "state", "tournaments"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    // LegacyPlayer is a player on the identity row but listed (in another case) in organizers.json; LegacyOnly has no row.
    legacyplayer: rec("LegacyPlayer", "player"),
    newcoach: rec("NewCoach", "player"),
    orgcoach: rec("OrgCoach", "organizer"),
    boss: rec("Boss", "admin"),
    fresh: { ...rec("Fresh", "player"), consent: undefined },
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: ["LEGACYPLAYER", "LegacyOnly"] }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const as = (coach: string) => ({ authorization: `Bearer ${createSession(coach).token}`, "content-type": "application/json" });
const session = async (coach: string) => (await (await fetch(`${origin}/api/auth/session`, { headers: as(coach) })).json()) as { organizer?: boolean; admin?: boolean };
const good = { run: "tournament", competition: "Spring Open", region: "West", note: "A monthly one-day tournament.", links: ["https://example.test/open"] };

describe("organizers.json import at startup", () => {
  it("ran before the first request: legacy organisers keep their rights through identity levels", async () => {
    expect(existsSync(join(root, "state", "legacy-organizers-imported.json"))).toBe(true);
    const ids = JSON.parse(readFileSync(join(root, "identities.json"), "utf8")).coaches;
    expect(ids.legacyplayer).toMatchObject({ ffbCoachId: "LegacyPlayer", level: "organizer", updatedBy: "legacy-organizers-import" });
    expect(ids.legacyonly).toMatchObject({ ffbCoachId: "LegacyOnly", level: "organizer" });
    expect((await session("LegacyPlayer")).organizer).toBe(true);
    // an organiser-only write passes the organiser gate (it fails later on validation, never with 403)
    const write = await fetch(`${origin}/api/tournaments`, { method: "POST", headers: as("LegacyPlayer"), body: "{}" });
    expect(write.status).not.toBe(403);
  });

  it("permission checks no longer read the file: editing it changes nothing", async () => {
    writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: ["NewCoach"] }), "utf8");
    expect((await session("NewCoach")).organizer).toBe(false);
    expect((await session("LegacyPlayer")).organizer).toBe(true);
    const write = await fetch(`${origin}/api/tournaments`, { method: "POST", headers: as("NewCoach"), body: "{}" });
    expect(write.status).toBe(403);
  });
});

describe("organiser requests over HTTP", () => {
  it("coach submits, duplicate refused; non-admins refused on the queue; admin approves and the level is granted", async () => {
    expect((await fetch(`${origin}/api/me/organiser-request`)).status).toBe(401);
    // onboarding gate: a coach who has not accepted the privacy notice cannot send one
    const gated = await fetch(`${origin}/api/me/organiser-request`, { method: "POST", headers: { authorization: `Bearer ${(await import("../src/auth/session.js")).createSession("Fresh").token}`, "content-type": "application/json" }, body: JSON.stringify(good) });
    expect(gated.status).toBe(428);

    const sent = await fetch(`${origin}/api/me/organiser-request`, { method: "POST", headers: as("NewCoach"), body: JSON.stringify(good) });
    expect(sent.status).toBe(201);
    const { request } = (await sent.json()) as { request: { id: string } };
    expect((await fetch(`${origin}/api/me/organiser-request`, { method: "POST", headers: as("NewCoach"), body: JSON.stringify(good) })).status).toBe(409);
    expect((await fetch(`${origin}/api/me/organiser-request`, { method: "POST", headers: as("OrgCoach"), body: JSON.stringify(good) })).status).toBe(409);

    // the admin got a notification row for it
    const bossNotes = (await (await fetch(`${origin}/api/me/notifications`, { headers: as("Boss") })).json()) as { notifications: Array<{ type: string; link: string }> };
    expect(bossNotes.notifications[0]).toMatchObject({ type: "organiser-request", link: "/app/admin/organiser-requests" });

    expect((await fetch(`${origin}/api/admin/organiser-requests`)).status).toBe(401);
    expect((await fetch(`${origin}/api/admin/organiser-requests`, { headers: as("NewCoach") })).status).toBe(403);
    expect((await fetch(`${origin}/api/admin/organiser-requests`, { headers: as("OrgCoach") })).status).toBe(403);
    expect((await fetch(`${origin}/api/admin/organiser-requests/${request.id}/approve`, { method: "POST", headers: as("NewCoach"), body: "{}" })).status).toBe(403);
    expect((await fetch(`${origin}/api/admin/organiser-requests/${request.id}/approve`, { method: "POST", headers: as("OrgCoach"), body: "{}" })).status).toBe(403);
    // cookie writes without the CSRF header are refused
    expect((await fetch(`${origin}/api/admin/organiser-requests/${request.id}/approve`, { method: "POST", headers: { cookie: `cw_session=${createSession("Boss").token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(403);

    const queue = (await (await fetch(`${origin}/api/admin/organiser-requests`, { headers: as("Boss") })).json()) as { pending: number; requests: Array<{ id: string; coach: string }> };
    expect(queue).toMatchObject({ pending: 1, requests: [{ id: request.id, coach: "NewCoach" }] });

    expect((await session("NewCoach")).organizer).toBe(false);
    const approved = await fetch(`${origin}/api/admin/organiser-requests/${request.id}/approve`, { method: "POST", headers: as("Boss"), body: JSON.stringify({ reason: "Welcome." }) });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ level: "granted", request: { status: "approved", decidedBy: "Boss" } });
    expect((await session("NewCoach")).organizer).toBe(true);
    const mine = (await (await fetch(`${origin}/api/me/organiser-request`, { headers: as("NewCoach") })).json()) as { organizer: boolean; request: Record<string, unknown> };
    expect(mine).toMatchObject({ organizer: true, request: { status: "approved", reason: "Welcome." } });
    expect(mine.request).not.toHaveProperty("decidedBy");
    const coachNotes = (await (await fetch(`${origin}/api/me/notifications`, { headers: as("NewCoach") })).json()) as { notifications: Array<{ type: string; title: string }> };
    expect(coachNotes.notifications[0]).toMatchObject({ type: "organiser-request", title: "You're now an organiser" });
  });

  it("withdraw over DELETE", async () => {
    await fetch(`${origin}/api/me/organiser-request`, { method: "POST", headers: as("LegacyOnly"), body: JSON.stringify(good) }); // already an organiser: 409
    const s = await fetch(`${origin}/api/me/organiser-request`, { method: "POST", headers: as("Fresh2"), body: JSON.stringify(good) });
    expect(s.status).toBe(201);
    const w = await fetch(`${origin}/api/me/organiser-request`, { method: "DELETE", headers: as("Fresh2") });
    expect(w.status).toBe(200);
    expect(await w.json()).toMatchObject({ request: { status: "withdrawn" } });
  });
});
