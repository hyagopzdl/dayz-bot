import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { PlayerLink } from "../../../state";
import { normalizeLocale, t, type Locale } from "../../../i18n";

const COLORS = {
  primary: 0x2f80ed,
  success: 0x22c55e,
  danger: 0xef4444,
  neutral: 0x94a3b8,
};

export type LinkPayloadOptions = {
  authorName?: string | null;
  authorIconURL?: string | null;
};

function applyBotAuthor(embed: EmbedBuilder, options?: LinkPayloadOptions) {
  embed.setAuthor({
    name: options?.authorName || "PZ DayZ Bot",
    iconURL: options?.authorIconURL || undefined,
  });
  return embed;
}

function languageName(locale: Locale) {
  return locale === "pt" ? "Português" : "English";
}

export function buildLanguageSelectCustomId(discordId: string) {
  return `link-language:${discordId}`;
}

export function buildLinkConfirmCustomId(discordId: string) {
  return `link-confirm:${discordId}`;
}

export function buildLinkSetupPayload(link: PlayerLink, options?: LinkPayloadOptions) {
  const locale = normalizeLocale(link.locale);

  const embed = applyBotAuthor(
    new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(t(locale, "link.linkedTitle"))
      .setDescription([
        t(locale, "link.linkedDescription"),
        "",
        `**${t(locale, "link.gamertagLabel")}**`,
        `\`${link.gamertag}\``,
        "",
        `**${t(locale, "link.languageLabel")}**`,
        languageName(locale),
        "",
        t(locale, "link.chooseLanguage"),
      ].join("\n"))
      .setFooter({ text: "PZ DayZ Bot" })
      .setTimestamp(new Date()),
    options,
  );

  const languageRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildLanguageSelectCustomId(link.discordId))
      .setPlaceholder(t(locale, "link.selectPlaceholder"))
      .addOptions(
        {
          label: t(locale, "common.languageEnglish"),
          value: "en",
          emoji: "🇺🇸",
          default: locale === "en",
        },
        {
          label: t(locale, "common.languagePortuguese"),
          value: "pt",
          emoji: "🇧🇷",
          default: locale === "pt",
        },
      ),
  );

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildLinkConfirmCustomId(link.discordId))
      .setLabel(t(locale, "common.confirm"))
      .setStyle(ButtonStyle.Success),
  );

  return {
    embeds: [embed],
    components: [languageRow, buttonRow],
    ephemeral: true,
  };
}

export function buildLinkCompletedPayload(link: PlayerLink, options?: LinkPayloadOptions) {
  const locale = normalizeLocale(link.locale);

  const embed = applyBotAuthor(
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(t(locale, "link.confirmTitle"))
      .setDescription([
        t(locale, "link.confirmDescription"),
        "",
        `**${t(locale, "link.gamertagLabel")}**`,
        `\`${link.gamertag}\``,
        "",
        `**${t(locale, "link.languageLabel")}**`,
        languageName(locale),
        "",
        `**${t(locale, "link.commandsTitle")}**`,
        t(locale, "link.shopCommand"),
        t(locale, "link.bankCommand"),
      ].join("\n"))
      .setFooter({ text: "PZ DayZ Bot" })
      .setTimestamp(new Date()),
    options,
  );

  return {
    embeds: [embed],
    components: [],
  };
}

export function buildLinkErrorPayload(locale: Locale | string | undefined | null, message: string, options?: LinkPayloadOptions) {
  const normalized = normalizeLocale(locale);
  const embed = applyBotAuthor(
    new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle(t(normalized, "link.errorTitle"))
      .setDescription(message)
      .setFooter({ text: "PZ DayZ Bot" })
      .setTimestamp(new Date()),
    options,
  );

  return {
    embeds: [embed],
    components: [],
    ephemeral: true,
  };
}

export function buildUnlinkPayload(locale: Locale | string | undefined | null, options?: LinkPayloadOptions) {
  const normalized = normalizeLocale(locale);
  const embed = applyBotAuthor(
    new EmbedBuilder()
      .setColor(COLORS.neutral)
      .setTitle(t(normalized, "link.unlinkedTitle"))
      .setDescription(t(normalized, "link.unlinked"))
      .setFooter({ text: "PZ DayZ Bot" })
      .setTimestamp(new Date()),
    options,
  );

  return {
    embeds: [embed],
    components: [],
    ephemeral: true,
  };
}
