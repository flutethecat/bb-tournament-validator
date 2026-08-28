import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiIdentity, type TournamentApiResult } from "../src/tournaments/api.js";
import { migrateTournamentData, TournamentStore } from "../src/tournaments/store.js";
import type { TournamentRecord } from "../src/tournaments/types.js";

const roots: string[] = [];
const now = new Date("2026-08-27T20:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const otherOrganizer: TournamentApiIdentity = { coach: "OtherTO", organizer: true, admin: false };
const admin: TournamentApiIdentity = { coach: "RootAdmin", organizer: true, admin: true };
const player: TournamentApiIdentity = { coach: "Alice", organizer: false, admin: false };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-owner-naf-"));
  roots.push(root);
  return new TournamentStore(root);
}

const identityRows: Record<string, { ffbCoachId: string; identities: { nafName?: string; nafId?: string } }> = {
  veers: { ffbCoachId: "Veers", identities: { nafName: "Veers & Sons", nafId: "900" } },
  alice: { ffbCoachId: "Alice", identities: { nafName: "Alice <Ace>", nafId: "101" } },
  bob: { ffbCoachId: "Bob", identities: { nafName: "Bob \"Blocker\"", nafId: "202" } },
};

function call(
  store: TournamentStore,
  method: string,
  path: string,
  auth?: TournamentApiIdentity,
  body?: unknown,
  query = "",
  identities = identityRows,
) {
  return tournamentApi(method, path, new URLSearchParams(query), auth, body, {
    store,
    packageExists: (name) => name === "Rules",
    teamOwner: (teamId) => ({ "team-alice": "Alice", "team-bob": "Bob" })[teamId],
    teamBuild: (teamId) => teamId === "team-alice"
      ? { teamName: "Ampersands", race: "Human & Elf", teamValue: 1_250_000 }
      : { teamName: "Quotes", rosterName: "Orc <Renegade>", currentTeamValue: 1_100_000 },
    identityRecord: (coachId) => identities[coachId.trim().toLowerCase()],
    now: () => now,
  });
}

function tournament(store: TournamentStore, status: TournamentRecord["status"] = "draft"): TournamentRecord {
  const created = store.createTournament({
    name: "Owner's Cup",
    packageName: "Rules",
    maxPlayers: 4,
    format: "swiss",
    organizerCoachId: owner.coach,
  }, now);
  if (status !== "draft") {
    const snapshot = store.snapshot();
    snapshot.tournaments[created.id]!.status = status;
    store.writeSnapshot(snapshot);
  }
  return store.tournament(created.id)!;
}

function addEntrants(store: TournamentStore, tournamentId: string): void {
  for (const coach of ["Alice", "Bob"]) {
    store.registerEntrant(tournamentId, {
      coachId: coach,
      ffbCoachId: coach,
      verifiedAt: now.toISOString(),
    }, `team-${coach.toLowerCase()}`, now);
  }
}

async function gatedOperation(
  operation: "patch" | "rounds" | "finish" | "export",
  auth?: TournamentApiIdentity,
): Promise<TournamentApiResult | undefined> {
  const store = newStore();
  const active = operation === "rounds" || operation === "finish";
  const record = tournament(store, active ? "active" : "draft");
  if (operation === "rounds") addEntrants(store, record.id);
  if (operation === "patch") return call(store, "PATCH", `/api/tournaments/${record.id}`, auth, { maxPlayers: 5 });
  if (operation === "rounds") return call(store, "POST", `/api/tournaments/${record.id}/rounds`, auth, {});
  if (operation === "finish") return call(store, "POST", `/api/tournaments/${record.id}/finish`, auth, {});
  return call(store, "GET", `/api/tournaments/${record.id}/export`, auth, undefined, "format=json");
}

describe("per-tournament organizer permissions", () => {
  it.each(["patch", "rounds", "finish", "export"] as const)(
    "%s allows the owner and admin, rejects another organizer verbatim, and requires auth",
    async (operation) => {
      expect((await gatedOperation(operation, owner))?.status).toBe(200);
      expect(await gatedOperation(operation, otherOrganizer)).toEqual({
        status: 403,
        body: { error: "You are not this tournament's organizer." },
      });
      expect((await gatedOperation(operation, admin))?.status).toBe(200);
      expect(await gatedOperation(operation)).toEqual({
        status: 401,
        body: { error: "Authentication required." },
      });
    },
  );

  it("keeps csv/json private from unauthenticated and ordinary coach sessions", async () => {
    const store = newStore();
    const record = tournament(store);
    for (const format of ["csv", "json"] as const) {
      const path = `/api/tournaments/${record.id}/export`;
      expect((await call(store, "GET", path, undefined, undefined, `format=${format}`))?.status).toBe(401);
      expect(await call(store, "GET", path, player, undefined, `format=${format}`)).toEqual({
        status: 403,
        body: { error: "You are not this tournament's organizer." },
      });
    }
  });

  it("keeps legacy ownerless rows admin-only until an admin assigns the owner", async () => {
    const store = newStore();
    const record = tournament(store);
    const snapshot = store.snapshot();
    delete snapshot.tournaments[record.id]!.organizerCoachId;
    store.writeSnapshot(snapshot);
    const exportPath = `/api/tournaments/${record.id}/export`;

    expect(await call(store, "GET", exportPath, otherOrganizer, undefined, "format=json")).toEqual({
      status: 403,
      body: { error: "You are not this tournament's organizer." },
    });
    expect((await call(store, "GET", exportPath, admin, undefined, "format=json"))?.status).toBe(200);
    expect(await call(store, "PATCH", `/api/tournaments/${record.id}`, admin, { organizerCoachId: "OtherTO" }))
      .toMatchObject({ status: 200, body: { tournament: { organizerCoachId: "OtherTO" } } });
    expect((await call(store, "GET", exportPath, otherOrganizer, undefined, "format=json"))?.status).toBe(200);
    expect(await call(store, "PATCH", `/api/tournaments/${record.id}`, otherOrganizer, { organizerCoachId: "Veers" }))
      .toEqual({ status: 403, body: { error: "Only an admin may change organizerCoachId." } });
  });

  it("migrates v2 atomically to v3 without inventing an owner for legacy rows", () => {
    const store = newStore();
    const record = tournament(store);
    const snapshot = store.snapshot();
    delete snapshot.tournaments[record.id]!.organizerCoachId;
    const migrated = migrateTournamentData({ ...snapshot, version: 2 });
    expect(migrated.version).toBe(3);
    expect(migrated.tournaments[record.id]).not.toHaveProperty("organizerCoachId");
    expect(store.writeSnapshot({ ...snapshot, version: 2 }).version).toBe(3);
    expect(store.snapshot().version).toBe(3);
  });

  it("scopes manual registration and dropping another entrant while preserving self-drop", async () => {
    const store = newStore();
    const record = tournament(store);
    const collection = `/api/tournaments/${record.id}/entrants`;
    expect(await call(store, "POST", collection, otherOrganizer, { teamId: "team-bob", coach: "Bob" }))
      .toEqual({ status: 403, body: { error: "You are not this tournament's organizer." } });
    const seeded = await call(store, "POST", collection, owner, { teamId: "team-bob", coach: "Bob" });
    const entrantId = (seeded?.body as { entrant: { id: string } }).entrant.id;
    expect(await call(store, "DELETE", `${collection}/${encodeURIComponent(entrantId)}`, otherOrganizer))
      .toEqual({ status: 403, body: { error: "You are not this tournament's organizer." } });
    expect((await call(store, "DELETE", `${collection}/${encodeURIComponent(entrantId)}`, {
      coach: "Bob", organizer: false, admin: false,
    }))?.status).toBe(200);
  });
});

describe("NAF submission export", () => {
  function completedTournament(store: TournamentStore): TournamentRecord {
    const record = tournament(store, "active");
    addEntrants(store, record.id);
    const round = store.generateNextRound(record.id, now);
    const match = store.match(round.scheduledMatchIds[0]!)!;
    store.recordResult(match.id, {
      expectedRevision: match.revision,
      homeScore: 2,
      awayScore: 1,
      homeCasualties: 3,
      awayCasualties: 1,
    }, now);
    return record;
  }

  it("returns owner-only XML with NAF fields, results, team data, and XML escaping", async () => {
    const store = newStore();
    const record = completedTournament(store);
    const result = await call(store, "GET", `/api/fork/tournaments/${record.id}/export`, owner, undefined, "format=naf");
    expect(result).toMatchObject({
      status: 200,
      contentType: "application/xml; charset=utf-8",
      headers: { "content-disposition": 'attachment; filename="Owner-s-Cup-naf.xml"' },
    });
    expect(result?.body).toContain("<organizer>Veers &amp; Sons</organizer>");
    expect(result?.body).toContain("<name>Alice &lt;Ace&gt;</name>");
    expect(result?.body).toContain("<name>Bob &quot;Blocker&quot;</name>");
    expect(result?.body).toContain("<team>Human &amp; Elf</team>");
    expect(result?.body).toContain("<team>Orc &lt;Renegade&gt;</team>");
    expect(result?.body).toContain("<teamRating>1250</teamRating>");
    expect(result?.body).toContain("<touchDowns>2</touchDowns>");
    expect(result?.body).toContain("<badlyHurt>3</badlyHurt>");
  });

  it("returns 400 with the full missing-number problems list verbatim", async () => {
    const store = newStore();
    const record = completedTournament(store);
    const identities = structuredClone(identityRows);
    delete identities.alice!.identities.nafId;
    const result = await call(store, "GET", `/api/tournaments/${record.id}/export`, owner, undefined, "format=naf", identities);
    expect(result).toEqual({
      status: 400,
      body: {
        error: "NAF export is unavailable: Alice: missing NAF number",
        problems: ["Alice: missing NAF number"],
      },
    });
  });

  it("returns 400 when the tournament organizer has no NAF name", async () => {
    const store = newStore();
    const record = completedTournament(store);
    const identities = structuredClone(identityRows);
    delete identities.veers!.identities.nafName;
    const result = await call(store, "GET", `/api/tournaments/${record.id}/export`, owner, undefined, "format=naf", identities);
    expect(result).toEqual({
      status: 400,
      body: {
        error: "NAF export is unavailable: Veers: exporting organizer is missing a NAF name",
        problems: ["Veers: exporting organizer is missing a NAF name"],
      },
    });
  });
});
