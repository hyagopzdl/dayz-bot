import { linkPlayerToGamertag, setPlayerLocale, unlinkPlayer, getPlayerLinkByDiscordId } from "../../../playerLinks";
import { normalizeLocale, t } from "../../../i18n";
import { buildLanguageSelectCustomId, buildLinkCompletedPayload, buildLinkConfirmCustomId, buildLinkSetupPayload } from "./ui";

export type LinkInteractionContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

function extractUserId(customId: string): string | null {
  return customId.split(":")[1] || null;
}

async function rejectForeignInteraction(interaction: any, ownerId: string) {
  if (interaction.user.id === ownerId) return false;

  await interaction.reply({
    content: t("en", "link.notYourSetup"),
    ephemeral: true,
  });
  return true;
}

export async function handleLinkComponentInteraction(interaction: any, ctx: LinkInteractionContext) {
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("link-language:")) {
    const ownerId = extractUserId(interaction.customId);
    if (!ownerId) return false;
    if (await rejectForeignInteraction(interaction, ownerId)) return true;

    const state = await ctx.getState();
    const locale = normalizeLocale(interaction.values[0]);
    const link = setPlayerLocale(state, interaction.user.id, locale);

    if (!link) {
      await interaction.reply({ content: t(locale, "link.noLinkFound"), ephemeral: true });
      return true;
    }

    await ctx.saveState(state);
    await interaction.update(buildLinkSetupPayload(link));
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith("link-confirm:")) {
    const ownerId = extractUserId(interaction.customId);
    if (!ownerId) return false;
    if (await rejectForeignInteraction(interaction, ownerId)) return true;

    const state = await ctx.getState();
    const link = getPlayerLinkByDiscordId(state, interaction.user.id);
    const locale = normalizeLocale(link?.locale);

    if (!link) {
      await interaction.reply({ content: t(locale, "link.noLinkFound"), ephemeral: true });
      return true;
    }

    await interaction.update(buildLinkCompletedPayload(link));
    return true;
  }

  return false;
}

export async function handleLinkCommand(interaction: any, ctx: LinkInteractionContext) {
  if (interaction.commandName === "link") {
    const gamertag = interaction.options.getString("gamertag", true);
    const state = await ctx.getState();
    const previousLink = getPlayerLinkByDiscordId(state, interaction.user.id);
    const result = linkPlayerToGamertag({
      state,
      discordId: interaction.user.id,
      gamertag,
      locale: previousLink?.locale || "en",
    });

    if (!result.ok) {
      const locale = normalizeLocale(previousLink?.locale);
      const message = result.reason === "GAMERTAG_ALREADY_LINKED"
        ? t(locale, "link.alreadyUsedGamertag")
        : t(locale, "link.invalidGamertag");

      await interaction.reply({ content: `❌ ${message}`, ephemeral: true });
      return true;
    }

    await ctx.saveState(state);
    await interaction.reply(buildLinkSetupPayload(result.link));
    return true;
  }

  if (interaction.commandName === "unlink") {
    const state = await ctx.getState();
    const existing = getPlayerLinkByDiscordId(state, interaction.user.id);
    const locale = normalizeLocale(existing?.locale);
    const removed = unlinkPlayer(state, interaction.user.id);

    if (!removed) {
      await interaction.reply({ content: `❌ ${t(locale, "link.noLinkFound")}`, ephemeral: true });
      return true;
    }

    await ctx.saveState(state);
    await interaction.reply({ content: `✅ ${t(locale, "link.unlinked")}`, ephemeral: true });
    return true;
  }

  return false;
}
