# Tournament API foundation

Config-Web persists the tournament domain in `data-store/tournaments.json`. The checked-in
schema is `schemas/tournaments.schema.json`; runtime migration accepts V1 array/object maps,
normalizes legacy V2 tournament rows with the creation-field defaults, and writes V2 with durable
standings snapshots and expiring waiting-presence leases.

## Client reads

- `GET /api/fork/tournaments?status=active` returns `{ tournaments }` (the portal alias is
  `/api/tournaments`). Only active tournaments are returned.
- `GET /api/fork/tournaments?status=draft` returns draft tournaments for the creation and
  registration screen; list rows include the active entrant count and, for an authenticated
  entrant, their own entrant id.
- `GET /api/fork/tournaments/:id` returns `{ tournament, entrants, rounds, standings,
  scheduledMatches }`. The scheduled array is empty without a coach session, participant-scoped
  with a coach Bearer token, and unscoped for organizers.
- `GET /api/fork/tournaments/:id/standings` returns `{ tournamentId, standings }`.
- `GET /api/fork/tournaments/:id/next-opponent` requires a coach session and marks its answer
  `provisional` unless a scheduled match already exists.
- `GET /api/fork/tournaments/:id/entrants/:entrantId/build` lazily returns the existing library
  team plus `inert: true` and disabled edit/retire/unscheduled-launch capabilities.

## Scheduled matches

`GET /api/scheduled-matches` and `GET /api/scheduled-matches/:id` require a coach session and are
participant-scoped. Every client row includes the stable fields `matchId`, `round`, `status`,
`scheduledAt`, `myTeamId`, `opponentTeamId`, `opponentCoach`, optional opponent display metadata,
`canLaunch`, and the established challenge/matchstatus/cancel/JNLP route paths.

`POST /api/scheduled-matches/:id/presence` renews the authenticated participant's lease (45 seconds
by default); `DELETE` clears it. Notification audience is empty when neither or both coaches wait,
and contains only the absent opponent when exactly one waits. The organizer-only
`GET /api/scheduled-matches/:id/notification-audience` includes a linked Discord id when present.

Launch/result writes use optimistic `revision` checks. A participant may `POST` actions `retry` or
`dismiss` only for `launch_failed`; either transition increments the revision and clears leases.
Organizer launch/result reporters use `PATCH /launch` and `PATCH /result` respectively.

## Tournament creation (owner requirements, 2026-08-27 — the Create Tournament entry point)

Owner-specified entry pane, visible to ORGANIZERS as a button on the Tournaments screen
(`tournaments.html` becomes a real page; it is currently a legacy redirect stub to admin.html):

1. **Ruleset selection** — the tournament binds to a saved tournament-rules package
   (the sets created in tournament-rules.html; source = the PackageFiles listing).
   Gap closed by adding `packageName` to `TournamentRecord`.
2. **# of Players** — an entrant cap (`maxPlayers`) enforced at registration.
3. **Type of competition** — `format: "swiss" | "roundRobin" | "knockout"`; pairing.ts grows
   round-robin (circle method) and knockout (single-elimination, byes to top seeds) beside swiss.
4. **Name of competition** — already present (`name`).

`POST /api/fork/tournaments` (organizer-gated) creates a draft tournament with those four fields;
activation and round generation ride the existing organizer round ops. The foundation's
swiss-only literal, missing package binding, and missing cap are the gaps this closes.

## Entrant registration contract (Veers ruling 2026-08-27, closing the honest-stop gap)

`POST /api/fork/tournaments/:id/entrants` — coach session required. Body `{teamId}`.
- Binds the AUTHENTICATED coach + their OWN library team (ownership resolved via the fork
  library, same source the admin teams search uses); an organizer session may instead pass
  `{teamId, coach}` to register another coach (manual seeding).
- Rejections (honest 400): tournament not draft/active or round 1 already generated; coach
  already entered (one seat per coach); team not owned by the target coach; **entrant count
  at `maxPlayers` ("Tournament is full.")** — this is where the cap binds.
- Seat shape = the existing `TournamentEntrantRecord` (`VerifiedCoachIdentity` from the
  session; seed = next ordinal at registration; organizer reseeding is a later concern).
- `DELETE .../entrants/:entrantId` — self or organizer; sets `droppedAt` (foundation field),
  never removes the row (pairing history integrity).

## Organizer live-edit (owner requirements 2026-08-27 eve)

`PATCH /api/fork/tournaments/:id` — organizer-gated, partial body, effective immediately:
1. **maxPlayers** — editable any time, but never below the current non-dropped entrant count
   (honest 400 naming the floor).
2. **format** (swiss | roundRobin | knockout) — editable only while NO round exists (a format
   flip would orphan pairing history); afterwards 400 "Format is locked once rounds exist."
3. **packageName** (ruleset) — validated against saved packages; same no-rounds lock as format
   (entrants built teams against the old ruleset — re-validation on change is a later concern,
   the lock keeps it honest for now).
4. **startsAt** — NEW optional ISO-8601 field on TournamentRecord (schema bump + migration
   default absent); freely editable; emitted on list/detail (portal decoders ignore unknown
   keys — verified against tournamentApi.ts record() picks).
UI: the web tournaments.html detail pane gains an organizer-only Edit form (pre-filled, save →
PATCH → re-fetch; server errors verbatim). Client portal stays read-only for now.

### Addendum (owner, same eve): primary tiebreaker choice
5. **primaryTiebreaker** — `"buchholz" | "sonnebornBerger"`, DEFAULT buchholz. On create AND the
   organizer PATCH. The choice sets the record's tiebreaker ladder to
   `[chosen, "touchdownDifferential", "casualtyDifferential", "seed"]` (the unchosen head drops
   out — the contract reflects the admin's pick, not both). Editable in tournaments.html on the
   Create pane and the Edit pane (dropdown). Existing records keep their stored ladder;
   PATCHing the choice rewrites it. Same rounds-lock as format? NO — tiebreakers are a ranking
   display/standings concern, safe to change until completion; lock only when status=completed.

### Amendment (owner): seed is NOT a tiebreaker
The ladder is `[chosen, "touchdownDifferential", "casualtyDifferential"]` — no trailing "seed".
Full ties rank equal (stable store order for display); knockout BRACKET seeding still uses
`entrant.seed` (registration ordinal) — that is placement, not ranking.

### Amendment 2 (owner): full ties = random flip
A remaining tie ranks by RANDOM FLIP — but the flip must be STABLE (standings cannot reshuffle
per refresh): derive it from a deterministic hash of (tournamentId, the two entrantIds) so the
coin lands the same way for the same pair all tournament, with no stored state. Unbiased across
pairs, decided "at random" from the entrants' perspective.
