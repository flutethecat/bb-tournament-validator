/** Slash-command definitions (registered by registerCommands.ts, handled in index.ts). */

import { SlashCommandBuilder } from "discord.js";

export const commandDefs = [
  new SlashCommandBuilder()
    .setName("validate")
    .setDescription("Validate a roster PDF against a tournament package")
    .addAttachmentOption((o) =>
      o.setName("roster").setDescription("bbtc.pl roster PDF export").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("package")
        .setDescription("Tournament package name (see /packages)")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName("report")
    .setDescription("List coaches with validated rosters (+ links to their posts)")
    .addStringOption((o) =>
      o.setName("package").setDescription("Filter by package").setAutocomplete(true),
    )
    .addBooleanOption((o) => o.setName("csv").setDescription("Attach the CSV export")),

  new SlashCommandBuilder().setName("packages").setDescription("List available tournament packages"),

  new SlashCommandBuilder()
    .setName("package")
    .setDescription("Tournament package management")
    .addSubcommand((s) =>
      s
        .setName("show")
        .setDescription("Show a package's rules")
        .addStringOption((o) =>
          o.setName("name").setDescription("Package name").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("import")
        .setDescription("Import a package from a rules document (PDF/text/JSON) + optional skill-cost CSV")
        .addAttachmentOption((o) =>
          o.setName("document").setDescription("Rules document").setRequired(true),
        )
        .addAttachmentOption((o) =>
          o.setName("skillcosts").setDescription("CSV skill-cost overrides (skill,costSP,elite)"),
        ),
    ),

  new SlashCommandBuilder()
    .setName("coach")
    .setDescription("Coach identity library")
    .addSubcommand((s) =>
      s
        .setName("register")
        .setDescription("Register/update your identity keys")
        .addStringOption((o) => o.setName("fumbbl").setDescription("FUMBBL coach name"))
        .addStringOption((o) => o.setName("naf-name").setDescription("NAF name"))
        .addStringOption((o) => o.setName("naf").setDescription("NAF number")),
    )
    .addSubcommand((s) =>
      s
        .setName("lookup")
        .setDescription("Look up a coach by any identity key")
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Which key")
            .setRequired(true)
            .addChoices(
              { name: "discord", value: "discordUserId" },
              { name: "fumbbl", value: "fumbblName" },
              { name: "naf-name", value: "nafName" },
              { name: "naf", value: "nafId" },
            ),
        )
        .addStringOption((o) => o.setName("value").setDescription("The value").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("me").setDescription("Show my registry entry")),
].map((c) => c.toJSON());
