import { PermissionFlagsBits } from "discord.js";
import { addCoins, removeCoins, setCoins } from "../../../economy";
import { normalizeLocale, t } from "../../../i18n";
import { getPlayerLinkByGamertag, searchKnownGamertags } from "../../../playerLinks";
import { buildEconomyAdminErrorPayload, buildEconomyAdminSuccessPayload } from "./ui";

export type EconomyAdminInteractionContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

const ADMIN_COMMANDS = new Set(["addcoins", "removecoins", "setcoins"]);

function userLocaleFromInteraction(interaction: any) {
  return interaction.locale === "pt-BR" || interaction.guildLocale === "pt-BR" ? "pt" : "en";
}

function authorOptions(_interaction: any) {
  // Branding is centralized in discord/ui. This compatibility object is kept so
  // existing handler calls do not need to know how embeds are branded.
  return {};
}

async function safeDeferReply(interaction: any) {
  if (interaction.deferred || interaction.replied) return true;
  await interaction.deferReply({ ephemeral: true });
  return true;
}

function canManageEconomy(interaction: any) {
  if (interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  const roleId = process.env.ECONOMY_ADMIN_ROLE_ID;
  if (!roleId) return false;

  const roles = interaction.member?.roles;
  if (roles?.cache?.has?.(roleId)) return true;
  if (Array.isArray(roles) && roles.includes(roleId)) return true;

  return false;
}

export async function handleEconomyAdminAutocomplete(interaction: any, ctx: EconomyAdminInteractionContext) {
  if (!interaction.isAutocomplete?.()) return false;
  if (!ADMIN_COMMANDS.has(interaction.commandName)) return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "gamertag") return false;

  const state = await ctx.getState();
  const known = searchKnownGamertags(state, String(focused.value || ""), 25);
  const linked = known.filter((gamertag) => Boolean(getPlayerLinkByGamertag(state, gamertag)));

  await interaction.respond(
    linked.slice(0, 25).map((gamertag) => ({
      name: gamertag,
      value: gamertag,
    })),
  );

  return true;
}

export async function handleEconomyAdminCommand(interaction: any, ctx: EconomyAdminInteractionContext) {
  if (!interaction.isChatInputCommand?.()) return false;
  if (!ADMIN_COMMANDS.has(interaction.commandName)) return false;

  await safeDeferReply(interaction);

  const locale = normalizeLocale(userLocaleFromInteraction(interaction));
  const options = authorOptions(interaction);

  if (!canManageEconomy(interaction)) {
    await interaction.editReply(buildEconomyAdminErrorPayload(locale, t(locale, "economy.adminNoPermission"), options));
    return true;
  }

  const amount = Math.floor(Number(interaction.options.getInteger("amount", true) || 0));
  const allowsZero = interaction.commandName === "setcoins";
  if (amount < 0 || (!allowsZero && amount <= 0)) {
    await interaction.editReply(buildEconomyAdminErrorPayload(locale, t(locale, "economy.adminInvalidAmount"), options));
    return true;
  }

  const gamertag = interaction.options.getString("gamertag", true);
  const reason = interaction.options.getString("reason", false) || undefined;
  const state = await ctx.getState();
  const link = getPlayerLinkByGamertag(state, gamertag);

  if (!link) {
    await interaction.editReply(buildEconomyAdminErrorPayload(locale, t(locale, "economy.adminNotLinked"), options));
    return true;
  }

  let result;
  let actionLabel: string;

  if (interaction.commandName === "addcoins") {
    result = addCoins({ state, link, amount, reason, createdBy: interaction.user.id });
    actionLabel = t(locale, "economy.adminAdded");
  } else if (interaction.commandName === "removecoins") {
    result = removeCoins({ state, link, amount, reason, createdBy: interaction.user.id });
    actionLabel = t(locale, "economy.adminRemoved");
  } else {
    result = setCoins({ state, link, amount, reason, createdBy: interaction.user.id });
    actionLabel = t(locale, "economy.adminSet");
  }

  await ctx.saveState(state);
  await interaction.editReply(
    buildEconomyAdminSuccessPayload({
      locale,
      link,
      wallet: result.wallet,
      transaction: result.transaction,
      actionLabel,
      options,
    }),
  );

  return true;
}
