# Spec: match recorder pre-game flow (2026-10-30)

Owner request 10-30: a test match opened straight at Turn 1 with an empty log; the pre-game steps never appeared.
Scope: fans, weather, journeymen, inducements, prayers, coin flip, kick/receive; every step in the match log; optional
Discord webhook. Rules: BB2025 pre-game sequence, https://bloodbowlbase.ru/bb2025/core_rules/the_game_of_blood_bowl/
(cited by URL only). Updated the same day for the owner's rulings on the open questions (section at the end).

## Root cause of the skipped pre-game
`POST /api/admin/testing/tabletop-match` (src/tabletop/testing.ts) defaulted `pregame` to `"skip"` when the body did not
name it, and the Testing Suite card (TabletopTestMatchCard.vue) never sent it. Every test match was created at
`phase: "playing"`. Casual and fixture matches already started at `pregame:fans`.
Fix: the default is `"full"`; the card gets an explicit "Skip pre-game" tick box (off by default). An organiser can
also skip a running pre-game (`pregame/skip`, logged).

## Seats (ruling 3)
Home and away are drawn at random when the match is created (`createMatch`, crypto-random, injectable as
`deps.drawSeats`; tests pin it). This holds for casual, fixture-launched and test matches alike: the request only names
the two teams. The fixture orientation check runs on the drawn seats, so `fixtureSwap` records which way round a
fixture was played. The draw is logged (`pg-seats`). An organiser may swap the seats (`seats/swap`, logged) only while
the match is at `pregame:fans` with no pre-game record yet, because every pre-game record (fans, journeymen,
inducements, the coin) names a seat; a skipped pre-game or a running turn never swaps (review fix). The swap also swaps
the base revisions and flips `fixtureSwap`.

## State machine (one authority: `match.phase`, advanced only by `pregameAdvance` in api.ts)
```
create (seats drawn, pg-seats) -> [seats/swap by an organiser, while no pre-game record exists]
pregame:fans -> pregame:weather -> pregame:journeymen -> pregame:inducements -> [pregame:prayers] -> pregame:coin
  -> [pregame:timers] -> playing (turn 0 = set-up; "Kick-off done" starts turn 1)
```
`pregame:coin` has sub-steps, derived from its events: call (by the away coach) -> flip -> kick/receive. There is no
caller draw: the caller is derived from the seats (`coinCallerOf`: the away coach; a match drawn under the old rule,
with a recorded `pg-coincaller`, keeps that caller). The match view adds `pregame.step`:
`fans|weather|journeymen|inducements|prayers|coin|kickreceive|timers|setup|done` (`setup` = playing at turn 0 before
any turn started, `done` afterwards). Prayers are skipped when none were bought; timers when the competition fixes them.
Skip: organiser only, from any pre-game phase, records `pregameSkip`, jumps to `playing` (timers: preset or the
competition's fixed rule, else off).

## Who acts
| step | who may act | dice |
|---|---|---|
| swap seats | organiser only, at pregame:fans before the first pre-game record | none |
| fans, weather, journeymen, prayers | either coach or an organiser | "Roll for me" (site) or "Enter result" (coach) |
| inducements | either coach for either team (one phone at the table) or an organiser; the higher-TV team first | none |
| coin call | the away coach, or an organiser (auto or real coin) | none |
| coin result | site (auto, straight after the call) or, for a real coin, either coach / an organiser after the call | site D2 / real coin |
| kick/receive | the toss winner, or an organiser (dialog held back while a cine plays) | none |
| timers | each coach for their team; an organiser for both | none |
| skip pre-game | organiser only | none |
| anything | a spectator: never (403) | - |

## Viewers and roles (ruling 7)
`GET /api/tabletop/matches/:id` answers every viewer with the same match view plus `role`:
`"home" | "away"` (a seat, checked first), `"organiser"` (an organiser outside the match), `"spectator"` (anyone else).
- a signed-in Discord coach outside the match: spectator (test matches included);
- an anonymous visitor, or a non-Discord session: spectator for a match that is not a test match; a test match answers
  401 (anonymous) / 403 (non-Discord session); a banned account gets 403;
- every write route (`events`, `submit`, `confirm`, `publish`, `undo-revision`, `resolve-conflict`,
  `pregame/advance`, `pregame/skip`, `seats/swap`, `turn/*`) answers a signed-in spectator 403 and an anonymous one 401.
The SPA route `/app/tabletop/:id` has no sign-in gate, and with the auth sidecar on, requireSession lets the exact
GET/HEAD `/api/tabletop/matches/:id` through (every other tabletop route stays session-gated); the page follows the
role. Spectators read through the 5 s poll (the Super socket's tabletop room is participants and organisers only).

Spectator view model (`spectatorView`, review fix): an allowlist, never the stored records. `match` = id, state, phase,
home/away `{coach, teamName}`, postMatch, confirmations, createdAt/updatedAt, test, allowOvertime; `teams.<side>` =
name, race, rosterId, color, avatarUrl and `players` (id, name, number, position, kind, sprite, mng, dead, available);
`events` = id, type, team, half, turn, ts, by, admin, removed, the payload without `treasury` / `pettyCash`; `tally` =
score, fanDelta, conceded, clock, casualtiesSuffered, per-player lines; `pregame` with inducement payloads stripped the
same way and `budget` reduced to role / submitted / spent; context, coachRating, clock, sppValues; `playerLines`.
Player names and player lines (roster players, an event's `player` / `victim` / `thrower` / `thrown` and `sppEarned`,
the per-player tally, per-event SPP, journeymen ids) appear only when `GAME_PAGES_PUBLIC_PLAYER_LINES` allows (the game
pages' policy; default on). Never: treasuries or treasury spend, team values beyond the pre-game TV, save ids, base
revisions, journals, organiser notes, the post-match preview. Seats and organisers keep the full view.

Load: the role-independent view is a cached snapshot per match, keyed by updatedAt / state / phase and the event log's
revision (size + mtime), dropped by every serialised write, shared by concurrent loads, at most 200 matches; undo
metadata is indexed once per snapshot. Match GETs are limited to 60 a minute per session coach, else per IP (429 with
retry-after).

## Wire (POST /api/tabletop/matches/:id/pregame/advance; `phase` optional double-advance guard)
- fans: `{}` or `{mode:"site"}`; `{mode:"hand", rolls:{home:1-3, away:1-3}}`
- weather: `{}`/`{mode:"site"}`; `{mode:"hand", dice:[1-6,1-6]}`
- journeymen: `{}`
- inducements: `{team, picks:[{id,qty}]}` or `{team, skip:true}` (resubmit replaces)
- prayers: `{}`/`{mode:"site"}`; `{mode:"hand", rolls:{home:[1-16...], away:[...]}}` (one per prayer bought, distinct)
- coin, three sub-steps, each authorised on its own (review fix 10-30):
  1. call: `{mode:"auto"|"hand", call:"heads"|"tails"}` by the away coach or an organiser (auto: the server flips at once);
  2. real-coin result: `{mode:"hand", result}` by either coach or an organiser;
  3. choice: `{choice:"kick"|"receive"}` by the winner or an organiser.
  One request may carry several sub-steps (`{mode:"hand", call, result, choice}`) only if its sender may do each;
  otherwise 403 and nothing is recorded. `caller`/`winner` in a body must match the server's.
POST `.../pregame/skip` `{}` organiser only.
POST `.../seats/swap` `{}` organiser only; 409 unless the match is recording at `pregame:fans` with no pre-game record. Answer:
`{match, recorded:["pg-seatswap-n"], pregame}`.

GET view: `role` (above); `pregame` adds `step`, `seatsSwappable` (recording at pregame:fans, no pre-game record yet),
`coin.caller` throughout the coin phase (before the call it is the only coin field), and during inducements
`inducementOptions: {home|away: [{id,name,price,max}]}` and `budget: {home|away: {role, pettyCash, treasury,
topUpLimit, spent}}, tv: {home, away}`.

## Events (all server-written, deterministic ids, `by` = session coach)
| id | type | payload |
|---|---|---|
| pg-seats | seats | stage:"draw", swapped, rolledBy:"site", home{coach,teamName}, away{coach,teamName} (written at creation) |
| pg-seatswap-n | seats | stage:"swap", home{...}, away{...} (after the swap); `admin` when the organiser plays in neither seat |
| pg-fans-home/away | fans | roll, dedicatedFans, total, rolledBy site/coach |
| pg-weather-0 | weather | pregame:true, roll, dice, result, rolledBy |
| pg-journeyman-side-n | journeyman | player, cost |
| pg-inducement-side[-n] | inducement | picks, total, treasury, pettyCash, skipped, submittedBy |
| pg-prayer-side-n | prayer | roll, name, rolledBy |
| pg-coincall | coinFlip | stage:"call", mode:"hand", caller, call, calledBy (real coin only) |
| pg-coinflip | coinFlip | mode, call, caller, result, winner, rolledBy, enteredBy (hand) |
| pg-coinchoice | coinFlip | stage:"choice", winner, choice (always its own event) |
| pg-skip | pregameSkip | from (phase), by organiser |
`pg-coincaller` (stage:"caller") is no longer written; old matches that have one keep their caller and the log reads it
like a derived caller. Every row shows in the Match log (feed.ts sentences): "The site draws home and away: A (a) at
home, B (b) away.", "<organiser> swaps home and away: ...", "Away team <team> (<coach>) calls the toss: heads. The coin
lands heads. <coach> wins the toss.". The socket (`tabletop-clock`) is pushed after every pre-game write and swap, so
the other phone refreshes at once.

## SPA
TabletopPregame.vue: stepper, a seat line ("Home: A (a) · Away: B (b)") and one card per step. Fans/weather/prayers:
"Roll for me" and "Enter result" (number pads). Inducements: TabletopInducementPicker.vue (catalogue left: icon, name,
price, limit, steppers; cart right: petty cash, treasury, remaining; home then away, higher TV first). Coin: the away
coach sees "Away team <team> (<coach>) calls the toss" with Heads/Tails, everyone else the same line and "Waiting for
<coach> to call…". Kick/receive: modal with two large buttons ("Kick or receive?" Receive / Kick) for the winner;
everyone else sees "<coach> (<team>) won the toss" and "Waiting for <coach> to choose…". Organiser: "Swap home and
away" (confirm) while `seatsSwappable`, and "Skip pre-game" (confirm).
TabletopPregameCine.vue plays a cine when a new pre-game event arrives: fans (crowd counter rolls up, D3, fans + D3 =
fan factor, both teams), weather (2D6 tumble then a splash with the name and effect line), coin (the coin spins and
lands, caption), kick/receive result splash. Each <= 2.5 s, click skips, reduced motion = static. Own CSS (`--tt-*`
palette), text and emoji only. A playing cine is the top dialog for the focus manager (sheetFocus.ts), swallows its skip
keys (capture phase, preventDefault + stopPropagation, keydown and keyup), and the Kick or receive? dialog waits until
it ends. The inducement cart follows the server's latest submission for the team; an unsaved draft is kept and a newer
submission from the other phone is flagged with "Reload their picks" (inducementCart.ts). Turn UI stays locked
(`recording` is false) until `playing`.
Spectator (`role: "spectator"`): TabletopRecorderView renders read-only. Scoreboard, pre-game steps and cines as they
happen, and the match log show, with a line "You are watching this match. It updates as the coaches record it."; the
TD/CAS/Injury/Other bar, rail buttons, admin tools, undo and every acting dialog do not (TabletopPregame `readOnly`; a
session organiser flag cannot re-enable them).

## Discord (`DISCORD_RECORDER_WEBHOOK_URL`, optional, never logged)
src/tabletop/discord.ts: pure `recorderAnnouncement({kind, match, events, result?})` -> webhook body;
`createRecorderWebhook` posts with a queue (min 1.2 s between posts, at most 20 waiting, oldest dropped), 5 s timeout,
failures logged without the URL, never blocks the match. Milestones: `fans`, `weather`, `inducements` (both submitted),
`prayers`, `coin` (after kick/receive), `skip`, and `result` (ruling 6). Body:
```json
{ "username": "Super FUMBBL Recorder", "allowed_mentions": {"parse": []},
  "embeds": [{ "title": "Weather: Pouring Rain", "description": "...", "color": 3447003,
    "fields": [{"name": "Home", "value": "...", "inline": true}],
    "footer": {"text": "tabletop:<matchId> | pregame.weather"}, "timestamp": "<iso>", "url": "<PUBLIC_BASE_URL>/app/tabletop/<id>" }] }
```
The bot keys on `footer.text` (`tabletop:<id> | pregame.<kind>`, or `tabletop:<id> | result`). Test matches post with a
"[Test] " title prefix.
Result summary: posted once each time a match is confirmed for good (the second coach's confirm, an organiser's
confirm for both, or the organiser's confirm-and-publish), best effort (it never fails the confirmation). One embed:
title `Result: <home team> <h> - <a> <away team>`, description `<home> (<coach>) v <away> (<coach>)` then the winner (or
"A draw.") and any concession; one field per team (`<team> (<coach>)`): `Score`, `Touchdowns` (scorers, `xN`),
`Casualties caused` (total, with BH / SI / dead: the side's own effective casualty events; a standalone injury has no
causer and counts for nobody), `MVP`, and `Conceded` when it did. Footer `tabletop:<id> | result`;
`url` = `<PUBLIC_BASE_URL>/app/games/tabletop/<id>` (the public game page; a test match has none, so it links its
recorder). Data: `resultSummaryOf(events, rosters)` in api.ts, the same tally as the results row.

## Owner rulings 10-30 (on the open questions)
1. No "shared phone" setting; keep the caller/winner authorisation as built.
2. Test matches post to Discord with the "[Test]" prefix.
3. Home/away seats are RANDOMISED when the match is created; the toss caller is derived from the seats (away coach calls; convention of the visiting side), not drawn separately.
4. No set-up confirmation step.
5. No two-coach agreement on a real coin result.
6. The final match result also goes to Discord as a summary embed.
7. A read-only spectator view of the pre-game (and the match) is required.

Built (branch codex/pregame-rulings): 1, 4, 5 unchanged by design; 2 kept and tested for milestones and the result;
3 = "Seats", the derived caller, `seats/swap` (until the first pre-game record); 6 = the `result` milestone; 7 =
"Viewers and roles" plus the read-only page.
