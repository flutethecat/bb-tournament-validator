/**
 * Discord side of the FUMBBL40k build announcer: render the embed, attach the
 * installer, and post to a channel. Shared by the running bot (poller + /bbbot 40k
 * announce) and the one-shot announceOnce.ts (scheduled daily publish) so both
 * produce identical announcements.
 */

import { existsSync, statSync } from "node:fs";
import { AttachmentBuilder, type Client, EmbedBuilder } from "discord.js";
import { type AnnounceState, type BuildManifest, devBuildMarker, fmtBytes, readManifest } from "./buildAnnounce";
import { type DailySummary, type DailySummaryState, readTopDailySummary } from "./dailySummary";
import type { AnnounceHold } from "./announceHold";

/** Held message, shared by both announce functions. `force` does NOT bypass a hold. */
function heldMessage(hold: AnnounceHold): string | undefined {
  if (!hold.isHeld()) return undefined;
  const s = hold.status();
  return `⏸ Announcements are HELD${s.reason ? ` (${s.reason})` : ""} — pending go-ahead. Nothing posted; run \`/bbbot 40k resume\` to lift it.`;
}

const BUILD_COLOR: Record<string, number> = { test: 0xe0a020, rc: 0x3a7bd5, release: 0x22e05a };

/**
 * The "FUMBBL40k Tester" role, pinged at the head of EVERY BUILD announcement (not the daily
 * summary) — a build announce must always ping the testers (owner/Yularen directive). The id
 * is overridable via `FORK_TESTER_ROLE_ID` (e.g. a different guild), but an empty/unset value
 * falls back to the default rather than silently disabling the ping — that `||` (not `??`) is
 * deliberate, so a blank env var can't drop the ping the way it did on 2026-07-09. The role is
 * non-mentionable, but the bot (Administrator) pings it via an explicit allowedMentions.roles.
 */
const TESTER_ROLE_ID = process.env.FORK_TESTER_ROLE_ID || "1522793395750310028";

/** Discord non-Nitro upload limit (25 MiB), with headroom for the embed. */
const MAX_ATTACH_BYTES = 24 * 1024 * 1024;

export function renderBuildEmbed(m: BuildManifest): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(`FUMBBL40k v${m.version} (${m.channel.toUpperCase()})`)
    .setColor(BUILD_COLOR[m.channel] ?? 0x8a4ab0)
    .setDescription(
      (m.highlights.length
        ? `**What's new**\n${m.highlights.map((h) => `• ${h}`).join("\n")}`
        : "_(no change-log highlights in this build)_"
      ).slice(0, 4000),
    )
    .addFields(
      {
        name: "Installer",
        value: `${m.installer.file}${m.installer.present ? "" : " ⚠ missing"}\n${fmtBytes(m.installer.bytes)}`,
        inline: true,
      },
      { name: "SHA-256", value: `\`${m.installer.sha256.slice(0, 16)}…\``, inline: true },
      { name: "Build", value: `commit \`${m.gitSha}\` · ${m.date}`, inline: true },
    );
  if (m.downloadUrl) {
    e.setURL(m.downloadUrl);
    e.addFields({ name: "Download", value: `📥 [${m.installer.file}](${m.downloadUrl})` });
  }
  if (m.notes) e.setFooter({ text: m.notes.slice(0, 2048) });
  return e;
}

/** The installer as a Discord attachment when it's on this box and small enough. */
export function installerAttachment(m: BuildManifest): AttachmentBuilder | undefined {
  const p = m.installer.absPath;
  if (!m.installer.present || !p || !existsSync(p)) return undefined;
  try {
    if (statSync(p).size > MAX_ATTACH_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return new AttachmentBuilder(p, { name: m.installer.file });
}

/**
 * Post the current manifest to `channelId`. `force` bypasses the version+gitSha
 * de-dupe. Returns a human status string (no throw on the expected no-op cases).
 */
export async function announceLatestBuild(
  client: Client,
  channelId: string | undefined,
  state: AnnounceState,
  force: boolean,
  hold: AnnounceHold,
): Promise<string> {
  const held = heldMessage(hold);
  if (held) return held;
  const m = readManifest();
  if (!m) return "No readable build manifest found.";
  if (!channelId) return "No announce channel set — run `/bbbot 40k announcechannel`.";
  // DEV-BUILD TRIPWIRE: refuse to announce a lettered dev cut, even with --force (a dev
  // build must NEVER be published). Does NOT mark de-dupe, so a proper BARE rebuild still
  // announces afterward. (owner "check if we're deploying dev fixes"; see buildAnnounce.)
  const devMarker = devBuildMarker(m);
  if (devMarker)
    return `⛔ REFUSED: manifest looks like a DEV build (\`${devMarker}\`) — the published release must be the BARE version (e.g. 0.2.8, no letter). Rebuild from the gate-passed tag with a plain \`pnpm build\` (no dev-cut env), then re-emit. Not announced, de-dupe untouched.`;
  if (!force && !state.isNew(m)) return `v${m.version} (${m.gitSha}) is already announced.`;
  const ch = await client.channels.fetch(channelId);
  if (!ch?.isTextBased()) return `<#${channelId}> is not a text channel.`;
  const attachment = installerAttachment(m);
  const testerPing = TESTER_ROLE_ID
    ? { content: `<@&${TESTER_ROLE_ID}> — new FUMBBL40k build`, allowedMentions: { roles: [TESTER_ROLE_ID] } }
    : {};
  await (ch as unknown as { send: (o: unknown) => Promise<unknown> }).send({
    ...testerPing,
    embeds: [renderBuildEmbed(m)],
    ...(attachment ? { files: [attachment] } : {}),
  });
  state.mark(m);
  return `✅ Announced FUMBBL40k v${m.version} (${m.channel}) → <#${channelId}>${attachment ? " (installer attached)" : ""}.`;
}

export function renderDailySummaryEmbed(d: DailySummary): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`FUMBBL40k — ${d.date} daily summary`)
    .setColor(0x8a4ab0)
    .setDescription(d.body.slice(0, 4000));
}

/**
 * Post the top day's summary from the shared daily-summary.md to `channelId`.
 * `force` bypasses the date de-dupe. Read directly from the file (not a cross-session
 * message) so publishing doesn't depend on the compiling session surviving to send it.
 */
export async function announceLatestDailySummary(
  client: Client,
  channelId: string | undefined,
  state: DailySummaryState,
  force: boolean,
  hold: AnnounceHold,
): Promise<string> {
  const held = heldMessage(hold);
  if (held) return held;
  const d = readTopDailySummary();
  if (!d) return "No readable daily summary found.";
  if (!channelId) return "No announce channel set — run `/bbbot 40k announcechannel`.";
  if (!force && !state.isNew(d)) return `${d.date} daily summary is already announced.`;
  const ch = await client.channels.fetch(channelId);
  if (!ch?.isTextBased()) return `<#${channelId}> is not a text channel.`;
  await (ch as unknown as { send: (o: unknown) => Promise<unknown> }).send({ embeds: [renderDailySummaryEmbed(d)] });
  state.mark(d);
  return `✅ Announced the ${d.date} daily summary → <#${channelId}>.`;
}
