# FUMBBL40k Fork — How to Register & Launch Games

A practical guide to getting a coach onto the **FUMBBL40k test fork** and launching a
game, driven from Discord with the **Blood Bowl Tournament Bot** (`/bbbot 40k …`).

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

### 1. Link your FUMBBL name to Discord (do this once)

So the bot can **@-ping you** when your game JNLP is ready:

```
/bbbot coach register fumbbl:<your-FUMBBL-coach-name>
```

Use your **exact** FUMBBL coach name (the one that owns your team — e.g. `Gondra87`,
not `Gondra`). Without this, your JNLP still gets posted, but with your name as plain
text and no ping.

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

Each coach gets a post with their `.jnlp` and an @mention (if they've registered). Your
**ephemeral reply** confirms delivery and flags anyone unlinked, e.g.:

> ✅ Launched **FriendlyBowl** → #40k-games:
> • Gondra87 (pinged)
> • Flutethecat (no Discord link — set with /bbbot coach register)

---

## End-to-end checklist (one game)

1. **Admin, once:** `/bbbot 40k setchannel channel:#40k-games`
2. **Admin, per coach:** `/bbbot 40k createaccount username:<coach>` (exact team-owner name)
3. **Admin, per team:** `/bbbot 40k copyteam url:<team-url>` → then **restart the FFB game server**
4. **Coach, once:** `/bbbot coach register fumbbl:<coach>` (for the @ping)
5. **Admin:** `/bbbot 40k launch game:<name> team:<url> team2:<url>`
6. **Each coach:** download the `.jnlp` → open in the FUMBBL40k client → 2nd join starts the match

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Coach isn't pinged (plain name) | They haven't run `/bbbot coach register fumbbl:<name>`. |
| "created … " but can't join | Coach name must **match the team's `<coach>`** exactly (e.g. `Gondra87`, not `Gondra`). |
| Team not found when joining | Run `copyteam`, then **restart the FFB game server** (loads teams at boot). |
| JNLP won't connect | Set/confirm the **fork IP in the client** (the JNLP has no host by design). |
| "Fork provisioning isn't configured" | `createaccount`/`copyteam` only work when the bot runs **on the fork host** with `FORK_*` env set. `setchannel`/`launch` don't need it. |
| "No FUMBBL40k channel set" | Run `/bbbot 40k setchannel` first. |
| Game won't start | Both coaches must join the **same game name**; the **second** join starts it. |

---

## Command reference (`/bbbot 40k`, Manage Server)

| Command | Purpose |
|---|---|
| `setchannel channel:<#ch>` | Set the channel where JNLPs are posted |
| `createaccount username:<name>` | Create/reset a fork coach (password `12345`) |
| `copyteam url:<fumbbl-team-url>` | Copy a FUMBBL team onto the fork (restart server after) |
| `launch game:<name> team:<url> [team2:<url>] [password:<pw>]` | Post JNLP(s), @-ping each coach |

Plus (any coach): `/bbbot coach register fumbbl:<name>` — link FUMBBL identity for pings.
