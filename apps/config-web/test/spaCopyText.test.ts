// copyText (spa/src/shell/copyText.ts): the clipboard API on secure origins, the selection copy command on plain http
// (owner 11-13: the Roster Builder's Copy did nothing on the public http address, where navigator.clipboard is undefined).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { copyText } from "../spa/src/shell/copyText";

function fakeDocument(execOk: boolean) {
  const made: any[] = [];
  const doc = {
    activeElement: { focus: vi.fn() },
    body: { appendChild: (el: any) => { el.attached = true; } },
    createElement: () => { const el: any = { style: {}, attrs: {}, setAttribute(k: string, v: string) { this.attrs[k] = v; }, select: vi.fn(), setSelectionRange: vi.fn(), remove() { this.attached = false; } }; made.push(el); return el; },
    execCommand: vi.fn(() => execOk),
  };
  return { doc, made };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("copyText", () => {
  it("uses the clipboard API when the browser offers it", async () => {
    const writeText = vi.fn(async () => undefined);
    const { doc } = fakeDocument(true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", doc);
    await copyText("http://x.test/t/abc");
    expect(writeText).toHaveBeenCalledWith("http://x.test/t/abc");
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it("plain http (no navigator.clipboard): copies through a hidden field, removes it and restores focus", async () => {
    const { doc, made } = fakeDocument(true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", doc);
    await copyText("http://x.test/t/abc");
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(made).toHaveLength(1);
    expect(made[0].value).toBe("http://x.test/t/abc");
    expect(made[0].select).toHaveBeenCalled();
    expect(made[0].attached).toBe(false);
    expect(doc.activeElement.focus).toHaveBeenCalled();
  });

  it("a refused clipboard permission falls back too; a refused copy command throws so callers show their message", async () => {
    const ok = fakeDocument(true);
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    vi.stubGlobal("document", ok.doc);
    await copyText("a");
    expect(ok.doc.execCommand).toHaveBeenCalled();
    const bad = fakeDocument(false);
    vi.stubGlobal("document", bad.doc);
    await expect(copyText("a")).rejects.toThrow("Copy refused");
    expect(bad.made[0].attached).toBe(false);
  });

  it("every copy button in the app goes through copyText", () => {
    for (const f of ["teams/builder.ts", "views/LeagueRedraftRollsView.vue", "views/RulesetSummaryView.vue", "views/TeamManageView.vue"]) {
      const src = readFileSync(new URL(`../spa/src/${f}`, import.meta.url), "utf8");
      expect(src).toContain('import { copyText } from "../shell/copyText";');
      expect(src).not.toMatch(/navigator\.clipboard/);
    }
  });
});
