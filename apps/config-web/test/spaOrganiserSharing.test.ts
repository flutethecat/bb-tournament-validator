import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createSharing, fieldDisabled, startingFields, toggleField, type SharingInfo } from "../spa/src/account/sharing";
import { createLeagueSharing } from "../spa/src/account/leagueSharing";
import { nafProblem, registrationBody } from "../spa/src/tournaments/detail";
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
  it("sends share always, a NAF number or notNafMember only when given", () => {
    expect(registrationBody("tm1", {})).toEqual({ teamId: "tm1", share: [] });
    expect(registrationBody("tm1", { share: ["email"], nafNumber: " 42 " })).toEqual({ teamId: "tm1", share: ["email"], nafNumber: "42" });
    expect(registrationBody("tm1", { nafNumber: "42", notNafMember: true })).toEqual({ teamId: "tm1", share: [], notNafMember: true });
  });

  it("required on a sanctioned tournament unless not a member; format-checked when typed", () => {
    expect(nafProblem(true, "", false)).toBe("NAF number required for this NAF-sanctioned tournament.");
    expect(nafProblem(true, "", true)).toBe("");
    expect(nafProblem(true, "12345", false)).toBe("");
    expect(nafProblem(true, "12a", false)).toBe("NAF number must be 1 to 10 digits.");
    expect(nafProblem(false, "", false)).toBe("");
  });

  it("Create Tournament sends nafSanctioned only when ticked", () => {
    const base = { name: "Spike Open", packageName: "nut-cup", maxPlayers: 16 as const, format: "swiss" as const, roundCount: "" as const, primaryTiebreaker: "buchholz" as const };
    expect(createBody({ ...base, nafSanctioned: false })).not.toHaveProperty("nafSanctioned");
    expect(createBody({ ...base, nafSanctioned: true })).toMatchObject({ nafSanctioned: true });
  });
});
