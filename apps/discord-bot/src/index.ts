/**
 * BB Tournament Validator bot (v1 = M3): validate bbtc.pl roster PDFs against
 * TO packages. On a valid roster: ✅ reaction, DM to the coach, row in the
 * validated-roster CSV; /report links every validated coach to their post.
 *
 * T1 note: these handlers become thin adapters over the tournament service API
 * later (/validate → POST /entrants, /report → GET /standings).
 */

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type Message,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";
import { ingestPackageDocument } from "@bb/ingest";
import { renderArtPrompt, renderPackageHtml, type Roster, type ValidationResult } from "@bb/validator";
import { handleGrognardMention } from "./askGrognard";
import { PackageStore } from "./packageStore";
import { renderProblemsEmbed, renderResultEmbed, validateFumbblTeam, validateRosterBytes, type EmbedData } from "./pipeline";
import { CsvValidatedStore, type ValidatedEntry } from "./store/validatedStore";
import { FileCoachRegistry, KeyConflictError, type CoachKey, type CoachTeamRegistration } from "./store/coachRegistry";
import { PendingResubmissionStore } from "./store/pendingResubmissions";
import { WatchStore } from "./store/watchStore";
import { PendingChannelResolutionStore } from "./store/pendingChannelResolutions";
import { resolveChannelPackage, tournamentDateStatus } from "./channelTournament";
import { Fork40kStore } from "./store/fork40kStore";
import { adminListLive, buildForkJnlp, copyForkTeam, createForkAccount, fetchForkTeam, forkAdminConfigFromEnv, forkConfigFromEnv, jnlpFilename } from "./fork40k";
import { AnnounceState, manifestReleaseTag, readManifest } from "./buildAnnounce";
import { DailySummaryState, readTopDailySummary } from "./dailySummary";
import { announceLatestBuild, announceLatestDailySummary } from "./announcePost";
import { AnnounceHold } from "./announceHold";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN is required (see .env.example).");
  process.exit(1);
}
const DATA_DIR = resolve(process.env.DATA_DIR || "./data-store");
const PACKAGES_DIR = resolve(process.env.PACKAGES_DIR || "../../tournament-packages");
mkdirSync(DATA_DIR, { recursive: true });

const packages = new PackageStore(PACKAGES_DIR);
const validated = new CsvValidatedStore(join(DATA_DIR, "validated-rosters.csv"));
const coaches = new FileCoachRegistry(join(DATA_DIR, "coaches.json"));
const watches = new WatchStore(join(DATA_DIR, "watches.json"));
const fork40k = new Fork40kStore(join(DATA_DIR, "fork40k.json"));
const announceState = new AnnounceState(join(DATA_DIR, "build-announce.json"));
const dailySummaryState = new DailySummaryState(join(DATA_DIR, "daily-summary-announce.json"));
const announceHold = new AnnounceHold(join(DATA_DIR, "announce-hold.json"));
const pendingResubs = new PendingResubmissionStore();
const pendingChannelResos = new PendingChannelResolutionStore();

/** Persist an entrant record: validated-roster row + coach-registry team. */
async function commitEntry(entry: ValidatedEntry, team: CoachTeamRegistration): Promise<void> {
  await validated.upsert(entry);
  try {
    const coach = await coaches.upsert({ discordUserId: entry.discordUserId });
    await coaches.addTeam(coach.id, team);
  } catch {
    /* registry is best-effort during validation */
  }
}

/**
 * Shared success side effects. On a coach's FIRST submission for a package we
 * record immediately (and DM the legal confirmation). On a RESUBMISSION we DM a
 * "replace your earlier entry?" prompt with buttons and hold the new entry
 * pending — nothing is overwritten until they confirm (handleResubButton).
 * If the coach's DMs are closed we can't ask, so we fall back to the historical
 * latest-wins behaviour and log it.
 */
async function recordValidRoster(
  user: User,
  roster: Roster,
  result: ValidationResult,
  packageName: string,
  messageLink: string,
  sourceName: string,
): Promise<void> {
  const teamName = roster.teamName || sourceName;
  const legalLine = `✅ Your roster **${teamName}** (${roster.rosterName}) is legal for **${packageName}** — ${result.recomputedSummary.skillPointsUsed}/${result.recomputedSummary.skillPointBudget} SP.`;
  const newEntry: ValidatedEntry = {
    discordUserId: user.id,
    coachName: roster.coach || user.username,
    teamName,
    rosterRace: roster.rosterName,
    packageName,
    messageLink,
    validatedAt: new Date().toISOString(),
  };
  const registryTeam: CoachTeamRegistration = {
    tournament: packageName,
    teamName,
    rosterRace: roster.rosterName,
    sourceRef: messageLink,
    registeredAt: newEntry.validatedAt,
  };

  const previous = await validated.find(user.id, packageName);
  if (!previous) {
    await user.send(legalLine).catch(() => void 0);
    await commitEntry(newEntry, registryTeam);
    return;
  }

  // Resubmission: ask before overwriting the earlier entry.
  const pending = pendingResubs.create({
    discordUserId: user.id,
    packageName,
    newEntry,
    registryTeam,
    previous: {
      teamName: previous.teamName,
      messageLink: previous.messageLink,
      validatedAt: previous.validatedAt,
    },
  });
  const when = Number.isNaN(Date.parse(previous.validatedAt))
    ? "earlier"
    : `<t:${Math.floor(Date.parse(previous.validatedAt) / 1000)}:R>`;
  const prevRef = previous.messageLink ? ` ([roster post](${previous.messageLink}))` : "";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`resub:yes:${pending.token}`).setLabel("Replace it").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`resub:no:${pending.token}`).setLabel("Keep original").setStyle(ButtonStyle.Secondary),
  );
  const sent = await user
    .send({
      content:
        `${legalLine}\n\n` +
        `⚠️ You already submitted **${previous.teamName}** for **${packageName}** (${when})${prevRef}.\n` +
        `Do you want to **replace** it with **${teamName}**? Your earlier entry will be deleted.`,
      components: [row],
    })
    .then(() => true)
    .catch(() => false);
  if (!sent) {
    // DMs closed — can't obtain consent; preserve latest-wins so the newest legal roster is on record.
    pendingResubs.take(pending.token);
    await commitEntry(newEntry, registryTeam);
    console.log(
      `Resubmission for ${user.id} / ${packageName}: DMs closed, auto-replaced without confirmation.`,
    );
  }
}

/** Coach clicked Replace / Keep on the resubmission DM prompt. */
async function handleResubButton(i: ButtonInteraction): Promise<void> {
  const [ns, action, token] = i.customId.split(":");
  if (ns !== "resub" || !token) return;
  const pending = pendingResubs.take(token);
  if (!pending) {
    await i.update({ content: "This request has expired or was already handled.", components: [] }).catch(() => void 0);
    return;
  }
  if (pending.discordUserId !== i.user.id) {
    await i.reply({ content: "This confirmation isn't yours.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return;
  }
  if (action === "yes") {
    await commitEntry(pending.newEntry, pending.registryTeam);
    await i
      .update({
        content: `✅ Replaced **${pending.previous.teamName}** with **${pending.newEntry.teamName}** for **${pending.packageName}**. Your earlier entry has been deleted.`,
        components: [],
      })
      .catch(() => void 0);
  } else {
    await i
      .update({
        content: `↩️ Kept your original **${pending.previous.teamName}** for **${pending.packageName}**. The new submission was discarded — nothing changed.`,
        components: [],
      })
      .catch(() => void 0);
  }
}

const toEmbed = (d: EmbedData): EmbedBuilder => {
  const e = new EmbedBuilder().setTitle(d.title).setColor(d.color);
  if (d.description) e.setDescription(d.description);
  if (d.fields.length) e.addFields(d.fields);
  return e;
};

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Attachment download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---- /validate (PDF upload OR FUMBBL team id) ----
async function handleValidate(i: ChatInputCommandInteraction): Promise<void> {
  const attachment = i.options.getAttachment("roster");
  const fumbblTeam = i.options.getInteger("fumbbl-team");
  const packageName = i.options.getString("package", true);

  if (!attachment && fumbblTeam == null) {
    await i.reply({ content: "Provide a roster PDF **or** a fumbbl-team id.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (attachment && fumbblTeam != null) {
    await i.reply({ content: "Provide just one of roster PDF or fumbbl-team, not both.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply();

  const found = packages.get(packageName);
  if (!found) {
    await i.editReply(`Unknown package "${packageName}". Try /packages.`);
    return;
  }
  const notes: string[] = [...found.problems];
  const sourceName = attachment ? attachment.name : `FUMBBL team ${fumbblTeam}`;

  let outcome;
  try {
    if (attachment) {
      const bytes = await download(attachment.url);
      outcome = await validateRosterBytes(bytes, attachment.name, found.pkg);
    } else {
      outcome = await validateFumbblTeam(String(fumbblTeam), found.pkg);
    }
  } catch (e) {
    await i.editReply(`Could not process the roster: ${(e as Error).message}`);
    return;
  }

  if (!outcome.ok || !outcome.result || !outcome.roster) {
    await i.editReply({ embeds: [toEmbed(renderProblemsEmbed(outcome.problems, sourceName))] });
    return;
  }
  notes.push(...outcome.problems);

  const { result, roster } = outcome;
  const embed = toEmbed(renderResultEmbed(result, roster.teamName || sourceName, found.pkg.name));
  if (notes.length) embed.setFooter({ text: notes.slice(0, 3).join(" | ").slice(0, 2048) });
  const reply = await i.editReply({ embeds: [embed] });

  if (result.valid) {
    await reply.react("✅").catch(() => void 0);
    const messageLink = i.guildId
      ? `https://discord.com/channels/${i.guildId}/${reply.channelId}/${reply.id}`
      : "";
    await recordValidRoster(i.user, roster, result, found.pkg.name, messageLink, sourceName);
  }
}

// ---- auto-ingestion: PDFs posted to watched channels (the PRIMARY path) ----
const pdfAttachments = (message: Message) =>
  [...message.attachments.values()].filter(
    (a) => a.contentType?.includes("pdf") || /\.pdf$/i.test(a.name),
  );

const channelName = (message: Message): string =>
  (message.channel as { name?: string }).name ?? "";

async function handleWatchedMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  if (pdfAttachments(message).length === 0) return;

  // Resolve the tournament: an explicit /watch binding wins; otherwise derive it
  // from a dated channel name like #09-12-spike.
  const watched = watches.get(message.channelId);
  if (watched) {
    const found = packages.get(watched);
    if (!found) {
      await message.reply(`⚠ This channel is watched, but its package "${watched}" no longer exists — ask the TO to re-run /bbbot watch.`).catch(() => void 0);
      return;
    }
    await processRosterMessage(message, found);
    return;
  }

  const resolution = resolveChannelPackage(channelName(message), packages.names());
  if (resolution.match) {
    const found = packages.get(resolution.match);
    if (found) await processRosterMessage(message, found);
    return;
  }
  // Only prompt in channels that look like tournament channels — otherwise a PDF
  // dropped in #general would trigger a question. Ambiguous or unmatched → ask.
  if (resolution.looksLikeTournamentChannel) {
    await promptForTournament(message, resolution.candidates);
  }
}

type FoundPackage = NonNullable<ReturnType<typeof packages.get>>;

/** Validate every roster PDF on a message against the resolved package. */
async function processRosterMessage(message: Message, found: FoundPackage): Promise<void> {
  const pdfs = pdfAttachments(message);
  if (pdfs.length === 0) return;

  // DM-first feedback (owner decision): channel gets only the ✅/❌ reaction.
  const dmOrFallback = async (embed: EmbedBuilder, fallback: string): Promise<void> => {
    const dmOk = await message.author
      .send({ embeds: [embed] })
      .then(() => true)
      .catch(() => false);
    if (!dmOk) await message.reply(fallback).catch(() => void 0);
  };

  for (const pdf of pdfs.slice(0, 3)) {
    try {
      const bytes = await download(pdf.url);
      const outcome = await validateRosterBytes(bytes, pdf.name, found.pkg);
      if (!outcome.ok || !outcome.result || !outcome.roster) {
        await message.react("❌").catch(() => void 0);
        await dmOrFallback(
          toEmbed(renderProblemsEmbed(outcome.problems, pdf.name)),
          `${message.author} I couldn't read **${pdf.name}** (and your DMs are closed) — is it a bbtc.pl roster export?`,
        );
        continue;
      }
      const { result, roster } = outcome;
      if (result.valid) {
        await message.react("✅").catch(() => void 0);
        await recordValidRoster(message.author, roster, result, found.pkg.name, message.url, pdf.name);
      } else {
        await message.react("❌").catch(() => void 0);
        await dmOrFallback(
          toEmbed(renderResultEmbed(result, roster.teamName || pdf.name, found.pkg.name)),
          `${message.author} **${roster.teamName || pdf.name}** is not legal for **${found.pkg.name}** (details blocked — your DMs are closed; use /bbbot validate for an in-channel result).`,
        );
      }
    } catch (e) {
      console.error(`watched-message error (${pdf.name}):`, e);
      await message.react("⚠").catch(() => void 0);
    }
  }
}

const NOT_LISTED = "__not_listed__";

/**
 * The channel name didn't resolve to a single package — ask the coach which
 * tournament this is. Offer the near-matches first (ambiguous case), else the
 * full package list, plus an escape hatch that loops in a TO.
 */
async function promptForTournament(message: Message, candidates: string[]): Promise<void> {
  const options = (candidates.length ? candidates : packages.names()).slice(0, 24);
  if (options.length === 0) {
    // Nothing to offer — go straight to the organizers.
    await escalateToOrganizer(message);
    return;
  }
  const pending = pendingChannelResos.create({
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`chtour:${pending.token}`)
    .setPlaceholder("Choose the tournament this roster is for…")
    .addOptions(
      ...options.map((n) => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setValue(n.slice(0, 100))),
      new StringSelectMenuOptionBuilder()
        .setLabel("It's not listed — ask an organizer")
        .setValue(NOT_LISTED)
        .setEmoji("🚫"),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  await message
    .reply({
      content:
        `${message.author} thanks for the roster! I couldn't tell which tournament **#${channelName(message)}** is for` +
        (candidates.length ? " — did you mean one of these?" : ".") +
        `\nPick it below and I'll validate your team.`,
      components: [row],
    })
    .catch(() => void 0);
}

/** Coach picked a tournament (or "not listed") from the prompt menu. */
async function handleChannelTournamentSelect(i: StringSelectMenuInteraction): Promise<void> {
  if (!i.customId.startsWith("chtour:")) return;
  const pending = pendingChannelResos.take(i.customId.slice("chtour:".length));
  if (!pending) {
    await i.update({ content: "This request has expired — please re-post your roster.", components: [] }).catch(() => void 0);
    return;
  }
  if (pending.userId !== i.user.id) {
    await i.reply({ content: "Only the coach who posted this roster can answer.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return;
  }
  const choice = i.values[0];
  const message = await i.channel?.messages.fetch(pending.messageId).catch(() => null);

  if (choice === NOT_LISTED || !choice) {
    if (message) await escalateToOrganizer(message);
    await i.update({ content: "🚫 Flagged for a tournament organizer — they'll get this channel set up.", components: [] }).catch(() => void 0);
    return;
  }
  const found = packages.get(choice);
  if (!found) {
    await i.update({ content: `Package **${choice}** no longer exists — ask an organizer to re-check.`, components: [] }).catch(() => void 0);
    return;
  }
  await i.update({ content: `Validating your roster against **${found.pkg.name}**… (results by DM)`, components: [] }).catch(() => void 0);
  if (message) await processRosterMessage(message, found);
}

/**
 * Neither the channel name nor the coach could identify the tournament — loop in
 * the organizers. Posts in-channel (visible to TOs, who hold Manage Server) with
 * the two ways to bind it: rename the channel or run /bbbot watch.
 */
async function escalateToOrganizer(message: Message): Promise<void> {
  await message
    .reply(
      `⚠️ I couldn't match this channel to a tournament and none was selected.\n` +
        `**Organizers:** either rename this channel to \`MM-DD-<tournament>\` (e.g. \`#09-12-spike\`), ` +
        `or run \`/bbbot watch channel:<#${message.channelId}> package:<name>\` to bind it. ` +
        `I'll validate rosters here automatically once it's set.`,
    )
    .catch(() => void 0);
}

// ---- /bbbot watch|unwatch|watches ----
async function handleWatch(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await i.reply({ content: "Watching channels requires Manage Server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = i.options.getSubcommand();
  if (sub === "watch") {
    const channel = i.options.getChannel("channel", true);
    const packageName = i.options.getString("package", true);
    const found = packages.get(packageName);
    if (!found) {
      await i.reply({ content: `Unknown package "${packageName}". Try /bbbot packages.`, flags: MessageFlags.Ephemeral });
      return;
    }
    watches.set(channel.id, found.pkg.name);
    await i.reply(
      `👁 Watching <#${channel.id}> — every PDF posted there is now validated against **${found.pkg.name}** (✅/❌ on the post, details by DM).`,
    );
    return;
  }
  const channel = i.options.getChannel("channel", true);
  const removed = watches.remove(channel.id);
  await i.reply(removed ? `Stopped watching <#${channel.id}>.` : `<#${channel.id}> was not being watched.`);
}

async function handleWatches(i: ChatInputCommandInteraction): Promise<void> {
  const all = watches.list();
  await i.reply({
    content: all.length
      ? `Watched channels:\n${all.map((w) => `• <#${w.channelId}> → **${w.packageName}**`).join("\n")}`
      : "No channels are being watched. TOs: /bbbot watch channel:<#ch> package:<name>.",
    flags: MessageFlags.Ephemeral,
  });
}

// ---- /bbbot expired (report past-date watched channels; offer to deprecate) ----
const fmtDate = (d: Date): string =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

async function handleExpired(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await i.reply({ content: "Reviewing tournament watches requires Manage Server.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const expired: { channelId: string; name: string; packageName: string; date: Date }[] = [];
  for (const w of watches.list()) {
    const ch = await i.client.channels.fetch(w.channelId).catch(() => null);
    const name = (ch as { name?: string } | null)?.name;
    if (!name) continue; // channel gone or unnamed — the date lives in the name
    const status = tournamentDateStatus(name);
    if (status?.passed) expired.push({ channelId: w.channelId, name, packageName: w.packageName, date: status.date });
  }

  if (expired.length === 0) {
    await i.editReply("✅ No watched channels have a tournament date in the past. Nothing to deprecate.");
    return;
  }
  expired.sort((a, b) => a.date.getTime() - b.date.getTime());

  const embed = new EmbedBuilder()
    .setTitle(`⌛ ${expired.length} watched channel${expired.length > 1 ? "s" : ""} past their tournament date`)
    .setColor(0xd08a30)
    .setDescription(
      expired.map((e) => `• <#${e.channelId}> (\`#${e.name}\`) → **${e.packageName}** — ${fmtDate(e.date)}`).join("\n").slice(0, 4000),
    )
    .setFooter({ text: "Select any you want to stop watching. This only unbinds the channel; nothing is deleted." });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("wexp:deprecate")
    .setPlaceholder("Deprecate watching for…")
    .setMinValues(1)
    .setMaxValues(expired.length)
    .addOptions(
      expired.map((e) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`#${e.name}`.slice(0, 100))
          .setDescription(`${e.packageName} · ${fmtDate(e.date)}`.slice(0, 100))
          .setValue(e.channelId),
      ),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  await i.editReply({ embeds: [embed], components: [row] });
}

/** TO selected which past-date channels to stop watching. */
async function handleDeprecateSelect(i: StringSelectMenuInteraction): Promise<void> {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await i.reply({ content: "Deprecating a watch requires Manage Server.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return;
  }
  const removed = i.values.filter((channelId) => watches.remove(channelId));
  const lines = removed.map((c) => `• <#${c}>`).join("\n");
  await i
    .update({
      content: removed.length
        ? `🗑 Stopped watching ${removed.length} channel${removed.length > 1 ? "s" : ""}:\n${lines}\nRe-bind any of them anytime with \`/bbbot watch\`.`
        : "Those channels were already not being watched.",
      embeds: [],
      components: [],
    })
    .catch(() => void 0);
}

// ---- /bbbot export ----
async function handleExport(i: ChatInputCommandInteraction): Promise<void> {
  const name = i.options.getString("package", true);
  const found = packages.get(name);
  if (!found) {
    await i.reply({ content: `Unknown package "${name}". Try /bbbot packages.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const html = renderPackageHtml(found.pkg);
  const filename = `${found.pkg.name.replace(/[^\w.-]+/g, "-").toLowerCase()}-rules.html`;
  const file = new AttachmentBuilder(Buffer.from(html, "utf8"), { name: filename });
  await i.reply({ content: `📄 One-page rules for **${found.pkg.name}** — open the attachment in a browser.`, files: [file] });
}

// ---- /bbbot artprompt ----
async function handleArtPrompt(i: ChatInputCommandInteraction): Promise<void> {
  const name = i.options.getString("package", true);
  const found = packages.get(name);
  if (!found) {
    await i.reply({ content: `Unknown package "${name}". Try /bbbot packages.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const prompt = renderArtPrompt(found.pkg);
  // Fits in a message; use a code block. (Discord limit 2000 chars — the prompt is well under.)
  await i.reply({ content: `🎨 AI-art prompt for **${found.pkg.name}**:\n\`\`\`\n${prompt.slice(0, 1900)}\n\`\`\`` });
}

// ---- /report ----
async function handleReport(i: ChatInputCommandInteraction): Promise<void> {
  const packageName = i.options.getString("package") ?? undefined;
  const wantCsv = i.options.getBoolean("csv") ?? false;
  const entries = await validated.list(packageName);
  if (entries.length === 0) {
    await i.reply({ content: "No validated rosters yet.", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = entries.map(
    (e) =>
      `**${e.coachName}** — ${e.teamName} (${e.rosterRace}) · ${e.packageName}` +
      (e.messageLink ? ` · [roster post](${e.messageLink})` : ""),
  );
  const embed = new EmbedBuilder()
    .setTitle(`Validated rosters${packageName ? ` — ${packageName}` : ""} (${entries.length})`)
    .setColor(0x22e05a)
    .setDescription(lines.join("\n").slice(0, 4000));
  const files = wantCsv
    ? [{ attachment: Buffer.from(await validated.exportCsv(packageName), "utf8"), name: "validated-rosters.csv" }]
    : [];
  await i.reply({ embeds: [embed], files });
}

// ---- /packages, /package show|import ----
async function handlePackages(i: ChatInputCommandInteraction): Promise<void> {
  const names = packages.names();
  await i.reply({
    content: names.length ? `Available packages:\n${names.map((n) => `• ${n}`).join("\n")}` : "No packages found.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePackageShow(i: ChatInputCommandInteraction): Promise<void> {
  const name = i.options.getString("name", true);
  const found = packages.get(name);
  if (!found) {
    await i.reply({ content: `Unknown package "${name}".`, flags: MessageFlags.Ephemeral });
    return;
  }
  const p = found.pkg;
  const sa = p.skillAllotment;
  const embed = new EmbedBuilder()
    .setTitle(p.name)
    .setColor(0x8a4ab0)
    .addFields(
      { name: "Eligible rosters", value: p.eligibleRosters.join(", ") || "—" },
      {
        name: "Skill Points",
        value:
          `budget ${sa.skillPointBudget} · primary ${sa.primaryCostSP} SP · secondary ${sa.secondaryCostSP ?? `${sa.primaryCostSP}×${sa.secondaryMultiplier}`} SP · elite +${sa.eliteSurchargeSP}\n` +
          `elite set: ${sa.eliteSkills.join(", ")} · max/player ${sa.maxPerPlayer ?? "—"} · stacking ${sa.maxStackedPlayers != null ? `≤ ${sa.maxStackedPlayers} players >1 skill` : "unlimited"}`,
      },
      {
        name: "Stars / Gold / Sideline",
        value: `stars ${p.starPlayers.allowed ? `yes (max ${p.starPlayers.maxCount ?? "—"})` : "no"} · gold ${p.goldBudget != null ? `${p.goldBudget / 1000}k` : "—"} · re-rolls ≤ ${p.sideline.maxReRolls ?? "—"}`,
      },
      {
        name: "Special",
        value: `min players ${p.special.minPlayers} · banned: ${p.special.bannedSkills.join(", ") || "none"}`,
      },
    );
  await i.reply({ embeds: [embed] });
}

async function handlePackageImport(i: ChatInputCommandInteraction): Promise<void> {
  const doc = i.options.getAttachment("document", true);
  const csv = i.options.getAttachment("skillcosts");
  await i.deferReply();
  try {
    const bytes = await download(doc.url);
    const csvText = csv ? new TextDecoder().decode(await download(csv.url)) : undefined;
    const isJson = /\.json$/i.test(doc.name);
    const isPdf = /\.pdf$/i.test(doc.name);
    const input = isJson
      ? { kind: "json" as const, text: new TextDecoder().decode(bytes) }
      : isPdf
        ? { kind: "pdf" as const, bytes }
        : { kind: "text" as const, text: new TextDecoder().decode(bytes) };
    const { pkg, problems } = await ingestPackageDocument(input, {
      csvText,
      resolveExtends: (n) => packages.get(n)?.pkg,
    });
    if (!pkg) {
      await i.editReply({ embeds: [toEmbed(renderProblemsEmbed(problems, doc.name))] });
      return;
    }
    const path = packages.save(pkg);
    const report = problems.length ? `\n⚠ Review:\n${problems.map((p) => `• ${p}`).join("\n")}` : "";
    await i.editReply(`Imported **${pkg.name}** → \`${path}\`.${report}`.slice(0, 1900));
  } catch (e) {
    await i.editReply(`Import failed: ${(e as Error).message}`);
  }
}

// ---- /coach ----
async function handleCoach(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  if (sub === "register") {
    const patch = {
      discordUserId: i.user.id,
      ...(i.options.getString("fumbbl") ? { fumbblName: i.options.getString("fumbbl")! } : {}),
      ...(i.options.getString("naf-name") ? { nafName: i.options.getString("naf-name")! } : {}),
      ...(i.options.getString("naf") ? { nafId: i.options.getString("naf")! } : {}),
    };
    try {
      const entry = await coaches.upsert(patch);
      await i.reply({ content: `Registered. Your coach id: \`${entry.id}\`.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      const msg = e instanceof KeyConflictError ? e.message : `Registration failed: ${(e as Error).message}`;
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  const entry =
    sub === "me"
      ? await coaches.lookup("discordUserId", i.user.id)
      : await coaches.lookup(i.options.getString("key", true) as CoachKey, i.options.getString("value", true));
  if (!entry) {
    await i.reply({ content: "No matching coach in the registry.", flags: MessageFlags.Ephemeral });
    return;
  }
  const teams = entry.teams.map((t) => `• ${t.teamName} (${t.rosterRace}) — ${t.tournament}`).join("\n");
  await i.reply({
    content:
      `**Coach** \`${entry.id}\`\n` +
      `discord: ${entry.discordUserId ? `<@${entry.discordUserId}>` : "—"} · fumbbl: ${entry.fumbblName ?? "—"} · naf: ${entry.nafName ?? "—"}${entry.nafId ? ` (#${entry.nafId})` : ""}\n` +
      (teams ? `**Teams**\n${teams}` : "No registered teams."),
    flags: MessageFlags.Ephemeral,
  });
}

// ---- /bbbot 40k (fork admin — Manage Server) ----
/** Send one (registered) coach's fork JNLP to the channel, @-mentioning them. */
async function sendCoachJnlp(
  i: ChatInputCommandInteraction,
  channelId: string,
  team: Awaited<ReturnType<typeof fetchForkTeam>>,
  discordUserId: string,
  game: string,
  password: string | undefined,
): Promise<void> {
  const jnlp = buildForkJnlp({ coach: team.coach, teamId: team.teamId, gameName: game, password });
  const file = new AttachmentBuilder(Buffer.from(jnlp, "utf8"), { name: jnlpFilename(game, team.coach) });
  const content =
    `<@${discordUserId}> — your fork-join JNLP for game **${game}** (team **${team.teamName}**, id ${team.teamId}).\n` +
    `Open it in the FUMBBL40k client; both coaches join game **${game}** (2nd join starts the match).`;
  const ch = await i.client.channels.fetch(channelId);
  if (!ch?.isTextBased()) throw new Error(`Channel <#${channelId}> is not a text channel.`);
  await (ch as unknown as { send: (o: unknown) => Promise<unknown> }).send({
    content,
    files: [file],
    allowedMentions: { users: [discordUserId] },
  });
}

async function handleFork40k(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await i.reply({ content: "FUMBBL40k fork admin requires Manage Server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = i.options.getSubcommand();

  // Channel setters just record a Discord channel — no fork-host config needed.
  if (sub === "setchannel") {
    const channel = i.options.getChannel("channel", true);
    fork40k.setChannel(channel.id);
    await i.reply({ content: `✅ FUMBBL40k JNLPs will be posted to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === "announcechannel") {
    const channel = i.options.getChannel("channel", true);
    fork40k.setAnnounceChannel(channel.id);
    await i.reply({
      content: `✅ FUMBBL40k build announcements will be posted to <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (sub === "launch") {
      const game = i.options.getString("game", true).trim();
      const password = i.options.getString("password") ?? undefined;
      const urls = [i.options.getString("team", true), i.options.getString("team2")].filter(Boolean) as string[];
      // Post to the dedicated 40k channel; fall back to any roster-watched channel.
      const channelId = fork40k.getChannel() ?? watches.list()[0]?.channelId;
      if (!channelId) {
        await i.editReply("⚠ No FUMBBL40k channel set. Run `/bbbot 40k setchannel channel:<#ch>` first.");
        return;
      }
      // Resolve every coach and GATE on FUMBBL-account registration — no JNLP goes
      // out (so the game can't start) until each coach has linked their identity.
      const resolved: { team: Awaited<ReturnType<typeof fetchForkTeam>>; discordUserId?: string }[] = [];
      for (const url of urls) {
        const team = await fetchForkTeam(url);
        const entry = await coaches.lookup("fumbblName", team.coach);
        resolved.push({ team, discordUserId: entry?.discordUserId });
      }
      const unregistered = resolved.filter((r) => !r.discordUserId);
      if (unregistered.length) {
        await i.editReply(
          `🚫 Can't launch **${game}** — every coach must register their FUMBBL account first:\n` +
            unregistered.map((r) => `• **${r.team.coach}** → \`/bbbot coach register fumbbl:${r.team.coach}\``).join("\n") +
            `\nRe-run the launch once they've registered.`,
        );
        return;
      }
      for (const r of resolved) await sendCoachJnlp(i, channelId, r.team, r.discordUserId!, game, password);
      await i.editReply(
        `✅ Launched **${game}** → <#${channelId}>:\n${resolved.map((r) => `• ${r.team.coach} (pinged)`).join("\n")}`,
      );
      return;
    }

    if (sub === "announce") {
      await i.editReply(await announceBuild(true));
      return;
    }

    if (sub === "daily") {
      await i.editReply(await announceDailySummary(true));
      return;
    }

    if (sub === "hold") {
      const reason = i.options.getString("reason") ?? undefined;
      announceHold.hold(reason);
      await i.editReply(`⏸ Announcements HELD${reason ? ` (${reason})` : ""}. Nothing will post until \`/bbbot 40k resume\`.`);
      return;
    }

    if (sub === "resume") {
      announceHold.resume();
      await i.editReply("▶️ Announcements RESUMED — the next new build/daily-summary will post normally.");
      return;
    }

    // createaccount / copyteam need the fork-host config (DB + teams dir).
    const cfg = forkConfigFromEnv();
    if (!cfg) {
      await i.editReply(
        "Fork provisioning isn't configured — set `FORK_TEAMS_DIR` (+ `FORK_DB_*`) in the bot's `.env`, and run the bot on the fork host.",
      );
      return;
    }
    if (sub === "createaccount") {
      const username = i.options.getString("username", true).trim();
      await createForkAccount(cfg, username);
      await i.editReply(`✅ Fork coach **${username}** created/reset — password \`12345\`.`);
    } else if (sub === "copyteam") {
      const adminCfg = forkAdminConfigFromEnv();
      const t = await copyForkTeam(cfg, i.options.getString("url", true), {
        isTeamActive: adminCfg ? async (teamId) => {
          const live = await adminListLive(adminCfg);
          return live.some((game) => game.homeTeamId === teamId || game.awayTeamId === teamId);
        } : undefined,
      });
      await i.editReply(
        `✅ Copied **${t.teamName}** (coach **${t.coach}**, id ${t.teamId}) → \`${t.path}\`.\n` +
          `⚠ A fork coach named **${t.coach}** must exist (\`/bbbot 40k createaccount ${t.coach}\`), and the FFB game server must restart to load the team.` +
          (t.raceWarning ? `\n⚠ ${t.raceWarning}` : ""),
      );
    }
  } catch (e) {
    await i.editReply(`❌ Fork command failed: ${(e as Error).message}`);
  }
}

// ---- FUMBBL40k build announcer ----
/** Post the current build manifest to the announce channel. `force` bypasses de-dupe. */
async function announceBuild(force: boolean): Promise<string> {
  return announceLatestBuild(client, fork40k.getAnnounceChannel(), announceState, force, announceHold);
}

/**
 * Poll the manifest; auto-announce genuinely-new builds. First run seeds silently.
 * TAG-GATED: the poller only auto-announces a build whose commit is a `vX.Y.Z` release tag,
 * so interim rebuilds (the manifest re-emitted mid-iteration) can't spam the channel. An
 * untagged new build is held with a log line — post it deliberately with `/bbbot 40k announce`
 * (which bypasses this gate) once it's the real cut.
 */
async function pollBuildManifest(): Promise<void> {
  const m = readManifest();
  if (!m) return;
  if (announceState.isEmpty()) {
    announceState.mark(m); // seed — don't announce the build that already exists at first boot
    console.log(`Build announcer seeded at v${m.version} (${m.gitSha}); new builds will auto-announce.`);
    return;
  }
  if (!announceState.isNew(m)) return;
  if (announceState.isRegression(m)) {
    // A stale manifest file (older version than last announced), NOT a new cut — e.g. the main
    // checkout lagging after a worktree-built release. Never auto-announce it; refresh the manifest
    // or post deliberately with `/bbbot 40k announce` if it's genuinely intended.
    console.log(
      `Build manifest v${m.version} (${m.gitSha}) is OLDER than the last announced release — ` +
        `stale manifest, holding auto-announce.`,
    );
    return;
  }
  const tag = manifestReleaseTag(m);
  if (!tag) {
    // Don't mark state — a later re-emit at the tagged commit still reads as new and posts.
    console.log(
      `Build manifest v${m.version} (${m.gitSha}) is not a tagged release — holding auto-announce ` +
        `(use \`/bbbot 40k announce\` to post it manually).`,
    );
    return;
  }
  console.log(await announceBuild(false));
}

/** Post the top day's entry from the shared daily-summary.md. `force` bypasses de-dupe. */
async function announceDailySummary(force: boolean): Promise<string> {
  return announceLatestDailySummary(client, fork40k.getAnnounceChannel(), dailySummaryState, force, announceHold);
}

/**
 * Poll the shared daily-summary.md; auto-announce a genuinely new day's entry. First
 * run seeds silently — same rationale as the build poller (don't re-post history).
 * The 40k track compiles this ~11:50 PM, so in practice this only fires once per day.
 */
async function pollDailySummary(): Promise<void> {
  const d = readTopDailySummary();
  if (!d) return;
  if (dailySummaryState.isEmpty()) {
    dailySummaryState.mark(d);
    console.log(`Daily-summary announcer seeded at ${d.date}; new days will auto-announce.`);
    return;
  }
  if (dailySummaryState.isNew(d)) console.log(await announceDailySummary(false));
}

// ---- wiring ----
// GuildMessages + MessageContent are required for watched-channel ingestion;
// MessageContent is PRIVILEGED — it must be toggled ON in the developer portal
// (Bot → Privileged Gateway Intents → Message Content Intent).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("messageCreate", (message) => {
  // "Ask BB-Bot" (gimmick): a direct @-mention gets a grognard answer and short-circuits;
  // otherwise fall through to the tournament PDF watcher.
  void handleGrognardMention(message, client.user?.id)
    .then((handled) => (handled ? undefined : handleWatchedMessage(message)))
    .catch((e) => console.error("messageCreate error:", e));
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return autocompletePackages(interaction);
    if (interaction.isButton()) return await handleResubButton(interaction);
    if (interaction.isStringSelectMenu())
      return interaction.customId.startsWith("wexp:")
        ? await handleDeprecateSelect(interaction)
        : await handleChannelTournamentSelect(interaction);
    if (!interaction.isChatInputCommand() || interaction.commandName !== "bbbot") return;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group === "package")
      return sub === "show"
        ? await handlePackageShow(interaction)
        : await handlePackageImport(interaction);
    if (group === "40k") return await handleFork40k(interaction);
    if (group === "coach") return await handleCoach(interaction);
    switch (sub) {
      case "validate":
        return await handleValidate(interaction);
      case "report":
        return await handleReport(interaction);
      case "packages":
        return await handlePackages(interaction);
      case "export":
        return await handleExport(interaction);
      case "artprompt":
        return await handleArtPrompt(interaction);
      case "watch":
      case "unwatch":
        return await handleWatch(interaction);
      case "watches":
        return await handleWatches(interaction);
      case "expired":
        return await handleExpired(interaction);
    }
  } catch (e) {
    console.error("interaction error:", e);
    const i = interaction;
    if (i.isRepliable()) {
      const msg = { content: `Something went wrong: ${(e as Error).message}` };
      await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => void 0);
    }
  }
});

async function autocompletePackages(i: AutocompleteInteraction): Promise<void> {
  const q = i.options.getFocused().toLowerCase();
  const names = packages.names().filter((n) => n.toLowerCase().includes(q));
  await i.respond(names.slice(0, 25).map((n) => ({ name: n, value: n }))).catch(() => void 0);
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}. Packages dir: ${PACKAGES_DIR}. Data dir: ${DATA_DIR}.`);
  // Watch the FUMBBL40k build manifest + shared daily-summary.md; auto-announce new cuts/days.
  void pollBuildManifest().catch((e) => console.error("build poll error:", e));
  void pollDailySummary().catch((e) => console.error("daily-summary poll error:", e));
  setInterval(() => {
    void pollBuildManifest().catch((e) => console.error("build poll error:", e));
    void pollDailySummary().catch((e) => console.error("daily-summary poll error:", e));
  }, 60_000);
});

void client.login(TOKEN);
