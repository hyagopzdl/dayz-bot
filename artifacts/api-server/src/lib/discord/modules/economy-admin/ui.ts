import type { EconomyTransaction, PlayerLink, Wallet } from "../../../state";
import { formatCoins } from "../../../economy";
import { normalizeLocale, t, type Locale } from "../../../i18n";
import { buildErrorEmbed, buildSuccessEmbed } from "../../ui/embeds";

export type EconomyAdminAuthorOptions = {
  /** Deprecated: kept for compatibility with handlers. Branding is now centralized in discord/ui. */
  authorName?: string | null;
  authorIconURL?: string | null;
};

export function buildEconomyAdminSuccessPayload(params: {
  locale?: Locale | string | null;
  link: PlayerLink;
  wallet: Wallet;
  transaction: EconomyTransaction;
  actionLabel: string;
  options?: EconomyAdminAuthorOptions;
}) {
  const locale = normalizeLocale(params.locale);
  const embed = buildSuccessEmbed({
    title: t(locale, "economy.adminTitle"),
    description: [
      `**${t(locale, "economy.adminActionLabel")}**`,
      params.actionLabel,
      "",
      `**${t(locale, "economy.adminPlayerLabel")}**`,
      `\`${params.link.gamertag}\``,
    ].join("\n"),
  })
    .addFields(
      {
        name: t(locale, "economy.adminAmountLabel"),
        value: `${formatCoins(params.transaction.amount)} ${t(locale, "economy.coins")}`,
        inline: true,
      },
      {
        name: t(locale, "economy.adminBalanceBeforeLabel"),
        value: `${formatCoins(params.transaction.balanceBefore)} ${t(locale, "economy.coins")}`,
        inline: true,
      },
      {
        name: t(locale, "economy.adminBalanceAfterLabel"),
        value: `**${formatCoins(params.wallet.balance)}** ${t(locale, "economy.coins")}`,
        inline: true,
      },
    );

  if (params.transaction.reason) {
    embed.addFields({
      name: t(locale, "economy.adminReasonLabel"),
      value: params.transaction.reason,
      inline: false,
    });
  }

  return { embeds: [embed], components: [] };
}

export function buildEconomyAdminErrorPayload(
  locale: Locale | string | null | undefined,
  message: string,
  _options?: EconomyAdminAuthorOptions,
) {
  const normalized = normalizeLocale(locale);
  const embed = buildErrorEmbed({
    title: t(normalized, "economy.adminUnavailableTitle"),
    description: message,
  });

  return { embeds: [embed], components: [] };
}
