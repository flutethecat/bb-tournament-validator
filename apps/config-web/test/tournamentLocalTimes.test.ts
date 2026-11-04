import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { gateInstant, parseInstant, registrationGateShut, tournamentTimeZone, utcWhenText, type TournamentGate } from "../src/tournaments/registrationGate.js";
import { discordTime } from "../src/discord/posts.js";
import { fromZoneInput, keptOrTyped, localDay, localWhen, localWhenLong, toZoneInput, viewerZone, zoneAbbr, zoneCaption } from "../spa/src/shared/localTime";
import { gateForm } from "../spa/src/leagues/gates";
import { cardDates } from "../spa/src/tournaments/list";
import { eventDates } from "../spa/src/tournaments/series";
import type { TournamentRecord } from "../src/tournaments/types.js";

// Owner 11-04: "Instead of doing tournament time zone, let's store these in epoch time and reveal them in the user's local
// time zone for the device they're viewing." Tournament times are UTC instants; pages show them in the browser's zone with
// its abbreviation and take typed times in that zone; an untouched time is never re-derived; server text says UTC; Discord
// uses <t:epoch>. League times keep the league zone (not touched here).

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const OWNER: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };

describe("the viewer's zone (spa/src/shared/localTime.ts)", () => {
  const at = "2026-12-05T09:00:00.000Z";
  it("shows an instant in the given zone with its abbreviation, through Intl", () => {
    expect(localWhen(at, "UTC")).toBe("05 Dec 2026, 09:00 UTC");
    expect(localWhen(at, "America/Los_Angeles")).toBe("05 Dec 2026, 01:00 PST");
    expect(localWhen(at, "America/New_York")).toBe("05 Dec 2026, 04:00 EST");
    expect(localWhen(at, "Europe/London")).toBe("05 Dec 2026, 09:00 GMT");
    expect(localWhen(at, "Australia/Sydney")).toBe("05 Dec 2026, 20:00 GMT+11");
    expect(localWhen("2026-07-05T09:00:00.000Z", "America/Los_Angeles")).toBe("05 Jul 2026, 02:00 PDT");
    expect(localWhenLong(at, "UTC")).toBe("Sat 05 Dec 2026, 09:00 UTC");
    expect(zoneAbbr(at, "Asia/Tokyo")).toBe("GMT+9");
    expect(localDay("2026-12-05T23:30:00.000Z", "Asia/Tokyo")).toBe("2026-12-06");
    expect(localWhen(undefined)).toBe("");
    expect(localWhen("not a time")).toBe("");
    // the default is the device's zone
    expect(viewerZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(localWhen(at)).toBe(localWhen(at, viewerZone()));
    expect(zoneCaption("UTC")).toBe("your time, UTC");
    // the cards and series rows show the start day in the viewer's zone
    expect(cardDates({ startsAt: "2026-12-05T23:30:00.000Z", endsAt: "2026-12-06T10:00:00.000Z" }, "Asia/Tokyo")).toBe("2026-12-06");
    expect(cardDates({ startsAt: "2026-12-05T23:30:00.000Z", endsAt: "2026-12-06T10:00:00.000Z" }, "UTC")).toBe("2026-12-05 to 2026-12-06");
    expect(eventDates({ startsAt: "2026-12-05T02:00:00.000Z" }, "America/Los_Angeles")).toBe("2026-12-04");
  });

  it("a time typed in the viewer's zone becomes the instant; DST gaps resolve forward; '' clears", () => {
    expect(fromZoneInput("2026-12-05T01:00", "America/Los_Angeles")).toBe(at);
    expect(fromZoneInput("2026-12-05T20:00", "Australia/Sydney")).toBe(at);
    expect(toZoneInput(at, "Europe/Paris")).toBe("2026-12-05T10:00");
    // 2026-03-08 02:30 does not exist in Los Angeles (clocks jump 02:00 -> 03:00)
    expect(fromZoneInput("2026-03-08T02:30", "America/Los_Angeles")).toBe("2026-03-08T10:30:00.000Z");
    expect(fromZoneInput("", "UTC")).toBe("");
    expect(fromZoneInput("garbage", "UTC")).toBe("");
  });

  it("an untouched field keeps its stored instant exactly (seconds and all); a changed one is converted", () => {
    const stored = "2026-12-05T09:00:42.123Z";
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
      expect(keptOrTyped(stored, toZoneInput(stored, zone), zone)).toBe(stored);
    }
    expect(keptOrTyped(stored, "2026-12-05T10:00", "UTC")).toBe("2026-12-05T10:00:00.000Z");
    expect(keptOrTyped(stored, "", "UTC")).toBe("");
    expect(keptOrTyped(undefined, "2026-12-05T10:00", "Asia/Kolkata")).toBe("2026-12-05T04:30:00.000Z");
  });

  it("the tournament gate editor fills the opening time in the viewer's zone (the server sends no wall time)", () => {
    const g = { id: "registration:tournament", kind: "registration", target: "tournament", targetName: "Spike Open", label: "Registration", title: "", state: "shut", opensAt: at, secondsLeft: 10, mode: "time", revision: 1 } as const;
    expect(gateForm({ ...g }, Date.parse(at), "America/New_York").wall).toBe("2026-12-05T04:00");
    expect(gateForm({ ...g }, Date.parse(at), "Asia/Tokyo").wall).toBe("2026-12-05T18:00");
  });
});

describe("server: instants, UTC-labelled text, Discord timestamps", () => {
  function harness(start = "2026-11-10T12:00:00.000Z") {
    const root = mkdtempSync(join(tmpdir(), "bbtv-times-"));
    roots.push(root);
    const store = new TournamentStore(root);
    const clock = { now: new Date(start) };
    const deps = (): TournamentApiDeps => ({ store, now: () => clock.now, teamBuild: () => undefined, packageExists: (n) => n === "Spike 2026", registeredCoach: (n) => n });
    const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) => tournamentApi(method, path, new URLSearchParams(), auth, body, deps());
    return { store, clock, call };
  }
  const gatePath = (t: TournamentRecord) => `/api/tournaments/${t.id}/gates/registration/tournament`;

  it("the gate takes an ISO instant (any offset) and stores it as UTC; a legacy wall time still reads in the old zone", async () => {
    const h = harness();
    const res = await h.call("POST", "/api/tournaments", OWNER, { name: "Spike Open", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, startsAt: "2026-12-05T09:00:00.000Z", registration: { approval: "auto", waitlist: true, rosterLater: true } });
    const t = (res!.body as { tournament: TournamentRecord }).tournament;
    // typed 19:00 in New York = 00:00 UTC next day
    const set = await h.call("PUT", gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00:00.000-05:00" });
    expect(set?.status).toBe(201);
    expect(h.store.tournament(t.id)!.registrationGate!.opensAt).toBe("2026-11-13T00:00:00.000Z");
    const view = (await h.call("GET", `/api/tournaments/${t.id}/gates`))!.body as { timeZone: string; gates: Array<Record<string, unknown>> };
    expect(view.gates[0]).toMatchObject({ opensAt: "2026-11-13T00:00:00.000Z" });
    expect(view.gates[0]).not.toHaveProperty("wall");
    expect(view.timeZone).toBe("UTC");
    // the public registration facts carry the opening instant; the server's own sentence says UTC
    const detail = (await h.call("GET", `/api/tournaments/${t.id}`))!.body as { registrationStatus: { open: boolean; gateOpensAt?: string; message?: string } };
    expect(detail.registrationStatus).toMatchObject({ open: false, gateOpensAt: "2026-11-13T00:00:00.000Z", message: "Registration opens Fri 13 Nov 2026, 00:00 UTC." });
    // a refused value
    expect((await h.call("PUT", gatePath(t), OWNER, { revision: 1, mode: "time", opensAt: "soon" }))?.status).toBe(400);
    // a gate stored by an earlier build (a wall time) reads in the zone it was typed in: UTC unless a zone was stored
    const legacy: TournamentGate = { opensAt: "2026-11-12T19:00", armedAt: "2026-11-10T12:00:00.000Z", state: "shut", revision: 1, createdAt: "", updatedAt: "" };
    expect(gateInstant(legacy, tournamentTimeZone({}))).toBe(Date.parse("2026-11-12T19:00:00.000Z"));
    expect(gateInstant(legacy, tournamentTimeZone({ timeZone: "Europe/Paris" }))).toBe(Date.parse("2026-11-12T18:00:00.000Z"));
    expect(registrationGateShut({ registrationGate: legacy }, new Date("2026-11-10T12:00:00.000Z"))?.opensAt).toBe("2026-11-12T19:00:00.000Z");
    expect(parseInstant("2026-11-12T19:00")).toBeUndefined();
    expect(parseInstant("2026-11-12T19:00Z")).toBe(Date.parse("2026-11-12T19:00:00.000Z"));
  });

  it("stored instants never move on an unrelated save; server text is UTC-labelled; Discord gets <t:epoch>", async () => {
    const h = harness();
    const startsAt = "2026-12-05T09:00:42.500Z";
    const res = await h.call("POST", "/api/tournaments", OWNER, { name: "Spike Open", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, startsAt, deadlines: { registration: "2026-12-01T18:00:00.000Z", checkIn: "2026-12-05T08:30:00.000Z" } });
    const t = (res!.body as { tournament: TournamentRecord }).tournament;
    await h.call("PATCH", `/api/tournaments/${t.id}`, OWNER, { entryFee: "15 GBP", maxPlayers: 6 });
    const after = h.store.tournament(t.id)!;
    expect(after.entryFee).toBe("15 GBP");
    expect(after.startsAt).toBe(startsAt);
    expect(after.deadlines).toEqual({ registration: "2026-12-01T18:00:00.000Z", checkIn: "2026-12-05T08:30:00.000Z" });
    expect(utcWhenText("2026-12-05T09:00:00.000Z")).toBe("Sat 5 Dec 2026, 09:00 UTC");
    expect(discordTime("2026-12-05T09:00:00.000Z")).toBe(`<t:${Date.parse("2026-12-05T09:00:00.000Z") / 1000}:F>`);
    expect(discordTime(Date.parse("2026-12-05T09:00:00.000Z"), "R")).toBe(`<t:${Date.parse("2026-12-05T09:00:00.000Z") / 1000}:R>`);
    expect(discordTime(undefined)).toBeUndefined();
  });
});
