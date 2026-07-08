/**
 * Slash-command definitions. Everything lives under the single /bbbot namespace
 * (owner directive 2026-07-06) so the bot can never conflict with other bots'
 * command names in a shared server.
 *
 *   /bbbot validate package:<name> [roster:<pdf>] [fumbbl-team:<id>]
 *   /bbbot report [package] [csv]
 *   /bbbot packages
 *   /bbbot package show <name>
 *   /bbbot package import <document> [skillcosts]
 *   /bbbot 40k createaccount <username>   (fork admin, Manage Server)
 *   /bbbot 40k copyteam <url>             (fork admin, Manage Server)
 *   /bbbot coach register [fumbbl] [naf-name] [naf]
 *   /bbbot coach lookup key:<key> value:<value>
 *   /bbbot coach me
 *   /bbbot watch channel:<#ch> package:<name>   (TO, Manage Server)
 *   /bbbot unwatch channel:<#ch>                (TO, Manage Server)
 *   /bbbot watches
 *
 * Watched channels are the PRIMARY ingestion path: any PDF posted there is
 * auto-validated against the bound package (✅/❌ on the coach's own post).
 */

import { ChannelType, SlashCommandBuilder } from "discord.js";

export const commandDefs = [
  new SlashCommandBuilder()
    .setName("bbbot")
    .setDescription("Blood Bowl tournament roster validation")
    .addSubcommand((s) =>
      s
        .setName("validate")
        .setDescription("Validate a roster (PDF upload or FUMBBL team id) against a tournament package")
        .addStringOption((o) =>
          o
            .setName("package")
            .setDescription("Tournament package name (see /bbbot packages)")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addAttachmentOption((o) =>
          o.setName("roster").setDescription("bbtc.pl roster PDF export"),
        )
        .addIntegerOption((o) =>
          o.setName("fumbbl-team").setDescription("FUMBBL team id (alternative to a PDF upload)"),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("report")
        .setDescription("List coaches with validated rosters (+ links to their posts)")
        .addStringOption((o) =>
          o.setName("package").setDescription("Filter by package").setAutocomplete(true),
        )
        .addBooleanOption((o) => o.setName("csv").setDescription("Attach the CSV export")),
    )
    .addSubcommand((s) =>
      s.setName("packages").setDescription("List available tournament packages"),
    )
    .addSubcommand((s) =>
      s
        .setName("export")
        .setDescription("Export a package's rules as a one-page HTML document")
        .addStringOption((o) =>
          o.setName("package").setDescription("Package name").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("artprompt")
        .setDescription("Generate an AI-art prompt for this tournament")
        .addStringOption((o) =>
          o.setName("package").setDescription("Package name").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("watch")
        .setDescription("Auto-validate every PDF posted in a channel (TO only)")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel to watch")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("package")
            .setDescription("Tournament package to validate against")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("unwatch")
        .setDescription("Stop auto-validating a channel (TO only)")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel to stop watching")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName("watches").setDescription("List watched channels and their packages"),
    )
    .addSubcommandGroup((g) =>
      g
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
    )
    .addSubcommandGroup((g) =>
      g
        .setName("40k")
        .setDescription("FUMBBL40k fork admin (Manage Server)")
        .addSubcommand((s) =>
          s
            .setName("createaccount")
            .setDescription("Create/reset a fork test coach (password 12345)")
            .addStringOption((o) =>
              o.setName("username").setDescription("Coach name (must match the team's owner to join)").setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("copyteam")
            .setDescription("Copy a FUMBBL team onto the fork")
            .addStringOption((o) =>
              o.setName("url").setDescription("https://fumbbl.com/t/<id>").setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((g) =>
      g
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
    ),
].map((c) => c.toJSON());
