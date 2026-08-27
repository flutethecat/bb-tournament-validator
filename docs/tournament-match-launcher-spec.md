# Tournament Match launcher — rostered inducements/stars applied at game start

**Status:** DRAFT — owner's architecture captured 2026-08-20; §4 (treasury + client-hook mechanics)
awaits the fork-source investigation before build. Two-sided spec: config-web half = Veers lane;
client executor half routes via Yularen (play-lane single-writer files).

## Owner's design (verbatim shape, 2026-08-20)
1. Config-web gets a **"Tournament Match" launcher** — a distinct launch path.
2. Config-web **schedules** the game and the sidecar carries **additional metadata** for that match.
3. The client connects through the tournament-match path and **checks with config-web for instructions**.
4. Config-web — having already validated the team via the tournament team builder — **delivers
   instructions**: "Buy Inducements", "Stars", etc.
5. Config-web sets the flow up exactly: it puts the **exact treasury amount** on the team, and the
   client **auto-selects through the inducement pane at game launch**. The client just executes.
6. The flow repeats for **both home and away**.

## Why this shape is right (design rationale)
- **Zero fork-server change / upstream parity intact.** The server sees a normal pregame: a client
  with treasury buying inducements through the standard `buyPrayersAndInducements` step. No new wire
  vocabulary. Server-derived law holds: the client only auto-selects options the server offers.
- **Exact-treasury = enforcement.** The client can only buy what the treasury covers, so a
  misbehaving client cannot over-induce; config-web (which validated the roster + package) is the
  budget authority. Execution is dumb by design.
- **Stars ride the same pane.** BB2025 hires Star Players as pregame *inducements*, so star
  instructions flow through the identical auto-select mechanism — one executor covers both.
- Config-web already owns validation, scheduling (admin API), and JNLP issuance; match metadata +
  an instructions endpoint extend the same trust boundary. Aligns with the gamefinder spec's
  outbox/scheduling architecture.

## Sketch — config-web half (Veers lane)
- **Match metadata store:** per scheduled tournament game (keyed by gameId from `scheduleForkGame`):
  `{ gameId, tournament/package name, home: { ffbCoachId, teamId, instructions }, away: {...} }`.
  Instructions per side: `{ treasury: number, inducements: [{ id, count }], stars: [starName] }` —
  derived from the validated roster (the team-builder registration already knows the package,
  inducement picks, and star picks).
- **Launcher:** "Tournament Match" pairing path (organizer-driven or fixture-driven) that
  (a) composes/refreshes both team XMLs **with the exact treasury** (per §4 findings),
  (b) schedules via the fork admin API, (c) persists the match metadata, (d) issues both JNLPs.
- **Instructions endpoint:** `GET /api/fork/match/<gameId>/instructions?coach=…` (session/coach-authed;
  a coach can fetch only their OWN side) → that side's instruction block. Idempotent, read-only.
- Serve for both seats; the client fetches at connect time (step 3).

## Client half (cross-lane — route via Yularen; play-lane single-writer)
- On a tournament-path join, fetch instructions from config-web; during the pregame
  `buyPrayersAndInducements` dialog, auto-select the instructed inducements/stars (exactly the
  commands a human click would send) and confirm. Fall back to manual on any mismatch (offer absent,
  treasury short) — never invent a selection the server didn't offer; surface the discrepancy.

## §4 CONFIRMED MECHANICS (fork-source investigation, 2026-08-20)
**The good news — every building block exists:**
- **Treasury:** the fork's team XML loader honors `<treasury>` (Team.java:435–437). The composer
  currently hardcodes `<treasury>0</treasury>` (teamComposer.ts:518, 733) — setting the exact
  amount is a config-web-only change. Skeleton-safe (TeamSkeleton ignores unknown fields).
- **Pre-rostered inducements are UPSTREAM-NATIVE:** team XML `<inducementSet>` (+`<starPlayerSet>`)
  is parsed by the server (Team.java:391–395; InducementSet.java:340–376), and upstream option
  `USE_PREDEFINED_INDUCEMENTS` makes StepBuyInducements copy it straight into the game with no
  dialog (StepBuyInducements.java:209–234). Restrict emitted children to `<inducement>` +
  `<starPlayerSet>` (never `<card>/<prayer>` — null-game factory hazard on other parse paths).
- **Client auto-answer seam exists** (the owner-design path): store.ts:7657 already auto-answers
  the dialog headlessly; a stored-roster branch reusing `buildValidatedBuyCommand` →
  `buildBuyInducementsCommand` (inducementPurchase.ts:212, the validated byte-parity seam) sends
  the identical `clientBuyInducements` wire a human would. Server validates spend (fatal on
  over-spend) — config-web's exact-treasury keeps it affordable by construction.
- **Instruction source:** the validator's `Roster.inducements` (teamComposer.ts:502/705) projected
  into `LibraryTeam` (add `rosteredInducements`; library.ts:15, written by registerBuiltTeam).

**The hard truth — every viable path needs ONE small fork-server enablement (owner parity ruling
required; jar = zero-staged-divergences doctrine):**
- With equal-TV teams and the fork's standalone defaults, `getAvailableGold()` yields 0 even WITH
  treasury: `INDUCEMENTS_ALWAYS_USE_TREASURY` / `..._ON_EQUAL_CTV` are commented out in
  UtilServerStartGame.addDefaultGameOptions (lines 274/277), so the dialog never opens.
- Per-game options are impossible outside `test:` games (`/option` is TalkRequirements
  Environment.TEST_GAME-gated; test games are also excluded from games lists via testing=0) — so
  the enablement must be a standalone-defaults change.
- **Path A (server-native):** default `USE_PREDEFINED_INDUCEMENTS=true` + pin the latent upstream
  NPE in that branch (availableInducementGold null → unboxed at leaveStep:573). 2 jar edits; no
  client work; global to standalone (harmless for inducement-set-less teams).
- **Path B (owner's client-executor design):** uncomment `INDUCEMENTS_ALWAYS_USE_TREASURY` (1 jar
  line) + composer emits exact `<treasury>` + client auto-answer branch. Behavior-neutral for all
  zero-treasury teams (dialog still skipped), so the divergence surface is minimal; keeps the
  config-web instructions flow and the fall-back-to-manual UX.
- **RULED (owner 2026-08-20): Path B EXECUTES.** The jar line is applied (UtilServerStartGame
  `INDUCEMENTS_ALWAYS_USE_TREASURY` now added, with owner citation — note the surrounding
  addDefaultGameOptions block was already fork-customized standalone config, e.g. the Claw 08-19
  default, so this rides the established surface). Path A is handed to YULAREN to investigate as an
  UPSTREAM CONTRIBUTION (the latent NPE pin + predefined-inducements enablement may be worth
  offering upstream along with our other change) — per Law 6 the fleet only PREPARES the material;
  the owner mediates all upstream contact.
- **CORRECTION (owner 2026-08-20): STARS RIDE THE ROSTER, NOT THE INDUCEMENT SCREEN.** The
  composer already emits stars as roster players (`isStar` positions, self-describing blocks —
  teamComposer.ts:281–306), so a tournament team's stars load with the team XML. Therefore the
  instructions block carries **INDUCEMENTS ONLY** (`stars` stays absent/empty from the roster
  path), and `<treasury>` funds exactly the wire-gold cost of the rostered INDUCEMENTS — nothing
  else. Config-web's job is to make the pregame math come out right: treasury = inducement cost,
  so the client can buy precisely the rostered list and no more. (Cross-roster star hiring is the
  star-program/league-selection track's concern, not this launcher's.)

## Out of scope
- Any fork-server modification. Any new wire vocabulary. Async/Blackbox modes (gamefinder spec owns
  those states). Standing scheduling/calendar negotiation (League15–17 — separate feature).
