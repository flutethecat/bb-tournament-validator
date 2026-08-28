# Match-results pull (Route C) — winnings/records for tournaments, zero jar change

**Status:** READY TO IMPLEMENT (owner-approved goal: track winnings/records — W/L, TDs scored,
casualties caused — for tournament results). Investigation verified 2026-08-27 against fork source;
file:line receipts in the session record. NO upload path, NO server mode change, NO jar edit.

## Mechanism (all existing fork endpoints, admin challenge-auth like forkAdmin.ts)
1. **Discover** finished games: `GET /admin/challenge` → `GET /admin/list?response=..&status=finished`
   and `status=backuped` (merge; there is NO "all"), or read `ffb_games_info` directly (status F/B;
   it carries NO score columns — index only).
2. **Pull result per game**: `GET /gamestate/challenge` → `GET /gamestate/result?response=..&gameId=<id>`
   → compact XML `<gameResult replayId halves>` with two `<teamResult teamId>` blocks:
   `<score> <winnings> <conceded> <concededLegally> <penaltyScore> <fame> <fanFactor> <teamValue>`,
   `<casualtiesSuffered badlyHurt= seriousInjury= rip=/>`, and `<playerResultList>` →
   `<playerResult playerId playerType name positionId>` with `<starPlayerPoints current earned>`
   containing `<touchdowns> <casualties> <completions> <interceptions> <deflections> <playerAwards>`
   and `<statistics>` `<blocks> <fouls> <rushing> <passing> <turnsPlayed>`.
   (JSON alternative: `/gamestate/get?...&includeLog=false` → `game.gameResult.teamResultHome|Away`
   → `score`, `badlyHurtSuffered/seriousInjurySuffered/ripSuffered`, `playerResults[].touchdowns|
   casualties|blocks|fouls|...` — but XML has deflections + names; prefer XML.)
3. **Retention: indefinite.** GameStateServlet's loader tries live cache → filesystem backup
   `backup/<d>/<d>/<d>/<d>/<gameId>.gz` (never purged) → DB. `ffb_games_serialized` rows ARE deleted
   ~seconds after game end (post-backup-verify), `ffb_games_info` kept (status 'B'). So pull anytime.
4. **Caveats:** casualties-CAUSED has no team-level key — sum `playerResults[].casualties`; a
   `<starPlayerPoints>` block is omitted when a player earned 0 SPP (absent = zero) and sub-elements
   are omitted when zero; `penaltyScore >= 0` overrides score semantics on concession; each endpoint
   consumes a one-shot challenge per call (re-challenge every request).

## Build shape (config-web, Veers lane; Codex dispatch)
- `@bb/fork-ops`: `gamestateResult(cfg, gameId)` (challenge→result, parse XML → typed
  `{ teams: [{teamId, score, winnings, penaltyScore, conceded, casualtiesSuffered{bh,si,rip},
  players: [{playerId, name, touchdowns, casualtiesCaused, blocks, fouls, completions,
  interceptions, deflections, mvp}] }] }`), reusing adminResponse + fetchWithTimeout idioms.
- config-web `tournamentResults.ts`: pull-on-demand + a small persisted results store keyed by
  gameId (data-store JSON, atomic write); derive per-team `{won|drawn|lost, tdFor/Against,
  casFor/Against, winnings}`; aggregate RECORDS per coach + per tournament package (the
  tournament-match metadata store already maps gameId→package+sides — join on it; also allow
  ad-hoc finished games without metadata).
- Routes: `GET /api/fork/match/:gameId/result` (session; participants + admin),
  `GET /api/fork/records?coach=|packageName=` (public read like games list) → standings rows
  (W-D-L, TD diff, cas diff, winnings) — classic tournament tiebreakers.
- Admin Console: a Results/Standings panel later (optional; API first).

## Context worth carrying
- Fork jar is ROLLED BACK to the 08-19 build (see fork-jar P0 memory / .bad-537bfb1aa forensics);
  Route C touches none of that — safe to build now.
- The full result-upload architecture (Routes A/B) is documented in
  `docs/tournament-match-launcher-spec.md` + Yularen's connected-mode material; A = the eventual
  cutover, B = declined for now, C = this doc.

## Coach Elo (owner ask 2026-08-27 eve — rides the Route C results store)

**Variant (Veers pins, owner may re-rule):** classic Elo with draw support — K=32, start 1500,
draws = 0.5. Small-pool-friendly and explainable; Glicko-2 rejected for now (opaque to players).
- **Derived, never stored**: recomputed from ALL retained finished games (the store keeps them
  indefinitely), processed chronologically (game finished timestamp, gameId as tie-order).
  Outcome per game = deriveTeamResult's W/D/L (penaltyScore-aware). Deterministic: same history
  in, same ratings out — no migration, no drift, cacheable in memory keyed by results count.
- **Provisional flag** while a coach has < 10 counted games.
- **Surfaces**: `/api/fork/records` rows gain `elo` + `provisional`; `/api/account` gains
  `elo {rating, games, provisional}`; client Statistics blade gains an Elo column and the
  Account & Identity pane shows it read-only (derived — not a profile field, NOT identities.json).
- Ad-hoc and tournament games both count (all fork results are real games); a later owner call
  may scope it per-package like standings.
