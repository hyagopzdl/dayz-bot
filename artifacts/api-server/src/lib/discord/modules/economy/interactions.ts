import { getOrCreateWalletForLink } from "../../../economy";
import { normalizeLocale, t } from "../../../i18n";
import { getPlayerLinkByDiscordId } from "../../../playerLinks";
import { buildBankPayload } from "./ui";

export type EconomyInteractionContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

async function safeDeferReply(interaction: any) {
  if (interaction.deferred || interaction.replied) return true;
  await interaction.deferReply({ ephemeral: true });
  return true;
}

async function editInteractionReply(interaction: any, payload: any) {
  const { ephemeral: _ephemeral, ...editablePayload } = payload || {};
  await interaction.editReply(editablePayload);
}

export async function handleEconomyCommand(interaction: any, ctx: EconomyInteractionContext) {
  if (interaction.commandName !== "bank") return false;

  await safeDeferReply(interaction);

  const state = await ctx.getState();
  const link = getPlayerLinkByDiscordId(state, interaction.user.id);
  const locale = normalizeLocale(link?.locale);

  if (!link) {
    await editInteractionReply(interaction, {
      content: `❌ ${t(locale, "economy.linkRequired")}`,
      embeds: [],
      components: [],
    });
    return true;
  }

  const { wallet, created } = getOrCreateWalletForLink(state, link);
  if (created) {
    await ctx.saveState(state);
  }

  await editInteractionReply(interaction, buildBankPayload({ link, wallet, walletCreated: created }));
  return true;
}
