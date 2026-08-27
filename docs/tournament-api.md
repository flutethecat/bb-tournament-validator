# Tournament API foundation

Config-Web persists the tournament domain in `data-store/tournaments.json`. The checked-in
schema is `schemas/tournaments.schema.json`; runtime migration accepts V1 array/object maps and
writes V2 with durable standings snapshots and expiring waiting-presence leases.

## Client reads

- `GET /api/fork/tournaments?status=active` returns `{ tournaments }` (the portal alias is
  `/api/tournaments`). Only active tournaments are returned.
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
