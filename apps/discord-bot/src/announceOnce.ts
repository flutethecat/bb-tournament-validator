/**
 * One-shot announcer for the daily scheduled publish (9:00 AM Pacific).
 * Logs in, posts (1) the latest FUMBBL40k build (change log + attached installer) and
 * (2) the shared daily-summary.md's top day's entry — each only if not already
 * announced — then exits. Runs on the fork host (needs .env DISCORD_TOKEN + the local
 * manifest/installer/daily-summary file). `--force` re-posts both even if already
 * announced. Shares de-dupe state with the running bot's pollers, so this is a safe
 * backstop whether or not the bot process is currently up.
 *
 *   pnpm --filter discord-bot announce            # publish latest if new
 *   pnpm --filter discord-bot announce -- --force # force re-post
 */

import "dotenv/config";
import { join, resolve } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { Fork40kStore } from "./store/fork40kStore";
import { AnnounceState } from "./buildAnnounce";
import { DailySummaryState } from "./dailySummary";
import { announceLatestBuild, announceLatestDailySummary } from "./announcePost";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[announceOnce] DISCORD_TOKEN is required (see apps/discord-bot/.env).");
  process.exit(1);
}
const DATA_DIR = resolve(process.env.DATA_DIR || "./data-store");
const fork40k = new Fork40kStore(join(DATA_DIR, "fork40k.json"));
const announceState = new AnnounceState(join(DATA_DIR, "build-announce.json"));
const dailySummaryState = new DailySummaryState(join(DATA_DIR, "daily-summary-announce.json"));
const force = process.argv.includes("--force");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  try {
    const channelId = fork40k.getAnnounceChannel();
    const buildMsg = await announceLatestBuild(client, channelId, announceState, force);
    console.log(`[announceOnce ${new Date().toISOString()}] ${buildMsg}`);
    const dailyMsg = await announceLatestDailySummary(client, channelId, dailySummaryState, force);
    console.log(`[announceOnce ${new Date().toISOString()}] ${dailyMsg}`);
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
