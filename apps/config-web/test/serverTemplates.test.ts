// Competition templates over HTTP (src/templates/api.ts through server.ts): the CSRF header on cookie writes, GETs that
// change nothing, the onboarding gate, 404 for organisers it was not shared with, and the share notification.
// Isolated state: every store points into this suite's temp root. Invented names only.
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, ONBOARDED_CONSENT } from "./onboardedFixture.js";

const root = mkdtempSync(join(tmpdir(), "server-templates-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const rec = (ffbCoachId: string, level: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level, banned: false, silenced: false, note: "", profile: {}, identities: {}, consent: ONBOARDED_CONSENT, updatedAt: "", updatedBy: "", ...extra,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"), FORK_TEAMS_DIR: join(root, "teams"), FORK_ADMIN_PASSWORD: "",
    FORK_STATE_DIR: join(root, "state"), TOURNAMENTS_DIR: join(root, "tournaments"),
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "teams", "log", "state", "tournaments"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    tamsin: rec("Tamsin", "organizer", { profile: { displayName: "Tamsin T" } }),
    ugo: rec("Ugo", "organizer"),
    vera: rec("Vera", "organizer"),
    fresh: { ...rec("Fresh", "organizer"), consent: undefined },
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
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
const cookie = (coach: string, csrf: boolean) => ({ cookie: `cw_session=${createSession(coach).token}`, "content-type": "application/json", ...(csrf ? { "x-cw-auth": "1" } : {}) });
const file = () => join(root, "state", "competition-templates.json");
const content = { packageName: "BB2025 Default", format: "swiss", maxPlayers: 16, relative: { checkInOpens: 1440 }, discordEvents: { published: true } };

describe("templates over HTTP", () => {
  it("cookie writes need the CSRF header; GETs change nothing; onboarding gate; others get 404; share notifies", async () => {
    const make = (headers: Record<string, string>) => fetch(`${origin}/api/templates`, { method: "POST", headers, body: JSON.stringify({ kind: "tournament", name: "Club night", content }) });
    expect((await make(cookie("Tamsin", false))).status).toBe(403);
    expect(existsSync(file())).toBe(false);
    const raw = (await import("../src/auth/session.js")).createSession("Fresh").token;
    expect((await make({ authorization: `Bearer ${raw}`, "content-type": "application/json" })).status).toBe(428);
    const ok = await make(cookie("Tamsin", true));
    expect(ok.status).toBe(201);
    const { template } = (await ok.json()) as { template: { id: string } };

    const before = readFileSync(file(), "utf8");
    expect((await fetch(`${origin}/api/templates?kind=tournament`, { headers: cookie("Tamsin", false) })).status).toBe(200);
    expect((await fetch(`${origin}/api/templates/${template.id}`, { headers: cookie("Tamsin", false) })).status).toBe(200);
    expect((await fetch(`${origin}/api/templates/organisers?q=ug`, { headers: cookie("Tamsin", false) })).status).toBe(200);
    expect(readFileSync(file(), "utf8")).toBe(before);

    // not shared: 404 for another organiser, 401 anonymous
    expect((await fetch(`${origin}/api/templates/${template.id}`, { headers: as("Ugo") })).status).toBe(404);
    expect((await fetch(`${origin}/api/templates/${template.id}`)).status).toBe(401);

    // share without / with the header (cookie), then Ugo reads it and has a notification
    const share = (csrf: boolean) => fetch(`${origin}/api/templates/${template.id}/share`, { method: "POST", headers: cookie("Tamsin", csrf), body: JSON.stringify({ coach: "Ugo" }) });
    expect((await share(false)).status).toBe(403);
    expect((await share(true)).status).toBe(200);
    expect((await fetch(`${origin}/api/templates/${template.id}`, { headers: as("Ugo") })).status).toBe(200);
    const notes = (await (await fetch(`${origin}/api/me/notifications`, { headers: as("Ugo") })).json()) as { notifications: Array<{ type: string; title: string }> };
    expect(notes.notifications[0]).toMatchObject({ type: "template-shared", title: "Tamsin T shared a tournament template with you" });
    expect((await fetch(`${origin}/api/templates/${template.id}`, { method: "DELETE", headers: cookie("Ugo", true) })).status).toBe(403);
    expect((await fetch(`${origin}/api/templates/${template.id}`, { method: "DELETE", headers: as("Vera") })).status).toBe(404);
    // delete without the header refused, with it done
    expect((await fetch(`${origin}/api/templates/${template.id}`, { method: "DELETE", headers: cookie("Tamsin", false) })).status).toBe(403);
    expect((await fetch(`${origin}/api/templates/${template.id}`, { method: "DELETE", headers: cookie("Tamsin", true) })).status).toBe(200);
    expect((await fetch(`${origin}/api/templates/${template.id}`, { headers: as("Ugo") })).status).toBe(404);
  });
});
