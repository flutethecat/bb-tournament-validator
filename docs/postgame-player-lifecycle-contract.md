# Post-game player lifecycle contract

Status: source-verified where marked; unresolved website-owned retention remains fail-closed.

## Scope and authority

This contract separates three systems that upstream FUMBBL keeps distinct:

1. The website provisions the team XML used to start a game and owns post-game roster choices.
2. The Java game server owns match mechanics and serializes their facts into `FumbblResult`.
3. Config-web may persist those facts, but must not recreate a roll, eligibility decision, or optional hiring choice.

Java references below are from official `christerk/ffb` `upstream/master` at
`c44abb0d5fa370b89e0c6868247205ae4b3454d0`.

## Ordinary journeymen

### Proven input shape

Ordinary journeymen are not created by an open-source Java start-game step. They arrive in the team
XML loaded by the server. The local upstream-derived corpus contains this exact shape in
`ffb-server/teams/team_nippon.xml`:

```xml
<player status="journeyman" nr="17" id="14840060">
  <name>Nicholas Quickwing</name>
  <gender>male</gender>
  <positionId>43571</positionId>
  <position>Ashigaru</position>
  <playerStatistics currentSpps="0">...</playerStatistics>
  <skillList><skill>Loner</skill></skillList>
  <injuryList/>
</player>
```

`RosterPlayer` parses the `status` attribute and `isJourneyman()` is exactly
`playerStatus == PlayerStatus.JOURNEYMAN`. The player otherwise remains a normal roster player with a
stable player ID.

The closed upstream website code that decides when to provision these players is not in
`christerk/ffb`. The Blood Bowl condition (top an eligible roster up to eleven before the match), name
generation, and post-game purchase/prune choice therefore remain website-owned and are not to be
reimplemented from inference alone.

### Result and hiring consequence

`FumbblResult` serializes `playerType`, but not `PlayerStatus`. An ordinary journeyman therefore appears
as its underlying regular player type. Config-web can only identify it by joining `playerResult.playerId`
to the exact pre-game team XML whose player carries `status="journeyman"`.

Banking may safely apply match statistics, injuries, and SPP to that stable ID while preserving its
status. Retain-versus-prune is a later post-game selection and must not happen inside the result banker.

## Raised From the Dead

### Proven in-game creation

The BB2025 apothecary/injury sequence calls `UtilServerInjury.raisePlayer` as soon as the qualifying
death resolves. `InjuryMechanic.raisePositions` supplies the eligible non-star/non-irregular lineman
positions and the server shows `PositionChoiceMode.RAISE_DEAD` if more than one is available. The server:

- uses the server-selected/coach-selected eligible roster position;
- generates ID `killedPlayerId + "R" + raisedDeadCounter`;
- copies the dead player's name;
- assigns the next roster number;
- sets `PlayerType.RAISED_FROM_DEAD`;
- adds the player to the runtime team and reserves box;
- broadcasts `sendAddPlayer`; and
- emits `ReportRaiseDead`.

Because `FumbblResult` iterates every runtime team player, the generated player is serialized with
`playerId`, `playerType="RaisedFromDead"`, `positionId`, `name`, and `gender`, plus any result fields.

### Persistence boundary

The game-server event and result identity are exact. The website-owned rule that makes this player a
permanent, free roster addition is not implemented in the open Java repository. Config-web currently
rejects a missing `RaisedFromDead` player rather than fabricate a persistent player block. Support may
be added after a golden upstream result and the exact retained team-XML shape are captured.

## Plague Ridden

### Proven in-game creation

BB2025 `InjuryMechanic` uses the same `UtilServerInjury.raisePlayer` path, but assigns
`PlayerType.PLAGUE_RIDDEN`. The generated ID has the same `killedPlayerId + "R" + counter` form. The
player is added to the runtime team, sent to reserves under BB2025, broadcast with `sendAddPlayer`, and
reported immediately.

The result therefore contains the same identity fields as Raised From the Dead, distinguished by
`playerType="PlagueRidden"`.

### Persistence boundary

Plague Ridden is a post-game offer, not an automatic roster insertion. The offer, cost, accept/decline
transaction, and resulting persistent XML are website-owned and absent from the open Java repository.
The result banker must retain the exact result for the later post-game workflow, but must not insert or
discard the player on its own. Current banking deliberately fails closed until that workflow exists.

## Capturing canonical `FumbblResult`

A live upstream game is not required. The fork's authenticated `GameStateServlet` exposes
`/gamestate/result` and returns `new FumbblResult(game).toXml(true)` for either an in-memory game or a
loadable game backup. `GameStateConnector result <gameId>` performs the challenge/response and calls
that endpoint. A locally completed fork game or completed replay therefore produces the exact serializer
output needed for a golden fixture.

Capture procedure:

1. Complete a local fork game that exercises the desired lifecycle.
2. Before deleting its backup, run the bundled `GameStateConnector result <gameId>` against the local
   server configuration.
3. Retain only the returned `<gameResult ...>` document; do not retain the printed challenge URL or
   response token.
4. Store the result beside the exact pre-game and expected post-game team XML fixtures.
5. Cover at least normal completion, legal concession, illegal concession, ordinary journeyman,
   Raised From the Dead, and Plague Ridden.

No Config-web raw-capture feature is added: the existing authenticated serializer endpoint is exact,
credential-free at the artifact layer, and avoids creating a second production retention surface.

## Pre-commit XML protection (AV-3)

All supported Config-web/fork writers acquire the shared per-team file lock. Banking additionally:

1. reads the authoritative team XML under that lock;
2. records byte length, filesystem size, modification time, and SHA-256 content hash;
3. calculates the proposed result without writing;
4. immediately before commit, re-reads the live file and rejects any metadata or content change;
5. persists the exact validated bytes as recovery backup;
6. writes the IN_PROGRESS ledger; and
7. commits with an atomic rename.

This protects against an unsupported external editor that changes the file during calculation. It does
not claim a mandatory operating-system lock over arbitrary processes: a process that ignores the shared
lock could still race after the final comparison and before rename. Production must route all team
mutations through the shared lock and must not edit live team XML directly.

## Remaining hold items

- Capture golden normal/concession/journeyman/Raised/Plague result and team fixtures.
- Specify and build the post-game hiring transaction separately from result banking.
- Prove the exact permanent Raised From the Dead team-XML representation.
- Prove the Plague Ridden offer cost and accepted team-XML representation.
- Stress the connected `xml:result` upload, exact retry, conflicting retry, cache reload, and final XML.
