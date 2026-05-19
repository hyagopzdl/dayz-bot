import {
  ActionRowBuilder,
  ButtonBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  createShopOrder,
  findSavedShopLocation,
  getShopItems,
  parseShopCoordinates,
  saveShopLocation,
} from "../../../shop";
import {
  buildShopCategoryPayload,
  buildShopCheckoutPayload,
  buildShopHomePayload,
  buildShopItemPayload,
  buildShopOrderCreatedPayload,
  buildShopLinkRequiredPayload,
  createPendingShopCheckout,
  findPendingShopCheckout,
  formatShopClosedMessage,
  removePendingShopCheckout,
  respondShopOrderConfirmation,
  showShopCheckoutConfirmation,
} from "./ui";
import { getPlayerLinkByDiscordId } from "../../../playerLinks";

export type ShopInteractionContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

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

function hasLinkedGamertag(state: any, discordUserId: string) {
  return Boolean(getPlayerLinkByDiscordId(state, discordUserId));
}

export async function handleShopInteraction(interaction: any, ctx: ShopInteractionContext) {
  if (interaction.isStringSelectMenu()) {
    const state = await ctx.getState();

    if (interaction.customId === "shop-category") {
      await interaction.update(
        buildShopCategoryPayload(state, interaction.values[0]),
      );
      return true;
    }

    if (interaction.customId.startsWith("shop-item:")) {
      const categoryId = interaction.customId.split(":")[1];
      await interaction.update(
        buildShopItemPayload(state, interaction.values[0], categoryId, interaction.user.id),
      );
      return true;
    }

    if (interaction.customId.startsWith("shop-location:")) {
      const [, itemId, categoryId] = interaction.customId.split(":");
      const selectedLocationId = interaction.values[0] === "custom" ? undefined : interaction.values[0];
      await interaction.update(
        buildShopItemPayload(
          state,
          itemId,
          categoryId,
          interaction.user.id,
          selectedLocationId,
        ),
      );
      return true;
    }
  }

  if (interaction.isButton()) {
    const state = await ctx.getState();

    if (interaction.customId === "shop-back-home") {
      await interaction.update(buildShopHomePayload(state));
      return true;
    }

    if (interaction.customId.startsWith("shop-back-category:")) {
      const categoryId = interaction.customId.split(":")[1];
      await interaction.update(buildShopCategoryPayload(state, categoryId));
      return true;
    }

    if (interaction.customId === "shop-cancel") {
      await interaction.update({
        content: "🛒 Shop closed.",
        embeds: [],
        components: [],
      });
      return true;
    }

    if (interaction.customId.startsWith("shop-confirm-cancel:")) {
      await safeDeferUpdate(interaction);
      const checkoutId = interaction.customId.split(":")[1];
      removePendingShopCheckout(state, checkoutId);
      await ctx.saveState(state);
      await interaction.editReply({
        content: "🛒 Purchase cancelled.",
        embeds: [],
        components: [],
        files: [],
      });
      return true;
    }

    if (interaction.customId.startsWith("shop-confirm:")) {
      await safeDeferUpdate(interaction);
      const checkoutId = interaction.customId.split(":")[1];
      const checkout = findPendingShopCheckout(
        state,
        checkoutId,
        interaction.user.id,
      );

      if (!checkout) {
        await interaction.editReply({
          content: "❌ This confirmation expired. Open the shop and try again.",
          embeds: [],
          components: [],
          files: [],
        });
        return true;
      }

      if (!hasLinkedGamertag(state, interaction.user.id)) {
        await interaction.editReply(buildShopLinkRequiredPayload(state, interaction.user.id));
        return true;
      }

      const closedMessage = formatShopClosedMessage(state);
      if (closedMessage) {
        await interaction.editReply({ content: closedMessage, embeds: [], components: [], files: [] });
        return true;
      }

      try {
        if (checkout.saveLocationName) {
          saveShopLocation({
            state,
            discordUserId: interaction.user.id,
            name: checkout.saveLocationName,
            x: checkout.x,
            y: checkout.y,
            z: checkout.z,
          });
        }

        const order = createShopOrder({
          state,
          discordUserId: interaction.user.id,
          itemInput: checkout.itemId,
          x: checkout.x,
          y: checkout.y,
          z: checkout.z,
        });

        removePendingShopCheckout(state, checkoutId);
        await ctx.saveState(state);

        await respondShopOrderConfirmation(
          interaction,
          buildShopOrderCreatedPayload({
            state,
            checkout,
            order,
          }),
        );
      } catch (err: any) {
        await interaction.editReply({
          content: `❌ ${err?.message || err}`,
          embeds: [],
          components: [],
          files: [],
        });
      }
      return true;
    }

    if (interaction.customId.startsWith("shop-buy-ui:")) {
      if (!hasLinkedGamertag(state, interaction.user.id)) {
        await interaction.reply({ ...buildShopLinkRequiredPayload(state, interaction.user.id), ephemeral: true });
        return true;
      }

      const closedMessage = formatShopClosedMessage(state);
      if (closedMessage) {
        await interaction.reply({ content: closedMessage, ephemeral: true });
        return true;
      }

      const [, itemId, locationId = "custom"] = interaction.customId.split(":");
      const item = getShopItems().find((candidate) => candidate.id === itemId);
      if (!item) {
        await interaction.reply({ content: "❌ Item not found.", ephemeral: true });
        return true;
      }

      if (locationId !== "custom") {
        const location = findSavedShopLocation(state, interaction.user.id, locationId);
        if (!location) {
          await interaction.reply({
            content: "❌ Saved coordinate not found. Select another delivery location.",
            ephemeral: true,
          });
          return true;
        }

        try {
          await safeDeferUpdate(interaction);
          const checkout = createPendingShopCheckout({
            state,
            discordUserId: interaction.user.id,
            itemId,
            x: location.x,
            y: location.y,
            z: location.z,
            saveLocationName: location.name,
          });

          await ctx.saveState(state);
          await showShopCheckoutConfirmation(interaction, state, checkout);
        } catch (err: any) {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `❌ ${err?.message || err}`, embeds: [], components: [], files: [] });
          } else {
            await interaction.reply({
              ephemeral: true,
              content: `❌ ${err?.message || err}`,
            });
          }
        }
        return true;
      }

      const modal = new ModalBuilder()
        .setCustomId(`shop-modal:${item.id}`)
        .setTitle(`Buy ${item.name}`);

      const coords = new TextInputBuilder()
        .setCustomId("coords")
        .setLabel("Coordinates (iZurvive: x / z or x y z)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("4579.03 / 8506.52");

      const saveName = new TextInputBuilder()
        .setCustomId("save_location_name")
        .setLabel("Save coordinate as (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("Base Principal");

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(coords),
        new ActionRowBuilder<TextInputBuilder>().addComponents(saveName),
      );

      await interaction.showModal(modal);
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("shop-modal:")) {
      await safeDeferReply(interaction);
      const itemId = interaction.customId.split(":")[1];
      const coordsInput = interaction.fields.getTextInputValue("coords");
      const saveLocationName = interaction.fields.getTextInputValue("save_location_name") || "";
      const state = await ctx.getState();

      if (!hasLinkedGamertag(state, interaction.user.id)) {
        await interaction.editReply(buildShopLinkRequiredPayload(state, interaction.user.id));
        return true;
      }

      try {
        const { x, y, z } = parseShopCoordinates(coordsInput, 0);
        const checkout = createPendingShopCheckout({
          state,
          discordUserId: interaction.user.id,
          itemId,
          x,
          y,
          z,
          saveLocationName,
        });

        await ctx.saveState(state);
        await showShopCheckoutConfirmation(interaction, state, checkout);
      } catch (err: any) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: `❌ ${err?.message || err}`, embeds: [], components: [], files: [] });
        } else {
          await interaction.reply({
            ephemeral: true,
            content: `❌ ${err?.message || err}`,
          });
        }
      }
      return true;
    }
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "shop") {
    await safeDeferReply(interaction);
    const state = await ctx.getState();

    if (!hasLinkedGamertag(state, interaction.user.id)) {
      await interaction.editReply(buildShopLinkRequiredPayload(state, interaction.user.id));
      return true;
    }

    await interaction.editReply(buildShopHomePayload(state));
    return true;
  }

  return false;
}
