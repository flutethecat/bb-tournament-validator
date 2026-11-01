import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { clearFences, coachKeyHash, fenceCoachHash } from "../src/privacy/fence.js";
import { ONBOARDED_CONSENT } from "./onboardedFixture.js";

// Friends / messages / blocks over HTTP: session required, the CSRF header on cookie writes, the onboarding gate (428),
// test sign-in sessions read only, the deletion fence, and the organiser thread through the tournament message route.

const root = mkdtempSync(join(tmpdir(), "server-social-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const rec = (ffbCoachId: string, onboarded = true) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: { email: `${ffbCoachId.toLowerCase()}@example.test`, discordUserId: "900000000000000099" },
  ...(onboarded ? { consent: ONBOARDED_CONSENT } : {}), updatedAt: "", updatedBy: "",
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
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    FORK_STATE_DIR: join(root, "state"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    socialann: rec("SocialAnn"), socialben: rec("SocialBen"), socialcy: rec("SocialCy"), newbie: rec("Newbie", false), fenced: rec("Fenced"),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clearFences();
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const bearer = (coach: string, test = false) => ({ authorization: `Bearer ${createSession(coach, Date.now(), "discord", test ? { test: true } : {}).token}` });
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("social HTTP routes", () => {
  it("every route needs a session", async () => {
    for (const p of ["/api/me/friends", "/api/me/threads", "/api/me/threads/unread", "/api/me/blocks"]) expect((await fetch(`${origin}${p}`)).status, p).toBe(401);
    expect((await post("/api/me/threads", {}, { to: "SocialBen", text: "hi" })).status).toBe(401);
  });

  it("a cookie session must send the CSRF header on writes; reads never cached", async () => {
    const cookie = `cw_session=${createSession("SocialAnn", Date.now(), "discord").token}`;
    expect((await post("/api/me/friends/request", { cookie }, { coach: "SocialBen" })).status).toBe(403);
    expect((await post("/api/me/friends/request", { cookie, "x-cw-auth": "1" }, { coach: "SocialBen" })).status).toBe(200);
    const res = await fetch(`${origin}/api/me/friends`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json() as { outgoing: Array<{ coach: string }> };
    expect(body.outgoing.map((r) => r.coach)).toEqual(["SocialBen"]);
    expect(JSON.stringify(body)).not.toMatch(/example\.test|900000000000000099/);
  });

  it("send, unread, read, and a block's 403 end to end; no contact fields in any answer", async () => {
    const ann = bearer("SocialAnn");
    const cy = bearer("SocialCy");
    const sent = await post("/api/me/threads", ann, { to: "socialcy", text: "<b>Game?</b>" });
    expect(sent.status).toBe(201);
    const { thread } = await sent.json() as { thread: { id: string; with: string } };
    expect(thread.with).toBe("SocialCy");
    expect(await (await fetch(`${origin}/api/me/threads/unread`, { headers: cy })).json()).toEqual({ unread: 1 });
    const view = await (await fetch(`${origin}/api/me/threads/${thread.id}`, { headers: cy })).json() as { messages: Array<{ text: string }> };
    expect(view.messages[0]!.text).toBe("<b>Game?</b>"); // stored and answered as plain text; the SPA renders it as text
    expect(JSON.stringify(view)).not.toMatch(/example\.test|900000000000000099/);
    expect(await (await post(`/api/me/threads/${thread.id}/read`, cy, {})).json()).toEqual({ unread: 0 });
    // the recipient got one notification for the burst
    const notes = await (await fetch(`${origin}/api/me/notifications`, { headers: cy })).json() as { notifications: Array<{ type: string; link: string }> };
    expect(notes.notifications.filter((n) => n.type === "private-message")).toHaveLength(1);
    expect(notes.notifications[0]!.link).toBe(`/app/messages/${thread.id}`);
    expect((await post("/api/me/blocks", cy, { coach: "SocialAnn" })).status).toBe(200);
    const refused = await post(`/api/me/threads/${thread.id}`, ann, { text: "again" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "This coach is not accepting messages" });
    const blocked = await fetch(`${origin}/api/me/blocks/SocialAnn`, { method: "DELETE", headers: cy });
    expect(blocked.status).toBe(200);
  });

  it("a coach who has not accepted the privacy notice gets 428 on every social write, but can read", async () => {
    const nb = bearer("Newbie");
    expect((await post("/api/me/threads", nb, { to: "SocialAnn", text: "hi" })).status).toBe(428);
    expect((await post("/api/me/friends/request", nb, { coach: "SocialAnn" })).status).toBe(428);
    expect((await post("/api/me/blocks", nb, { coach: "SocialAnn" })).status).toBe(428);
    expect((await fetch(`${origin}/api/me/blocks/SocialAnn`, { method: "DELETE", headers: nb })).status).toBe(428);
    expect((await fetch(`${origin}/api/me/threads`, { headers: nb })).status).toBe(200);
  });

  it("test sign-in sessions read only", async () => {
    const t = bearer("SocialBen", true);
    expect((await post("/api/me/threads", t, { to: "SocialAnn", text: "hi" })).status).toBe(403);
    expect((await fetch(`${origin}/api/me/threads`, { headers: t })).status).toBe(200);
  });

  it("the deletion fence: a coach being deleted can't write, and can't be written to", async () => {
    const ann = bearer("SocialAnn");
    const fencedToken = bearer("Fenced");
    fenceCoachHash(coachKeyHash("Fenced"));
    try {
      const res = await post("/api/me/threads", ann, { to: "Fenced", text: "hi" });
      expect(res.status).toBe(403);
      expect((await post("/api/me/friends/request", ann, { coach: "Fenced" })).status).toBe(403);
      // the fenced coach's own session (made before the fence) is refused on writes
      expect((await post("/api/me/threads", fencedToken, { to: "SocialAnn", text: "hi" })).status).toBe(409);
    } finally { clearFences(); }
  });
});
