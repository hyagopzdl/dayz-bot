import type { PlayerLink, Wallet } from "../../../state";
import { formatCoins } from "../../../economy";
import { normalizeLocale, t } from "../../../i18n";
import { buildEconomyEmbed, buildErrorEmbed } from "../../ui/embeds";

export function buildBankPayload(params: {
  link: PlayerLink;
  wallet: Wallet;
  walletCreated?: boolean;
}) {
  const locale = normalizeLocale(params.link.locale);
  const { link, wallet } = params;

  const embed = buildEconomyEmbed({
    title: t(locale, "economy.bankTitle"),
    description: params.walletCreated ? t(locale, "economy.walletCreated") : undefined,
  })
    .addFields(
      {
        name: t(locale, "economy.gamertagLabel"),
        value: `\`${link.gamertag}\``,
        inline: true,
      },
      {
        name: t(locale, "economy.balanceLabel"),
        value: `**${formatCoins(wallet.balance)}** ${t(locale, "economy.coins")}`,
        inline: true,
      },
      {
        name: t(locale, "economy.totalEarnedLabel"),
        value: `${formatCoins(wallet.totalEarned)} ${t(locale, "economy.coins")}`,
        inline: true,
      },
      {
        name: t(locale, "economy.totalSpentLabel"),
        value: `${formatCoins(wallet.totalSpent)} ${t(locale, "economy.coins")}`,
        inline: true,
      },
    );

  return { embeds: [embed], components: [] };
}

export function buildBankLinkRequiredPayload(locale: string | null | undefined) {
  const normalized = normalizeLocale(locale);
  const embed = buildErrorEmbed({
    title: t(normalized, "link.errorTitle"),
    description: t(normalized, "economy.linkRequired"),
  });

  return { embeds: [embed], components: [] };
}
