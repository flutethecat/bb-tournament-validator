/**
 * Registers the slash commands. With GUILD_ID set they appear instantly in that
 * guild (recommended for testing); without it they register globally (~1h).
 *   pnpm --filter discord-bot register
 */

import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commandDefs } from "./commands";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;
if (!token || !clientId) {
  console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required (see .env.example).");
  process.exit(1);
}

const rest = new REST().setToken(token);
const route = guildId
  ? Routes.applicationGuildCommands(clientId, guildId)
  : Routes.applicationCommands(clientId);
await rest.put(route, { body: commandDefs });
console.log(
  `Registered ${commandDefs.length} commands ${guildId ? `in guild ${guildId}` : "globally"}.`,
);
