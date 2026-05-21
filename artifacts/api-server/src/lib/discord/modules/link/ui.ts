import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import type { PlayerLink } from "../../../state";
import { normalizeLocale, t, type Locale } from "../../../i18n";
import { buildErrorEmbed, buildNeutralEmbed, buildSuccessEmbed, buildSystemEmbed } from "../../ui/embeds";

export type LinkPayloadOptions = {
  /** Deprecated: kept for compatibility with handlers. Branding is now centralized in discord/ui. */
  authorName?: string | null;
  authorIconURL?: string | null;
};

function languageName(locale: Locale) {
  return locale === "pt" ? "Português" : "English";
}

export function buildLanguageSelectCustomId(discordId: string) {
  return `link-language:${discordId}`;
}

export function buildLinkConfirmCustomId(discordId: string) {
  return `link-confirm:${discordId}`;
}

export function buildLinkSetupPayload(link: PlayerLink, _options?: LinkPayloadOptions) {
  const locale = normalizeLocale(link.locale);

  const embed = buildSystemEmbed({
    title: t(locale, "link.linkedTitle"),
    description: [
      t(locale, "link.linkedDescription"),
      "",
      `**${t(locale, "link.gamertagLabel")}**`,
      `\`${link.gamertag}\``,
      "",
      `**${t(locale, "link.languageLabel")}**`,
      languageName(locale),
      "",
      t(locale, "link.chooseLanguage"),
    ].join("\n"),
  });

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

export function buildLinkCompletedPayload(link: PlayerLink, _options?: LinkPayloadOptions) {
  const locale = normalizeLocale(link.locale);

  const embed = buildSuccessEmbed({
    title: t(locale, "link.confirmTitle"),
    description: [
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
    ].join("\n"),
  });

  return {
    embeds: [embed],
    components: [],
  };
}

export function buildLinkErrorPayload(locale: Locale | string | undefined | null, message: string, _options?: LinkPayloadOptions) {
  const normalized = normalizeLocale(locale);
  const embed = buildErrorEmbed({
    title: t(normalized, "link.errorTitle"),
    description: message,
  });

  return {
    embeds: [embed],
    components: [],
    ephemeral: true,
  };
}

export function buildUnlinkPayload(locale: Locale | string | undefined | null, _options?: LinkPayloadOptions) {
  const normalized = normalizeLocale(locale);
  const embed = buildNeutralEmbed({
    title: t(normalized, "link.unlinkedTitle"),
    description: t(normalized, "link.unlinked"),
  });

  return {
    embeds: [embed],
    components: [],
    ephemeral: true,
  };
}
