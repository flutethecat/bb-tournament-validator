# Discord SSO fork registration + password reset (config-web) — build spec

**Status:** for Codex dispatch. Orchestrated by Veers. Owner directive 2026-08-20: build via Codex,
DO NOT commit (leave in working tree for review). config-web ONLY — no fork server, no Tauri client.

## Why
Replaces the "email reset" project (blocked: zero SMTP infra, no `email` column on the parity-locked
`ffb_coaches`). Discord OAuth2 gives a **verified identity + verified email** in one step and reuses the
existing Discord app. It does registration, password reset, and email-capture together. The fork's join
credential is still an md5 password in `ffb_coaches` (Java server does literal `.equals` — parity-locked),
so SSO is an identity/registration/reset layer on top: it still sets a fork password. **Password UX
decision (owner-deferred, Veers default): the user SETS their own fork password on the completion page.**

## New env (opt-in gate, like the other fork-* features)
- `DISCORD_CLIENT_ID` — the existing Discord app's client id.
- `DISCORD_CLIENT_SECRET` — OAuth2 secret (owner adds in the Discord dev portal).
- `DISCORD_OAUTH_REDIRECT_URI` — e.g. `http://<host>:4310/api/auth/discord/callback` (must match the
  redirect registered in the Discord dev portal).
When any is unset → SSO is disabled: the OAuth routes return 503 `{error:"Discord SSO not configured"}`
and the "Sign in with Discord" affordance is hidden. Document all three in `.env.example`.

## Flow (all routes under /api/ so handleApi routes them; all PUBLIC — add to PUBLIC_PATHS + requireSession PUBLIC_API_METHODS)
1. **`GET /api/auth/discord/start`** — generate a random `state`, set it in a short-lived HttpOnly cookie
   (`discord_oauth_state`, SameSite=Lax so it survives the Discord round-trip, ~10 min Max-Age), then 302 to
   `https://discord.com/api/oauth2/authorize?response_type=code&client_id=<id>&redirect_uri=<uri>&scope=identify%20email&state=<state>`.
2. **`GET /api/auth/discord/callback?code&state`** — verify `state` equals the cookie (reject mismatch/absent
   → 400). POST `https://discord.com/api/oauth2/token` (`grant_type=authorization_code`, code, redirect_uri,
   client_id, client_secret; `application/x-www-form-urlencoded`) → `access_token`. GET
   `https://discord.com/api/users/@me` with `Authorization: Bearer <access_token>` → `{id, username, email,
   verified}`. If Discord returns no email or `verified:false`, still proceed but mark email absent.
   Then create a short-lived **pending-SSO** server-side record (in-memory Map keyed by a fresh random token
   set in an HttpOnly cookie `discord_sso_pending`, ~10 min TTL) holding `{discordId, discordUsername, email}`,
   clear the state cookie, and 302 to `/discord-complete.html`. Never put the Discord data in the URL.
3. **`GET /api/auth/discord/pending`** — read the `discord_sso_pending` cookie → return the pending record
   PLUS `existingForkName` (look up `identities.json` for a coach whose `identities.discordUserId === discordId`;
   null if none). 404/`{pending:false}` if no valid pending cookie. This is what the completion page reads.
4. **`POST /api/auth/discord/complete`** — body `{ forkName, passwordMd5? , password? }` (dual-accept, reuse
   `coachSecretDigest`). Require a valid `discord_sso_pending` cookie (else 401). Resolve:
   - If `existingForkName` is set (this Discord id already owns a fork account): ignore a differing `forkName`,
     operate on the existing name (this is a RESET). Otherwise use the submitted `forkName` (new registration).
   - Validate `forkName` (non-empty, ≤40, same rules as register). If NEW, reject if that name already exists in
     `ffb_coaches` AND is NOT already linked to this Discord id (don't let SSO claim someone else's coach name).
   - `createForkAccountDigest(dbCfg, forkName, digest)` (create-or-reset the fork password).
   - `upsertIdentity({ forkName, level: <existing or 'player'>, banned/silenced: <preserve>, identities: { ...existing,
     discordUserId: discordId, discordUsername, email }, ... })` — merges the Discord identity + email into the store.
   - Clear the pending cookie/record, `createSession(forkName)`, set the `cw_session` cookie, return `{ ok:true,
     coach: forkName }`.
5. **`/discord-complete.html`** (+ its small JS; reuse `tournament-rules.css`) — a public page that on load calls
   `/api/auth/discord/pending`, shows the verified Discord username + email (read-only) and: if `existingForkName`
   → "Reset the fork password for <name>" (one password field); if new → a "fork coach name" field (prefilled
   with the Discord username, editable) + password field. Submits to `/api/auth/discord/complete` (hash the
   password client-side to `passwordMd5` if the existing register/login client-hash helper is available; else send
   `password`). On success, link to the app / show "you're registered, use <name> + your password in the client".
   Add `/discord-complete.html` (+ its .js) to BOTH static allowlists (like admin.html).

## identities.json change
Add `email?: string` to the `CoachIdentities` interface in `apps/config-web/src/auth/identitiesStore.ts`
(and its per-field validation/length bound in `normalizedRecord`, same as the other identity fields).

## 🔴 Register-gate fix (fold in — Yularen security flag)
`GET /api/fork/register` (`server.ts:807-826`) is currently UNGATED: anyone who knows a coach *name* can
overwrite that coach's password (anonymous account takeover). Fix WITHOUT breaking new self-registration:
- Before provisioning, check whether `coach` already exists in `ffb_coaches` (add a `coachExists(cfg, name)`
  helper in `@bb/fork-ops` — a `SELECT 1 FROM ffb_coaches WHERE name = ? ` — or inline a guarded query).
- If it EXISTS and the requester is NOT authenticated as that coach (session `auth.coach` === name, case-insensitive)
  AND NOT admin (`isAdminAuthed || isTokenAuthed || auth.admin`) → **403** `{error:"That account already exists —
  sign in or use Discord to reset its password."}`. Creating a NEW (non-existing) coach stays allowed.
- The Discord SSO `complete` route is exempt (it authenticated identity out-of-band via Discord before resetting).

## Constraints / done
- config-web only. No new npm deps (use `fetch` for Discord API; crypto.randomBytes for state/tokens). No framework.
- Reuse: `createForkAccountDigest`, `coachSecretDigest`, `forkDbConfigFromEnv` (@bb/fork-ops); `createSession`,
  cookie helpers (auth/session.ts); `upsertIdentity`/`readIdentities` (identitiesStore); the sendJson/route idiom.
- Escape all user/Discord-derived strings in HTML. Never log the token, secret, code, or password.
- Tests: a unit test for the register-gate helper (exists+unauthed → blocked; new → allowed; admin → allowed) and
  for the pending-SSO store TTL/round-trip, matching the existing vitest style.
- DoD: `pnpm --filter config-web build` clean; `npx vitest run apps/config-web` green. DO NOT commit/push —
  leave the working tree for Veers review (this is security-sensitive: OAuth state/CSRF, the gate, session mint).

## ⭐ REVISION — owner-confirmed FINAL model (2026-08-20, supersedes the password-UX + record-shape above)
The first build was the user-sets-password model. The final model, per owner:

**A. Generated password, invisible.** The user NEVER sets or sees a fork password. On SSO complete,
generate a random password server-side (`crypto.randomBytes` → the digest via the existing hashing),
`createForkAccountDigest` with it, and store nothing user-visible. Joins work because config-web issues
JNLPs from the stored credential on the authenticated user's behalf — the fork password is pure plumbing.

**B. `ffbCoachId` vs `displayName` distinction.** Rename the record's stable-id field `forkName` →
**`ffbCoachId`** (still the `ffb_coaches.name`, still the normalized store key). It is the join/scheduler
identity AND the in-match nameplate (Java-owned, parity) — chosen ONCE at registration, availability-checked,
effectively permanent (a change = a separate guarded rename op, NOT in scope). Update every reader
(identitiesStore.ts, access.ts, server.ts `/api/admin/identities`, admin.js, tests) to the new field name.
Add a **`profile`** sub-object holding the EDITABLE, our-surfaces-only fields: `displayName` (defaults to the
Discord username), `avatar` (default = the Discord avatar URL), and **arbitrary/freeform additional keys**
(owner: "adding keys is free form as long as identities.json has a match"). Final record shape:
```jsonc
"<ffbcoachid>": {
  "ffbCoachId": "Flutethecat", "level": "player", "banned": false, "silenced": false, "note": "",
  "profile":    { "displayName": "Flutethecat", "avatar": "https://cdn.discordapp.com/...", "...": "freeform" },
  "identities": { "discordUserId": "", "discordUsername": "", "email": "", "nafName": "", "nafId": "", "tournamentCoachId": "" },
  "updatedAt": "...", "updatedBy": "..."
}
```
Store validation for `profile`: an object whose values are strings, bounded (per-value length cap + a max
number of keys) — NO fixed key whitelist (freeform). `email` stays under `identities` (SSO-verified).

**C. Coach-name availability (no silent uniquify).** New public `GET /api/fork/name-available?coach=<name>`
→ `{ available: boolean }` (reuse `coachExists`; available = not-exists). The completion page calls it live as
the user types; on submit, `/api/auth/discord/complete` re-checks and rejects a taken name (pick another) —
never a suffix. Existing Discord-linked users (identities record with matching `discordUserId`) skip the
name step and log straight in.

**D. Completion page (`discord-complete.html`) reworked:** shows verified Discord username + email read-only;
ONE user field — the coach name (`ffbCoachId`), prefilled with the Discord username, with the live
availability check; NO password field. Submit → `/api/auth/discord/complete { ffbCoachId }` → server generates
the password, provisions, upserts the record (profile.displayName = Discord username, profile.avatar = Discord
avatar, identities.email/discordUserId/discordUsername), creates the session.

**E. Self-service `/api/account` (build it — owner confirmed).** Distinct from the admin `/api/admin/identities`:
- `GET /api/account` (session-gated, any authenticated coach) → the caller's OWN record (`ffbCoachId` = auth.coach).
  If no record exists yet (pre-SSO coach), synthesize a minimal one from the session (ffbCoachId = auth.coach,
  empty profile) — don't 404.
- `PATCH /api/account` (session-gated) → merge the body's `profile` keys into the caller's OWN record's
  `profile` (freeform, validated as bounded strings). Editable: `profile.*` ONLY. NEVER editable here:
  `ffbCoachId`, `level`, `banned`, `silenced`, `identities.*` (those are admin/SSO-owned). Stamp updatedAt +
  updatedBy = auth.coach. Add `/api/account` to the CSRF `isStateChangingApiWrite` list (PATCH/POST). It is
  NOT public — a normal session-gated route.
- Add a unit test: a coach can PATCH their own `profile` (incl. a freeform key) but cannot touch level/ban via it.

## Out of scope (note, don't build)
- The Tauri client "Sign in with Discord" button (cross-lane; SSO supersedes the earlier client email-field plan).
- Actual TLS for the public OAuth callback (owed pre-competitive; localhost/LAN dev works over http).
- Stronger password hashing / salting (MD5 is parity-locked to the Java join handler — separate owner call).
