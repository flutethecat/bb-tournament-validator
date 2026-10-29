# League fixture on the local Super FUMBBL fork — end-to-end test (2026-10-29/30)

Worktree `C:\Users\Jay\Documents\Claude\bbtv-rig`, branch `codex/league-fork-test-rig` (base `42a2132` = live).
Live config-web on :4310 (`bb-tournament-validator`, state `apps/config-web/data-store`), local fork FFB on `ws://localhost:22227`
(standalone, `server.test=true`). Owner: "We can run a test here."

**Verdict: PASS.** A throwaway league fixture was generated, launched, played (TD + casualty + concession), and its result
banked as a **full** FumbblResult into the fixture and both league team records. The live server's own 2-minute sync banked
it in one run, and the organiser "Check for result" module call banked it in another. One forkTeam defect (9 of 28 TABBL
season-6 teams could not be built) is fixed with tests. The test league was deleted after every run.

## Rig

`apps/config-web/scripts/league-fork-test.ts` (run from `apps/config-web`):

```
pnpm exec tsx scripts/league-fork-test.ts [--keep] [--teardown-only] [--self-sync] [--home <teamId>] [--away <teamId>]
    [--state-dir <dir>] [--env <file>] [--client <fumbbl40k-client worktree>] [--out <dir>] [--result-wait <s>]
```

| step | what it does |
|---|---|
| teardown (first) | removes any earlier run, so every run is idempotent |
| setup | league `tabbl-test` "TABBL Test" (owner/organiser Flutethecat, playOnFork, BB2025, **no webhook**). One season `run-<stamp>` holds copies of two TABBL season-6 teams. Flutethecat is seated home and Gondra87 away through `applyTeamCoach`. Fixture `f1` has `test: true, forkEnabled: true`. Default teams: Middeinheimian Rhapsody (OWA, 10 stat advances) vs Questionable Choices (Lizardmen, one MNG player). |
| generate | `POST .../fork/generate` through `leagueForkRoutes`, using the real `createLeagueForkClient` (live .env, values never printed) |
| launch | `POST .../fork/launch` and `GET .../fork/jnlp` for each seat. The JNLPs are saved with the credential digest redacted. |
| play | Both seats run headless on the **scheduled game id** (see below). |
| wait | Polls the store for `fork.result`, either from the live server's 2-minute timer or, with `--self-sync`, from the organiser `sync` route in this process every 10 s. |
| verify | Writes `checks.json`, `diff.json` (before/after for both teams and the fixture), the fork team XMLs, the raw `fork-result.xml` + `fork-result-parsed.json`, `bot.log` and `rig.log` to `--out` (default `apps/config-web/.league-fork-test/<stamp>`, git-ignored). |
| teardown | Withdraws an unstarted game. Deletes the `lg_*` fork team files (then a fork refresh), the library rows, the notification rows linking to `/app/leagues/tabbl-test`, any stored result rows and the league folder. Skipped with `--keep`. `--teardown-only` runs only this step. |

**Play driver (adapted from the P0 rig):** the rig does not use the Playwright real client. It builds a scenario variant of
the client worktree's `drivePregame.ts` (default `wt-declare`) at runtime: anchored string patches, a fail-fast assert
that each patch applied, and imports pointed back at the worktree. It runs with `--side both --gameId <scheduled id>` and
the fork team ids. Behaviour:

- **Home:** queues `/roll pow pow pow 6 6 6 6 13 3` (POW, armour 12, injury 12, casualty 13 with lasting-injury roll 3,
  which is Smashed Knee) and blocks an adjacent foe. It then uses `/set_player <nr> 24 y` and `/set_ball 24 y` and moves
  into the end zone.
- **Away:** ends its turns until the touchdown, then concedes. The winner answers the BB2025 concession dialogs.

The client under test here is config-web, not the game client, so headless seats are enough. The JNLPs are still produced
and checked for each seat.

## Runs and timings

| run | teams | game | outcome |
|---|---|---|---|
| 1 | Rhapsody v Choices | 1094 | Driver patch anchor missed on CRLF. The rig withdrew the unstarted game and tore down cleanly. |
| 2 | Rhapsody v Choices | 1095 | Touchdown scored, but the stock bot never set up the next drive. The game was finished by hand with the patched driver. The result arrived after the rig's window, and teardown ran. |
| **3** | Rhapsody v Choices | 1096 | **All checks PASS. The result was banked by the live server's sync.** |
| 4 | Grudge Rollers (Dwarf) v Hypno toads (Slann) | 1097 | These teams could only be built after the forkTeam fix. A Secret Weapon argue-the-call dialog in setup stalled the bot; the game was finished by hand. **Result banked (live sync), all result checks PASS.** |
| **5** | Grudge Rollers v Hypno toads, `--self-sync` | 1098 | **All checks PASS, unattended. Result banked by the organiser Check-for-result call in process.** |

Run 3 timings: generate 0.4 s, launch 0.03 s, play 22.8 s, result 5.0 s (the live timer happened to fire), teardown 0.1 s.
Run 5 timings: generate 0.3 s, play 44.9 s, result 10.2 s, teardown 0.1 s. Total about 1 minute.

## Verification items

| # | item | result |
|---|---|---|
| 1 | Generate: both teams built on the fork, game scheduled, status `scheduled`, notifications | **PASS**. Home `lg_…` file: 12 players, **10 `+MA/+ST/…` stat skills**, 12 `storedValue` attributes, the niggling/MNG injuries. The library rows are `forkLoadable`. 3 notification rows (opponent invite, plus the organiser notice to site admins). |
| 2 | Launch: a JNLP for each seat; game played with a TD, a casualty and a concession | **PASS**. Both JNLPs were 200 and carried `-gameId <id> -teamId lg_…`. Each game reached `endGame` → `gameStatistics`. |
| 3 | Result sync: score, cas, concession, lines, source, team mutation | **PASS**. `source: "full"`, 2-0, cas 1/0, away `conceded: true`, 12 home and 13 away lines. Details below. |
| 4 | Discord: no webhook means nothing posted and nothing logged | **PASS**. 0 in-process webhook calls, no `secrets.json`, no Discord or webhook lines in the live log during the runs. The live log only shows `[leagues] Super FUMBBL results applied: 1096` (and 1097). |
| 5 | Fork result format | **Full FumbblResult**. `/gamestate/result` returned the `<gameResult replayId>` document, which `parseFumbblResult` parsed without error. See the format notes below. |
| — | Real TABBL untouched | **PASS**. The size and mtime of `season-6.json` were unchanged in every run. `identities.json` and `organizers.json` were only read. |

### Before → after (run 3, game 1096; Middeinheimian Rhapsody 2 – 0 Questionable Choices, away conceded)

Home team record: `treasury 245000 → 325000` (winnings 80 000, no inducement spend), `fans 7 → 8`
(dedicatedFansModifier +1). teamValue was unchanged (see gap G3).

| home player | change |
|---|---|
| Iron G. | availableSpp 8 → 11, td 0 → 1, spp 5 → 8 (the concession-awarded TD; the server asks the winner to assign it) |
| Brick Dudkus The Dour (blocker) | availableSpp 3 → 5, cas 3 → 4, spp 6 → 8 |
| Trilaic Silverore (scorer) | availableSpp 2 → 9, td 0 → 1, mvp 0 → 1, spp 0 → 7 |
| Walter sweetness Painton | availableSpp 0 → 4, mvp 1 → 2, spp 39 → 43 (second MVP: the winner nominates for the conceding side) |

Away team record: treasury and fans unchanged (the server sent winnings 0 and no fans modifier for the conceding side).

| away player | change |
|---|---|
| Duxl (victim) | **ma 7 → 6** (Smashed Knee (-MA)), **missNextGame false → true**, availableSpp 1 → 0 |
| Galhel | missNextGame true → false (served the MNG they arrived with) |
| every other player with SPP | availableSpp → 0 (a conceding team's spendable SPP is cleared, as in banking) |

Fixture after the result: `home {score 2, cas 1, conceded false}` and `away {score 0, cas 0, conceded true}`.
`finishedAt` = the fork's finished time. `announced {started, result "2-0/1-0/a"}`.
`fork {status "finished", gameId "1096", gameName "league-f1", launched {home, away}, invited true}`.
`result {source "full", winnings 80000/0, lines …}`. The fork log reads: Built … → Scheduled game 1096 →
"Result 2 - 0 applied (game 1096, full result)." The season log has team-coach ×2, match-started and match-result.

Run 5 (Dwarf v Slann) showed the same pattern. In addition, the injured Kroxigor gained **Hatred (Dwarf)** from the
server's `gainedHatred`, and it was banked as a skill.

## Fork result format (what the live fork returned)

`/gamestate/result?gameId=` returns the full `FumbblResult` document: per team `score`, `conceded`, `concededLegally`,
`stalled`, `fanFactor`, `winnings`, `dedicatedFansModifier`, `teamValue`, `casualtiesSuffered`; per player
`starPlayerPoints current/earned` with `touchdowns/casualties/playerAwards`, `statistics` (`blocks`, `rushing`,
`turnsPlayed`), `injury` and `gainedHatred`. The serializer omits zero and false fields.

These are parsed but not applied to the league:

- **G1** `concededLegally` (false in these runs): not recorded on the fixture.
- **G2** `casualtiesSuffered`, `spectators`/`fame`/`fanFactor` (attendance), and the `blocks`, `rushing`, `passing`,
  `deflections`, `landings` and `turnsPlayed` counters: there is no league field for them.
- **G3** `teamValue`: the server's current team value (1 740 000 against the league's 1 700 000; 905 000 against 885 000
  for the Dwarves) is not written back. The league TV stays as imported even after an injury or MNG.
- **G4** `PlayerSeasonStats.injuries` for the victim is not incremented. It is unclear whether that TourPlay counter means
  injuries suffered or inflicted, so it was left alone.

Server behaviour worth knowing:

- A BB2025 concession makes the server ask the winner to assign the awarded touchdowns (`playerChoice assignTouchdown`)
  and to nominate MVPs twice. The final score therefore included an awarded TD (2-0 from one scored TD).
- `/gamestate/result` also answers mid-game (run 2 parsed a document while the game was active). config-web only reads
  it after `gameStates` reports `finished`, so this is harmless.

## Defects

**Fixed (forkTeam.ts, with tests in `test/leagueForkPlay.test.ts`):**

9 of 28 TABBL season-6 teams could not be built for the fork. After the fix 26 of 28 build, and Dwarf v Slann was played
and banked live (runs 4 and 5).

- The fork's Slann roster is named **"Slann 2025"** (`slann.bb2025`). The race match now ignores a trailing edition year.
- League short position names: "Dwarf Lineman" → "Dwarf Blocker Lineman", "Jaguar Warrior" → "Jaguar Warrior Blocker",
  "Beastman Lineman" → "Beastman Runner Lineman", "Bull Centaur" → "Bull Centaur Blitzer". These match only when every word
  appears in **exactly one** roster position; an ambiguous name is still refused.
- "Ball & Chain" is now read as the dataset's "Ball and Chain".

**Open (not fixed; your call):**

- **D2** Two teams (Lakewood Rotbacks, The Iron Shank Syndicate) list a skill **"Eye Gunge"**. The dataset has "Eye Gouge".
  This looks like a TourPlay spelling, but aliasing it would be a guess. Either correct the data or approve an alias.
- **D3** = G3: the league team value is not refreshed from the result.
- **D4** `fixture.startedAt` and the "match started" event are stamped when the game is **scheduled** (generate), not when
  play starts. This is cosmetic for leagues without a webhook.
- **D5** The fork game name is `league-<fixtureId>` (for example `league-f1`), which is not unique across leagues or
  seasons. It is only cosmetic, because seats join by `gameId`.
- **D6** Fork locks are per process. The rig, or any second process using the same state dir, can race the live server's
  sync. `applyForkResult` re-reads before writing, so the window is tiny; production runs a single process.

**In the client worktree's `drivePregame.ts` bot (not owned here; the rig patches them at runtime):**

- The setup key is per half, so the drive after a touchdown never sets up.
- Setup sends the first 11 by number, including injured or KO'd players.
- `assignTouchdown` is answered with an empty list, and the server asks again forever.
- The second MVP ask after a concession is never answered.
- An argue-the-call dialog during turnMode `setup` (a Secret Weapon sent off) is never answered.

**Fork server (FFB):** no defects found. One data oddity: the `slann.bb2025` roster also lists a "Rotter Lineman"
position. No Java was touched.

## Side effects left behind

- Fork games 1094 (withdrawn) and 1095–1099 (finished) stay in the fork DB between Flutethecat and Gondra87. All six are
  listed in the live `data-store/test-games.json`, and 1095–1099 are stored in `tournament-results.json` with
  `test: true`, so they never count in ratings (see the follow-up below).
- No league, fork team file, library row or notification row from the test remains. This was checked after run 6.

## Live server

**No restart was needed for the test.** The league store re-reads from disk, and the live server picked up the test
league and banked results 1096 and 1097 on its own timer. The forkTeam fix runs in the live server only after this branch
lands and the server restarts (path-checked recipe).

## Suite

`pnpm exec vitest run apps/config-web`: 10 failed / 2200 passed. These are exactly the baseline failures (rulesRoute ×6,
eurobowl2026Package, smallGodsPackage, tabletopTesting, teamBuilderPage). `leagueForkPlay.test.ts` passes 51 of 51,
including the 4 new tests, 3 of which fail without the fix. `tsc -p apps/config-web` reports no errors in the touched
files; all reported errors are pre-existing.


## Follow-up: three P2 defects from the adversarial review (fixed)

**1. Finished test games could enter real ratings after teardown.** The first version of the rig deleted the stored
result rows at teardown. But the games stay on the fork's finished list, and `/api/fork/records` →
`refreshFinishedResults` imports any finished game it has not retained, with no test marker, into Elo, Glicko and
records.

- **Live cleanup (done 2026-10-29 23:36 PDT):** `league-fork-test.ts --mark-test-games 1094,1095,1096,1097,1098` against
  the live state dir. It listed all five in the new `data-store/test-games.json` and pulled 1095–1098 from the fork admin
  API into `tournament-results.json` with `test: true`. 1094 was withdrawn before play, so it is not on the finished
  list and there is nothing to import. Run 6 then added 1099 the same way. Verified with the **live server's own code**
  (`bb-tournament-validator/apps/config-web/src/tournamentResults.ts`, 42a2132) reading the live file: `list()` holds
  **none** of 1094–1099. 1095–1099 are retained, so `refreshFinishedResults` skips them. 27 rated rows remain. This
  protection works on the running live server **without a restart**.
- **`GET /api/fork/records` on the live server answers 502 for every caller.** This is unrelated to the test and was
  there before it. Fork game **1072** is on the finished list, but `/gamestate/result` answers 404 for it, and the old
  `refreshFinishedResults` throws on that one game. Diagnosed in process against a copy of the store. Because of this, the
  HTTP check could not be run against the live server; the in-process check above stands in for it. Fixed on the branch:
  an unreadable game is skipped (logged as `[records] finished game <id> skipped`) and retried on the next call. It goes
  live after the branch lands and the server restarts.
- **Code:** `src/testGames.ts` (a `test-games.json` store, add-only). `TournamentResultStore` stamps `test: true` for a
  listed id on every read (so a row imported before the listing reads as test) and in `put()` (every importer:
  `refreshFinishedResults`, the single pull, the tabletop recorder). The rig lists the game id immediately after
  scheduling (check 1e), stores the finished result as `test: true` (check 5b), and keeps both through teardown.

**2. Test notifications could evict real ones.** The rig's routes notified into the live inboxes (500-row cap per coach).
The rig now uses an isolated `NotificationStore` under `<out>/isolated/` (check 1d counts there). Check 2c asserts that
**0** rows were written to the live inboxes. The organiser "Check for result" call in process is now the default, so the
live server's result notices are not triggered. `--live-sync` opts back into the live timer: its two result notices
reach the test coaches' live inboxes and teardown sweeps them.

**3. The banking checks could pass vacuously.** Each stored league team is now recomputed from the parsed FumbblResult,
independently of `forkResult.ts`, and compared field by field:

- per-player availableSpp and stats.spp (a conceding side's spendable SPP is cleared);
- the server's earned SPP against the BB2025 table (TD 3, CAS 2, MVP 4) for every player without passing or
  interception points;
- td, cas, mvp, completions, int and fouls;
- injuries applied to MA/ST/AG/PA/AV and niggling within the fork's limits, plus missNextGame, on the stored record;
- treasury = before − treasurySpentOnInducements + winnings;
- fans = before + dedicatedFansModifier.

**Run 6** (game 1099, default teams, unattended, `--keep` off, total about 27 s) — **all checks PASS**:

```
PASS 1d notifications created (isolated store) - 3 row(s) ... in <out>isolated
otifications
PASS 1e game listed as a test game at once - 1099 in ...data-store	est-games.json
PASS 3a fixture received the result - 2-0 source=full cas 1/0 conceded false/true
PASS 3d home SPP exact for every player (BB2025: TD 3, CAS 2, MVP 4) - 12 players checked, 12 against the table
PASS 3e home injuries + MNG on the stored team record - no injuries in the result
PASS 3f home treasury = before - inducement spend + winnings - 245000 - 0 + 70000 = 315000; stored 315000
PASS 3g home fan factor = before + dedicatedFansModifier - 7 + 1 = 8; stored 8
PASS 3h home counters (td/cas/mvp/completions/int/fouls) exact - all players match
PASS 3d away SPP exact for every player (BB2025: TD 3, CAS 2, MVP 4; conceded: spendable SPP cleared) - 13 players checked, 13 against the table
PASS 3e away injuries + MNG on the stored team record - Duxl: Smashed Knee (-MA) -> stored ma 7->6, av 8->8, niggling 0->0, missNextGame false->true
PASS 3f away treasury = before - inducement spend + winnings - 200000 - 0 + 0 = 200000; stored 200000
PASS 3g away fan factor = before + dedicatedFansModifier - 4 + 0 = 4; stored 4
PASS 3h away counters (td/cas/mvp/completions/int/fouls) exact - all players match
  home: Iron G.: td 1 cas 0 mvp 1 earned 7 -> availableSpp 8->15 (exp 15), spp 5->12 (exp 12)
  home: Brick Dudkus The Dour: td 0 cas 1 mvp 0 earned 2 -> availableSpp 3->5 (exp 5), spp 6->8 (exp 8)
  home: Trilaic Silverore: td 1 cas 0 mvp 0 earned 3 -> availableSpp 2->5 (exp 5), spp 0->3 (exp 3)
  home: Sid Luckmanheim: td 0 cas 0 mvp 1 earned 4 -> availableSpp 1->5 (exp 5), spp 27->31 (exp 31)
  away: Duxl: ... (conceded) -> availableSpp 1->0 (exp 0), spp 1->1 (exp 1), Smashed Knee (-MA): mng true
  away: (9 more conceding players) availableSpp -> 0 (exp 0), spp unchanged
PASS 3i the scenario produced a touchdown, a casualty and an injury - score 2-0, injured: Duxl Smashed Knee (-MA)
PASS 5b finished game stored test:true and left out of ratings
PASS 4 Discord silent (no webhook on the test league)
PASS 2c no row written to the live inboxes - 0 live row(s) link to /app/leagues/tabbl-test
PASS real TABBL season untouched
```

Suite after the fixes: `pnpm exec vitest run apps/config-web` gives 10 failed / 2203 passed, exactly the baseline. New
tests in `test/tournamentResults.test.ts` cover a listed game being stamped on put and on read and left out of
`list()`, and the records refresh skipping an unreadable game.
