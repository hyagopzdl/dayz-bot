import {
  findKnownGamertag,
  getPlayerLinkByDiscordId,
  linkPlayerToGamertag,
  searchKnownGamertags,
  setPlayerLocale,
  unlinkPlayer,
} from "../../../playerLinks";
import { normalizeLocale, t } from "../../../i18n";
import {
  buildLinkCompletedPayload,
  buildLinkErrorPayload,
  buildLinkSetupPayload,
  buildUnlinkPayload,
  type LinkPayloadOptions,
} from "./ui";

export type LinkInteractionContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

function extractUserId(customId: string): string | null {
  return customId.split(":")[1] || null;
}

function getBotAuthorOptions(interaction: any): LinkPayloadOptions {
  const botUser = interaction.client?.user;
  return {
    authorName: botUser?.username ? `${botUser.username}` : "PZ DayZ Bot",
    authorIconURL: botUser?.displayAvatarURL?.({ size: 128 }) || botUser?.avatarURL?.() || null,
  };
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

export async function handleLinkAutocomplete(interaction: any, ctx: LinkInteractionContext) {
  if (!interaction.isAutocomplete?.() || interaction.commandName !== "link") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "gamertag") {
    await interaction.respond([]);
    return true;
  }

  try {
    const state = await ctx.getState();
    const choices = searchKnownGamertags(state, String(focused.value || ""), 25).map((gamertag) => ({
      name: gamertag.slice(0, 100),
      value: gamertag.slice(0, 100),
    }));

    await interaction.respond(choices);
  } catch (error) {
    console.error("❌ erro no autocomplete de gamertag:", error);
    try {
      await interaction.respond([]);
    } catch {
      // Discord autocomplete interactions expire quickly. Nothing else to do here.
    }
  }

  return true;
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
    const author = getBotAuthorOptions(interaction);

    if (!link) {
      await editInteractionReply(interaction, buildLinkErrorPayload(locale, t(locale, "link.noLinkFound"), author));
      return true;
    }

    await ctx.saveState(state);
    await editInteractionReply(interaction, buildLinkSetupPayload(link, author));
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
    const author = getBotAuthorOptions(interaction);

    if (!link) {
      await editInteractionReply(interaction, buildLinkErrorPayload(locale, t(locale, "link.noLinkFound"), author));
      return true;
    }

    await editInteractionReply(interaction, buildLinkCompletedPayload(link, author));
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
    const locale = normalizeLocale(previousLink?.locale);
    const author = getBotAuthorOptions(interaction);
    const knownGamertag = findKnownGamertag(state, gamertag);

    if (!knownGamertag) {
      await editInteractionReply(
        interaction,
        buildLinkErrorPayload(locale, t(locale, "link.unknownGamertag"), author),
      );
      return true;
    }

    const result = linkPlayerToGamertag({
      state,
      discordId: interaction.user.id,
      gamertag: knownGamertag,
      locale: previousLink?.locale || "en",
    });

    if (!result.ok) {
      const message = result.reason === "GAMERTAG_ALREADY_LINKED"
        ? t(locale, "link.alreadyUsedGamertag")
        : t(locale, "link.invalidGamertag");

      await editInteractionReply(interaction, buildLinkErrorPayload(locale, message, author));
      return true;
    }

    await ctx.saveState(state);
    await editInteractionReply(interaction, buildLinkSetupPayload(result.link, author));
    return true;
  }

  if (interaction.commandName === "unlink") {
    await safeDeferReply(interaction);

    const state = await ctx.getState();
    const existing = getPlayerLinkByDiscordId(state, interaction.user.id);
    const locale = normalizeLocale(existing?.locale);
    const author = getBotAuthorOptions(interaction);
    const removed = unlinkPlayer(state, interaction.user.id);

    if (!removed) {
      await editInteractionReply(interaction, buildLinkErrorPayload(locale, t(locale, "link.noLinkFound"), author));
      return true;
    }

    await ctx.saveState(state);
    await editInteractionReply(interaction, buildUnlinkPayload(locale, author));
    return true;
  }

  return false;
}
