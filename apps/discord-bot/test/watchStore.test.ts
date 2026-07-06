import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WatchStore } from "../src/store/watchStore";

const store = () => new WatchStore(join(mkdtempSync(join(tmpdir(), "bbtv-w-")), "watches.json"));

describe("WatchStore", () => {
  it("binds channels to packages, rebinding replaces", () => {
    const s = store();
    s.set("c1", "Lustrian");
    s.set("c2", "Strict");
    s.set("c1", "Rebound");
    expect(s.get("c1")).toBe("Rebound");
    expect(s.get("c2")).toBe("Strict");
    expect(s.get("c3")).toBeUndefined();
    expect(s.list()).toHaveLength(2);
  });

  it("remove reports whether a watch existed", () => {
    const s = store();
    s.set("c1", "Lustrian");
    expect(s.remove("c1")).toBe(true);
    expect(s.remove("c1")).toBe(false);
    expect(s.list()).toHaveLength(0);
  });
});
