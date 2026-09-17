import { Client, GatewayIntentBits } from "discord.js";

export const DISCORD_GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildPresences,
] as const;

export function createDiscordClient() {
  return new Client({ intents: [...DISCORD_GATEWAY_INTENTS] });
}
