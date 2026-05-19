import { EmbedBuilder } from "discord.js";
import type { PlayerLink, Wallet } from "../../../state";
import { formatCoins } from "../../../economy";
import { normalizeLocale, t } from "../../../i18n";
import { BOT_ICON, BOT_NAME } from "../../constants";

const COLORS = {
  primary: 0xf2c94c,
};

export function buildBankPayload(params: {
  link: PlayerLink;
  wallet: Wallet;
  walletCreated?: boolean;
}) {
  const locale = normalizeLocale(params.link.locale);
  const { link, wallet } = params;

  const description = params.walletCreated ? t(locale, "economy.walletCreated") : undefined;

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: BOT_NAME, iconURL: BOT_ICON })
    .setTitle(t(locale, "economy.bankTitle"));

  if (description) {
    embed.setDescription(description);
  }

  embed.addFields(
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
    )
    .setFooter({ text: BOT_NAME })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [] };
}
