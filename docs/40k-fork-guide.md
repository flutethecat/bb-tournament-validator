# FUMBBL40k Fork — Register, Launch Games & Build Announcements

A practical guide to getting a coach onto the **FUMBBL40k test fork**, launching a game,
and the automated build announcements — all driven from Discord with the **Blood Bowl
Tournament Bot** (`/bbbot 40k …`). Game launching is below; build announcements have their
own section near the end.

There are two roles:

- **Coach / player** — you have a FUMBBL team and want to play a game on the fork.
- **Admin / TO** — you provision accounts, copy teams, and launch games. All
  `/bbbot 40k` commands require **Manage Server**.

> The fork side (server, DB schema, client JNLP handling) is documented in
> `fumbbl40k-client/docs/Fork_Account_Creation.md`. This guide is the Discord/bot
> workflow that sits on top of it.

---

## What you need first

- **The FUMBBL40k client** installed, with its **fork IP configured** (editable in-app).
  The JNLP file deliberately does **not** contain the host, so a changed home IP never
  breaks a saved JNLP — the client always uses its configured fork IP.
- A **FUMBBL team** (build/pick one on fumbbl.com; note its URL, e.g.
  `https://fumbbl.com/t/1264703`).
- The bot online **on the fork host** (the DB + team files live there).
- Test password for every fork account: **`12345`**.

---

## Part A — For Coaches

### 1. Link your FUMBBL name to Discord (REQUIRED, do this once)

```
/bbbot coach register fumbbl:<your-FUMBBL-coach-name>
```

Use your **exact** FUMBBL coach name (the one that owns your team — e.g. `Gondra87`,
not `Gondra`). **This is mandatory:** the bot will **not launch a game** until every
coach in it has registered — the launch is blocked and names the coaches who still need
to register. Registration is also what lets the bot **@-ping you** with your JNLP.

### 2. Get your fork account

Ask your admin to create it (`/bbbot 40k createaccount <your-name>`). Your login is:

- **Coach name:** your FUMBBL coach name (must match your team's owner)
- **Password:** `12345`

### 3. Join a game

When the admin launches your game, a **`.jnlp` file** is posted to the 40k channel with
an **@mention** to you. Then:

1. **Download** the `.jnlp` file from the channel.
2. **Open it** with the FUMBBL40k client (make sure your fork IP is set in the client).
3. You'll join the game named in the post. **Both coaches must open their JNLP for the
   same game** — the **second** coach to join **starts the match**.

That's it — no manual server/ID/password entry; the JNLP carries it all.

---

## Part B — For Admins / TOs

All commands are under `/bbbot 40k` and require **Manage Server**.

### 1. Set the JNLP channel (once)

Pick the channel where game JNLPs should be posted to coaches:

```
/bbbot 40k setchannel channel:#40k-games
```

This is separate from any roster-validation *watched* channels.

### 2. Provision each coach's account

The fork coach name **must match the team's FUMBBL `<coach>`** (standalone join checks
this). So create the account under the team's owner name:

```
/bbbot 40k createaccount username:Gondra87
```

Re-running it just resets the password to `12345` (idempotent).

### 3. Copy each team onto the fork

```
/bbbot 40k copyteam url:https://fumbbl.com/t/1264703
```

This fetches the team's XML and writes `team_<coach>_<id>.xml` into the fork's teams
dir. **⚠ Restart the FFB game server afterward** — it scans the teams directory only at
boot, so newly copied teams won't be joinable until it restarts.

### 4. Launch the game

Post the JNLP(s) to the 40k channel, pinging each coach:

```
/bbbot 40k launch game:FriendlyBowl team:https://fumbbl.com/t/1264703 team2:https://fumbbl.com/t/1272390
```

- `game:` — the game name. **Both coaches use the same one.**
- `team:` / `team2:` — the two teams (team2 optional; omit it to post just one side).
- `password:` — optional, defaults to `12345`.

Each coach gets a post with their `.jnlp` and an @mention. **Registration is enforced:**
if any coach hasn't linked their FUMBBL account, the launch is **blocked** and lists who
still needs to register — no JNLPs go out, so the game can't start until everyone's ready:

> 🚫 Can't launch **FriendlyBowl** — every coach must register their FUMBBL account first:
> • **Flutethecat** → `/bbbot coach register fumbbl:Flutethecat`
> Re-run the launch once they've registered.

Once all coaches are registered:

> ✅ Launched **FriendlyBowl** → #40k-games:
> • Gondra87 (pinged)
> • Flutethecat (pinged)

### One-click launch (from the FUMBBL40k client itself)

The client's own Play button can skip Discord entirely: it calls
`GET {config-web}/api/fork/jnlp?coach=<name>&teamId=<id>&gameName=<name>&password=<pw>`
and opens the returned JNLP in-process. This is served by **config-web** (default
`http://<fork-host>:4310`, the client's fork controls let a coach override it),
**not** the Discord bot — no registration gate, no channel post, just a direct JNLP
fetch. It's the same `buildForkJnlp` logic as `/bbbot 40k launch` (shared package
`@bb/fork-jnlp`), so both paths produce identical JNLPs. `coach`, `teamId`, and
`gameName` are required (400 otherwise); `password` defaults to `12345`.

---

## End-to-end checklist (one game)

1. **Admin, once:** `/bbbot 40k setchannel channel:#40k-games`
2. **Admin, per coach:** `/bbbot 40k createaccount username:<coach>` (exact team-owner name)
3. **Admin, per team:** `/bbbot 40k copyteam url:<team-url>` → then **restart the FFB game server**
4. **Coach, once (REQUIRED):** `/bbbot coach register fumbbl:<coach>` — launch is blocked until every coach has done this
5. **Admin:** `/bbbot 40k launch game:<name> team:<url> team2:<url>`
6. **Each coach:** download the `.jnlp` → open in the FUMBBL40k client → 2nd join starts the match

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Launch blocked / "must register first" | A coach hasn't run `/bbbot coach register fumbbl:<name>` — registration is required before a game can launch. |
| "created … " but can't join | Coach name must **match the team's `<coach>`** exactly (e.g. `Gondra87`, not `Gondra`). |
| Team not found when joining | Run `copyteam`, then **restart the FFB game server** (loads teams at boot). |
| JNLP won't connect | Set/confirm the **fork IP in the client** (the JNLP has no host by design). |
| "Fork provisioning isn't configured" | `createaccount`/`copyteam` only work when the bot runs **on the fork host** with `FORK_*` env set. `setchannel`/`launch` don't need it. |
| "No FUMBBL40k channel set" | Run `/bbbot 40k setchannel` first. |
| Game won't start | Both coaches must join the **same game name**; the **second** join starts it. |
| `copyteam` warns "no fork roster matches …" | The fork's roster set predates BB2025 — as of 2026-07-08 it's **missing Black Orc, Khorne, Snotling, Gnome, Imperial Nobility, and Old World Alliance** entirely, and uses legacy names for others (e.g. "Underworld" not "Underworld Denizens"). The team copies fine, but the fork server can't load/play it until that roster is imported. Not fixable from the bot side — it's fork roster DATA, not code. |

---

## Build announcements (separate from games)

The bot also announces new FUMBBL40k client builds to testers. It reads the client's
build manifest (`fumbbl40k-client/dist-manifest/latest-build.json`) and posts an embed
with the **"What's new" change log** (author-curated per build, rendered verbatim), the
installer details, and the **installer attached** (auth-free download; the private-repo
release link is a fallback).

- **Set the announce channel** (kept separate from the games channel):
  ```
  /bbbot 40k announcechannel channel:#build-updates
  ```
- **Auto-post:** while the bot is running it polls the manifest every 60s and posts new
  cuts (de-duped on version+gitSha, so no double-posts).
- **Daily 9 AM publish (Pacific):** a Windows Scheduled Task **"FUMBBL40k Daily Build
  Announce"** runs `apps/discord-bot/scripts/daily-announce.cmd` → `pnpm announce` each
  morning, publishing the previous night's build **and** the daily summary if either is
  new. This backstops both pollers for when the bot process isn't running. (Runs only
  while the machine is logged in; log at `apps/discord-bot/data-store/announce.log`.)
- **Manual re-post:** `/bbbot 40k announce` posts the latest build on demand.

> The change log itself is owned by the FUMBBL40k client (it curates `highlights` per
> build); the bot never parses changelogs — it renders whatever the manifest provides.

### Daily work summary

Separately, the bot also auto-publishes the **shared cross-track daily summary**
(`fumbbl40k-client/docs/daily-summary.md` — the single end-of-day file all three
tracks append to). It reads the file's **topmost day** directly and posts it as its
own embed to the announce channel — de-duped on date, so it only posts once per day.

- **Auto-post:** picked up by the same 60s poller as the build manifest, and by the
  **daily 9 AM task** (below) as a backstop.
- **Manual re-post:** `/bbbot 40k daily`.

The build announcement and the daily summary post back-to-back in the same channel
when the 9 AM task runs, so "here's the new build" and "here's what changed today"
land together.

### Pausing announcements

`/bbbot 40k hold [reason]` pauses ALL build/daily-summary posting — the poller, the
manual commands, and the 9 AM task all check it, and **`force` does not bypass a
hold**. Nothing is lost while held: whatever was pending still posts once you run
`/bbbot 40k resume`. Check `data-store/announce-hold.json` (or the top of
`docs/RESUME.md`) to see if a hold is currently active before assuming the pipeline
is broken.

---

## Command reference (`/bbbot 40k`, Manage Server)

| Command | Purpose |
|---|---|
| `setchannel channel:<#ch>` | Set the channel where **game JNLPs** are posted |
| `announcechannel channel:<#ch>` | Set the channel for **build announcements** |
| `createaccount username:<name>` | Create/reset a fork coach (password `12345`) |
| `copyteam url:<fumbbl-team-url>` | Copy a FUMBBL team onto the fork (restart server after) |
| `launch game:<name> team:<url> [team2:<url>] [password:<pw>]` | Post JNLP(s), @-ping each coach |
| `announce` | Re-post the latest FUMBBL40k build announcement |
| `daily` | Re-post today's FUMBBL40k daily work summary |
| `hold [reason:<text>]` | Pause ALL build/daily-summary announcements until `resume` |
| `resume` | Resume announcements |

Plus (any coach): `/bbbot coach register fumbbl:<name>` — link FUMBBL identity (required to launch + for pings).
