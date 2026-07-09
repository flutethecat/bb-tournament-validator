# FUMBBL40k — How to Set Up a Game (Tester Guide)

A step-by-step for setting up and starting a game in the FUMBBL40k client using **Create Game**
(pick a team, challenge an opponent by name, and the match starts when they challenge you back).

---

## Before you start

- **You need the right build.** Create Game / Register / team ingest only work in a build that includes
  the fork-API fix — **v0.2.0 or later**. (The earlier v0.1.14 installer blocks these calls inside the app;
  they'll fail with an error.)
- **You need a name.** Use your real **FUMBBL coach name** so opponents recognise you.
- **The Tournament Bot must be reachable.** Register and Create Game talk to a small server ("config-web")
  that runs alongside the fork. If it's offline or unreachable, those features won't work (plain spectating
  still does). See **Troubleshooting** if you hit "config-web unreachable".

---

## 1. Point the client at the FUMBBL40k fork

1. Open the **Game Browser** (the games/browse screen).
2. In the toolbar, click the **`FUMBBL40k`** button (the server toggle: `FUMBBL | FUMBBL40k`). The fork
   fields only appear when FUMBBL40k is selected.
3. Confirm the **fork IP** field is set to the fork's address:
   - **Remote testers:** use the fork's public IP (the one the organiser gives you).
   - **Running the fork on your own machine:** set it to `127.0.0.1` and click **Set IP**.
4. *(Optional)* If the organiser gives you a separate **Tournament Bot URL**, put it in the
   **`bot URL (optional)`** box. Leave it blank to use `http://<fork IP>:4310` automatically.

---

## 2. Register your fork account (first time only)

You don't need a FUMBBL login to play on the fork — you register a coach directly.

1. Open **Settings → Connection → FUMBBL40k → Register**.
2. Enter:
   - **Coach name** — your real FUMBBL name (so opponents recognise you).
   - **Password** — pick your own; it does **not** have to match your FUMBBL password (and shouldn't).
3. Submit. On success you'll see a confirmation and your credentials are filled in automatically.

You only do this once. After that the client remembers you.

---

## 3. Add a team to your library

Your **library** is the set of teams you can play with on the fork. You add teams by importing ("ingesting")
them from FUMBBL.

1. Open **Create Game** (Play mode → **Create Game**).
2. Under **Your Team → Your Library**, click into the **Ingest Team** box.
3. Paste a **FUMBBL team id** (e.g. `1263233`) or a **team URL** (e.g. `https://fumbbl.com/t/1263233`).
4. Click **Ingest Team**. The team appears in your library showing **name · race · team value · gold**.
   - ⚠ **A newly ingested team is only playable after the next fork restart.** If you just ingested a team
     and can't join with it yet, that's why — the organiser needs to restart the fork (or wait for the next
     scheduled restart). Already-loaded teams are fine immediately.
   - A ⚠ marker on a team means the fork doesn't have a matching roster for that race loaded yet — tell the
     organiser if you want to play it.

Repeat for as many teams as you like; they stay in your library.

---

## 4. Create a game and challenge an opponent

1. Open **Create Game** (Play mode → **Create Game**).
2. **Opponent** — start typing your opponent's coach name; pick them from the autocomplete list.
3. **Your Team** — click **Choose team** and select one of your library teams.
4. Click **Create Game**. You'll drop into a **"Waiting for &lt;opponent&gt;…"** state (with a **Cancel**
   button if you change your mind).

---

## 5. How the match starts

The game is **mutual** — it starts when **both** of you challenge **each other**:

- You challenge your opponent (Step 4).
- Your opponent does the same, naming **you** as their opponent.
- As soon as both challenges match, **the game launches automatically for both players** — you'll join the
  same match and go straight into pre-game.

So coordinate with your opponent (Discord, etc.): agree who you're playing, then both hit Create Game
naming each other. Order doesn't matter — whoever's second triggers the start.

---

## Troubleshooting

| Symptom | What it means / fix |
|---|---|
| **"config-web unreachable"** (or an ingest/register error) | The Tournament Bot server isn't reachable at the address the client is using. If you're on the same machine as the fork, set the **fork IP** to `127.0.0.1`. Otherwise, tell the organiser — the Bot may be offline or not exposed to your network. |
| **Ingest works but you can't join with the team** | A freshly ingested team needs a **fork restart** before it's joinable. Ask the organiser to restart the fork. |
| **"Set your FUMBBL40k coach name first"** | You haven't registered / set your coach yet — do **Step 2** (Settings → Connection → Register). |
| **Stuck on "Waiting for &lt;opponent&gt;"** | The match only starts once your opponent challenges **you** back by name. Confirm they've entered your exact coach name and hit Create Game. |
| **Nothing happens / features missing** | Make sure you're on a **v0.2.0+** build. Earlier builds can't reach the Bot. |

---

*Notes for maintainers: this guide targets the fork-API-working client build (v0.2.0+). The v0.2.0 UI
restructure may move some controls — reconcile the exact labels/locations against the shipped v0.2.0 UI
before wide distribution. Remote testers require config-web to be reachable at the fork's address
(`HOST=0.0.0.0` + port 4310 forwarded); it is loopback-only by default.*
