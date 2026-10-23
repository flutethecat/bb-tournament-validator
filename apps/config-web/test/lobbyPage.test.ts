import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expiryLine, formatWar, lobbyIdFromHash, lobbyStatusLine, presenceLine, ratingParts, renderEmoji } from "../spa/src/shared/format";

describe("lobby page helpers", () => {
  it("presence lines", () => {
    expect(presenceLine("Bob", "here")).toBe("Bob is here");
    expect(presenceLine("Bob", "left")).toBe("Bob left");
    expect(presenceLine("Bob", "client")).toBe("Bob is in the client");
    expect(presenceLine("Bob", "not-here-yet")).toBe("Bob is not here yet");
  });
  it("rating parts show only what FUMBBL sent", () => {
    expect(ratingParts({ record: { w: 20, d: 12, l: 16 }, winPct: 54, cr: 162.4, war: 2 })).toEqual(["Record 20/12/16", "54 %", "CR 162.4", "+2.0 WAR"]);
    expect(ratingParts({})).toEqual([]);
    expect(formatWar(-2.5)).toBe("−2.5");
    expect(formatWar(0.04)).toBe("0.0");
  });
  it("emoji shortcodes, display only, never inside URLs or words", () => {
    expect(renderEmoji("gg :+1: :joy:")).toBe("gg 👍 😂");
    expect(renderEmoji("a:joy:b :nope: 12:30")).toBe("a:joy:b :nope: 12:30");
    expect(renderEmoji("see https://x.test/:joy: ok :fire:")).toBe("see https://x.test/:joy: ok 🔥");
  });
  it("status line follows the server's pairing state", () => {
    const base = { creator: { coach: "Alice" }, opponent: { coach: "Bob" }, game: null, canLaunch: false, opponentAccepted: false };
    expect(lobbyStatusLine({ ...base, me: "creator", status: "waiting" })).toBe("Waiting for Bob to accept.");
    expect(lobbyStatusLine({ ...base, me: "opponent", status: "waiting" })).toBe("Alice challenged you. Pick a team to accept.");
    expect(lobbyStatusLine({ ...base, me: "opponent", status: "needs-renewal", opponentAccepted: true })).toBe("You accepted. Waiting for Alice to confirm.");
    expect(lobbyStatusLine({ ...base, me: "creator", status: "needs-renewal" })).toMatch(/Confirm it/);
    expect(lobbyStatusLine({ ...base, me: "creator", status: "ready", canLaunch: true, game: { gameId: "7" } })).toBe("Game set up (game 7). Ready to start.");
  });

  it("hash routing and expiry copy", () => {
    expect(lobbyIdFromHash("#abcDEF12_-")).toBe("abcDEF12_-");
    expect(lobbyIdFromHash("")).toBeUndefined();
    expect(lobbyIdFromHash("#<x>")).toBeUndefined();
    expect(expiryLine(0, 1)).toBe("This lobby has expired.");
    expect(expiryLine(30 * 60000, 0)).toBe("Lobby closes in 30 min.");
  });
});

describe("lobby page build (smoke)", () => {
  it("vite build succeeds and emits index.html with the /lobby/ base and the site theme left unbundled", async () => {
    const { build } = await import("vite");
    const outDir = mkdtempSync(join(tmpdir(), "lobby-build-"));
    try {
      await build({
        configFile: fileURLToPath(new URL("../lobby/vite.config.ts", import.meta.url)),
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      expect(html).toMatch(/src="\/lobby\/assets\/index-[\w-]+\.js"/);
      expect(html).toContain('href="/theme.css"');
      expect(readdirSync(join(outDir, "assets")).some((f) => f.endsWith(".css"))).toBe(true);
      // copy rules: no hyphenated reroll, no Java-client wording in the shipped bundle
      const js = readdirSync(join(outDir, "assets")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(outDir, "assets", f), "utf8")).join("\n");
      expect(js).not.toMatch(/re-roll/i);
      expect(js).not.toMatch(/\bjava\b|webstart/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
