# Spec: match recorder pre-game flow (2026-10-30)

Owner request 10-30: a test match opened straight at Turn 1 with an empty log; the pre-game steps never appeared.
Scope: fans, weather, journeymen, inducements, prayers, coin flip, kick/receive; every step in the match log; optional
Discord webhook. Rules: BB2025 pre-game sequence, https://bloodbowlbase.ru/bb2025/core_rules/the_game_of_blood_bowl/
(cited by URL only).

## Root cause of the skipped pre-game
`POST /api/admin/testing/tabletop-match` (src/tabletop/testing.ts) defaulted `pregame` to `"skip"` when the body did not
name it, and the Testing Suite card (TabletopTestMatchCard.vue) never sent it. Every test match was created at
`phase: "playing"`. Casual and fixture matches already started at `pregame:fans`.
Fix: the default is `"full"`; the card gets an explicit "Skip pre-game" tick box (off by default). An organiser can
also skip a running pre-game (`pregame/skip`, logged).

## State machine (one authority: `match.phase`, advanced only by `pregameAdvance` in api.ts)
```
pregame:fans -> pregame:weather -> pregame:journeymen -> pregame:inducements -> [pregame:prayers] -> pregame:coin
  -> [pregame:timers] -> playing (turn 0 = set-up; "Kick-off done" starts turn 1)
```
`pregame:coin` has sub-steps, derived from its events: caller drawn (on entering the phase) -> call -> flip ->
kick/receive. The match view adds `pregame.step`:
`fans|weather|journeymen|inducements|prayers|coin|kickreceive|timers|setup|done` (`setup` = playing at turn 0 before
any turn started, `done` afterwards). Prayers are skipped when none were bought; timers when the competition fixes them.
Skip: organiser only, from any pre-game phase, records `pregameSkip`, jumps to `playing` (timers: preset or the
competition's fixed rule, else off).

## Who acts
| step | who may act | dice |
|---|---|---|
| fans, weather, journeymen, prayers | either coach or an organiser | "Roll for me" (site) or "Enter result" (coach) |
| inducements | either coach for either team (one phone at the table) or an organiser; the higher-TV team first | none |
| coin call | the drawn calling coach, or an organiser | none |
| coin flip | site (auto) or entered by either coach/organiser (hand) | site D2 / real coin |
| kick/receive | the toss winner, or an organiser | none |
| timers | each coach for their team; an organiser for both | none |
| skip pre-game | organiser only | none |
Spectators (organisers not playing, the other coach) see every step through the GET poll and the socket push.

## Wire (POST /api/tabletop/matches/:id/pregame/advance; `phase` optional double-advance guard)
- fans: `{}` or `{mode:"site"}`; `{mode:"hand", rolls:{home:1-3, away:1-3}}`
- weather: `{}`/`{mode:"site"}`; `{mode:"hand", dice:[1-6,1-6]}`
- journeymen: `{}`
- inducements: `{team, picks:[{id,qty}]}` or `{team, skip:true}` (resubmit replaces)
- prayers: `{}`/`{mode:"site"}`; `{mode:"hand", rolls:{home:[1-16...], away:[...]}}` (one per prayer bought, distinct)
- coin: `{mode:"auto", call:"heads"|"tails"}` (server flips); then `{choice:"kick"|"receive"}` by the winner;
  or `{mode:"hand", call, result, choice}` in one go. `caller`/`winner` in a body must match the server's.
POST `.../pregame/skip` `{}` organiser only.

GET view adds to `pregame`: `step`, `coin.caller` (before the call), and during inducements
`inducementOptions: {home|away: [{id,name,price,max}]}` and `budget: {home|away: {role, pettyCash, treasury,
topUpLimit, spent}}, tv: {home, away}`.

## Events (all server-written, deterministic ids, `by` = session coach)
| id | type | payload |
|---|---|---|
| pg-fans-home/away | fans | roll, dedicatedFans, total, rolledBy site/coach |
| pg-weather-0 | weather | pregame:true, roll, dice, result, rolledBy |
| pg-journeyman-side-n | journeyman | player, cost |
| pg-inducement-side[-n] | inducement | picks, total, treasury, pettyCash, skipped, submittedBy |
| pg-prayer-side-n | prayer | roll, name, rolledBy |
| pg-coincaller | coinFlip | stage:"caller", caller, rolledBy:"site" |
| pg-coinflip | coinFlip | mode, call, caller, result, winner, rolledBy, choice (hand) |
| pg-coinchoice | coinFlip | stage:"choice", winner, choice |
| pg-skip | pregameSkip | from (phase), by organiser |
Every row shows in the Match log (feed.ts sentences). The socket (`tabletop-clock`) is pushed after every pre-game
write, so the other phone refreshes at once.

## SPA
TabletopPregame.vue: stepper + one card per step. Fans/weather/prayers: "Roll for me" and "Enter result" (number
pads). Inducements: TabletopInducementPicker.vue (catalogue left: icon, name, price, limit, steppers; cart right:
petty cash, treasury, remaining; home then away, higher TV first). Coin: the caller sees Heads/Tails, everyone else
"<coach> is calling". Kick/receive: modal with two large buttons ("Kick or receive?" Receive / Kick) for the winner;
others see "waiting". TabletopPregameCine.vue plays a cine when a new pre-game event arrives: fans (crowd counter rolls
up, D3, fans + D3 = fan factor, both teams), weather (2D6 tumble then a splash with the name and effect line), coin
(the coin spins and lands, caption), kick/receive result splash. Each <= 2.5 s, click skips, reduced motion = static.
Own CSS (`--tt-*` palette), text and emoji only. Turn UI stays locked (`recording` is false) until `playing`.
Organiser: "Skip pre-game" (confirm).

## Discord (`DISCORD_RECORDER_WEBHOOK_URL`, optional, never logged)
src/tabletop/discord.ts: pure `pregameAnnouncement(kind, match, events)` -> webhook body; `createRecorderWebhook`
posts with a queue (min 1.2 s between posts, at most 20 waiting, oldest dropped), 5 s timeout, failures logged without
the URL, never blocks the match. Milestones: `fans`, `weather`, `inducements` (both submitted), `prayers`, `coin`
(after kick/receive), `skip`. Body:
```json
{ "username": "Super FUMBBL Recorder", "allowed_mentions": {"parse": []},
  "embeds": [{ "title": "Weather: Pouring Rain", "description": "...", "color": 3447003,
    "fields": [{"name": "Home", "value": "...", "inline": true}],
    "footer": {"text": "tabletop:<matchId> | pregame.weather"}, "timestamp": "<iso>", "url": "<PUBLIC_BASE_URL>/app/tabletop/<id>" }] }
```
The bot keys on `footer.text` (`tabletop:<id> | pregame.<kind>`). Test matches post with a "[Test] " title prefix.
There is no existing result-posting path in config-web; a result milestone can reuse the same poster later.

## Open questions for the owner
1. One phone at the table: the coin call and kick/receive are limited to the named coach (or an organiser). Allow
   either participant on a shared phone?
2. Should test matches post to Discord (now: yes, with "[Test]")?
3. "Randomly select a team for home/away": built as "the site draws which coach calls the toss"; home/away seats stay
   as created. Randomise the seats too?
4. Set-up is not recorded beyond turn 0 ("Kick-off done"). Want a set-up confirmation step?
