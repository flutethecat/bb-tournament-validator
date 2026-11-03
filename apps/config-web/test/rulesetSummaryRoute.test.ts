// Ruleset export (creation wizards v2): GET /api/ruleset-summary is a public read on BOTH gates (requireSession's public
// reads and authorized(), law 14b), and a package whose own visibility is "draft" stays hidden (404) from anyone but an
// organiser / admin, in the summary AND the package list and read. Isolated state dirs (laws §C14), no live data.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireSession } from "../src/auth/requireSession.js";
import { TournamentStore } from "../src/tournaments/store.js";

const root = mkdtempSync(join(tmpdir(), "ruleset-summary-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
const ADMIN = "summary-test-pw";

const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  name, skillAllotment: { skillPointBudget: 0 }, goldBudget: 1_000_000,
  customStars: [{ id: "grim-hound", name: "Grim Hound", cost: 150000, MA: 7, ST: 3, AG: 3, PA: null, AV: 9, skills: ["Dodge"], specialRules: [{ kind: "trait", name: "Fog Walker", description: "Ignores one tackle zone." }] }],
  ...extra,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "", ADMIN_PASSWORD: ADMIN, HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"), FORK_BUILDER_SAVES_DIR: join(root, "saves"), FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"), TOURNAMENTS_DIR: join(root, "tournaments"), COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "", FORK_DB_HOST: "", SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "packages", "tournaments", "state", "saves"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  writeFileSync(join(root, "packages", "open-cup.json"), pkg("Open Cup"), "utf8");
  writeFileSync(join(root, "packages", "secret-cup.json"), pkg("Secret Cup", { visibility: "draft" }), "utf8");
  writeFileSync(join(root, "packages", "used-cup.json"), pkg("Used Cup"), "utf8");
  // a base package used only through a child that extends it, and a published child of the draft "Secret Cup"
  writeFileSync(join(root, "packages", "base-cup.json"), pkg("Base Cup"), "utf8");
  writeFileSync(join(root, "packages", "child-cup.json"), JSON.stringify({ name: "Child Cup", extends: "Base Cup", skillAllotment: { skillPointBudget: 0 } }), "utf8");
  writeFileSync(join(root, "packages", "open-child.json"), JSON.stringify({ name: "Open Child", extends: "Secret Cup", skillAllotment: { skillPointBudget: 0 } }), "utf8");
  // a tournament with a registered coach on "Used Cup" (fake data)
  const store = new TournamentStore(join(root, "tournaments"));
  const at = new Date("2026-11-02T12:00:00Z");
  const t = store.createTournament({ name: "Used Open", packageName: "Used Cup", maxPlayers: 8, format: "swiss", organizerCoachId: "Org", roundCount: 3 }, at);
  store.registerEntrant(t.id, { coachId: "Ann", ffbCoachId: "Ann", verifiedAt: at.toISOString() }, "team-ann", at);
  const c = store.createTournament({ name: "Child Open", packageName: "Child Cup", maxPlayers: 8, format: "swiss", organizerCoachId: "Org", roundCount: 3 }, at);
  store.registerEntrant(c.id, { coachId: "Bea", ffbCoachId: "Bea", verifiedAt: at.toISOString() }, "team-bea", at);
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const basic = { authorization: `Basic ${Buffer.from(`admin:${ADMIN}`).toString("base64")}` };
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { headers });

describe("GET /api/ruleset-summary", () => {
  it("is a public read on both gates", () => {
    const req = (method: string) => ({ method, headers: {} }) as IncomingMessage;
    expect(requireSession(req("GET"), "/api/ruleset-summary", "?package=x").kind).toBe("allow");
    expect(requireSession(req("POST"), "/api/ruleset-summary", "").kind).toBe("unauthorized");
  });

  it("answers anonymously (admin password configured) with the summary, custom stars and their special rules", async () => {
    const res = await get("/api/ruleset-summary?package=Open%20Cup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { name: string; draft: boolean; customStars: Array<{ name: string; specialRules: unknown[] }>; houseRules: unknown } };
    expect(body.summary).toMatchObject({ name: "Open Cup", draft: false, houseRules: null });
    expect(body.summary.customStars[0]).toMatchObject({ name: "Grim Hound", specialRules: [{ kind: "trait", name: "Fog Walker", description: "Ignores one tackle zone." }] });
    expect(JSON.stringify(body)).not.toMatch(/@|discord|email/i);
  });

  it("hides a draft package from the public (summary, list and read) and shows it to an admin", async () => {
    expect((await get("/api/ruleset-summary?package=Secret%20Cup")).status).toBe(404);
    expect((await get("/api/ruleset-summary?package=Nope")).status).toBe(404);
    const list = (await (await get("/api/packages")).json()) as Array<{ name: string }>;
    expect(list.map((p) => p.name)).toContain("Open Cup");
    expect(list.map((p) => p.name)).not.toContain("Secret Cup");
    expect((await get("/api/packages/Secret%20Cup")).status).toBe(404);
    const admin = await get("/api/ruleset-summary?package=Secret%20Cup", basic);
    expect(admin.status).toBe(200);
    expect(((await admin.json()) as { summary: { draft: boolean } }).summary.draft).toBe(true);
    expect((await get("/api/packages/Secret%20Cup", basic)).status).toBe(200);
  });

  it("refuses a competition overlay that does not exist or does not use the ruleset", async () => {
    expect((await get("/api/ruleset-summary?package=Open%20Cup&tournament=nope")).status).toBe(404);
    expect((await get("/api/ruleset-summary?package=Open%20Cup&league=nope")).status).toBe(404);
  });

  it("the traits catalogue for the star creator is opt-in on /api/skills", async () => {
    const plain = (await (await get("/api/skills")).json()) as Record<string, unknown>;
    expect(plain.traits).toBeUndefined();
    const withTraits = (await (await get("/api/skills?traits=1")).json()) as { traits: Array<{ name: string }> };
    expect(withTraits.traits.some((t) => t.name === "Loner")).toBe(true);
  });

  it("visibility is the package's own: a published child of a draft base is served and listed; the base stays hidden", async () => {
    expect((await get("/api/fork/team-builder/tiers?packageName=Open%20Child")).status).toBe(200);
    expect((await get("/api/packages/Open%20Child")).status).toBe(200);
    const list = (await (await get("/api/packages")).json()) as Array<{ name: string }>;
    expect(list.map((p) => p.name)).toContain("Open Child");
    expect((await get("/api/packages/Secret%20Cup")).status).toBe(404);
    expect((await get("/api/ruleset-summary?package=Open%20Child")).status).toBe(200);
  });
  it("every package resolver hides a draft: team-builder tiers, limits and inducements answer as unknown for the public", async () => {
    for (const route of ["tiers", "limits", "inducements"]) {
      expect((await get(`/api/fork/team-builder/${route}?packageName=Secret%20Cup`)).status, route).toBe(400);
      expect((await get(`/api/fork/team-builder/${route}?packageName=Secret%20Cup`, basic)).status, route).toBe(200);
      expect((await get(`/api/fork/team-builder/${route}?packageName=Open%20Cup`)).status, route).toBe(200);
    }
  });
});

describe("Creator saves of a ruleset in use", () => {
  const post = async (doc: Record<string, unknown>) => {
    const { revision } = (await (await get("/api/packages/Used%20Cup", basic)).json()) as { revision: string };
    return fetch(`${origin}/api/packages?replace=Used%20Cup`, { method: "POST", headers: { ...basic, "content-type": "application/json", "x-cw-auth": "1", "if-match": revision }, body: JSON.stringify(doc) });
  };
  const current = JSON.parse(pkg("Used Cup")) as Record<string, unknown>;
  it("refuses a rules edit to a package a competition with registered coaches uses, naming it", async () => {
    const res = await post({ ...current, goldBudget: 1_100_000 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; inUse: string[] };
    expect(body.inUse).toEqual(["Used Open"]);
    expect(body.error).toContain("switch the competition");
  });
  it("normalises the replace name before the check (a trailing space is the same package)", async () => {
    const { revision } = (await (await get("/api/packages/Used%20Cup", basic)).json()) as { revision: string };
    const res = await fetch(`${origin}/api/packages?replace=Used%20Cup%20`, { method: "POST", headers: { ...basic, "content-type": "application/json", "x-cw-auth": "1", "if-match": revision }, body: JSON.stringify({ ...current, goldBudget: 900_000 }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { inUse: string[] }).inUse).toEqual(["Used Open"]);
  });
  it("refuses a rules edit to a BASE package that an in-use package extends", async () => {
    const { revision } = (await (await get("/api/packages/Base%20Cup", basic)).json()) as { revision: string };
    const base = JSON.parse(pkg("Base Cup")) as Record<string, unknown>;
    const res = await fetch(`${origin}/api/packages?replace=Base%20Cup`, { method: "POST", headers: { ...basic, "content-type": "application/json", "x-cw-auth": "1", "if-match": revision }, body: JSON.stringify({ ...base, goldBudget: 900_000 }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { inUse: string[] }).inUse).toEqual(["Child Open"]);
  });
  it("lets a notes-only edit (description, rules note, visibility) through", async () => {
    const res = await post({ ...current, description: "Clarified wording.", dataNote: "Hand-check nothing." });
    expect(res.status).toBe(200);
  });
});
