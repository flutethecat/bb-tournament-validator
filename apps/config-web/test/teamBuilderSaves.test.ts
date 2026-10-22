import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { TEAM_BUILDER_SAVES_BODY_CAP, buildBodyForSave, coachSaveKey, createSave, readSaves, recordBuild, teamBuilderSavesPath } from "../src/teamBuilderSaves.js";

const root = mkdtempSync(join(tmpdir(), "team-builder-saves-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

/** A base fork roster XML for Dwarf, synthesised from the dataset (positionId = index). */
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
  coach: "SomeoneElse", // ignored: saves are keyed by the session coach only
  password: "hunter2",
  picks: [{ positionId: "1", count: 11, chosenSkills: [] }],
  reRolls: 2,
  apothecary: true,
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
  // Trip reloadFork's busy guard so this suite cannot stop or spawn a live fork.
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "rosters", "dwarf.xml"), dwarfRosterXml(), "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
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

describe("team-builder saves path matcher", () => {
  it("matches the collection and safe ids only", () => {
    expect(teamBuilderSavesPath("/api/fork/team-builder/saves")).toBe("");
    expect(teamBuilderSavesPath("/api/fork/team-builder/saves/sv_ab12")).toBe("sv_ab12");
    expect(teamBuilderSavesPath("/api/fork/team-builder/saves/..%2Fx")).toBeUndefined();
    expect(teamBuilderSavesPath("/api/fork/team-builder/saves/a/b")).toBeUndefined();
  });
});

describe("team-builder saves HTTP", () => {
  const alice = createSession("Alice");
  const bob = createSession("Bob");
  let saveId = "";

  it("requires a session for every verb", async () => {
    expect((await call("GET", "/api/fork/team-builder/saves")).status).toBe(401);
    expect((await call("POST", "/api/fork/team-builder/saves", undefined, { name: "x", body: sheet("x") })).status).toBe(401);
    expect((await call("GET", "/api/fork/team-builder/saves/sv_x")).status).toBe(401);
    expect((await call("PUT", "/api/fork/team-builder/saves/sv_x", undefined, { body: sheet("x") })).status).toBe(401);
    expect((await call("DELETE", "/api/fork/team-builder/saves/sv_x")).status).toBe(401);
  });

  it("creates, lists, reads, updates and deletes a save (password stripped)", async () => {
    const created = await call("POST", "/api/fork/team-builder/saves", alice.token, {
      name: "Grudge XI",
      body: { ...sheet("Grudge XI"), packageName: "Small Gods" },
      lastPreview: { goldUsed: 1000000 },
    });
    expect(created.status).toBe(201);
    const { save } = (await created.json()) as { save: Record<string, unknown> & { id: string; body: Record<string, unknown> } };
    saveId = save.id;
    expect(save).toMatchObject({ name: "Grudge XI", packageName: "Small Gods", rosterId: "dwarf.bb2025", raceName: "Dwarf", teamId: null, lastPreview: { goldUsed: 1000000 } });
    expect(save.body.password).toBeUndefined();
    expect(readFileSync(join(root, "saves", `${coachSaveKey("Alice")}.json`), "utf8")).not.toContain("hunter2");

    const list = (await (await call("GET", "/api/fork/team-builder/saves", alice.token)).json()) as { saves: Array<Record<string, unknown>> };
    expect(list.saves).toEqual([
      { id: saveId, name: "Grudge XI", packageName: "Small Gods", rosterId: "dwarf.bb2025", raceName: "Dwarf", teamId: null, updatedAt: save.updatedAt, createdAt: save.createdAt },
    ]);

    const read = await call("GET", `/api/fork/team-builder/saves/${saveId}`, alice.token);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { save: { body: { teamName: string } } }).save.body.teamName).toBe("Grudge XI");

    const updated = await call("PUT", `/api/fork/team-builder/saves/${saveId}`, alice.token, { name: "Grudge XII", body: sheet("Grudge XII") });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { save: { name: string; packageName: string | null; createdAt: string } }).save).toMatchObject({
      name: "Grudge XII",
      packageName: null,
      createdAt: save.createdAt,
    });

    const scratch = (await (await call("POST", "/api/fork/team-builder/saves", alice.token, { name: "Scratch", body: sheet("Scratch") })).json()) as { save: { id: string } };
    const del = await call("DELETE", `/api/fork/team-builder/saves/${scratch.save.id}`, alice.token);
    expect(del.status).toBe(204);
    expect((await call("GET", `/api/fork/team-builder/saves/${scratch.save.id}`, alice.token)).status).toBe(404);
  });

  it("validates the body", async () => {
    expect((await call("POST", "/api/fork/team-builder/saves", alice.token, { name: "", body: sheet("x") })).status).toBe(400);
    expect((await call("POST", "/api/fork/team-builder/saves", alice.token, { name: "x", body: { picks: [] } })).status).toBe(400);
    const badStats = await call("POST", "/api/fork/team-builder/saves", alice.token, {
      name: "x",
      body: { ...sheet("x"), picks: [{ positionId: "1", count: 1, chosenStatIncreases: ["WS"] }] },
    });
    expect(badStats.status).toBe(400);
    const huge = await call("POST", "/api/fork/team-builder/saves", alice.token, { name: "x", body: { ...sheet("x"), pad: "x".repeat(70_000) } });
    expect(huge.status).toBe(413);
  });

  it("isolates coaches: Bob can neither see nor touch Alice's save", async () => {
    const list = (await (await call("GET", "/api/fork/team-builder/saves", bob.token)).json()) as { saves: unknown[] };
    expect(list.saves).toEqual([]);
    expect((await call("GET", `/api/fork/team-builder/saves/${saveId}`, bob.token)).status).toBe(404);
    expect((await call("PUT", `/api/fork/team-builder/saves/${saveId}`, bob.token, { body: sheet("Mine now") })).status).toBe(404);
    expect((await call("DELETE", `/api/fork/team-builder/saves/${saveId}`, bob.token)).status).toBe(404);
    expect((await call("GET", `/api/fork/team-builder/saves/${saveId}`, alice.token)).status).toBe(200);
  });

  it("requires the CSRF header for cookie-authenticated writes", async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${alice.token}`;
    const noHeader = await call("POST", "/api/fork/team-builder/saves", undefined, { name: "c", body: sheet("c") }, { cookie });
    expect(noHeader.status).toBe(403);
    const withHeader = await call("POST", "/api/fork/team-builder/saves", undefined, { name: "c", body: sheet("c") }, { cookie, "x-cw-auth": "1" });
    expect(withHeader.status).toBe(201);
  });

  it("links the save on build (saveId) and stores the body for later recall", async () => {
    const built = await call("POST", "/api/fork/team-builder/build", alice.token, { ...sheet("Linked Grudgers"), saveId });
    const payload = (await built.json()) as { ok?: boolean; teamId?: string; saveId?: string; error?: string };
    expect(payload.error).toBeUndefined();
    expect(built.status).toBe(200);
    expect(payload.saveId).toBe(saveId);
    const save = ((await (await call("GET", `/api/fork/team-builder/saves/${saveId}`, alice.token)).json()) as {
      save: { teamId: string; body: Record<string, unknown>; lastPreview?: unknown };
    }).save;
    expect(save.teamId).toBe(payload.teamId);
    expect(save.body.teamName).toBe("Linked Grudgers");
    expect(save.body.password).toBeUndefined();
    expect(save.body.saveId).toBeUndefined();
    expect(save.lastPreview).toBeDefined();

  });

  // One HTTP build per server: with the fork reload busy-guarded, the first build leaves the team
  // cache awaiting a recovery reload, which (correctly) blocks further builds. The remaining build
  // linkage cases are covered against the store directly.
  it("recordBuild: creates a linked save without saveId, ignores a foreign saveId, re-links by teamId", () => {
    const dir = join(root, "unit-saves");
    const deps = { dir, raceNameFor: () => "Dwarf" };
    const own = createSave(deps, "Carol", { name: "Carol XI", body: sheet("Carol XI") });
    expect(own.ok).toBe(true);
    const carolSaveId = own.ok ? own.save.id : "";

    const fresh = recordBuild(deps, "Dave", { teamId: "tb_dave_1", teamName: "Dave XI", body: sheet("Dave XI") });
    expect(readSaves(dir, "Dave")).toMatchObject([{ id: fresh, teamId: "tb_dave_1", name: "Dave XI" }]);

    const foreign = recordBuild(deps, "Dave", { teamId: "tb_dave_2", teamName: "Dave II", body: sheet("Dave II"), saveId: carolSaveId });
    expect(foreign).not.toBe(carolSaveId);
    expect(readSaves(dir, "Carol")[0]).toMatchObject({ id: carolSaveId, teamId: null });

    // Rebuilding the same team updates its existing save instead of adding one.
    const again = recordBuild(deps, "Dave", { teamId: "tb_dave_1", teamName: "Dave XI", body: { ...sheet("Dave XI"), reRolls: 3 } });
    expect(again).toBe(fresh);
    expect(readSaves(dir, "Dave")).toHaveLength(2);
    expect(readSaves(dir, "Dave").find((x) => x.id === fresh)!.body.reRolls).toBe(3);
  });
});

describe("team-builder saves store hardening (review 10-22)", () => {
  const deps = () => ({ dir: join(root, "hardening"), raceNameFor: () => "Dwarf" });

  it("keys coaches injectively: case, spacing and device names never share a file", () => {
    for (const [a, b] of [["Foo", "foo"], ["A B", "A_B"], ["CON", "con"]] as const) {
      expect(coachSaveKey(a)).not.toBe(coachSaveKey(b));
      const made = createSave(deps(), a, { name: `${a} XI`, body: sheet("x") });
      expect(made.ok).toBe(true);
      expect(readSaves(deps().dir, b)).toEqual([]);
      expect(readSaves(deps().dir, a)).toHaveLength(1);
    }
    expect(coachSaveKey("CON")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("whitelists build bodies and refuses to store an oversized one", () => {
    const body = { ...sheet("W"), evil: { nested: true }, picks: [{ positionId: "1", count: 11, junk: "x" }] };
    expect(buildBodyForSave(body)).toEqual({
      rosterId: "dwarf.bb2025",
      teamName: "W",
      picks: [{ positionId: "1", count: 11 }],
      reRolls: 2,
      apothecary: true,
    });
    const id = recordBuild(deps(), "Whitelist", { teamId: "tb_w", teamName: "W", body });
    const stored = readSaves(deps().dir, "Whitelist").find((x) => x.id === id)!;
    expect(stored.body.evil).toBeUndefined();
    expect(stored.body.coach).toBeUndefined();
    const huge = { ...sheet("Huge"), specialRule: "x".repeat(TEAM_BUILDER_SAVES_BODY_CAP + 1) };
    expect(recordBuild(deps(), "Whitelist", { teamId: "tb_h", teamName: "Huge", body: huge })).toBeUndefined();
  });
});
