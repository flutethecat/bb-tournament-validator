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

- Fork games 1094 (withdrawn) and 1095–1098 (finished) remain in the fork DB between Flutethecat and Gondra87, the same
  as any rig game.
- No league, fork team file, library row, notification row or tournament-results row from the test remains. This was
  checked after run 5.

## Live server

**No restart was needed for the test.** The league store re-reads from disk, and the live server picked up the test
league and banked results 1096 and 1097 on its own timer. The forkTeam fix runs in the live server only after this branch
lands and the server restarts (path-checked recipe).

## Suite

`pnpm exec vitest run apps/config-web`: 10 failed / 2200 passed. These are exactly the baseline failures (rulesRoute ×6,
eurobowl2026Package, smallGodsPackage, tabletopTesting, teamBuilderPage). `leagueForkPlay.test.ts` passes 51 of 51,
including the 4 new tests, 3 of which fail without the fix. `tsc -p apps/config-web` reports no errors in the touched
files; all reported errors are pre-existing.
