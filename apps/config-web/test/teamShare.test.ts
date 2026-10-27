import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import {
  coachSaveKey,
  createSave,
  findSharedSave,
  readSaves,
  shareSave,
  teamBuilderSharedPath,
  teamBuilderSharePath,
  teamViewPagePath,
  unshareSave,
  updateSave,
} from "../src/teamBuilderSaves.js";
import { resolveCrest, resolveSprite } from "../src/teamShareView.js";

// Team share links (owner 10-27): create / revoke on the coach's own save, the public sanitised read, and the
// /t/<token> page route — against a real server (auth sidecar ON) with a synthesised Dwarf fork roster.
const root = mkdtempSync(join(tmpdir(), "team-share-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let port = 0;
let server: (typeof import("../src/server.js"))["server"];

function dwarfRosterXml(): string {
  const r = findRoster(bb2025, "Dwarf")!;
  const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
  const positions = r.positions.map(
    (p, i) =>
      `<position id="${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
      `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility>` +
      `<passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList></skillList></position>`,
  );
  return `<roster id="dwarf.bb2025"><name>Dwarf</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>${positions.join("")}</roster>`;
}

const sheet = (teamName: string) => ({
  rosterId: "dwarf.bb2025",
  teamName,
  coach: "SomeoneElse",
  picks: [
    { positionId: "1", count: 9, chosenSkills: [] },
    { positionId: "1", count: 1, chosenSkills: ["Tackle"] },
    { positionId: "2", count: 1, chosenSkills: [], chosenStatIncreases: ["MA"] },
  ],
  reRolls: 2,
  apothecary: true,
  cheerleaders: 1,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_TEAMS_DIR: join(root, "teams"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "rosters", "packages", "tournaments", "log", "state"])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "rosters", "dwarf.xml"), dwarfRosterXml(), "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A raw GET that keeps the path verbatim (fetch would normalise dot segments away). */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("share path matchers", () => {
  it("match only well-formed ids and 32-hex tokens", () => {
    expect(teamBuilderSharePath("/api/fork/team-builder/saves/sv_ab12/share")).toBe("sv_ab12");
    expect(teamBuilderSharePath("/api/fork/team-builder/saves/..%2Fx/share")).toBeUndefined();
    expect(teamBuilderSharePath("/api/fork/team-builder/saves/sv_ab12")).toBeUndefined();
    const t = "0123456789abcdef0123456789abcdef";
    expect(teamBuilderSharedPath(`/api/fork/team-builder/shared/${t}`)).toBe(t);
    expect(teamBuilderSharedPath(`/api/fork/team-builder/shared/${t.toUpperCase()}`)).toBeUndefined();
    expect(teamBuilderSharedPath("/api/fork/team-builder/shared/abc")).toBeUndefined();
    expect(teamViewPagePath(`/t/${t}`)).toBe(t);
    for (const bad of ["/t/", "/t/abc", `/t/${t}/x`, "/t/../x", `/t/%2e%2e/${t}`, `/t/${t}.html`]) expect(teamViewPagePath(bad)).toBeUndefined();
  });
});

describe("share store", () => {
  const deps = () => ({ dir: join(root, "unit"), raceNameFor: () => "Dwarf" });
  it("is idempotent, survives edits, revokes, and never resolves a forged index entry", () => {
    const made = createSave(deps(), "Uma", { name: "Uma XI", body: sheet("Uma XI") });
    expect(made.ok).toBe(true);
    const id = made.ok ? made.save.id : "";
    const first = shareSave(deps().dir, "Uma", id);
    const again = shareSave(deps().dir, "Uma", id);
    expect(first.ok && again.ok && first.token === again.token && first.created && !again.created).toBe(true);
    const token = first.ok ? first.token : "";
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // An edit keeps the link.
    expect(updateSave(deps(), "Uma", id, { name: "Uma XII", body: sheet("Uma XII") }).ok).toBe(true);
    expect(findSharedSave(deps().dir, token)?.save.name).toBe("Uma XII");
    // Another coach can't share or revoke it.
    expect(shareSave(deps().dir, "Vic", id)).toMatchObject({ ok: false, status: 404 });
    expect(unshareSave(deps().dir, "Vic", id)).toBe(false);
    // A forged index entry pointing at Uma's save with a different token resolves nothing.
    const forged = "f".repeat(32);
    writeFileSync(join(deps().dir, "shares", `${forged}.json`), JSON.stringify({ coach: "Uma", id }));
    expect(findSharedSave(deps().dir, forged)).toBeUndefined();
    expect(unshareSave(deps().dir, "Uma", id)).toBe(true);
    expect(findSharedSave(deps().dir, token)).toBeUndefined();
    expect(existsSync(join(deps().dir, "shares", `${token}.json`))).toBe(false);
    expect(readSaves(deps().dir, "Uma")[0]!.shareToken).toBeUndefined();
  });
});

describe("share routes", () => {
  const alice = createSession("Alice");
  const bob = createSession("Bob");
  let saveId = "";
  let token = "";

  it("requires a session to share or revoke", async () => {
    expect((await call("POST", "/api/fork/team-builder/saves/sv_x/share")).status).toBe(401);
    expect((await call("DELETE", "/api/fork/team-builder/saves/sv_x/share")).status).toBe(401);
  });

  it("creates a token (idempotently) for the owner only; another coach gets 404", async () => {
    const created = await call("POST", "/api/fork/team-builder/saves", alice.token, { name: "Grudge XI", body: sheet("Grudge XI") });
    expect(created.status).toBe(201);
    saveId = ((await created.json()) as { save: { id: string } }).save.id;

    expect((await call("POST", `/api/fork/team-builder/saves/${saveId}/share`, bob.token)).status).toBe(404);
    expect((await call("DELETE", `/api/fork/team-builder/saves/${saveId}/share`, bob.token)).status).toBe(404);

    const first = await call("POST", `/api/fork/team-builder/saves/${saveId}/share`, alice.token);
    expect(first.status).toBe(201);
    const body = (await first.json()) as { shareToken: string; path: string };
    token = body.shareToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.path).toBe(`/t/${token}`);
    const again = await call("POST", `/api/fork/team-builder/saves/${saveId}/share`, alice.token);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { shareToken: string }).shareToken).toBe(token);

    // Only the owner's own listing carries the token.
    const mine = (await (await call("GET", "/api/fork/team-builder/saves", alice.token)).json()) as { saves: Array<{ shareToken?: string }> };
    expect(mine.saves[0]!.shareToken).toBe(token);
    const bobs = await (await call("GET", "/api/fork/team-builder/saves", bob.token)).text();
    expect(bobs).not.toContain(token);
  });

  it("requires the CSRF header for cookie-authenticated share writes", async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${alice.token}`;
    expect((await call("POST", `/api/fork/team-builder/saves/${saveId}/share`, undefined, undefined, { cookie })).status).toBe(403);
    expect((await call("POST", `/api/fork/team-builder/saves/${saveId}/share`, undefined, undefined, { cookie, "x-cw-auth": "1" })).status).toBe(200);
  });

  it("public read: no sign-in, no-store, the sanitised view model only", async () => {
    const res = await call("GET", `/api/fork/team-builder/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const { team } = JSON.parse(text) as { team: Record<string, any> };
    expect(Object.keys(team).sort()).toEqual(
      ["coach", "crest", "inducements", "players", "raceName", "ruleset", "sideline", "specialRules", "summary", "teamName", "updatedAt", "validity"].sort(),
    );
    expect(team).toMatchObject({ teamName: "Grudge XI", coach: "Alice", raceName: "Dwarf" });
    expect(team.players).toHaveLength(11);
    expect(team.sideline).toEqual({ reRolls: 2, apothecary: true, assistantCoaches: 0, cheerleaders: 1, dedicatedFans: 1 });
    const tackler = team.players.find((p: any) => p.added.length);
    expect(tackler.added).toEqual([{ name: "Tackle", category: "General", access: "primary" }]);
    const runner = team.players.find((p: any) => p.position === "Dwarf Runner");
    expect(runner.statIncreases).toEqual(["MA"]);
    expect(runner.stats.MA).toBe(7);
    expect(team.summary.players).toBe(11);
    expect(typeof team.summary.total).toBe("number");
    expect(typeof team.validity.valid).toBe("boolean");
    // Nothing identifying beyond the public coach name: no ids, token, roster ids, raw body, or the caller's coach.
    for (const leak of [saveId, token, "dwarf.bb2025", "SomeoneElse", "rosterId", "\"id\"", "body", "shareToken", "ownerSaveId", "Bob"]) expect(text).not.toContain(leak);
  });

  it("names the owner's save id only to the owner's own session", async () => {
    const asBob = (await (await call("GET", `/api/fork/team-builder/shared/${token}`, bob.token)).json()) as { team: Record<string, unknown> };
    expect(asBob.team.ownerSaveId).toBeUndefined();
    const asAlice = (await (await call("GET", `/api/fork/team-builder/shared/${token}`, alice.token)).json()) as { team: Record<string, unknown> };
    expect(asAlice.team.ownerSaveId).toBe(saveId);
  });

  it("generic 404 for unknown tokens; GET only", async () => {
    const unknown = await call("GET", `/api/fork/team-builder/shared/${"0".repeat(32)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.json()).toEqual({ error: "This team link is no longer available." });
    expect((await call("GET", "/api/fork/team-builder/shared/not-a-token")).status).not.toBe(200);
    expect((await call("POST", `/api/fork/team-builder/shared/${token}`, undefined, {})).status).not.toBe(200);
  });

  it("serves the team view page at /t/<token> and refuses other /t/ paths", async () => {
    const page = await call("GET", `/t/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain('data-page="team-view"');
    for (const path of ["/team-view.html", "/team-view.js", "/team-view.css"]) expect((await call("GET", path)).status).toBe(200);
    for (const path of ["/t/abc", `/t/${token}/x`, "/t/../package.json", "/t/%2e%2e/server.ts", `/t/..%2f..%2fsrc%2fserver.ts`]) {
      const res = await rawGet(path);
      expect(res.body).not.toContain('data-page="team-view"');
      expect(res.body).not.toContain("createServer");
      expect(res.status).not.toBe(200);
    }
  });

  it("revoke: old link 404s, re-sharing mints a new token; deleting the save drops its link", async () => {
    expect((await call("DELETE", `/api/fork/team-builder/saves/${saveId}/share`, alice.token)).status).toBe(204);
    expect((await call("GET", `/api/fork/team-builder/shared/${token}`)).status).toBe(404);
    const again = (await (await call("POST", `/api/fork/team-builder/saves/${saveId}/share`, alice.token)).json()) as { shareToken: string };
    expect(again.shareToken).not.toBe(token);
    expect((await call("GET", `/api/fork/team-builder/shared/${again.shareToken}`)).status).toBe(200);
    expect((await call("DELETE", `/api/fork/team-builder/saves/${saveId}`, alice.token)).status).toBe(204);
    expect((await call("GET", `/api/fork/team-builder/shared/${again.shareToken}`)).status).toBe(404);
    expect(existsSync(join(root, "saves", "shares", `${again.shareToken}.json`))).toBe(false);
    expect(readFileSync(join(root, "saves", `${coachSaveKey("Alice")}.json`), "utf8")).not.toContain(again.shareToken);
  });

  it("rate-limits share creation per coach (30 a minute)", async () => {
    const carol = createSession("Carol");
    const created = (await (await call("POST", "/api/fork/team-builder/saves", carol.token, { name: "C", body: sheet("C") })).json()) as { save: { id: string } };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await call("POST", `/api/fork/team-builder/saves/${created.save.id}/share`, carol.token)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200 || s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("art lookup parity with the builder page", () => {
  it("resolves sprites and crests exactly like team-builder.js Core", () => {
    const js = readFileSync(new URL("../public/team-builder.js", import.meta.url), "utf8");
    const context: Record<string, unknown> = { console };
    runInNewContext(js, context);
    const Core = context.TeamBuilderCore as { resolveSprite: typeof resolveSprite; resolveCrest: typeof resolveCrest };
    const sprites = JSON.parse(readFileSync(new URL("../public/sprites/manifest.json", import.meta.url), "utf8"));
    const crests = JSON.parse(readFileSync(new URL("../public/crests/manifest.json", import.meta.url), "utf8"));
    const cases: Array<[string, string]> = [["Dwarf", "Dwarf Runner"], ["Amazon", "Eagle Warrior"], ["BB2025 Lizardmen", "Saurus Blocker"], ["Human", "Griff Oberwald"], ["Nope", "Nobody"]];
    for (const [race, pos] of cases) expect(resolveSprite(sprites, race, pos)).toBe(Core.resolveSprite(sprites, race, pos));
    for (const race of ["Dwarf", "Chaos Chosen", "Slann 2025", "Nope"]) expect(resolveCrest(crests, race)).toBe(Core.resolveCrest(crests, race));
  });
});

describe("hardening (Sol r1)", () => {
  /** Write a save + its share index straight into the store, bypassing every save-route check. */
  function seedShared(coach: string, id: string, token: string, body: unknown) {
    const dir = join(root, "saves");
    mkdirSync(join(dir, "shares"), { recursive: true });
    const save = { id, name: "Seeded", packageName: null, rosterId: "dwarf.bb2025", raceName: "Dwarf", teamId: null,
      createdAt: "2026-10-27T09:00:00.000Z", updatedAt: "2026-10-27T09:00:00.000Z", shareToken: token, sharedAt: "2026-10-27T09:00:00.000Z", body };
    writeFileSync(join(dir, `${coachSaveKey(coach)}.json`), JSON.stringify({ coach, saves: [save] }));
    writeFileSync(join(dir, "shares", `${token}.json`), JSON.stringify({ coach, id }));
  }
  const xff = (ip: string) => ({ "x-forwarded-for": ip });

  it("a stored save with count 2147483647 is never composed: quick 404, no allocation", async () => {
    const token = "1".repeat(32);
    seedShared("Bomber", "sv_bomb", token, { ...sheet("Bomb"), picks: [{ positionId: "1", count: 2147483647 }] });
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const res = await call("GET", `/api/fork/team-builder/shared/${token}`, undefined, undefined, xff("198.51.100.1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This team link is no longer available." });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("rejects over-limit bodies at save time (422) and on preview, before composition", async () => {
    const dave = createSession("Dave");
    const bomb = { ...sheet("Bomb"), picks: [{ positionId: "1", count: 2147483647 }] };
    const created = await call("POST", "/api/fork/team-builder/saves", dave.token, { name: "Bomb", body: bomb });
    expect(created.status).toBe(422);
    const tooMany = { ...sheet("Many"), picks: [{ positionId: "1", count: 12 }, { positionId: "2", count: 5 }] };
    expect((await call("POST", "/api/fork/team-builder/saves", dave.token, { name: "Many", body: tooMany })).status).toBe(422);
    const skills = { ...sheet("Skills"), picks: [{ positionId: "1", count: 1, chosenSkills: Array(9).fill("Block") }] };
    expect((await call("POST", "/api/fork/team-builder/saves", dave.token, { name: "Skills", body: skills })).status).toBe(422);
    const ok = (await (await call("POST", "/api/fork/team-builder/saves", dave.token, { name: "Ok", body: sheet("Ok") })).json()) as { save: { id: string } };
    expect((await call("PUT", `/api/fork/team-builder/saves/${ok.save.id}`, dave.token, { body: bomb })).status).toBe(422);
    const preview = await call("POST", "/api/fork/team-builder/preview", undefined, bomb);
    expect(preview.status).toBe(400);
    expect(((await preview.json()) as { error: string }).error).toMatch(/count must be an integer between 0 and 16/);
  });

  it("non-string text fields: 422 at save time; a stored one reads as the generic 404, not a 500 (Sol r2)", async () => {
    const fay = createSession("Fay");
    const odd: Array<Record<string, unknown>> = [
      { ...sheet("x"), teamName: { toString: null } },
      { ...sheet("x"), specialRule: ["a"] },
      { ...sheet("x"), coach: 5 },
      { ...sheet("x"), picks: [{ positionId: { toString: null }, count: 1 }] },
      { ...sheet("x"), inducements: [{ key: 7, count: 1 }] },
    ];
    for (const body of odd) expect((await call("POST", "/api/fork/team-builder/saves", fay.token, { name: "Odd", body })).status).toBe(422);
    const token = "5".repeat(32);
    seedShared("Fay", "sv_odd", token, { ...sheet("x"), teamName: { toString: null } });
    const res = await call("GET", `/api/fork/team-builder/shared/${token}`, undefined, undefined, xff("198.51.100.3"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This team link is no longer available." });
  });

  it("a malformed stored body answers without any secret-bearing text", async () => {
    const cases: Array<[string, unknown]> = [["2".repeat(32), null], ["3".repeat(32), { rosterId: "nope.bb2025", teamName: "X", picks: [{ positionId: "1", count: 1 }] }], ["4".repeat(32), { picks: "x" }]];
    for (const [token, body] of cases) {
      seedShared("Mallory", `sv_m${token[0]}`, token, body);
      const res = await call("GET", `/api/fork/team-builder/shared/${token}`, undefined, undefined, xff("198.51.100.2"));
      expect([200, 404]).toContain(res.status);
      const text = await res.text();
      for (const secret of [root, root.replace(/\\/g, "/"), "team-share-", coachSaveKey("Mallory"), token, "sv_m", "nope.bb2025", "Error:", "C:\\", "C:/"])
        expect(text).not.toContain(secret);
      if (res.status === 200) expect(JSON.parse(text).team.validity).toMatchObject({ valid: false, issues: 1 });
    }
  });

  it("public read rate limit: exhausts per IP, other IPs unaffected, a spoofed X-Forwarded-For can't change the key", async () => {
    const shared = createSession("Erin");
    const created = (await (await call("POST", "/api/fork/team-builder/saves", shared.token, { name: "E", body: sheet("E") })).json()) as { save: { id: string } };
    const { shareToken } = (await (await call("POST", `/api/fork/team-builder/saves/${created.save.id}/share`, shared.token)).json()) as { shareToken: string };
    const path = `/api/fork/team-builder/shared/${shareToken}`;
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) statuses.push((await call("GET", path, undefined, undefined, xff("203.0.113.7"))).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
    // The client prepends its own value; the proxy appends the real address, which is what keys the limiter.
    expect((await call("GET", path, undefined, undefined, xff("10.9.9.9, 203.0.113.7"))).status).toBe(429);
    expect((await call("GET", path, undefined, undefined, { "x-forwarded-for": ["1.1.1.1", "203.0.113.7"].join(",") })).status).toBe(429);
    // Another client address is unaffected.
    expect((await call("GET", path, undefined, undefined, xff("203.0.113.8"))).status).toBe(200);
  });
});
