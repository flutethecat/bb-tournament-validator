import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { requireSession } from "../src/auth/requireSession.js";
import { migrateTournamentData, TournamentStore } from "../src/tournaments/store.js";
import type { ScheduledMatchRecord, TournamentDataFileV2, TournamentEntrantRecord, TournamentRecord } from "../src/tournaments/types.js";

const roots: string[] = [];
const now = new Date("2026-08-26T12:00:00.000Z");
const player = (coach: string): TournamentApiIdentity => ({ coach, organizer: false, admin: false });
const organizer: TournamentApiIdentity = { coach: "TO", organizer: true, admin: false };

function tournament(): TournamentRecord {
  return {
    id: "spike-cup",
    name: "Spike Cup",
    status: "active",
    format: "swiss",
    packageName: "Spike 2026",
    maxPlayers: 16,
    roundCount: 3,
    currentRound: 1,
    tiebreakers: ["buchholz", "touchdownDifferential", "seed"],
    points: { win: 3, draw: 1, loss: 0, bye: 3 },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function entrant(id: "alice" | "bob", seed: number): TournamentEntrantRecord {
  const name = id === "alice" ? "Alice" : "Bob";
  return {
    id,
    tournamentId: "spike-cup",
    seed,
    coach: { coachId: id, ffbCoachId: name, discordUserId: `discord-${id}`, verifiedAt: now.toISOString() },
    teamId: `team-${id}`,
    registeredAt: now.toISOString(),
  };
}

function scheduled(status: ScheduledMatchRecord["status"] = "scheduled", revision = 1): ScheduledMatchRecord {
  return {
    id: "spike-cup:round:1:match:1",
    tournamentId: "spike-cup",
    roundId: "spike-cup:round:1",
    roundNumber: 1,
    home: { entrantId: "alice", coach: entrant("alice", 1).coach, teamId: "team-alice" },
    away: { entrantId: "bob", coach: entrant("bob", 2).coach, teamId: "team-bob" },
    status,
    revision,
    launch: {
      challengePath: "/api/fork/challenge",
      jnlpPath: "/api/fork/jnlp",
      retryCount: 0,
      ...(status === "launch_failed" ? { lastError: "fork offline", lastAttemptAt: now.toISOString() } : {}),
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function store(match = scheduled()): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tournaments-"));
  roots.push(root);
  const result = new TournamentStore(root);
  const alice = entrant("alice", 1);
  const bob = entrant("bob", 2);
  result.writeSnapshot({
    version: 2,
    tournaments: { "spike-cup": tournament() },
    entrants: { alice, bob },
    rounds: {
      "spike-cup:round:1": {
        id: "spike-cup:round:1",
        tournamentId: "spike-cup",
        number: 1,
        status: "active",
        scheduledMatchIds: [match.id],
        createdAt: now.toISOString(),
      },
    },
    standings: {},
    scheduledMatches: { [match.id]: match },
    waitingPresence: {},
  });
  return result;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function call(store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) {
  return tournamentApi(method, path, new URLSearchParams(), auth, body, {
    store,
    teamBuild: (teamId) => teamId === "team-alice" ? { teamId, teamName: "Alice XI", retired: false } : undefined,
    now: () => now,
  });
}

describe("tournament data migration and reads", () => {
  it("keeps list/detail/standings public but session-gates coach-scoped tournament routes", () => {
    const request = { method: "GET", headers: {} } as never;
    expect(requireSession(request, "/api/fork/tournaments", "").kind).toBe("allow");
    expect(requireSession(request, "/api/fork/tournaments/spike-cup", "").kind).toBe("allow");
    expect(requireSession(request, "/api/fork/tournaments/spike-cup/standings", "").kind).toBe("allow");
    expect(requireSession(request, "/api/fork/tournaments/spike-cup/next-opponent", "").kind).toBe("unauthorized");
    expect(requireSession(request, "/api/scheduled-matches", "").kind).toBe("unauthorized");
  });

  it("migrates array-shaped V1 data and adds presence leases", () => {
    const migrated = migrateTournamentData({ version: 1, tournaments: [tournament()], entrants: [], rounds: [], scheduledMatches: [] });
    expect(migrated.version).toBe(2);
    expect(migrated.tournaments["spike-cup"]?.name).toBe("Spike Cup");
    expect(migrated.waitingPresence).toEqual({});
  });

  it("serves the client /api/fork alias without leaking Discord identities", async () => {
    const result = await call(store(), "GET", "/api/fork/tournaments/spike-cup");
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({ tournament: { id: "spike-cup" } });
    expect((result?.body as { entrants: Array<{ coach: { ffbCoachId: string } }> }).entrants[0]?.coach.ffbCoachId).toBe("Alice");
    expect(JSON.stringify(result?.body)).not.toContain("discord-alice");
  });

  it("returns inert team build detail only to its coach or an organizer", async () => {
    const tournamentStore = store();
    expect((await call(tournamentStore, "GET", "/api/tournaments/spike-cup/entrants/alice/build"))?.status).toBe(401);
    expect((await call(tournamentStore, "GET", "/api/tournaments/spike-cup/entrants/alice/build", player("Bob")))?.status).toBe(403);
    const own = await call(tournamentStore, "GET", "/api/tournaments/spike-cup/entrants/alice/build", player("Alice"));
    expect(own).toMatchObject({ status: 200, body: { inert: true, capabilities: { editRoster: { available: false } } } });
  });
});

describe("waiting presence and notification audience", () => {
  it("requires the authenticated scheduled coach and targets only the absent opponent", async () => {
    const tournamentStore = store();
    const path = "/api/scheduled-matches/spike-cup%3Around%3A1%3Amatch%3A1/presence";
    expect((await call(tournamentStore, "POST", path))?.status).toBe(401);
    expect((await call(tournamentStore, "POST", path, player("Outsider"), {}))?.status).toBe(403);
    const aliceWaiting = await call(tournamentStore, "POST", path, player("Alice"), {});
    expect(aliceWaiting).toMatchObject({ status: 200, body: { notificationAudience: ["Bob"] } });
    expect(tournamentStore.notificationAudience(scheduled().id, now)).toMatchObject([{ ffbCoachId: "Bob", discordUserId: "discord-bob" }]);
    await call(tournamentStore, "POST", path, player("Bob"), {});
    expect(tournamentStore.notificationAudience(scheduled().id, now)).toEqual([]);
  });

  it("expires leases and treats neither coach waiting as no notification event", () => {
    const tournamentStore = store();
    tournamentStore.renewWaiting(scheduled().id, "Alice", 15_000, now);
    expect(tournamentStore.notificationAudience(scheduled().id, new Date(now.getTime() + 14_999))).toHaveLength(1);
    expect(tournamentStore.notificationAudience(scheduled().id, new Date(now.getTime() + 15_000))).toEqual([]);
  });
});

describe("scheduled match revision semantics", () => {
  it("persists a result/standings snapshot and generates the next round with verified seats", () => {
    const tournamentStore = store(scheduled("launched", 4));
    const completed = tournamentStore.recordResult(scheduled().id, {
      expectedRevision: 4,
      homeScore: 2,
      awayScore: 1,
      homeCasualties: 3,
      awayCasualties: 1,
    }, now);
    expect(completed).toMatchObject({ status: "completed", revision: 5 });
    expect(tournamentStore.standings("spike-cup")[0]).toMatchObject({
      entrantId: "alice",
      points: 3,
      casualtiesFor: 3,
      casualtiesAgainst: 1,
      casualtyDifferential: 2,
    });
    expect(tournamentStore.snapshot().standings["spike-cup"]?.rows).toHaveLength(2);
    const round = tournamentStore.generateNextRound("spike-cup", new Date(now.getTime() + 60_000));
    const next = tournamentStore.match(round.scheduledMatchIds[0]!);
    expect(next).toMatchObject({
      tournamentId: "spike-cup",
      roundNumber: 2,
      home: { coach: { verifiedAt: now.toISOString() }, teamId: expect.any(String) },
      away: { coach: { verifiedAt: now.toISOString() }, teamId: expect.any(String) },
      launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp" },
    });
  });

  it("retries a failure once, increments revision, and rejects stale retries", async () => {
    const tournamentStore = store(scheduled("launch_failed", 7));
    const path = "/api/scheduled-matches/spike-cup%3Around%3A1%3Amatch%3A1/actions/retry";
    const result = await call(tournamentStore, "POST", path, player("Alice"), { revision: 7 });
    expect(result).toMatchObject({ status: 200, body: { match: { status: "scheduled", revision: 8, launch: { retryCount: 1 } } } });
    expect((await call(tournamentStore, "POST", path, player("Alice"), { revision: 7 }))?.status).toBe(409);
  });

  it("dismisses only a launch failure and does not mutate the game assignment", async () => {
    const failure = scheduled("launch_failed", 3);
    const tournamentStore = store(failure);
    const path = "/api/scheduled-matches/spike-cup%3Around%3A1%3Amatch%3A1/actions/dismiss";
    const result = await call(tournamentStore, "POST", path, player("Bob"), { revision: 3 });
    expect(result).toMatchObject({ status: 200, body: { match: { status: "dismissed", revision: 4, home: { teamId: "team-alice" }, away: { teamId: "team-bob" } } } });
    expect((await call(store(), "POST", path, player("Bob"), { revision: 1 }))?.status).toBe(409);
  });

  it("restricts exact Discord notification targets to organizers", async () => {
    const tournamentStore = store();
    tournamentStore.renewWaiting(scheduled().id, "Alice", 45_000, now);
    const path = "/api/scheduled-matches/spike-cup%3Around%3A1%3Amatch%3A1/notification-audience";
    expect((await call(tournamentStore, "GET", path, player("Alice")))?.status).toBe(403);
    expect(await call(tournamentStore, "GET", path, organizer)).toMatchObject({
      status: 200,
      body: { audience: [{ coachId: "Bob", discordUserId: "discord-bob" }] },
    });
  });
});
