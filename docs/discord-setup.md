# Discord bot setup (one-time, ~5 minutes)

Everything code-side is built; this is the Discord-portal work only you can do (it ties the bot to
your Discord account).

## 1. Create the application

1. Go to https://discord.com/developers/applications → **New Application** → name it
   (e.g. `BB Tournament Validator`) → Create.
2. On **General Information**, copy the **Application ID** → this is `DISCORD_CLIENT_ID`.

## 2. Get the bot token

1. Left sidebar → **Bot**.
2. Click **Reset Token** → copy the token → this is `DISCORD_TOKEN`.
   ⚠ Shown once — if you lose it, reset again. Never commit it; it lives only in `.env`
   (already gitignored).
3. On the same page, under **Privileged Gateway Intents**: turn **Message Content Intent ON**
   (required for watched-channel ingestion — attachments on ordinary messages are hidden from
   bots without it). Leave Presence and Server Members OFF. Free below 100 servers; the bot
   fails login with "Used disallowed intents" if this toggle is off.

## 3. Invite the bot to your server

Build the invite URL (replace `YOUR_APP_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=116800
```

`116800` = Send Messages + Embed Links + Attach Files + Add Reactions + Read Message History —
exactly what /bbbot validate (embed + ✅ reaction), /bbbot report (CSV attachment) need. Open the URL, pick your
server, Authorize. (You need **Manage Server** on that server.)

## 4. Get the server id (GUILD_ID)

1. Discord app → User Settings → **Advanced** → enable **Developer Mode**.
2. Right-click your server icon → **Copy Server ID** → this is `GUILD_ID`.

With `GUILD_ID` set, slash commands register **instantly** in that server. Without it they register
globally, which Discord takes up to an hour to propagate — always use `GUILD_ID` while testing.

## 5. Configure and run

```
cd C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\discord-bot
copy .env.example .env
notepad .env          ← paste DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID
pnpm register         ← "Registered 1 commands in guild …"
pnpm start            ← "Logged in as BB Tournament Validator#1234 …"
```

Leave `DATA_DIR`/`PACKAGES_DIR` empty — defaults are `apps\discord-bot\data-store\` and the repo's
`tournament-packages\` folder. The bot process must stay running (it's a normal console app; later
it can become a service or run beside the fork server per decision D3).

All commands are namespaced under **/bbbot** so they can never conflict with another bot.

## 5b. Watched channels — the primary ingestion path

A TO (Manage Server permission) binds a submission channel to a package once:

```
/bbbot watch channel:#roster-submissions package:Lustrian Superleague (Example)
```

From then on **every PDF posted in that channel is validated automatically** — no command needed:
- legal roster → **✅ reaction on the coach's post**, DM confirmation, row in the validated CSV
  (the /bbbot report link points at the coach's own post);
- illegal roster → **❌ reaction**, full errors + suggestions **by DM** (if the coach's DMs are
  closed, the bot posts a one-line mention in-channel so nothing fails silently);
- unreadable PDF → ❌ + DM explaining it isn't a recognized roster export.

`/bbbot unwatch channel:<#ch>` stops it; `/bbbot watches` lists the bindings.
`/bbbot validate` remains available for one-off checks in unwatched channels.

> **Private-channel gotcha (learned the hard way):** even with **Administrator**, the bot may not
> see a **private** channel until it's explicitly added to it. Administrator overrides *permissions*
> but Discord still won't deliver messages from a private channel the bot isn't a member of. Fix:
> open the channel → **Edit Channel → Permissions/Members → add the bot** (or a role it has). Public
> channels work with no extra step. If `/bbbot watch` succeeds but nothing happens when a PDF is
> posted, this is almost always the cause.

## 6. Smoke test (the live-guild E2E from the plan)

In any channel of the server:

1. `/bbbot packages` → should list **BB2025 Default** and **Lustrian Superleague (Example)**.
2. `/bbbot validate` → attach `fixtures\pdfs\Example PDF 1.pdf` → package: start typing "Lus…" and pick
   the autocomplete → expect the **green embed** "✅ TEAM NAME — legal for Lustrian Superleague
   (Example)" showing **10 / 10 SP (6 primary, 0 secondary)**, a **✅ reaction** on the reply, and a
   **DM** from the bot.
3. `/bbbot report` → your entry with a clickable **[roster post]** link; add `csv:true` for the file.
4. Failure path: `/bbbot package import` a text file containing `Skill point budget: 8` +
   `Name: Strict Test` + `Eligible rosters: Amazon`, then `/bbbot validate` the same PDF against
   **Strict Test** → expect the red embed with "Team spends 10 Skill Points; the budget is 8
   (2 over)" and the suggestion line.
5. `/bbbot coach register fumbbl:<name> naf:<number>` then `/bbbot coach me` → your identity entry + the team
   registered by step 2.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Slash commands don't appear | `GUILD_ID` empty (global registration = up to 1h) or `pnpm register` not run; re-run and restart the Discord client (Ctrl+R). |
| "Used disallowed intents" on start | You toggled a privileged intent in the portal but the code doesn't request it — turn them all off (step 2.3). |
| Bot shows offline | Wrong/reset `DISCORD_TOKEN` in `.env`, or `pnpm start` not running. |
| No DM after a valid roster | Your privacy settings block server-member DMs — the validation itself still succeeds and is recorded; the DM is best-effort by design. |
| "Unknown package" on /bbbot validate | Name must match a package in `tournament-packages\` — use the autocomplete rather than typing freehand. |
| ✅ reaction missing | Bot lacks **Add Reactions** in that channel (check channel-level permission overrides). |
| Watched channel does nothing on upload | The channel is **private** and the bot isn't a member — add the bot to it (Administrator does NOT bypass this for private channels). |

## What the bot stores (all local, gitignored)

- `data-store\validated-rosters.csv` — one row per validated coach+package (latest wins),
  incl. the Discord message link `/bbbot report` renders.
- `data-store\coaches.json` — the coach identity library (D4).
- `tournament-packages\*.json` — packages; `/bbbot package import` writes new ones here.
