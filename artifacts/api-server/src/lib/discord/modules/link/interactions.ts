import { linkPlayerToGamertag, setPlayerLocale, unlinkPlayer, getPlayerLinkByDiscordId } from "../../../playerLinks";
import { normalizeLocale, t } from "../../../i18n";
import { buildLinkCompletedPayload, buildLinkSetupPayload } from "./ui";

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

async function safeDeferReply(interaction: any) {
  if (interaction.deferred || interaction.replied) return true;
  await interaction.deferReply({ ephemeral: true });
  return true;
}

async function safeDeferUpdate(interaction: any) {
  if (interaction.deferred || interaction.replied) return true;
  await interaction.deferUpdate();
  return true;
}

async function editInteractionReply(interaction: any, payload: any) {
  const { ephemeral: _ephemeral, ...editablePayload } = payload || {};
  await interaction.editReply(editablePayload);
}

export async function handleLinkComponentInteraction(interaction: any, ctx: LinkInteractionContext) {
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("link-language:")) {
    const ownerId = extractUserId(interaction.customId);
    if (!ownerId) return false;
    if (await rejectForeignInteraction(interaction, ownerId)) return true;

    await safeDeferUpdate(interaction);

    const state = await ctx.getState();
    const locale = normalizeLocale(interaction.values[0]);
    const link = setPlayerLocale(state, interaction.user.id, locale);

    if (!link) {
      await editInteractionReply(interaction, { content: t(locale, "link.noLinkFound"), embeds: [], components: [] });
      return true;
    }

    await ctx.saveState(state);
    await editInteractionReply(interaction, buildLinkSetupPayload(link));
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith("link-confirm:")) {
    const ownerId = extractUserId(interaction.customId);
    if (!ownerId) return false;
    if (await rejectForeignInteraction(interaction, ownerId)) return true;

    await safeDeferUpdate(interaction);

    const state = await ctx.getState();
    const link = getPlayerLinkByDiscordId(state, interaction.user.id);
    const locale = normalizeLocale(link?.locale);

    if (!link) {
      await editInteractionReply(interaction, { content: t(locale, "link.noLinkFound"), embeds: [], components: [] });
      return true;
    }

    await editInteractionReply(interaction, buildLinkCompletedPayload(link));
    return true;
  }

  return false;
}

export async function handleLinkCommand(interaction: any, ctx: LinkInteractionContext) {
  if (interaction.commandName === "link") {
    await safeDeferReply(interaction);

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

      await editInteractionReply(interaction, { content: `❌ ${message}`, embeds: [], components: [] });
      return true;
    }

    await ctx.saveState(state);
    await editInteractionReply(interaction, buildLinkSetupPayload(result.link));
    return true;
  }

  if (interaction.commandName === "unlink") {
    await safeDeferReply(interaction);

    const state = await ctx.getState();
    const existing = getPlayerLinkByDiscordId(state, interaction.user.id);
    const locale = normalizeLocale(existing?.locale);
    const removed = unlinkPlayer(state, interaction.user.id);

    if (!removed) {
      await editInteractionReply(interaction, { content: `❌ ${t(locale, "link.noLinkFound")}`, embeds: [], components: [] });
      return true;
    }

    await ctx.saveState(state);
    await editInteractionReply(interaction, { content: `✅ ${t(locale, "link.unlinked")}`, embeds: [], components: [] });
    return true;
  }

  return false;
}
