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
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  type AutocompleteInteraction,
} from "discord.js";
import { ingestPackageDocument } from "@bb/ingest";
import { PackageStore } from "./packageStore";
import { renderProblemsEmbed, renderResultEmbed, validateRosterBytes, type EmbedData } from "./pipeline";
import { CsvValidatedStore } from "./store/validatedStore";
import { FileCoachRegistry, KeyConflictError, type CoachKey } from "./store/coachRegistry";

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

// ---- /validate ----
async function handleValidate(i: ChatInputCommandInteraction): Promise<void> {
  const attachment = i.options.getAttachment("roster", true);
  const packageName = i.options.getString("package", true);
  await i.deferReply();

  const found = packages.get(packageName);
  if (!found) {
    await i.editReply(`Unknown package "${packageName}". Try /packages.`);
    return;
  }
  const notes: string[] = [...found.problems];

  let outcome;
  try {
    const bytes = await download(attachment.url);
    outcome = await validateRosterBytes(bytes, attachment.name, found.pkg);
  } catch (e) {
    await i.editReply(`Could not process the attachment: ${(e as Error).message}`);
    return;
  }

  if (!outcome.ok || !outcome.result || !outcome.roster) {
    await i.editReply({ embeds: [toEmbed(renderProblemsEmbed(outcome.problems, attachment.name))] });
    return;
  }
  notes.push(...outcome.problems);

  const { result, roster } = outcome;
  const embed = toEmbed(renderResultEmbed(result, roster.teamName || "Team", found.pkg.name));
  if (notes.length) embed.setFooter({ text: notes.slice(0, 3).join(" | ").slice(0, 2048) });
  const reply = await i.editReply({ embeds: [embed] });

  if (result.valid) {
    // (a) ✅ on the roster post (the bot's reply carrying the attachment result)
    await reply.react("✅").catch(() => notes.push("Could not add the ✅ reaction."));
    // (b) DM the coach — closed DMs are a note, never a failure
    await i.user
      .send(
        `✅ Your roster **${roster.teamName || attachment.name}** (${roster.rosterName}) is legal for **${found.pkg.name}** — ${result.recomputedSummary.skillPointsUsed}/${result.recomputedSummary.skillPointBudget} SP.`,
      )
      .catch(() => void 0);
    // (c) record in the validated store (+ coach registry team registration)
    const messageLink = i.guildId
      ? `https://discord.com/channels/${i.guildId}/${reply.channelId}/${reply.id}`
      : "";
    await validated.upsert({
      discordUserId: i.user.id,
      coachName: roster.coach || i.user.username,
      teamName: roster.teamName || attachment.name,
      rosterRace: roster.rosterName,
      packageName: found.pkg.name,
      messageLink,
      validatedAt: new Date().toISOString(),
    });
    try {
      const entry = await coaches.upsert({ discordUserId: i.user.id });
      await coaches.addTeam(entry.id, {
        tournament: found.pkg.name,
        teamName: roster.teamName || attachment.name,
        rosterRace: roster.rosterName,
        sourceRef: messageLink,
        registeredAt: new Date().toISOString(),
      });
    } catch {
      /* registry is best-effort during /validate */
    }
  }
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
          `elite set: ${sa.eliteSkills.join(", ")} · max/player ${sa.maxPerPlayer ?? "—"}`,
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

// ---- wiring ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return autocompletePackages(interaction);
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case "validate":
        return await handleValidate(interaction);
      case "report":
        return await handleReport(interaction);
      case "packages":
        return await handlePackages(interaction);
      case "package":
        return interaction.options.getSubcommand() === "show"
          ? await handlePackageShow(interaction)
          : await handlePackageImport(interaction);
      case "coach":
        return await handleCoach(interaction);
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
});

void client.login(TOKEN);
