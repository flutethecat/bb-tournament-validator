// Admin Reports panel (owner 11-04): the reply to the reporter and the fixed-in version sit in their own "Visible to the
// player" block, apart from the private root cause and notes, and ride the existing PATCH.
import { describe, expect, it } from "vitest";
import { readPublic, runPage, type Any } from "./tournamentRulesHarness.js";

const IDS = ["toolbar", "workspace", "right-rail", "modal-root", "connection-state", "report-status", "report-root-cause", "report-reason", "report-reply", "report-fixed-in"];
const REPORT = {
  id: "2026-11-04T10-00-00-000Z_Kildash_nogame",
  coach: "fumbbl:Kildash",
  kind: "bug",
  description: "Ball vanished after a blitz.",
  submittedAt: "2026-11-04T10:00:00.000Z",
  gameId: null,
  gameService: null,
  clientVersion: "1.0.306",
  files: {},
  triage: { status: "triaged", rootCause: "Stale offer", reason: "Private note", updatedAt: null, updatedBy: null },
  playerUpdate: { reply: "Thanks <b>!</b>", replyAt: "2026-11-04T11:00:00.000Z", fixedIn: "1.0.307", updatedAt: "2026-11-04T11:00:00.000Z" },
};

function boot(patches: Array<{ path: string; body: Any }>) {
  const routes: Record<string, unknown> = {
    "/api/auth/session": { authenticated: false },
    [`/api/bug-reports/${encodeURIComponent(REPORT.id)}`]: (path: string, init: { method?: string; body?: string }) => {
      const body = JSON.parse(init.body ?? "{}");
      patches.push({ path, body });
      return { status: 200, body: { ok: true, report: { ...REPORT, triage: { ...REPORT.triage, status: body.status }, playerUpdate: { ...REPORT.playerUpdate, reply: body.reply, fixedIn: body.fixedIn } } } };
    },
  };
  const page = runPage(`${readPublic("admin.js")}\nglobalThis.__admin = { state, render, saveReportTriage };`, IDS, routes);
  const admin = page.context.__admin as Any;
  admin.state.authed = true;
  admin.state.section = "reports";
  admin.state.reports = [REPORT];
  admin.state.selectedReport = REPORT;
  admin.render();
  return { page, admin };
}

describe("admin Reports panel: reply to reporter", () => {
  it("renders the public reply and fixed-in fields in a separate block labelled as visible to the player", () => {
    const { page } = boot([]);
    const html = page.elements["#workspace"]!.innerHTML;
    expect(html).toContain('<fieldset class="report-player-update">');
    expect(html).toContain("<legend>Visible to the player</legend>");
    expect(html).toContain("Reply to reporter (shown to the player)");
    expect(html).toContain("Fixed in version (shown to the player)");
    expect(html).toContain('id="report-reply"');
    expect(html).toContain('maxlength="2000"');
    expect(html).toContain('id="report-fixed-in"');
    expect(html).toContain('value="1.0.307"');
    expect(html).toContain("Thanks &lt;b&gt;!&lt;/b&gt;"); // escaped
    // The private fields come first and sit outside the public block.
    const publicBlock = html.slice(html.indexOf('<fieldset class="report-player-update">'), html.indexOf("</fieldset>"));
    expect(publicBlock).not.toContain("report-root-cause");
    expect(publicBlock).not.toContain("report-reason");
    expect(html.indexOf('id="report-root-cause"')).toBeLessThan(html.indexOf('<fieldset class="report-player-update">'));
    expect(html).toContain("Root cause and reason stay private to organizers.");
    expect(html).not.toMatch(/re-roll/i);
  });

  it("saves reply and fixedIn alongside the triage in one PATCH", async () => {
    const patches: Array<{ path: string; body: Any }> = [];
    const { page, admin } = boot(patches);
    const set = (id: string, value: string) => { (page.elements[`#${id}`] as Any).value = value; };
    set("report-status", "resolved");
    set("report-root-cause", "Stale offer");
    set("report-reason", "Private note");
    set("report-reply", "Fixed, thanks!");
    set("report-fixed-in", "1.0.307");
    await admin.saveReportTriage(REPORT.id);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ status: "resolved", rootCause: "Stale offer", reason: "Private note", reply: "Fixed, thanks!", fixedIn: "1.0.307" });
    expect(admin.state.reports[0].playerUpdate).toMatchObject({ reply: "Fixed, thanks!", fixedIn: "1.0.307" });
  });
});
