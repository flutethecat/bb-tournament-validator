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

/**
 * Attachment size ceiling. The announce guild (TABBL) is Boost tier 2 ⇒ a real 50 MiB upload
 * limit, so 24 MiB was ~26 MiB too conservative and SILENTLY dropped v0.3.1 (25.4 MiB) — the
 * embed posted with no installer. Raised to 45 MiB (headroom under the 50 MiB tier-2 cap for the
 * embed + multipart overhead). NB: if the guild ever drops below tier 2 this must come down.
 * When an installer is EXPECTED but can't be attached, the announce now FAILS LOUD instead of
 * shipping a payload-less post — enforced by `installerFailLoud` below (the 0.3.1 silent-drop
 * that this raised ceiling patched over; a green announce that attaches nothing is now impossible).
 */
const MAX_ATTACH_BYTES = 45 * 1024 * 1024;

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
 * If the manifest CLAIMS an installer is present but it can't actually be attached, return the
 * concrete reason (for the fail-loud guard). Returns undefined when the manifest claims no
 * installer, or when the claimed installer can be attached fine.
 */
function installerAttachBlocker(m: BuildManifest): string | undefined {
  if (!m.installer.present) return undefined; // manifest claims none → nothing to fail on here
  const p = m.installer.absPath;
  if (!p || !existsSync(p)) return `installer not found on this box (${m.installer.file})`;
  try {
    const size = statSync(p).size;
    if (size > MAX_ATTACH_BYTES) {
      return `installer ${fmtBytes(size)} exceeds the ${fmtBytes(MAX_ATTACH_BYTES)} attach ceiling`;
    }
  } catch {
    return `installer unreadable (${m.installer.file})`;
  }
  return undefined;
}

/**
 * FAIL-LOUD guard. Returns a refusal string when this build must NOT be announced because an
 * installer is EXPECTED but won't reach the post — else null (safe to announce). Pure + testable.
 * Two ways an installer is "expected": (a) the manifest says installer.present but it can't be
 * attached (missing/too-big/unreadable — the exact 0.3.1 silent-drop), or (b) it's a `release`
 * channel cut, whose whole purpose is to deliver the installer, yet the manifest reports none.
 * A `test`/`rc` build with a legitimately-absent installer is still allowed (embed flags ⚠ missing).
 */
export function installerFailLoud(m: BuildManifest): string | null {
  const blocker = installerAttachBlocker(m);
  if (blocker) {
    return `⛔ REFUSED (fail-loud): v${m.version} (${m.channel}) would announce with NO installer — ${blocker}. Nothing posted, de-dupe untouched. Fix the installer/manifest and re-emit.`;
  }
  if (m.channel === "release" && !m.installer.present) {
    return `⛔ REFUSED (fail-loud): a release announce must ship its installer, but the manifest reports installer.present=false (${m.installer.file}). Nothing posted, de-dupe untouched.`;
  }
  return null;
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
    return `⛔ REFUSED: manifest/installer looks unpublishable (\`${devMarker}\`) — the release must be the BARE \`FUMBBL40k_x.y.z\` (no letter, no \`o66\`, no "Super FUMBBL") built from a gate-passed tag. This often means the manifest points at a stale dev/o66 installer in the nsis dir. Rebuild the bare release, confirm the manifest installer file, then re-emit. Not announced, de-dupe untouched.`;
  // FAIL LOUD before any post: an expected-but-unattachable installer must never ship a ✅ embed
  // with no download (the 0.3.1 silent drop). Refuses regardless of `force`; de-dupe untouched.
  const failLoud = installerFailLoud(m);
  if (failLoud) return failLoud;
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
