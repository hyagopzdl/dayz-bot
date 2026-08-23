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
import { refreshManagedServerRegistryFromDb } from "../state";
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

function isLinkInteraction(interaction: any) {
  if (interaction.isAutocomplete?.()) return interaction.commandName === "link";
  if (interaction.isChatInputCommand?.()) return interaction.commandName === "link" || interaction.commandName === "unlink";
  const customId = String(interaction.customId || "");
  return customId.startsWith("link-language:") || customId.startsWith("link-confirm:");
}

async function handleSecondaryLinkInteraction(interaction: any, serverId: string) {
  const stateAccess = createDiscordStateAccess(serverId);
  const ctx = { getState: stateAccess.getState, saveState: stateAccess.saveState };

  // Identity linking must be available as soon as the Discord guild is bound to
  // this managed server. Do not make /link wait for the full runtime activation
  // gate or for command-settings state to load before Discord is acknowledged.
  if (await handleLinkAutocomplete(interaction, ctx)) return true;
  if (await handleLinkComponentInteraction(interaction, ctx)) return true;

  if (interaction.isChatInputCommand?.() && (interaction.commandName === "link" || interaction.commandName === "unlink")) {
    // Acknowledge Discord first. The previous secondary flow loaded the full
    // server state before handleLinkCommand() could defer the interaction,
    // which is why /link could sit on an endless loading state.
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    // Preserve the per-server command toggle, but evaluate it after the
    // interaction has already been acknowledged.
    const state = await stateAccess.getState();
    if (!isDiscordCommandEnabled(state.discordCommandSettings, interaction.commandName)) {
      await interaction.editReply({ content: DISABLED_COMMAND_MESSAGE });
      return true;
    }

    if (await handleLinkCommand(interaction, ctx)) return true;
  }

  return false;
}

async function handleSecondaryInteraction(interaction: any, serverId: string) {
  const stateAccess = createDiscordStateAccess(serverId);
  const ctx = { getState: stateAccess.getState, saveState: stateAccess.saveState };

  if (await handleEconomyAdminAutocomplete(interaction, ctx)) return;

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

    let serverId = resolveServerIdFromDiscordGuildId(guildId);

    try {
      // Discord can be connected after the bot process has already started. If
      // the in-memory registry has not observed that binding yet, refresh it
      // once from Neon before deciding that this guild is unknown.
      if (!serverId) {
        await refreshManagedServerRegistryFromDb();
        serverId = resolveServerIdFromDiscordGuildId(guildId);
      }

      if (!serverId) {
        if (interaction.isAutocomplete?.()) {
          await interaction.respond([]).catch(() => undefined);
        } else if (interaction.isChatInputCommand?.()) {
          await interaction.reply({
            content: "This Discord server is not linked to an ADM DayZ server yet.",
            ephemeral: true,
          }).catch(() => undefined);
        }
        return;
      }

      if (serverId === getPrimaryServerId()) return;

      // /link and /unlink are onboarding-safe identity operations. Route them
      // immediately in the guild-resolved server context so they acknowledge
      // Discord before any full runtime readiness checks or settings reads.
      if (isLinkInteraction(interaction)) {
        await runInServerRuntimeContext(serverId, () => handleSecondaryLinkInteraction(interaction, serverId!));
        return;
      }

      if (!canExecuteManagedServerRuntime(serverId)) {
        await replyUnavailable(interaction);
        return;
      }

      // Keep the complete interaction (catalog lookup, wallet mutation, order
      // creation and XML deploy included) inside the resolved server context.
      // This is stronger than wrapping only getState/saveState and prevents any
      // helper that calls getActiveServerId() from falling back to the PZ.
      await runInServerRuntimeContext(serverId, () => handleSecondaryInteraction(interaction, serverId!));
    } catch (error) {
      console.error(`❌ secondary Discord interaction failed [${serverId || "unresolved"}]:`, error);
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
