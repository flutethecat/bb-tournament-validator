/**
 * One-shot build announcer for the daily scheduled publish (9:00 AM Pacific).
 * Logs in, posts the latest FUMBBL40k build (change log + attached installer) to the
 * announce channel if it hasn't been announced yet, then exits. Runs on the fork host
 * (needs .env DISCORD_TOKEN + the local manifest/installer). `--force` re-posts even
 * if already announced. Shares the de-dupe state with the running bot's poller.
 *
 *   pnpm --filter discord-bot announce            # publish latest if new
 *   pnpm --filter discord-bot announce -- --force # force re-post
 */

import "dotenv/config";
import { join, resolve } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { Fork40kStore } from "./store/fork40kStore";
import { AnnounceState } from "./buildAnnounce";
import { announceLatestBuild } from "./announcePost";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[announceOnce] DISCORD_TOKEN is required (see apps/discord-bot/.env).");
  process.exit(1);
}
const DATA_DIR = resolve(process.env.DATA_DIR || "./data-store");
const fork40k = new Fork40kStore(join(DATA_DIR, "fork40k.json"));
const announceState = new AnnounceState(join(DATA_DIR, "build-announce.json"));
const force = process.argv.includes("--force");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  try {
    const msg = await announceLatestBuild(client, fork40k.getAnnounceChannel(), announceState, force);
    console.log(`[announceOnce ${new Date().toISOString()}] ${msg}`);
  } catch (e) {
    console.error("[announceOnce] failed:", e);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.login(token).catch((e) => {
  console.error("[announceOnce] login failed:", e);
  process.exit(1);
});
