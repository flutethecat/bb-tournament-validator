import { describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps } from "../src/tournaments/api";
import type { TournamentStore } from "../src/tournaments/store";
import type { TournamentEntrantRecord, TournamentRecord } from "../src/tournaments/types";

// GET /api/fork/tournaments?coach=me: the signed-in coach's own entries, most recent first, limited on the server, so the
// coach page's nav never loses its newest finished entries behind the 20-per-page alphabetical list.

const record = (id: string, name: string, status: TournamentRecord["status"], endsAt?: string): TournamentRecord => ({
  id, name, status, format: "swiss", packageName: "P", maxPlayers: 8, roundCount: 3, currentRound: 3, tiebreakers: [],
  points: { win: 3, draw: 1, loss: 0, bye: 3 }, ...(endsAt ? { endsAt } : {}), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const entrant = (tid: string, coach: string, dropped = false): TournamentEntrantRecord => ({
  id: `${tid}:${coach}`, tournamentId: tid, seed: 1, coach: { coachId: coach, ffbCoachId: coach, verifiedAt: "x" }, teamId: "tm",
  registeredAt: "2026-01-01T00:00:00Z", ...(dropped ? { droppedAt: "2026-01-02T00:00:00Z" } : {}),
});

function fixture() {
  const tournaments: TournamentRecord[] = [];
  const entrants: Record<string, TournamentEntrantRecord[]> = {};
  // 61 finished entries for Alice, named so alphabetical order is the reverse of recency (the newest sort last by name)
  for (let i = 0; i < 61; i++) {
    const id = `c${String(i).padStart(2, "0")}`;
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString();
    tournaments.push(record(id, `Cup ${String(99 - i).padStart(2, "0")}`, "completed", day));
    entrants[id] = [entrant(id, "Alice"), entrant(id, "Bob")];
  }
  tournaments.push(record("theirs", "AAA Theirs", "completed", "2027-01-01T00:00:00Z"));
  entrants.theirs = [entrant("theirs", "Bob")];
  tournaments.push(record("left", "AAA Left", "completed", "2027-02-01T00:00:00Z"));
  entrants.left = [entrant("left", "alice", true)];
  tournaments.push(record("live", "Live Cup", "active"));
  entrants.live = [entrant("live", "ALICE")];
  const store = {
    tournaments: (statuses: readonly string[]) => tournaments.filter((t) => statuses.includes(t.status)),
    activeTournaments: () => tournaments.filter((t) => t.status === "active"),
    entrants: (id: string) => entrants[id] ?? [],
  } as unknown as TournamentStore;
  return { teamBuild: () => undefined, store } as TournamentApiDeps;
}

const alice = { coach: "Alice", organizer: false, admin: false };
type Page = { tournaments: Array<{ id: string; myEntrantId?: string }>; total: number; hasMore: boolean; pageSize: number };

describe("tournament list ?coach=me", () => {
  it("returns the newest five of 61 finished entries, never others' or withdrawn ones", async () => {
    const res = await tournamentApi("GET", "/api/fork/tournaments", new URLSearchParams("status=completed&coach=me&limit=5"), alice, undefined, fixture());
    expect(res?.status).toBe(200);
    const body = res!.body as Page;
    expect(body.tournaments.map((t) => t.id)).toEqual(["c60", "c59", "c58", "c57", "c56"]);
    expect(body.tournaments.every((t) => t.myEntrantId)).toBe(true);
    expect(body).toMatchObject({ total: 61, hasMore: true, pageSize: 5 });
  });

  it("matches the coach case-insensitively, defaults and caps the limit at 20, and needs a session", async () => {
    const live = await tournamentApi("GET", "/api/fork/tournaments", new URLSearchParams("coach=me"), alice, undefined, fixture());
    expect((live!.body as Page).tournaments.map((t) => t.id)).toEqual(["live"]);
    const capped = await tournamentApi("GET", "/api/fork/tournaments", new URLSearchParams("status=completed&coach=me&limit=500"), alice, undefined, fixture());
    expect((capped!.body as Page).tournaments).toHaveLength(20);
    const anon = await tournamentApi("GET", "/api/fork/tournaments", new URLSearchParams("coach=me"), undefined, undefined, fixture());
    expect(anon?.status).toBe(401);
    // without coach=me the list is unchanged (alphabetical pages of 20)
    const plain = await tournamentApi("GET", "/api/fork/tournaments", new URLSearchParams("status=completed"), alice, undefined, fixture());
    expect((plain!.body as Page).tournaments).toHaveLength(20);
  });
});
