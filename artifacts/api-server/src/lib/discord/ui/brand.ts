import type { APIEmbedAuthor } from "discord.js";
import { BOT_ICON, BOT_NAME } from "../constants";

export const DISCORD_BRAND = {
  name: BOT_NAME,
  iconURL: BOT_ICON,
} as const;

export function getBotAuthor(): APIEmbedAuthor {
  return {
    name: DISCORD_BRAND.name,
    icon_url: DISCORD_BRAND.iconURL,
  };
}

export function getBotFooterText(suffix?: string | null) {
  return suffix ? `${DISCORD_BRAND.name} • ${suffix}` : DISCORD_BRAND.name;
}
