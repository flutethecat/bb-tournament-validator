// Competition templates in the SPA: the tournament wizard's Save as template body (relative times, no webhook, payment
// links only when kept), Start from template (relative check-in times fill in once Starts is set, without overwriting an
// organiser's own edit), and the Start a new season body for Copy last season / From template.
import { describe, expect, it } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { createTemplates, type TemplateView } from "../spa/src/shared/templates";
import { templatesFor } from "../spa/src/shared/templateCache";
import { createTournamentWizard, templateContent } from "../spa/src/tournaments/wizard";
import { newSeasonBody } from "../spa/src/leagues/templates";
import { parseTournamentTemplateContent } from "../src/competition/templates";
import { tournamentContentOptions } from "../src/templates/tournament";

const noApi = (async () => { throw new Error("no network in this test"); }) as never;

describe("tournament wizard and templates", () => {
  it("Save as template: the form becomes a template body the server accepts, times relative to the start", () => {
    const w = createTournamentWizard({ api: noApi });
    w.start({ restore: false });
    Object.assign(w.state.form, {
      name: "Spring Open", startsAt: "2026-12-05T09:00", checkInOpensAt: "2026-12-04T09:00", checkInClosesAt: "2026-12-05T08:30", closesAt: "2026-12-01T09:00",
      payPal: "paypal.me/SpringOpen", maxPlayers: 24, entryFee: "15 GBP",
    });
    w.state.discord.webhook = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
    const body = templateContent(w.state.form, w.state.discord.events, false);
    expect(JSON.stringify(body)).not.toContain("webhooks");
    expect(body.payLinks).toBeUndefined();
    const c = parseTournamentTemplateContent(body, tournamentContentOptions());
    expect(c.relative).toEqual({ registrationOpens: null, registrationCloses: 4 * 1440, rosterBy: null, checkInOpens: 1440, checkInCloses: 30 });
    expect(c.maxPlayers).toBe(24);
    expect(parseTournamentTemplateContent(templateContent(w.state.form, {}, true), tournamentContentOptions()).payLinks).toEqual({ payPal: "https://paypal.me/SpringOpen" });
  });

  it("Start from template: settings applied, check-in times resolve when Starts is set, own edits kept", () => {
    const w = createTournamentWizard({ api: noApi });
    w.start({ restore: false });
    const c = parseTournamentTemplateContent({
      packageName: "Small Gods", format: "roundRobin", maxPlayers: 10, approval: "organiser", points: { win: 2000, draw: 1000, loss: 0 },
      relative: { checkInOpens: 1440, checkInCloses: 30, registrationCloses: 2 * 1440 }, discordEvents: { matchStarted: true }, payLinks: { venmo: "Spring-Open" },
    }, tournamentContentOptions());
    w.applyTemplate("Club night", c, false);
    expect(w.state.form).toMatchObject({ packageName: "Small Gods", format: "roundRobin", maxPlayers: 10, approval: "organiser", venmo: "", checkInOpensAt: "" });
    expect(w.state.discord.events.matchStarted).toBe(true);
    w.state.form.startsAt = "2027-03-06T10:00";
    w.resolveTemplateTimes();
    expect(w.state.form.checkInOpensAt).toBe("2027-03-05T10:00");
    expect(w.state.form.checkInClosesAt).toBe("2027-03-06T09:30");
    expect(w.state.form.closesAt).toBe("2027-03-04T10:00");
    // the organiser edits one; a new start moves the others, not the edited one
    w.state.form.checkInClosesAt = "2027-03-06T09:45";
    w.state.form.startsAt = "2027-04-10T10:00";
    w.resolveTemplateTimes();
    expect(w.state.form.checkInOpensAt).toBe("2027-04-09T10:00");
    expect(w.state.form.checkInClosesAt).toBe("2027-03-06T09:45");
    // payment links only when asked
    w.applyTemplate("Club night", c, true);
    expect(w.state.form.venmo).toBe("Spring-Open");
  });

  it("Start a new season: Copy last season is the default body; From template sends the template and the choices", () => {
    expect(newSeasonBody({ name: "Season 3", ruleset: "BB2025", source: "last", templateId: "", applyRules: true, usePayLinks: false })).toEqual({ name: "Season 3", ruleset: "BB2025", from: "last" });
    expect(newSeasonBody({ name: "Season 3", ruleset: "BB2025", source: "template", templateId: "tp0123456789ab", applyRules: false, usePayLinks: true }))
      .toEqual({ name: "Season 3", from: "template", templateId: "tp0123456789ab", applyRules: false, usePayLinks: true });
  });
});

const view = (id: string, owner: string, content: Record<string, unknown>): TemplateView => ({
  id, kind: "tournament", name: `T ${id}`, description: "", mine: true, owner, sharedWith: [], hasPayLinks: false, content, summary: [], createdAt: "", updatedAt: "", revision: 0,
});

describe("templates through the reactive controller", () => {
  it("Use template with a template from the reactive list (Vue proxies): no DataCloneError, nothing shared with the list", async () => {
    const content = parseTournamentTemplateContent({ packageName: "Small Gods", houseRules: { prayers: { mode: "banned" }, progression: { enabled: true } }, relative: { checkInOpens: 60 } }, tournamentContentOptions());
    const api = (async () => ({ templates: [view("tp000000000001", "Jay", content as never)] })) as never;
    const templates = createTemplates(api, "tournament", () => "Jay");
    await templates.load();
    const fromList = templates.state.list[0]!;
    const w = createTournamentWizard({ api: noApi });
    w.start({ restore: false });
    expect(() => w.applyTemplate(fromList.name, fromList.content as never, false)).not.toThrow();
    expect(w.state.form.houseRules.prayers.mode).toBe("banned");
    w.state.form.houseRules.prayers.mode = "ruleset";
    expect((templates.state.list[0]!.content as any).houseRules.prayers.mode).toBe("banned");
    // and saving it back: the wizard body from a reactive form clones cleanly
    w.state.form.startsAt = "2027-01-01T10:00";
    expect(() => templateContent(w.state.form, reactive({ published: true }), false)).not.toThrow();
  });

  it("the cache follows the signed-in account: switching empties the list and drops the old account's late reply", async () => {
    const who = ref("Jay");
    const replies: Array<(v: unknown) => void> = [];
    const api = ((path: string) => new Promise((resolve) => { replies.push(resolve); void path; })) as never;
    const session = { coach: () => who.value };
    const t = templatesFor(api, session, "tournament");
    expect(templatesFor(api, session, "tournament")).toBe(t);
    const first = t.load();
    replies.shift()!({ templates: [view("tp00000000000a", "Jay", {})] });
    await first;
    expect(t.state.list.map((x) => x.id)).toEqual(["tp00000000000a"]);
    // a reload starts for Jay, then Kim signs in before the reply comes back
    const slow = t.load();
    who.value = "Kim";
    await nextTick();
    expect(t.state.list).toEqual([]);
    expect(t.state.loaded).toBe(false);
    replies.shift()!({ templates: [view("tp00000000000a", "Jay", {})] });
    await slow;
    expect(t.state.list).toEqual([]);
    // Kim's own list loads
    const kims = t.load();
    replies.shift()!({ templates: [view("tp00000000000b", "Kim", {})] });
    await kims;
    expect(t.state.list.map((x) => x.id)).toEqual(["tp00000000000b"]);
    // sign-out empties it too
    who.value = "";
    await nextTick();
    expect(t.state.list).toEqual([]);
  });
});
