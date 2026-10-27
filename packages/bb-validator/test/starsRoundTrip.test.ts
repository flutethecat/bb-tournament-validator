import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regenerating stars.json must reproduce the committed file byte-for-byte: the generator's
// build_stars() only derives name/cost/playsFor/teams from FUMBBL roster/get, so the fields it cannot
// derive (pairedWith/pairPrimary for inseparable pairs, the printed `skills`) must be carried over.
// No network: roster/get is faked from the committed file itself, rosters.json is the committed one.
const scriptsDir = fileURLToPath(new URL("../scripts/", import.meta.url));
const datasetDir = fileURLToPath(new URL("../src/dataset/bb2025/", import.meta.url));
const committed = readFileSync(new URL("../src/dataset/bb2025/stars.json", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const py = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
import generate_dataset as g
ds = sys.argv[2]
prev = json.load(open(os.path.join(ds, "stars.json"), encoding="utf-8"))["stars"]
g.get = lambda path: {"positions": [{"title": s["name"], "cost": str(s["cost"]), "playsFor": s["playsFor"]} for s in prev]}
rosters = json.load(open(os.path.join(ds, "rosters.json"), encoding="utf-8"))["rosters"]
stars = g.merge_preserved_star_fields(g.build_stars(rosters), prev)
sys.stdout.write(json.dumps(g.stars_document(stars), indent=1))
`;

const python = ["python", "python3"].find((cmd) => spawnSync(cmd, ["--version"]).status === 0);

describe("stars.json generator round trip", () => {
  it.skipIf(!python)("regenerating reproduces the committed stars.json (pairs + skills preserved)", () => {
    const run = spawnSync(python!, ["-c", py, scriptsDir, datasetDir], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.replace(/\r\n/g, "\n")).toBe(committed);
    const doc = JSON.parse(run.stdout) as { stars: { name: string; pairedWith?: string; pairPrimary?: boolean }[] };
    expect(doc.stars.find((s) => s.name === "Grak")).toMatchObject({ pairedWith: "Crumbleberry", pairPrimary: true });
  });
});
