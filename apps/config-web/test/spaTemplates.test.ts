// Competition templates in the SPA: the tournament wizard's Save as template body (relative times, no webhook, payment
// links only when kept), Start from template (relative check-in times fill in once Starts is set, without overwriting an
// organiser's own edit), and the Start a new season body for Copy last season / From template.
import { describe, expect, it } from "vitest";
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
