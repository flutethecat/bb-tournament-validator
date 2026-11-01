import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leagueDialogKey } from "../spa/src/leagues/dialog";

// League dialog keys (LeagueDialog.vue): Escape and Tab keep working after the focused control was removed (focus on
// <body>) or focus left the dialog, because the dialog listens on the window while it is open.

describe("league dialog keys", () => {
  const list = ["first", "middle", "last"];
  const tab = { key: "Tab", shiftKey: false };
  const back = { key: "Tab", shiftKey: true };

  it("Escape closes unless a request is in flight, wherever focus is", () => {
    expect(leagueDialogKey({ key: "Escape", shiftKey: false }, list, "body", false, "frame", false)).toEqual({ type: "close" });
    expect(leagueDialogKey({ key: "Escape", shiftKey: false }, list, "middle", true, "frame", false)).toEqual({ type: "close" });
    expect(leagueDialogKey({ key: "Escape", shiftKey: false }, list, "body", false, "frame", true)).toEqual({ type: "block" });
    expect(leagueDialogKey({ key: "Enter", shiftKey: false }, list, "body", false, "frame", false)).toBeNull();
  });

  it("[review P2] focus outside the dialog (a removed button left it on body): Tab and Shift+Tab bring it back", () => {
    expect(leagueDialogKey(tab, list, "body", false, "frame", false)).toEqual({ type: "focus", target: "first" });
    expect(leagueDialogKey(back, list, "body", false, "frame", false)).toEqual({ type: "focus", target: "last" });
    expect(leagueDialogKey(tab, list, null, false, "frame", false)).toEqual({ type: "focus", target: "first" });
    expect(leagueDialogKey(tab, [], "body", false, "frame", false)).toEqual({ type: "focus", target: "frame" });
  });

  it("inside the dialog Tab wraps at both ends and is left alone in between", () => {
    expect(leagueDialogKey(tab, list, "last", true, "frame", false)).toEqual({ type: "focus", target: "first" });
    expect(leagueDialogKey(back, list, "first", true, "frame", false)).toEqual({ type: "focus", target: "last" });
    expect(leagueDialogKey(tab, list, "middle", true, "frame", false)).toBeNull();
    expect(leagueDialogKey(tab, list, "frame", true, "frame", false)).toEqual({ type: "focus", target: "first" });
  });

  it("the dialog listens on the window (capture) only while it is open", () => {
    const src = readFileSync(fileURLToPath(new URL("../spa/src/components/LeagueDialog.vue", import.meta.url)), "utf8");
    expect(src).toContain('window.addEventListener("keydown", onKey, true)');
    expect(src).toContain('window.removeEventListener("keydown", onKey, true)');
    expect(src).not.toMatch(/@keydown="onKey"/);
  });
});
