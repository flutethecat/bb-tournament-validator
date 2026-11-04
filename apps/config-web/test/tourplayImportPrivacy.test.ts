import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectExport } from "../src/privacy/collectors.js";
import { PrivacyService } from "../src/privacy/service.js";
import { clearFences } from "../src/privacy/fence.js";
import { createSession } from "../src/auth/session.js";
import { depsFor, seed } from "./privacyFixture.js";

// TourPlay import (lane L8): the private record (NAF numbers, claims) is in the coach's export and erased on deletion.
// Invented names and numbers only.

const roots: string[] = [];
const prevIdentities = process.env.IDENTITIES_FILE;
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tp-privacy-"));
  roots.push(root);
  process.env.IDENTITIES_FILE = join(root, "identities.json");
  clearFences();
});
afterEach(() => {
  if (prevIdentities === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prevIdentities;
  clearFences();
});
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const record = () => ({
  version: 1,
  coaches: {
    "naf:allytp": { id: "tp000000000001", key: "naf:allytp", name: "Ally TP", nafUser: "allytp", nafNumber: "81001", seasons: [{ seasonId: "s1", number: 1, teamIds: ["green-orcs"], teams: ["Green Orcs"] }], status: "matched", basis: "naf-number", coachId: "Alice" },
    "naf:bobtp": { id: "tp000000000002", key: "naf:bobtp", name: "Bob TP", nafUser: "bobtp", nafNumber: "82002", seasons: [], status: "conflict", candidates: { byName: ["Alice"], byNumber: ["Bob"] }, decision: { coachId: "Bob", by: "Alice", at: "2026-11-01T00:00:00Z", via: "organiser" } },
    "naf:allyold": { id: "tp000000000004", key: "naf:allyold", name: "Ally Old", nafUser: "allyold", nafNumber: "81004", seasons: [], status: "unmatched", decision: { coachId: "Alice", by: "Bob", at: "2026-11-01T00:00:00Z", via: "organiser" } },
    "naf:allys2": { id: "tp000000000005", key: "naf:allys2", name: "Ally Season Two", nafUser: "allys2", nafNumber: "81005", seasons: [], status: "unmatched", linked: ["Bob", "Alice"], seasonLinks: { s1: { coachId: "Alice", by: "Bob", at: "2026-11-01T00:00:00Z" }, s2: { coachId: "Bob", by: "Bob", at: "2026-11-01T00:00:00Z" } } },
    "name:nobody": { id: "tp000000000003", key: "name:nobody", name: "No Body", nafNumber: "83003", seasons: [], status: "unmatched" },
  },
  claims: [
    { id: "tc000000000001", row: "tp000000000003", coach: "Alice", at: "2026-11-02T00:00:00Z", state: "pending" },
    { id: "tc000000000002", row: "tp000000000003", coach: "Alice", at: "2026-11-01T00:00:00Z", state: "declined", decidedBy: "Bob", decidedAt: "2026-11-01T01:00:00Z" },
    { id: "tc000000000003", row: "tp000000000003", coach: "Bob", at: "2026-11-02T00:00:00Z", state: "declined", decidedBy: "Alice", decidedAt: "2026-11-02T01:00:00Z" },
  ],
  imports: [{ at: "2026-11-01T00:00:00Z", by: "Alice", seasons: [] }],
  snapshots: { s1: { fixtures: {}, teams: { "green-orcs": { name: "Green Orcs", coach: "Ally TP", roster: "x" } } } },
});

describe("TourPlay import record and privacy", () => {
  it("export: the rows linked to the coach (with the NAF number) and their claims, nothing of anyone else", async () => {
    await seed(root);
    const deps = depsFor(root);
    writeFileSync(join(deps.stateDir, "leagues", "l1", "tourplay-import.json"), JSON.stringify(record()));
    createSession("Alice", Date.now(), "discord");
    const files = new Map((await collectExport(deps, "alice")).map((f) => [f.name, String(f.content)]));
    const leagues = JSON.parse(files.get("league-teams.json")!);
    const tp = leagues.find((l: { id: string }) => l.id === "l1").tourplayImport;
    // by the account link, and by the decided coach only (a Teams-tab assignment records a decision)
    expect(tp.coaches).toEqual([
      expect.objectContaining({ name: "Ally TP", nafUser: "allytp", nafNumber: "81001", basis: "naf-number" }),
      expect.objectContaining({ name: "Ally Old", nafNumber: "81004", decision: expect.objectContaining({ via: "organiser" }) }),
      expect.objectContaining({ name: "Ally Season Two", nafNumber: "81005" }), // a season-specific Teams-tab seat
    ]);
    expect(tp.claims.map((c: { state: string }) => c.state)).toEqual(["pending", "declined"]);
    expect(files.get("league-teams.json")).not.toContain("82002");
    expect(files.get("league-teams.json")).not.toContain("83003");
  });

  it("delete: her linked row is erased, her pending claim goes, her name elsewhere becomes the pseudonym", async () => {
    await seed(root);
    const deps = depsFor(root);
    const path = join(deps.stateDir, "leagues", "l1", "tourplay-import.json");
    writeFileSync(path, JSON.stringify(record()));
    createSession("Alice", Date.now(), "discord");
    const out = await new PrivacyService(deps).deleteCoach("alice", "Alice", "self");
    expect(out).toMatchObject({ status: "deleted", pending: [] });
    const P = out.pseudonym!;
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("81001");
    expect(text).not.toContain("allytp");
    expect(text).not.toContain("81004");
    expect(text).not.toContain("81005");
    expect(text).not.toContain("Ally TP"); // the snapshots went with her rows
    expect(text).not.toMatch(/"Alice"/);
    const f = JSON.parse(text);
    expect(Object.keys(f.coaches)).toEqual(["naf:bobtp", "name:nobody"]);
    expect(f.coaches["naf:bobtp"].candidates).toEqual({ byName: [], byNumber: ["Bob"] });
    expect(f.coaches["naf:bobtp"].decision.by).toBe(P);
    expect(f.claims.map((c: { id: string; coach: string; decidedBy?: string }) => [c.id, c.coach, c.decidedBy])).toEqual([
      ["tc000000000002", P, "Bob"], ["tc000000000003", "Bob", P],
    ]);
    expect(f.imports[0].by).toBe(P);
    expect(f.coaches["name:nobody"].nafNumber).toBe("83003"); // another coach's row is untouched
  });
});
