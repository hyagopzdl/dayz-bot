import {
  EmbedBuilder,
  ColorResolvable,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import {
  getShopRuntimeStatus,
  getShopCategories,
  getShopItemsByCategory,
  getShopItems,
  getSavedShopLocations,
} from "../../../shop";
import { generateShopMapPreview } from "../../../shopMapPreview";
import { buildBrandedEmbed } from "../../ui/embeds";
import { getOrCreateWalletForLink, formatCoins } from "../../../economy";
import { normalizeLocale, t } from "../../../i18n";
import { getPlayerLinkByDiscordId } from "../../../playerLinks";

export function formatShopClosedMessage(state: any) {
  const runtime = getShopRuntimeStatus(state);
  if (runtime.canAcceptPurchase) return null;

  return [
    "⚠️ **Shop temporarily closed**",
    "",
    runtime.reason,
    runtime.nextRestartLabel
      ? `Restart window: **${runtime.nextRestartLabel}**`
      : null,
    "",
    "You can browse the catalog, but checkout is locked until the delivery cycle finishes.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildShopHomePayload(state: any) {
  const runtime = getShopRuntimeStatus(state);
  const categories = getShopCategories();

  const embed = new EmbedBuilder()
    .setTitle("🛒 DayZ Shop")
    .setDescription(
      [
        runtime.canAcceptPurchase
          ? "Select a category to browse items."
          : `⚠️ **Checkout closed**\n${runtime.reason}`,
        runtime.nextRestartLabel
          ? `\nNext restart window: **${runtime.nextRestartLabel}**`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setColor(runtime.canAcceptPurchase ? "Green" : "Orange");

  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId("shop-category")
    .setPlaceholder("Select a category")
    .addOptions(
      categories.slice(0, 25).map((category) => ({
        label: category.label,
        value: category.id,
      })),
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        categoryMenu,
      ),
    ],
  };
}

export function buildShopCategoryPayload(state: any, categoryId: string) {
  const runtime = getShopRuntimeStatus(state);
  const items = getShopItemsByCategory(categoryId);
  const categoryLabel = getShopCategories().find((c) => c.id === categoryId)?.label || categoryId;

  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${categoryLabel}`)
    .setDescription(
      items.length
        ? "Produtos disponíveis nesta categoria. Selecione um item no menu abaixo para ver detalhes e comprar."
        : "No items in this category.",
    )
    .setFooter({
      text: runtime.canAcceptPurchase
        ? "Select an item below to continue."
        : "Checkout is currently closed; browsing is still available.",
    })
    .setColor(runtime.canAcceptPurchase ? "Blue" : "Orange");

  const visibleItems = items.slice(0, 9);
  const widestShopName = Math.max(
    18,
    ...visibleItems.map((item) => String(item.name || "").length),
  );

  const itemEmbeds = visibleItems.map((item) => {
    const paddedTitle = String(item.name || "Item").padEnd(widestShopName, " ");
    const description = [
      `💰 **${Number(item.price || 0).toLocaleString("pt-BR")}**`,
      item.description ? String(item.description).slice(0, 120) : "Pronto para entrega no próximo restart.",
    ].join("\n");

    const itemEmbed = new EmbedBuilder()
      .setTitle(paddedTitle)
      .setDescription(description)
      .setColor(runtime.canAcceptPurchase ? "Blue" : "Orange");

    if (item.imageUrl) itemEmbed.setThumbnail(item.imageUrl);
    return itemEmbed;
  });

  const itemMenu = new StringSelectMenuBuilder()
    .setCustomId(`shop-item:${categoryId}`)
    .setPlaceholder("Select an item")
    .setDisabled(!items.length)
    .addOptions(
      (items.length ? items : getShopItems()).slice(0, 25).map((item) => ({
        label: item.name,
        value: item.id,
        description: `$${item.price} • ${item.description || "Entrega no próximo restart"}`.slice(0, 100),
      })),
    );

  const backButton = new ButtonBuilder()
    .setCustomId("shop-back-home")
    .setLabel("Back to categories")
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed, ...itemEmbeds],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(backButton),
    ],
  };
}

export function buildShopItemPayload(
  state: any,
  itemId: string,
  categoryId?: string,
  discordUserId?: string,
  selectedLocationId?: string,
) {
  const runtime = getShopRuntimeStatus(state);
  const item = getShopItems().find((candidate) => candidate.id === itemId);

  if (!item) {
    return {
      content: "❌ Item not found.",
      embeds: [],
      components: [],
    };
  }

  const savedLocations = discordUserId
    ? getSavedShopLocations(state, discordUserId)
    : [];
  const selectedLocation = selectedLocationId
    ? savedLocations.find((location) => location.id === selectedLocationId)
    : null;

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${item.name}`)
    .setDescription(
      [
        item.description || "Delivered on the next restart.",
        "",
        `Class: \`${item.className}\``,
        `Price: **${item.price}**`,
        selectedLocation
          ? `Delivery: **${selectedLocation.name}** — \`${selectedLocation.x}, ${selectedLocation.y}, ${selectedLocation.z}\``
          : savedLocations.length
            ? "Delivery: select a saved coordinate or choose custom."
            : "Delivery: custom coordinate required at checkout.",
        runtime.nextRestartLabel
          ? `Estimated delivery: next restart window **${runtime.nextRestartLabel}**`
          : null,
        runtime.canAcceptPurchase ? null : `\n⚠️ ${runtime.reason}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setColor(runtime.canAcceptPurchase ? "Green" : "Orange");

  if (item.imageUrl) embed.setThumbnail(item.imageUrl);

  const buyButton = new ButtonBuilder()
    .setCustomId(`shop-buy-ui:${item.id}:${selectedLocation?.id || "custom"}`)
    .setLabel(
      runtime.canAcceptPurchase
        ? selectedLocation
          ? `Buy to ${selectedLocation.name}`
          : "Buy with custom coordinate"
        : "Checkout closed",
    )
    .setStyle(runtime.canAcceptPurchase ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!runtime.canAcceptPurchase);

  const backButton = new ButtonBuilder()
    .setCustomId(`shop-back-category:${categoryId || item.category || "misc"}`)
    .setLabel("Back")
    .setStyle(ButtonStyle.Secondary);

  const cancelButton = new ButtonBuilder()
    .setCustomId("shop-cancel")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  const components: any[] = [];

  if (savedLocations.length) {
    const locationMenu = new StringSelectMenuBuilder()
      .setCustomId(`shop-location:${item.id}:${categoryId || item.category || "misc"}`)
      .setPlaceholder("Select delivery coordinate")
      .addOptions([
        ...savedLocations.slice(0, 24).map((location) => ({
          label: location.name,
          value: location.id,
          description: `${location.x}, ${location.y}, ${location.z}`,
          default: location.id === selectedLocation?.id,
        })),
        {
          label: "Custom coordinate",
          value: "custom",
          description: "Type a new iZurvive coordinate during checkout",
          default: !selectedLocation,
        },
      ]);

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(locationMenu),
    );
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      buyButton,
      backButton,
      cancelButton,
    ),
  );

  return {
    embeds: [embed],
    components,
  };
}


export function formatShopMoney(value: unknown) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-US");
}

export function getUserShopBalanceLabel(state: any, discordUserId: string) {
  const link = getPlayerLinkByDiscordId(state, discordUserId);
  if (!link) return "Not linked";

  const { wallet } = getOrCreateWalletForLink(state, link);
  const locale = normalizeLocale(link.locale);
  return `${formatCoins(wallet.balance)} ${t(locale, "economy.coins")}`;
}

export function buildShopLinkRequiredPayload(state: any, discordUserId: string) {
  const link = getPlayerLinkByDiscordId(state, discordUserId);
  const locale = normalizeLocale(link?.locale);

  const embed = buildShopEmbedBase("Orange")
    .setTitle(t(locale, "shop.linkRequiredTitle"))
    .setDescription([
      t(locale, "shop.linkRequiredDescription"),
      "",
      t(locale, "shop.linkRequiredHint"),
    ].join("\n"));

  return {
    embeds: [embed],
    components: [],
    files: [],
  };
}

export function formatShopFooterTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.SHOP_RESTART_TIMEZONE || "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function buildShopEmbedBase(color: ColorResolvable = "Green") {
  return buildBrandedEmbed({
    color,
    footerSuffix: formatShopFooterTime(),
    timestamp: false,
  });
}

export function formatShopCoordinateLabel(checkout: any) {
  return `${Number(checkout.x).toFixed(2)}, ${Number(checkout.y).toFixed(2)}, ${Number(checkout.z).toFixed(2)}`;
}

export function formatShopDeliveryResetLabel(state: any) {
  const runtime = getShopRuntimeStatus(state);

  if (runtime.nextRestartLabel) {
    return `Next scheduled restart (${runtime.nextRestartLabel})`;
  }

  return "Next server restart";
}

export function ensurePendingShopCheckouts(state: any) {
  const now = Date.now();
  const checkouts = Array.isArray(state.shopPendingCheckouts)
    ? state.shopPendingCheckouts
    : [];

  state.shopPendingCheckouts = checkouts.filter((checkout: any) => {
    const expiresAt = new Date(checkout.expiresAt || 0).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now;
  });

  return state.shopPendingCheckouts;
}

export function createPendingShopCheckout(options: {
  state: any;
  discordUserId: string;
  itemId: string;
  x: number;
  y: number;
  z: number;
  saveLocationName?: string;
}) {
  const item = getShopItems().find((candidate) => candidate.id === options.itemId);
  if (!item) throw new Error("Item not found.");

  const checkouts = ensurePendingShopCheckouts(options.state);
  const now = new Date();
  const checkout = {
    id: `checkout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    discordUserId: options.discordUserId,
    itemId: item.id,
    itemClass: item.className,
    itemName: item.name,
    price: item.price,
    x: Number(options.x.toFixed(2)),
    y: Number(options.y.toFixed(2)),
    z: Number(options.z.toFixed(2)),
    saveLocationName: String(options.saveLocationName || "").trim().slice(0, 40) || undefined,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  };

  options.state.shopPendingCheckouts = checkouts.filter(
    (candidate: any) => candidate.discordUserId !== options.discordUserId,
  );
  options.state.shopPendingCheckouts.push(checkout);

  return checkout;
}

export function findPendingShopCheckout(state: any, checkoutId: string, discordUserId: string) {
  const checkouts = ensurePendingShopCheckouts(state);
  return (
    checkouts.find(
      (checkout: any) =>
        checkout.id === checkoutId && checkout.discordUserId === discordUserId,
    ) || null
  );
}

export function removePendingShopCheckout(state: any, checkoutId: string) {
  state.shopPendingCheckouts = ensurePendingShopCheckouts(state).filter(
    (checkout: any) => checkout.id !== checkoutId,
  );
}

export async function buildShopCheckoutPayload(state: any, checkout: any) {
  const runtime = getShopRuntimeStatus(state);
  const item = getShopItems().find((candidate) => candidate.id === checkout.itemId);
  const itemName = checkout.itemName || item?.name || checkout.itemClass;
  const link = getPlayerLinkByDiscordId(state, checkout.discordUserId);
  const locale = normalizeLocale(link?.locale);
  const wallet = link ? getOrCreateWalletForLink(state, link).wallet : null;
  const price = Number(checkout.price || 0);
  const balanceAfter = wallet ? Math.max(0, Number(wallet.balance || 0) - price) : 0;
  const balanceLabel = wallet
    ? `${formatCoins(wallet.balance)} ${t(locale, "economy.coins")}`
    : t(locale, "shop.linkRequiredTitle");
  const balanceAfterLabel = wallet
    ? `${formatCoins(balanceAfter)} ${t(locale, "economy.coins")}`
    : t(locale, "shop.linkRequiredTitle");
  const deliveryLabel = formatShopDeliveryResetLabel(state);

  const embed = buildShopEmbedBase(runtime.canAcceptPurchase ? "Green" : "Orange")
    .setTitle(`Buy ${itemName}`)
    .setDescription(
      runtime.canAcceptPurchase
        ? "Review your purchase details and delivery location before confirming."
        : `Checkout is currently closed. ${runtime.reason}`,
    )
    .addFields(
      {
        name: t(locale, "shop.priceLabel"),
        value: `${formatShopMoney(checkout.price)} ${t(locale, "economy.coins")}`,
        inline: true,
      },
      {
        name: t(locale, "shop.balanceLabel"),
        value: balanceLabel,
        inline: true,
      },
      {
        name: t(locale, "shop.balanceAfterLabel"),
        value: balanceAfterLabel,
        inline: true,
      },
      {
        name: "Delivery location",
        value: `\`${formatShopCoordinateLabel(checkout)}\``,
        inline: false,
      },
      {
        name: "Delivery reset",
        value: deliveryLabel,
        inline: false,
      },
    );

  if (checkout.saveLocationName) {
    embed.addFields({
      name: "Saved location",
      value: checkout.saveLocationName,
      inline: false,
    });
  }

  if (item?.imageUrl) embed.setThumbnail(item.imageUrl);

  const confirmButton = new ButtonBuilder()
    .setCustomId(`shop-confirm:${checkout.id}`)
    .setLabel(runtime.canAcceptPurchase ? "Confirm purchase" : "Checkout closed")
    .setStyle(runtime.canAcceptPurchase ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!runtime.canAcceptPurchase);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`shop-confirm-cancel:${checkout.id}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  const payload: any = {
    content: "",
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton),
    ],
  };

  try {
    const preview = await generateShopMapPreview({
      x: Number(checkout.x),
      z: Number(checkout.z),
    });
    const attachment = new AttachmentBuilder(preview.buffer, {
      name: preview.filename,
    });
    embed.setImage(`attachment://${preview.filename}`);
    payload.files = [attachment];
  } catch (err) {
    console.error("❌ erro gerando preview do mapa da shop:", err);
    embed.addFields({
      name: "Map preview",
      value: "The delivery map preview could not be generated, but you can still confirm the purchase.",
    });
  }

  return payload;
}

export async function showShopCheckoutConfirmation(interaction: any, state: any, checkout: any) {
  const payload = await buildShopCheckoutPayload(state, checkout);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }

  try {
    if (typeof interaction.update === "function") {
      await interaction.update(payload);
      return;
    }
  } catch (err) {
    console.error("❌ erro atualizando confirmação da shop:", (err as any)?.message || err);
  }

  await interaction.reply({
    ...payload,
    ephemeral: true,
  });
}

export function buildShopInsufficientBalancePayload(options: {
  state: any;
  discordUserId: string;
  checkout: any;
}) {
  const link = getPlayerLinkByDiscordId(options.state, options.discordUserId);
  const locale = normalizeLocale(link?.locale);
  const wallet = link ? getOrCreateWalletForLink(options.state, link).wallet : null;
  const required = Number(options.checkout?.price || 0);
  const current = Number(wallet?.balance || 0);

  const embed = buildShopEmbedBase("Red")
    .setTitle(t(locale, "shop.insufficientBalanceTitle"))
    .setDescription([
      t(locale, "shop.insufficientBalanceDescription"),
      "",
      `**${t(locale, "shop.requiredLabel")}:** ${formatCoins(required)} ${t(locale, "economy.coins")}`,
      `**${t(locale, "shop.currentLabel")}:** ${formatCoins(current)} ${t(locale, "economy.coins")}`,
    ].join("\n"));

  return {
    content: "",
    embeds: [embed],
    components: [],
    files: [],
  };
}

export function buildShopProcessingPayload(state: any, discordUserId: string) {
  const link = getPlayerLinkByDiscordId(state, discordUserId);
  const locale = normalizeLocale(link?.locale);

  const embed = buildShopEmbedBase("Orange")
    .setTitle(t(locale, "shop.processingTitle"))
    .setDescription(t(locale, "shop.processingDescription"));

  return {
    content: "",
    embeds: [embed],
    components: [],
    files: [],
  };
}

export function buildShopOrderCreatedPayload(options: {
  state: any;
  checkout: any;
  order: any;
}) {
  const item = getShopItems().find(
    (candidate) => candidate.id === options.checkout.itemId,
  );
  const itemName =
    options.checkout.itemName ||
    item?.name ||
    options.order.itemName ||
    options.order.itemClass;

  const embed = buildShopEmbedBase("Green")
    .setTitle("Purchase confirmed")
    .setDescription(
      "Your shop order was created successfully. It will be included in the next delivery cycle.",
    )
    .addFields(
      {
        name: "Item",
        value: itemName,
        inline: true,
      },
      {
        name: "Order",
        value: `\`${options.order.id}\``,
        inline: true,
      },
      {
        name: "Status",
        value: `\`${options.order.status}\``,
        inline: false,
      },
    );

  if (item?.imageUrl) embed.setThumbnail(item.imageUrl);

  return {
    content: "",
    embeds: [embed],
    components: [],
    files: [],
  };
}

export async function respondShopOrderConfirmation(interaction: any, payload: any) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }

  try {
    if (typeof interaction.update === "function") {
      await interaction.update(payload);
      return;
    }
  } catch (err) {
    console.error("❌ erro atualizando mensagem da shop:", (err as any)?.message || err);
  }

  try {
    if (interaction.message?.edit) {
      await interaction.message.edit(payload);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate?.();
      }
      return;
    }
  } catch (err) {
    console.error("❌ erro editando mensagem original da shop:", (err as any)?.message || err);
  }

  await interaction.reply({ ephemeral: true, ...payload });
}
