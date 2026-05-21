import { EmbedBuilder, type ColorResolvable } from "discord.js";
import { DISCORD_BRAND, getBotFooterText } from "./brand";
import { DISCORD_COLORS, type DiscordColorTone } from "./colors";

export type BrandedEmbedOptions = {
  tone?: DiscordColorTone;
  color?: ColorResolvable;
  title?: string;
  description?: string;
  footerSuffix?: string | null;
  timestamp?: boolean;
};

export function applyBrand(embed: EmbedBuilder) {
  return embed.setAuthor({
    name: DISCORD_BRAND.name,
    iconURL: DISCORD_BRAND.iconURL,
  });
}

export function applyFooter(embed: EmbedBuilder, suffix?: string | null) {
  return embed.setFooter({ text: getBotFooterText(suffix) });
}

export function buildBrandedEmbed(options: BrandedEmbedOptions = {}) {
  const color = options.color ?? DISCORD_COLORS[options.tone ?? "system"];
  const embed = applyFooter(applyBrand(new EmbedBuilder().setColor(color)), options.footerSuffix);

  if (options.title) embed.setTitle(options.title);
  if (options.description) embed.setDescription(options.description);
  if (options.timestamp !== false) embed.setTimestamp(new Date());

  return embed;
}

export function buildSystemEmbed(options: Omit<BrandedEmbedOptions, "tone"> = {}) {
  return buildBrandedEmbed({ ...options, tone: "system" });
}

export function buildSuccessEmbed(options: Omit<BrandedEmbedOptions, "tone"> = {}) {
  return buildBrandedEmbed({ ...options, tone: "success" });
}

export function buildWarningEmbed(options: Omit<BrandedEmbedOptions, "tone"> = {}) {
  return buildBrandedEmbed({ ...options, tone: "warning" });
}

export function buildErrorEmbed(options: Omit<BrandedEmbedOptions, "tone"> = {}) {
  return buildBrandedEmbed({ ...options, tone: "danger" });
}

export function buildNeutralEmbed(options: Omit<BrandedEmbedOptions, "tone"> = {}) {
  return buildBrandedEmbed({ ...options, tone: "neutral" });
}

export function buildEconomyEmbed(options: Omit<BrandedEmbedOptions, "tone"> = {}) {
  return buildBrandedEmbed({ ...options, tone: "economy" });
}
