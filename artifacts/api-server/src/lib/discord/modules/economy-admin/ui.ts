import { EmbedBuilder } from "discord.js";
import type { EconomyTransaction, PlayerLink, Wallet } from "../../../state";
import { formatCoins } from "../../../economy";
import { normalizeLocale, t, type Locale } from "../../../i18n";
import { BOT_ICON, BOT_NAME } from "../../constants";

const COLORS = {
  success: 0x22c55e,
  danger: 0xef4444,
};

export type EconomyAdminAuthorOptions = {
  authorName?: string | null;
  authorIconURL?: string | null;
};

function applyAuthor(embed: EmbedBuilder, options?: EconomyAdminAuthorOptions) {
  return embed.setAuthor({
    name: options?.authorName || BOT_NAME,
    iconURL: options?.authorIconURL || BOT_ICON,
  });
}

export function buildEconomyAdminSuccessPayload(params: {
  locale?: Locale | string | null;
  link: PlayerLink;
  wallet: Wallet;
  transaction: EconomyTransaction;
  actionLabel: string;
  options?: EconomyAdminAuthorOptions;
}) {
  const locale = normalizeLocale(params.locale);
  const embed = applyAuthor(
    new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(t(locale, "economy.adminTitle"))
      .setDescription([
        `**${t(locale, "economy.adminActionLabel")}**`,
        params.actionLabel,
        "",
        `**${t(locale, "economy.adminPlayerLabel")}**`,
        `\`${params.link.gamertag}\``,
      ].join("\n"))
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
      )
      .setFooter({ text: BOT_NAME })
      .setTimestamp(new Date()),
    params.options,
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

export function buildEconomyAdminErrorPayload(locale: Locale | string | null | undefined, message: string, options?: EconomyAdminAuthorOptions) {
  const embed = applyAuthor(
    new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle("Economy unavailable")
      .setDescription(message)
      .setFooter({ text: BOT_NAME })
      .setTimestamp(new Date()),
    options,
  );

  return { embeds: [embed], components: [] };
}
