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
3. On the same page, under **Privileged Gateway Intents**: leave all three OFF.
   The bot only uses slash commands + the `Guilds` intent, which is not privileged —
   no Message Content, no Presence, no Server Members needed.

## 3. Invite the bot to your server

Build the invite URL (replace `YOUR_APP_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=116800
```

`116800` = Send Messages + Embed Links + Attach Files + Add Reactions + Read Message History —
exactly what /validate (embed + ✅ reaction), /report (CSV attachment) need. Open the URL, pick your
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
pnpm register         ← "Registered 5 commands in guild …"
pnpm start            ← "Logged in as BB Tournament Validator#1234 …"
```

Leave `DATA_DIR`/`PACKAGES_DIR` empty — defaults are `apps\discord-bot\data-store\` and the repo's
`tournament-packages\` folder. The bot process must stay running (it's a normal console app; later
it can become a service or run beside the fork server per decision D3).

## 6. Smoke test (the live-guild E2E from the plan)

In any channel of the server:

1. `/packages` → should list **BB2025 Default** and **Lustrian Superleague (Example)**.
2. `/validate` → attach `fixtures\pdfs\Example PDF 1.pdf` → package: start typing "Lus…" and pick
   the autocomplete → expect the **green embed** "✅ TEAM NAME — legal for Lustrian Superleague
   (Example)" showing **10 / 10 SP (6 primary, 0 secondary)**, a **✅ reaction** on the reply, and a
   **DM** from the bot.
3. `/report` → your entry with a clickable **[roster post]** link; add `csv:true` for the file.
4. Failure path: `/package import` a text file containing `Skill point budget: 8` +
   `Name: Strict Test` + `Eligible rosters: Amazon`, then `/validate` the same PDF against
   **Strict Test** → expect the red embed with "Team spends 10 Skill Points; the budget is 8
   (2 over)" and the suggestion line.
5. `/coach register fumbbl:<name> naf:<number>` then `/coach me` → your identity entry + the team
   registered by step 2.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Slash commands don't appear | `GUILD_ID` empty (global registration = up to 1h) or `pnpm register` not run; re-run and restart the Discord client (Ctrl+R). |
| "Used disallowed intents" on start | You toggled a privileged intent in the portal but the code doesn't request it — turn them all off (step 2.3). |
| Bot shows offline | Wrong/reset `DISCORD_TOKEN` in `.env`, or `pnpm start` not running. |
| No DM after a valid roster | Your privacy settings block server-member DMs — the validation itself still succeeds and is recorded; the DM is best-effort by design. |
| "Unknown package" on /validate | Name must match a package in `tournament-packages\` — use the autocomplete rather than typing freehand. |
| ✅ reaction missing | Bot lacks **Add Reactions** in that channel (check channel-level permission overrides). |

## What the bot stores (all local, gitignored)

- `data-store\validated-rosters.csv` — one row per validated coach+package (latest wins),
  incl. the Discord message link `/report` renders.
- `data-store\coaches.json` — the coach identity library (D4).
- `tournament-packages\*.json` — packages; `/package import` writes new ones here.
