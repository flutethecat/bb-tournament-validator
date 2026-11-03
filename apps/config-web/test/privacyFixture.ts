// Shared fixture for the privacy tests: a coach "Alice" with data in every store, plus "Bob" (and "Carol") whose data
// must neither leak into Alice's export nor be touched by her deletion. Invented names and example.test addresses only.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { avatarStoreFor } from "../src/teamAvatars.js";
import { coachAvatarKey, coachProxyCacheKeys } from "../src/coachAvatars.js";
import { discordAvatarUrl } from "../src/auth/discordSso.js";
import { coachSaveKey } from "../src/teamBuilderSaves.js";
import { notificationFileName } from "../src/notifications.js";
import type { PrivacyDeps } from "../src/privacy/collectors.js";
import { seasonAwardId } from "../src/leagues/awards.js";

export const ALICE_DISCORD = "900000000000000001";
export const BOB_DISCORD = "900000000000000002";
export const ALICE_EMAIL = "alice@example.test";
export const BOB_EMAIL = "bob@example.test";
export const SHARE = "a".repeat(32);
/** Test-only PRIVACY_MAP_KEY (the live one is set by the operator in .env). */
export const TEST_MAP_KEY = "test-map-key-0123456789abcdef0123456789";
export const JOSE_NFC = "Jos\u00e9";
export const JOSE_NFD = "Jose\u0301";

/** A minimal PNG header the avatar store accepts (64 x 64). */
export function png(): Buffer {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(64, 20);
  return b;
}

const w = (path: string, value: unknown): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
};

// Every fixture coach has accepted the current privacy notice (otherwise the onboarding gate answers 428).
export const ACCEPTED = "2026-10-31";
const rec = (ffbCoachId: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "",
  consent: { privacy: { acceptedVersion: ACCEPTED, at: "2026-10-31T00:00:00Z" } }, ...extra,
});

export function depsFor(root: string): PrivacyDeps {
  return {
    stateDir: join(root, "state"),
    tournamentsDir: join(root, "tournaments"),
    libraryDir: join(root, "library"),
    builderSavesDir: join(root, "builder-saves"),
    teamAvatarsDir: join(root, "team-avatars"),
    coachAvatarsDir: join(root, "coach-avatars"),
    bugReportsDir: join(root, "bug-reports"),
    tabletopDir: join(root, "tabletop"),
    organizersFile: join(root, "organizers.json"),
    mapKey: TEST_MAP_KEY,
  };
}

export interface SeedOptions { aliceBanned?: boolean; aliceOwnsActiveTournament?: boolean; aliceOwnsLeague?: boolean; aliceDisplayName?: string; aliceNafName?: string; extraCoaches?: Record<string, unknown> }

/** Write the fixture. IDENTITIES_FILE must already point at <root>/identities.json. */
export async function seed(root: string, opts: SeedOptions = {}): Promise<void> {
  const d = depsFor(root);
  const aliceRecord = rec("Alice", {
    banned: opts.aliceBanned === true,
    profile: { displayName: opts.aliceDisplayName ?? "Ally Example" },
    identities: { discordUserId: ALICE_DISCORD, discordUsername: "ally_dc", discordAvatarHash: "abc123", email: ALICE_EMAIL, nafId: "1001", nafName: opts.aliceNafName ?? "AliceNaf" },
    // the NAF link is verified (coach page check): only then does deletion touch NAF data
    ...(opts.aliceNafName ? {} : { connections: { naf: { verifiedAt: "2026-10-01T00:00:00Z", source: "coachpage", nafId: "1001", nafName: "AliceNaf" } } }),
    // onboarding-lane fields (may not exist on this base): exported as stored, removed with the record
    contact: { email: ALICE_EMAIL, emailSource: "discord", emailVerified: true, phones: ["+00 0000 0001"] },
    consent: {
      leagueContact: { granted: true, at: "2026-10-01T00:00:00Z", version: "1" }, privacy: { acceptedVersion: ACCEPTED, at: "2026-10-01T00:00:00Z" },
      // per-organiser sharing grants (spec 2026-10-31): exported with the record, removed with it
      sharing: { "tournament:t1": { fields: ["email"], at: "2026-10-01T00:00:00Z", version: "2026-10-31" } },
    },
  });
  w(join(root, "identities.json"), { version: 1, coaches: {
    alice: aliceRecord,
    bob: rec("Bob", { identities: { discordUserId: BOB_DISCORD, discordUsername: "bob_dc", email: BOB_EMAIL, nafId: "2002", nafName: "BobNaf" }, contact: { email: BOB_EMAIL, phones: ["+00 0000 0002"] }, consent: { privacy: { acceptedVersion: ACCEPTED, at: "2026-10-01T00:00:00Z" } } }),
    carol: rec("Carol", { identities: { discordUserId: "900000000000000003" } }),
    root: rec("Root", { level: "admin" }),
    a_b: rec("A_B"),
    [JOSE_NFC.toLowerCase()]: rec(JOSE_NFC),
    [JOSE_NFD.toLowerCase()]: rec(JOSE_NFD),
    ...(opts.extraCoaches ?? {}),
  } });
  w(join(root, "organizers.json"), { organizers: ["Alice", "Bob"] });
  // "Become an organiser" requests: Alice's own (free text names her), and Bob's, decided by Alice as an admin.
  w(join(d.stateDir, "organiser-requests.json"), { version: 1, requests: [
    { id: "or000000000001", coach: "Alice", run: "league", competition: "Ally Example Cup", region: "North", note: "I am Alice and I run a club.", links: ["https://example.test/alice-club"], status: "pending", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "or000000000002", coach: "Bob", run: "tournament", competition: "Bob Open", region: "", note: "Alice can vouch for me.", links: [], status: "declined", createdAt: "2026-10-30T00:00:00.000Z", closedAt: "2026-10-31T00:00:00.000Z", decidedBy: "Alice", reason: "Ask Alice again later." },
    { id: "or000000000003", coach: "Alice", run: "both", competition: "", region: "", note: "Self check.", links: [], status: "approved", createdAt: "2026-10-20T00:00:00.000Z", closedAt: "2026-10-21T00:00:00.000Z", decidedBy: "Alice" },
  ] });

  // avatars
  await avatarStoreFor(d.coachAvatarsDir).save("Alice", coachAvatarKey("Alice"), png(), "png");
  await avatarStoreFor(d.coachAvatarsDir).save("Bob", coachAvatarKey("Bob"), png(), "png");
  for (const key of coachProxyCacheKeys(aliceRecord, discordAvatarUrl)) w(join(d.coachAvatarsDir, "proxy-cache", `${key}.png`), png().toString("latin1"));
  await avatarStoreFor(d.teamAvatarsDir).save("Alice", "save:s1", png(), "png");
  await avatarStoreFor(d.teamAvatarsDir).save("Alice", "library:t1", png(), "png");
  await avatarStoreFor(d.teamAvatarsDir).save("Bob", "save:b1", png(), "png");

  // builder saves + share link
  w(join(d.builderSavesDir, `${coachSaveKey("Alice")}.json`), { coach: "Alice", saves: [{ id: "s1", name: "Green Orcs", shareToken: SHARE, sharedAt: "2026-10-01T00:00:00Z", body: {} }] });
  w(join(d.builderSavesDir, "shares", `${SHARE}.json`), { coach: "Alice", id: "s1" });
  w(join(d.builderSavesDir, `${coachSaveKey("Bob")}.json`), { coach: "Bob", saves: [{ id: "b1", name: "Blue Elves", body: {} }] });
  w(join(d.builderSavesDir, `${coachSaveKey("Dave")}.json`), { coach: "Dave", saves: [{ id: "d1", name: "Grey Dwarfs", body: {} }] });

  // library
  w(join(d.libraryDir, "alice.json"), [{ teamId: "t1", teamName: "Green Orcs", race: "Orc", coach: "Alice", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "" }]);
  w(join(d.libraryDir, "a_b.json"), [{ teamId: "t9", teamName: "Spaced Out", race: "Human", coach: "A B", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "" }]);
  w(join(d.libraryDir, "shared.json"), [
    { teamId: "t7", teamName: "Old Guard", race: "Human", coach: "Alice", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "" },
    { teamId: "t8", teamName: "New Guard", race: "Human", coach: "Bob", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "" },
  ]);
  w(join(d.libraryDir, "eve.json"), [{ teamId: "t6", teamName: "Night Owls", race: "Elf", coach: "Eve", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "" }]);
  w(join(d.libraryDir, "bob.json"), [{ teamId: "t2", teamName: "Blue Elves", race: "Elf", coach: "Bob", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "" }]);

  // tournaments
  const id = (c: string, discord?: string) => ({ coachId: c, ffbCoachId: c, ...(discord ? { discordUserId: discord } : {}), verifiedAt: "2026-10-01T00:00:00Z" });
  w(join(d.tournamentsDir, "tournaments.json"), {
    version: 4,
    tournaments: {
      t1: { id: "t1", name: "Autumn Open", status: "active", ownerCoachId: "Bob", organizerCoachId: "Bob", organizerCoachIds: ["Alice"], news: [{ id: "p1", title: "Round 1", body: "Alice wins the opener; well played Alicent.", by: "Bob", at: "", pinned: false }],
        awards: [
          { id: "ta1", tournamentId: "t1", title: "Best sport", icon: "captain", toCoach: "Alice", entrantId: "e1", toTeam: "Green Orcs", note: "Alice never complained", by: "Bob", at: "2026-10-03T00:00:00Z" },
          { id: "ta2", tournamentId: "t1", title: "Iron wall", icon: "guard", toCoach: "Bob", note: "", by: "Alice", at: "2026-10-03T00:00:00Z" },
          { id: "ta3", tournamentId: "t1", title: "Fan favourite", icon: "fans", toCoach: "Carol", note: "", by: "Bob", at: "2026-10-03T00:00:00Z" },
        ],
        // Organiser result edits (activity log): one Alice made as an organiser, one Bob made.
        activity: [
          { id: "ra1", at: "2026-10-04T00:00:00Z", by: "Alice", kind: "result-edited", admin: true, fixtureId: "m1", roundNumber: 1, result: { homeScore: 2, awayScore: 1 }, previous: { homeScore: 1, awayScore: 1 }, reason: "Alice fixed a typo" },
          { id: "ra2", at: "2026-10-04T00:00:00Z", by: "Bob", kind: "result-edited", admin: true, fixtureId: "m1", roundNumber: 1, result: { homeScore: 1, awayScore: 1 }, previous: { homeScore: 0, awayScore: 1 } },
        ] },
      t2: { id: "t2", name: "Old Cup", status: opts.aliceOwnsActiveTournament ? "draft" : "completed", ownerCoachId: "Alice", organizerCoachId: "Alice" },
    },
    entrants: {
      e1: { id: "e1", tournamentId: "t1", seed: 1, coach: id("Alice", ALICE_DISCORD), teamId: "save:s1", registeredAt: "", nafNumber: "1001", nafSnapshot: { nafName: "Alice Fake", nafNumber: "1001", at: "2026-10-02T00:00:00Z" } },
      e2: { id: "e2", tournamentId: "t1", seed: 2, coach: id("Bob", BOB_DISCORD), teamId: "save:b1", registeredAt: "", notNafMember: true },
    },
    rounds: {},
    standings: { t1: { tournamentId: "t1", rows: [{ rank: 1, entrantId: "e1", coachId: "Alice" }, { rank: 2, entrantId: "e2", coachId: "Bob" }] } },
    scheduledMatches: {
      m1: { id: "m1", tournamentId: "t1", home: { entrantId: "e1", coach: id("Alice", ALICE_DISCORD), teamId: "save:s1" }, away: { entrantId: "e2", coach: id("Bob", BOB_DISCORD), teamId: "save:b1" }, status: "completed",
        edited: { byCoachId: "Alice", at: "2026-10-04T00:00:00Z", kind: "result", reason: "Agreed with Alice and Bob", previous: { homeScore: 1, awayScore: 1 }, original: { homeScore: 0, awayScore: 1 } } },
    },
    waitingPresence: { "m1\u0000alice": { scheduledMatchId: "m1", coachId: "Alice", renewedAt: "", expiresAt: "" }, "m1\u0000bob": { scheduledMatchId: "m1", coachId: "Bob", renewedAt: "", expiresAt: "" } },
    // Tournament Series: one Alice created (Bob co-organises), one Bob runs with Alice as co-organiser, one of others only.
    series: {
      sr1: { id: "sr1", name: "Alice Cup Series", description: "Run by Alice for the valley.", organisers: ["Alice", "Bob"], scoring: "sum", seeding: "dutch", tournaments: ["t1"], createdBy: "Alice", createdAt: "2026-10-01T00:00:00Z", updatedAt: "", revision: 1 },
      sr2: { id: "sr2", name: "Bob Tour", description: "", organisers: ["Bob", "Alice"], scoring: "bestN", bestN: 2, seeding: "elo", tournaments: [], createdBy: "Bob", createdAt: "2026-10-01T00:00:00Z", updatedAt: "", revision: 1 },
      sr3: { id: "sr3", name: "Carol Circuit", description: "", organisers: ["Carol"], scoring: "sum", seeding: "monrad", tournaments: [], createdBy: "Carol", createdAt: "2026-10-01T00:00:00Z", updatedAt: "", revision: 1 },
    },
  });

  // leagues
  const S1_CHAMPION = { category: "Season", type: "Overall Champion", name: "Champion", description: "", coach: "Alice Smith", coachId: "Alice", team: "Green Orcs", race: "Orc", goldenStar: true, podium: true as const };
  const lg = join(d.stateDir, "leagues", "l1");
  w(join(lg, "league.json"), {
    id: "l1", name: "Valley League", owner: opts.aliceOwnsLeague ? "Alice" : "Bob", organisers: ["Bob", "Alice"],
    // Awards given on this site (awards.ts): one to Alice's account (shown under her display name), one Alice gave Bob,
    // one between others; Hall of Fame pins by Alice and by Bob.
    awards: [
      { id: "a-1", title: "Iron coach", icon: "veteran", toCoach: "Alice Smith", toCoachId: "Alice", toTeam: "Green Orcs", teamId: "green-orcs", race: "Orc", seasonId: "s1", note: "Alice never missed a deadline", by: "Bob", at: "2026-10-02T00:00:00Z" },
      { id: "a-2", title: "Fair play", icon: "star", toCoach: "BobNaf", toCoachId: "Bob", note: "", by: "Alice", at: "2026-10-03T00:00:00Z" },
      { id: "a-3", title: "Rookie of the year", icon: "rookie", toCoach: "Carol", note: "", by: "Bob", at: "2026-10-04T00:00:00Z" },
    ],
    hallOfFame: [
      { id: "p-1", kind: "record", text: "Most TDs in a season: Alice, 31", note: "", by: "Alice", at: "2026-10-05T00:00:00Z" },
      { id: "p-2", kind: "award", awardId: "a-3", note: "", by: "Bob", at: "2026-10-05T00:00:00Z" },
      // a pin to Alice's podium award: its id must survive her deletion (no coach name in season award ids)
      { id: "p-3", kind: "award", awardId: seasonAwardId("s1", S1_CHAMPION, -1), note: "", by: "Bob", at: "2026-10-05T00:00:00Z" },
    ],
  });
  w(join(lg, "secrets.json"), { webhookUrl: "https://discord.example.test/api/webhooks/1/secret" });
  w(join(lg, "seasons", "s1.json"), {
    id: "s1", leagueId: "l1", number: 1, name: "Season 1",
    teams: [
      { id: "green-orcs", name: "Green Orcs", race: "Orc", coach: "Alice Smith", coachId: "Alice", nafUser: "AliceNaf", players: [{ name: "Grub", injuries: [{ type: "dead", at: "", by: "Alice" }] }], statusChanged: { by: "Alice", at: "" }, history: [{ at: "", by: "Alice", kind: "organiser-edit", changes: [{ what: "Alice Smith fixed Grub", from: "Alice", to: "Bob" }] }] },
      { id: "blue-elves", name: "Blue Elves", race: "Elf", coach: "BobNaf", coachId: "Bob", nafUser: "BobNaf", players: [] },
    ],
    fixtures: [{
      id: "f1", home: { team: "Green Orcs", teamId: "green-orcs", coach: "AliceNaf", coachId: "Alice", race: "Orc", score: 2 }, away: { team: "Blue Elves", coach: "BobNaf", coachId: "Bob", race: "Elf", score: 1 },
      fork: { status: "finished", teams: { home: { teamId: "ft1", coach: "Alice" }, away: { teamId: "ft2", coach: "Bob" } }, generatedBy: "Alice", log: [{ at: "", by: "Alice", text: "Alice generated the game for Bob" }] },
      resultEdit: { by: "Alice", at: "2026-10-30T00:00:00.000Z" },
    }],
    redraft: {
      startedAt: "", byCoach: "Bob", capEnabled: false, cap: 0, revision: 1, log: [{ at: "", by: "Alice", text: "Alice submitted a draft" }],
      teams: [{ coach: "Alice Smith", coachId: "Alice", submittedBy: "Alice", rest: { at: "", by: "Alice", rolls: [] }, override: { budget: 1, reason: "r", by: "Bob", at: "" }, draft: { team: { id: "green-orcs-2", name: "Green Orcs", coach: "Alice Smith", coachId: "Alice", statusChanged: { by: "Alice", at: "" }, history: [{ at: "", by: "Alice", kind: "organiser-edit", changes: [{ what: "Alice Smith fixed Grub", from: "Alice", to: "Bob" }] }], players: [{ name: "Grub", injuries: [{ type: "niggling", at: "", by: "Alice" }] }] } } },
        // Bob's draft: Alice (an organiser) edited his team; her name must leave this snapshot too
        { coach: "BobNaf", coachId: "Bob", draft: { team: { id: "blue-elves-2", name: "Blue Elves", coach: "BobNaf", coachId: "Bob", statusChanged: { by: "Alice", at: "" }, history: [{ at: "", by: "Alice", kind: "organiser-edit", changes: [{ what: "Alice Smith fixed Grub", from: "Alice", to: "Bob" }] }], players: [] } } }],
    },
    participants: [{ coach: "AliceNaf", nafUser: "AliceNaf", team: "Green Orcs" }, { coach: "BobNaf", nafUser: "BobNaf", team: "Blue Elves", paid: true, flagsUpdated: { by: "Alice", at: "" } }],
    phases: [{ name: "Regular", standings: [{ rank: 1, team: "Green Orcs", coach: "Alice Smith" }, { rank: 2, team: "Blue Elves", coach: "BobNaf" }] }],
    honours: [
      { category: "c", stat: "td", kind: "player", rows: [{ rank: 1, name: "Grub", team: "Green Orcs", coach: "Alice Smith" }] },
      { category: "c", stat: "wins", kind: "coach", rows: [{ rank: 1, name: "Alice Smith", team: "", coach: "" }, { rank: 2, name: "BobNaf", team: "", coach: "" }] },
    ],
    awards: [S1_CHAMPION], news: [{ id: "n1", title: "Welcome", body: "Hello all", by: "Alice", at: "" }],
    log: [{ at: "", by: "Bob", kind: "team-coach", text: "Bob assigned Alice Smith to Green Orcs" }],
    podium: { decidedBy: "organiser", proposed: { champion: "green-orcs" }, final: { champion: "green-orcs" }, overridden: true, by: "Alice", at: "" },
  });

  // tabletop
  w(join(d.tabletopDir, "matches", "tm1.json"), { id: "tm1", state: "published", home: { coach: "Alice", teamSaveId: "s1", teamName: "Green Orcs" }, away: { coach: "Bob", teamSaveId: "b1", teamName: "Blue Elves" }, createdBy: "Alice", confirmations: { Alice: "2026-10-01", Bob: "2026-10-01" } });
  w(join(d.tabletopDir, "events", "tm1.ndjson"), `${JSON.stringify({ seq: 0, by: "Bob", type: "seats", payload: { home: { coach: "Alice" }, away: { coach: "Bob" } } })}\n${JSON.stringify({ seq: 1, by: "Alice", kind: "touchdown" })}\n${JSON.stringify({ seq: 2, by: "Bob", kind: "touchdown" })}\n`);
  w(join(d.tabletopDir, "journals", "tm1.json"), { matchId: "tm1", opId: "o1", kind: "confirm", by: "Alice", homeChain: { expect: { head: 0, revisions: 0 }, target: { saveId: "s1", coach: "Alice", head: 1, revisions: [] } }, result: null, match: { id: "tm1", home: { coach: "Alice" }, away: { coach: "Bob" }, createdBy: "Alice", confirmations: {} } });
  w(join(d.tabletopDir, "teams", "chain-alice.json"), { saveId: "s1", coach: "Alice", head: 0, revisions: [] });
  w(join(d.tabletopDir, "teams", "chain-bob.json"), { saveId: "b1", coach: "Bob", head: 0, revisions: [] });

  // results, ratings, NAF, replays
  w(join(d.stateDir, "tournament-results.json"), { version: 1, results: {
    g1: { gameId: "g1", pulledAt: "", home: { teamId: "t1", teamName: "Green Orcs", coach: "Alice" }, away: { teamId: "t2", teamName: "Blue Elves", coach: "Bob" }, teams: [] },
    g3: { gameId: "g3", pulledAt: "", home: { teamId: "t4", teamName: "Pale Elves", coach: JOSE_NFC }, away: { teamId: "t5", teamName: "Dark Elves", coach: JOSE_NFD }, teams: [] },
    g4: { gameId: "g4", pulledAt: "", home: { teamId: "t6", teamName: "Night Owls", coach: "Eve" }, away: { teamId: "t2", teamName: "Blue Elves", coach: "Bob" }, teams: [] },
    g2: { gameId: "g2", pulledAt: "", home: { teamId: "t2", teamName: "Blue Elves", coach: "Bob" }, away: { teamId: "t3", teamName: "Red Men", coach: "Carol" }, teams: [] },
  } });
  w(join(d.stateDir, "tournament-matches.json"), { version: 1, matches: { g1: { home: { teamId: "t1", ffbCoachId: "Alice" }, away: { teamId: "t2", ffbCoachId: "Bob" } } } });
  w(join(d.stateDir, "coach-titles.json"), { version: 1, titles: { alice: { title: "Star", cr: 160, at: "" }, bob: { title: "Rookie", cr: 140, at: "" } } });
  w(join(d.stateDir, "naf-games.json"), { version: 1, coaches: {
    1001: { nafId: "1001", nafName: "AliceNaf", fetchedAt: "", games: [] },
    2002: { nafId: "2002", nafName: "BobNaf", fetchedAt: "", games: [{ date: "2026-01-01", tournament: "X", variant: "BB", coaches: ["BobNaf", "AliceNaf"], coachIds: ["2002", "1001"], races: ["Elf", "Orc"], score: [1, 2] }] },
  } });
  w(join(d.stateDir, "replay-moments", "g1.json"), { gameId: "g1", status: "ready", teams: { home: { name: "Green Orcs", coach: "Alice" }, away: { name: "Blue Elves", coach: "Bob" } }, moments: [] });

  // notifications
  const n = (from: string, title: string, body: string) => ({ id: "n1", type: "organiser-message", title, body, link: "/app/", at: "2026-10-01T00:00:00.000Z", from });
  w(join(d.stateDir, "notifications", notificationFileName("alice")), { version: 1, seq: 1, notifications: [n("Bob", "From Bob", "Hi")] });
  w(join(d.stateDir, "notifications", notificationFileName("bob")), { version: 1, seq: 1, notifications: [n("Alice", "Alice proposed a time", "Alice says hi; Alicent is someone else")] });

  // bug reports
  w(join(d.bugReportsDir, "2026-10-01_Alice_nogame", "report.json"), { id: "2026-10-01_Alice_nogame", coach: "Alice", submittedAt: "2026-10-01", kind: "bug", description: "Crash" });
  w(join(d.bugReportsDir, "2026-10-01_Alice_nogame", "wire.log"), "log");
  w(join(d.bugReportsDir, "2026-10-01_Bob_nogame", "report.json"), { id: "2026-10-01_Bob_nogame", coach: "Bob", submittedAt: "2026-10-01", kind: "bug", description: "Bob crash" });
}

/** Every file under a directory (recursive). */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

/** Files (text read) whose content matches. */
export function filesContaining(dir: string, re: RegExp): string[] {
  return walkFiles(dir).filter((p) => re.test(readFileSync(p, "latin1")));
}

/** Parse a stored (uncompressed) zip into name -> content. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const size = buf.readUInt32LE(p + 20);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localName = buf.readUInt16LE(offset + 26);
    out.set(name, buf.subarray(offset + 30 + localName, offset + 30 + localName + size));
    p += 46 + nameLen;
  }
  return out;
}
