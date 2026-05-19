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
};

export function buildLanguageSelectCustomId(discordId: string) {
  return `link-language:${discordId}`;
}

export function buildLinkConfirmCustomId(discordId: string) {
  return `link-confirm:${discordId}`;
}

export function buildLinkSetupPayload(link: PlayerLink) {
  const locale = normalizeLocale(link.locale);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(t(locale, "link.linkedTitle"))
    .setDescription(`${t(locale, "link.linkedDescription")}\n\n${t(locale, "link.chooseLanguage")}`)
    .addFields(
      {
        name: t(locale, "link.gamertagLabel"),
        value: `\`${link.gamertag}\``,
        inline: true,
      },
      {
        name: t(locale, "link.languageLabel"),
        value: locale === "pt" ? "Português" : "English",
        inline: true,
      },
    )
    .setFooter({ text: "PZ DayZ Bot" })
    .setTimestamp(new Date());

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

export function buildLinkCompletedPayload(link: PlayerLink) {
  const locale = normalizeLocale(link.locale);
  const language = locale === "pt" ? "Português" : "English";

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(t(locale, "link.confirmTitle"))
    .setDescription(t(locale, "link.confirmDescription"))
    .addFields(
      {
        name: t(locale, "link.gamertagLabel"),
        value: `\`${link.gamertag}\``,
        inline: true,
      },
      {
        name: t(locale, "link.languageLabel"),
        value: language,
        inline: true,
      },
      {
        name: t(locale, "link.commandsTitle"),
        value: [t(locale, "link.shopCommand"), t(locale, "link.bankCommand")].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: "PZ DayZ Bot" })
    .setTimestamp(new Date());

  return {
    embeds: [embed],
    components: [],
  };
}
