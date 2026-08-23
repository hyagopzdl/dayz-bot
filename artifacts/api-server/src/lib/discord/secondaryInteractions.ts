import type { Client } from "discord.js";
import { createDiscordStateAccess } from "./stateAccess";
import { handleLinkAutocomplete, handleLinkCommand, handleLinkComponentInteraction } from "./modules/link/interactions";
import { handleEconomyCommand } from "./modules/economy/interactions";
import { handleEconomyAdminAutocomplete, handleEconomyAdminCommand } from "./modules/economy-admin/interactions";
import { handleShopInteraction } from "./modules/shop/interactions";
import { DISABLED_COMMAND_MESSAGE, isDiscordCommandEnabled } from "./commandSettings";
import { isShopServiceEnabled, SHOP_COMMAND_NAMES } from "../serviceSettings";
import { clearShopSpawnerAndMarkSpawned, deployPendingShopOrders, formatShopQueue, getShopItems } from "../shop";
import { ensureShopCatalogLoaded } from "../shopCatalog";
import {
  canExecuteManagedServerRuntime,
  getPrimaryServerId,
  resolveServerIdFromDiscordGuildId,
} from "../serverRegistry";
import { runInServerRuntimeContext } from "../serverRuntime";
import { deferEphemeral } from "./responses";
import { assertAdmin } from "./permissions";

const SECONDARY_ADMIN_SHOP_COMMANDS = new Set(["shop-queue", "shop-deploy", "shop-clear", "shop-catalog"]);

async function replyUnavailable(interaction: any) {
  const payload = { content: "This DayZ server runtime is currently unavailable. Try again after the administrator resumes it.", ephemeral: true };
  if (interaction.isAutocomplete?.()) {
    await interaction.respond([]).catch(() => undefined);
  } else if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: payload.content }).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

async function handleSecondaryInteraction(interaction: any, serverId: string) {
  const stateAccess = createDiscordStateAccess(serverId);
  const ctx = { getState: stateAccess.getState, saveState: stateAccess.saveState };

  if (await handleLinkAutocomplete(interaction, ctx)) return;
  if (await handleEconomyAdminAutocomplete(interaction, ctx)) return;
  if (await handleLinkComponentInteraction(interaction, ctx)) return;

  if (interaction.isChatInputCommand?.()) {
    const state = await stateAccess.getState();
    if (SHOP_COMMAND_NAMES.has(interaction.commandName) && !isShopServiceEnabled(state)) {
      await interaction.reply({ content: "The shop is currently disabled on this server.", ephemeral: true });
      return;
    }
    if (!isDiscordCommandEnabled(state.discordCommandSettings, interaction.commandName)) {
      await interaction.reply({ content: DISABLED_COMMAND_MESSAGE, ephemeral: true });
      return;
    }
  }

  if ((interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.())
    && String(interaction.customId || "").startsWith("shop-")) {
    const state = await stateAccess.getState();
    if (!isShopServiceEnabled(state)) {
      await interaction.reply({ content: "The shop is currently disabled on this server.", ephemeral: true }).catch(() => undefined);
      return;
    }
  }

  if (await handleShopInteraction(interaction, ctx)) return;
  if (!interaction.isChatInputCommand?.()) return;
  if (await handleLinkCommand(interaction, ctx)) return;
  if (await handleEconomyCommand(interaction, ctx)) return;
  if (await handleEconomyAdminCommand(interaction, ctx)) return;

  if (!SECONDARY_ADMIN_SHOP_COMMANDS.has(interaction.commandName)) return;
  const acknowledged = await deferEphemeral(interaction);
  if (!acknowledged || !(await assertAdmin(interaction))) return;

  if (interaction.commandName === "shop-catalog") {
    await ensureShopCatalogLoaded();
    await interaction.editReply([
      "🛒 **Shop Catalog**",
      "",
      ...getShopItems(true).map((item) => `• **${item.name}** — \`${item.price}\` coins — \`${item.className}\``),
    ].join("\n"));
    return;
  }

  const state = await stateAccess.getState();
  if (interaction.commandName === "shop-queue") {
    await interaction.editReply(formatShopQueue(state));
    return;
  }

  if (interaction.commandName === "shop-deploy") {
    const result = await deployPendingShopOrders(state);
    if (!result || result.deployed <= 0) {
      await interaction.editReply(result?.reason || "No pending shop orders to deploy.");
      return;
    }
    await stateAccess.saveState(state);
    await interaction.editReply([
      `✅ Injected and verified **${result.deployed}** order(s) in this server's DayZ XML.`,
      `Batch: \`${result.batchId || "unknown"}\``,
      `Path: \`${result.path}\``,
      "Restart this DayZ server to spawn the included delivery.",
    ].join("\n"));
    return;
  }

  if (interaction.commandName === "shop-clear") {
    const result = await clearShopSpawnerAndMarkSpawned(state);
    await stateAccess.saveState(state);
    await interaction.editReply([
      "✅ SHOP_BOT XML blocks removed from this server.",
      `Spawned: **${result.cleared}** · Cancelled: **${result.cancelled}**`,
      `Path: \`${result.path}\``,
    ].join("\n"));
  }
}

export function registerSecondaryManagedServerInteractions(client: Client) {
  client.on("interactionCreate", async (interaction: any) => {
    const guildId = String(interaction.guildId || "").trim();
    if (!guildId) return;

    const serverId = resolveServerIdFromDiscordGuildId(guildId);
    if (!serverId || serverId === getPrimaryServerId()) return;

    try {
      if (!canExecuteManagedServerRuntime(serverId)) {
        await replyUnavailable(interaction);
        return;
      }

      // Keep the complete interaction (catalog lookup, wallet mutation, order
      // creation and XML deploy included) inside the resolved server context.
      // This is stronger than wrapping only getState/saveState and prevents any
      // helper that calls getActiveServerId() from falling back to the PZ.
      await runInServerRuntimeContext(serverId, () => handleSecondaryInteraction(interaction, serverId));
    } catch (error) {
      console.error(`❌ secondary Discord interaction failed [${serverId}]:`, error);
      if (interaction.isAutocomplete?.()) {
        await interaction.respond([]).catch(() => undefined);
        return;
      }
      const message = `❌ ${String((error as Error)?.message || error).slice(0, 1500)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message }).catch(() => undefined);
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
  });
}
