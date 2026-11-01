import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createSharing, fieldDisabled, startingFields, toggleField, type SharingInfo } from "../spa/src/account/sharing";
import { createLeagueSharing } from "../spa/src/account/leagueSharing";
import { linkProfileNaf, NAF_ADD_PROMPT, nafProblem, nafSharedLine, registrationBody } from "../spa/src/tournaments/detail";
import { createBody } from "../spa/src/tournaments/create";

// SPA side of organiser sharing (spec 2026-10-31): the Account Sharing controller, the league notice's share boxes, the
// registration body and NAF check, and the Create Tournament "NAF sanctioned" flag.

function mockFetcher(routes: Record<string, unknown | ((body: unknown) => unknown)>): Fetcher & { calls: Array<{ path: string; method: string; body: unknown }> } {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown) => unknown)(init.body) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const INFO = (over: Partial<SharingInfo> = {}): SharingInfo => ({
  version: "2026-10-31", text: "Choose what each organiser can see. They can always message you through Super FUMBBL without seeing your email.",
  phoneOnFile: false, emailOnFile: true,
  scopes: [
    { scope: "league:a", kind: "league", id: "a", name: "League A", fields: ["email"], at: "2026-11-01T00:00:00Z" },
    { scope: "tournament:t1", kind: "tournament", id: "t1", name: "Spike Open", fields: [], previous: ["preferredName"] },
  ],
  ...over,
});

describe("Account Sharing controller", () => {
  it("starts each row from what is shared, or the earlier choice to confirm; saves one row with PUT", async () => {
    const f = mockFetcher({
      "/api/me/sharing": INFO(),
      "PUT /api/me/sharing/tournament%3At1": (body: unknown) => INFO({ scopes: [INFO().scopes[0]!, { ...INFO().scopes[1]!, fields: (body as { fields: [] }).fields, previous: undefined }] }),
    });
    const s = createSharing({ api: f });
    await s.load();
    expect(s.state.draft).toEqual({ "league:a": ["email"], "tournament:t1": ["preferredName"] });
    const [league, trn] = s.state.info!.scopes;
    expect(s.dirty(league!)).toBe(false);
    expect(s.dirty(trn!)).toBe(true); // an unconfirmed earlier choice
    s.set("tournament:t1", "email", true);
    expect(s.state.draft["tournament:t1"]).toEqual(["preferredName", "email"]);
    expect(await s.save(trn!)).toBe(true);
    expect(f.calls.at(-1)).toEqual({ path: "/api/me/sharing/tournament%3At1", method: "PUT", body: { fields: ["preferredName", "email"] } });
    expect(s.state.notice).toBe("Saved for Spike Open.");
    expect(s.dirty(s.state.info!.scopes[1]!)).toBe(false);
  });

  it("a refused save shows the server's message; 428 asks for the welcome form", async () => {
    const f = mockFetcher({ "/api/me/sharing": INFO(), "PUT /api/me/sharing/league%3Aa": new ApiError(403, "You have not joined that league.") });
    const s = createSharing({ api: f });
    await s.load();
    expect(await s.save(s.state.info!.scopes[0]!)).toBe(false);
    expect(s.state.error).toBe("You have not joined that league.");
    const g = createSharing({ api: mockFetcher({ "/api/me/sharing": INFO(), "PUT /api/me/sharing/league%3Aa": new ApiError(428, "Complete your profile first.") }) });
    await g.load();
    await g.save(g.state.info!.scopes[0]!);
    expect(g.state.error).toBe("Complete the welcome form first.");
  });

  it("helpers: phone box disabled without a phone; toggles keep the order; starting fields", () => {
    expect(fieldDisabled({ phoneOnFile: false, emailOnFile: true }, "phone")).toBe(true);
    expect(fieldDisabled({ phoneOnFile: true, emailOnFile: true }, "phone")).toBe(false);
    expect(fieldDisabled({ phoneOnFile: true, emailOnFile: false }, "email")).toBe(true);
    expect(toggleField(["phone"], "preferredName", true)).toEqual(["preferredName", "phone"]);
    expect(toggleField(["preferredName", "phone"], "phone", false)).toEqual(["preferredName"]);
    expect(startingFields({ scope: "x", kind: "league", id: "x", name: "X", fields: [], previous: ["email"] })).toEqual(["email"]);
  });
});

describe("league notice share boxes", () => {
  it("the boxes pre-tick from an earlier choice and go with Share as fields", async () => {
    const row = { id: "lg", name: "Test League", status: "pending", onRoster: true, text: "You are joining Test League.", fields: ["phone"] };
    const f = mockFetcher({
      "/api/me/leagues/sharing": { version: "2026-10-31c", phoneOnFile: true, leagues: [row] },
      "POST /api/me/leagues/sharing": { version: "2026-10-31c", phoneOnFile: true, leagues: [{ ...row, status: "shared" }] },
    });
    const ls = createLeagueSharing({ api: f });
    await ls.load("Alice");
    expect(ls.state.fields.lg).toEqual(["phone"]);
    ls.setField("lg", "email", true);
    ls.tick("lg", true);
    expect(await ls.share("lg")).toBe(true);
    expect(f.calls.at(-1)?.body).toEqual({ leagueId: "lg", share: true, acknowledged: true, fields: ["email", "phone"] });
  });
});

describe("registration body and NAF check", () => {
  it("sends share always and notNafMember only when ticked; never a typed NAF number (owner 10-31: the profile is the source)", () => {
    expect(registrationBody("tm1", {})).toEqual({ teamId: "tm1", share: [] });
    expect(registrationBody("tm1", { share: ["email"] })).toEqual({ teamId: "tm1", share: ["email"] });
    expect(registrationBody("tm1", { notNafMember: true })).toEqual({ teamId: "tm1", share: [], notNafMember: true });
  });

  it("sanctioned: profile NAF or not-a-member settles it; otherwise the inline NAF name and number are checked", () => {
    const empty = { nafName: "", nafId: "" };
    expect(nafProblem(false, null, false, empty)).toBe("");
    expect(nafProblem(true, { nafNumber: "34116", nafName: "Alice Fake" }, false, empty)).toBe("");
    expect(nafProblem(true, null, true, empty)).toBe("");
    expect(nafProblem(true, null, false, empty)).toBe(NAF_ADD_PROMPT);
    expect(nafProblem(true, null, false, { nafName: "", nafId: "12" })).toBe("Enter your NAF name.");
    expect(nafProblem(true, null, false, { nafName: "Alice Fake", nafId: "" })).toBe("Enter your NAF number.");
    expect(nafProblem(true, null, false, { nafName: "Alice Fake", nafId: "12a" })).toBe("NAF number must be 1 to 10 digits.");
    expect(nafProblem(true, null, false, { nafName: "<b>", nafId: "12" })).toBe("NAF name can use letters, digits, spaces and . _ ' -");
    expect(nafProblem(true, null, false, { nafName: " Alice Fake ", nafId: " 12 " })).toBe("");
  });

  it("the shared line names the profile's NAF name and number", () => {
    expect(nafSharedLine({ nafName: "Alice Fake", nafNumber: "34116" })).toBe("Your NAF name Alice Fake and number 34116 will be shared with the organiser.");
    expect(nafSharedLine({ nafNumber: "34116" })).toBe("Your NAF number 34116 will be shared with the organiser.");
  });

  it("the inline add saves to the profile through the Account NAF link", async () => {
    const f = mockFetcher({ "POST /api/me/connections/naf": (b: unknown) => ({ nafName: (b as { nafName: string }).nafName, nafId: "34116" }) });
    expect(await linkProfileNaf(f, { nafName: " Alice Fake ", nafId: " 034116 " })).toEqual({ nafName: "Alice Fake", nafNumber: "34116" });
    expect(f.calls).toEqual([{ path: "/api/me/connections/naf", method: "POST", body: { nafName: "Alice Fake", nafId: "034116" } }]);
    const refused = mockFetcher({ "POST /api/me/connections/naf": new ApiError(422, "No NAF coach page was found for number 1.") });
    await expect(linkProfileNaf(refused, { nafName: "A", nafId: "1" })).rejects.toThrow("No NAF coach page");
  });

  it("Create Tournament sends nafSanctioned only when ticked", () => {
    const base = { name: "Spike Open", packageName: "nut-cup", maxPlayers: 16 as const, format: "swiss" as const, roundCount: "" as const, primaryTiebreaker: "buchholz" as const };
    expect(createBody({ ...base, nafSanctioned: false })).not.toHaveProperty("nafSanctioned");
    expect(createBody({ ...base, nafSanctioned: true })).toMatchObject({ nafSanctioned: true });
  });
});

describe("Country field text (review P3 on a7dad19)", () => {
  it("typing over a chosen country keeps every keystroke; an outside change shows the country's name", async () => {
    const { countryTextAfterModel } = await import("../spa/src/account/onboarding");
    // "United Kingdom" chosen, the coach deletes one letter: the model becomes "" but the text stays as typed.
    expect(countryTextAfterModel("United Kingdo", "")).toBe("United Kingdo");
    expect(countryTextAfterModel("G", "")).toBe("G");
    // Typing completes a name: the text is already right.
    expect(countryTextAfterModel("germany", "DE")).toBe("germany");
    // A code set from outside (reload, reset) shows its name.
    expect(countryTextAfterModel("", "GB")).toBe("United Kingdom");
    expect(countryTextAfterModel("France", "DE")).toBe("Germany");
  });
});

describe("stored phone checked only when changed (review P2 on 1c506f7)", () => {
  it("an unchanged stored number that fails today's rules does not block a name edit; editing it is checked", async () => {
    const { createContactEditor } = await import("../spa/src/account/contact");
    const view = {
      preferredName: "Alice", email: "alice@example.test", emailSource: "discord", emailVerified: true, country: "US",
      phones: [{ number: "+15551234", country: "US" }], leagueContact: null, privacy: null, privacyVersion: "2026-10-31", leagueContactText: "x",
    };
    const f = mockFetcher({ "/api/me/contact": view, "PATCH /api/me/contact": { ...view, preferredName: "Alicia" } });
    const e = createContactEditor({ api: f });
    await e.load();
    expect(e.state.form.phones).toEqual([{ number: "5551234", country: "US" }]); // still displayed
    expect(e.problems().phones).toEqual([""]);
    e.state.form.preferredName = "Alicia";
    expect(await e.save()).toBe(true);
    expect(f.calls.at(-1)).toEqual({ path: "/api/me/contact", method: "PATCH", body: { preferredName: "Alicia" } });
    e.state.form.phones[0]!.number = "555 12345";
    expect(e.problems().phones[0]).toBe("Enter the number without the country code, for example 555 123 4567.");
  });

  it("onboarding re-acceptance keeps an unchanged stored phone out of the body and out of the checks", async () => {
    const { createOnboarding } = await import("../spa/src/account/onboarding");
    const info = { needed: true, privacyVersion: "2026-10-31", leagueContactText: "x", prefill: { preferredName: "a", email: "a@b.cd", emailSource: "discord", country: "US", phones: [{ number: "+15551234", country: "US" }] } };
    const f = mockFetcher({ "/api/me/onboarding": info, "POST /api/me/onboarding": { ...info, needed: false } });
    const o = createOnboarding({ api: f });
    await o.load("Alice");
    o.state.form.privacyAccepted = true;
    expect(o.canSubmit()).toBe(true);
    expect(await o.submit()).toBe(true);
    expect(f.calls.at(-1)!.body).not.toHaveProperty("phones");
  });
});
