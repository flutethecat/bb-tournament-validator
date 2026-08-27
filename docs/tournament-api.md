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
