import { Client, ChannelType, PermissionFlagsBits, TextBasedChannel } from "discord.js";
import {
  createShopOrder,
  deployPendingShopOrders,
  clearShopSpawnerAndMarkSpawned,
  formatShopQueue,
  parseShopCoordinates,
  getShopItems,
  getShopResetMonitorPersistenceKey,
} from "../shop";
import { deferEphemeral, respondEphemeral } from "./responses";
import { assertAdmin } from "./permissions";
import { handleShopInteraction } from "./modules/shop/interactions";
import { handleLinkAutocomplete, handleLinkCommand, handleLinkComponentInteraction } from "./modules/link/interactions";
import { handleMapVoteComponentInteraction } from "./modules/map-vote/interactions";
import { handleEconomyCommand } from "./modules/economy/interactions";
import { handleEconomyAdminAutocomplete, handleEconomyAdminCommand } from "./modules/economy-admin/interactions";
import { DISABLED_COMMAND_MESSAGE, isDiscordCommandEnabled } from "./commandSettings";
import { isShopServiceEnabled, SHOP_COMMAND_NAMES } from "../serviceSettings";
import {
  KILLFEED_MESSAGE_PREFIX,
  KILLSTREAK_MESSAGE_PREFIX,
} from "./constants";

type RegisterInteractionHandlersContext = {
  client: Client;
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
  longShotChannel: TextBasedChannel | null;
  killfeedChannel: TextBasedChannel | null;
  killStreakChannel: TextBasedChannel | null;
  createPlayerStatsEmbed: (state: any, playerQuery: string) => any;
  updateMatchRanking: (state: any) => Promise<void>;
  updateLeaderboard: () => Promise<void>;
  resetRankings: () => Promise<void>;
  resetDaily: (state: any) => void;
  resetWeekly: (state: any) => void;
  resetStreaks: (state: any) => void;
  wipePlayer: (state: any, playerName: string) => void;
  sendOrEdit: (state: any, channel: any, key: string, embeds: any[]) => Promise<void>;
  deleteBotMessagesFromChannel: (channel: any) => Promise<void>;
  killfeedPageKey: (pageIndex: number) => string;
  killStreakPageKey: (pageIndex: number) => string;
  longShotPageKey: (pageIndex: number) => string;
  createKillFeedEmptyEmbed: () => any;
  createKillStreakEmptyEmbed: () => any;
  createLongShotEmptyEmbed: () => any;
};

export function registerInteractionHandlers(ctx: RegisterInteractionHandlersContext) {
  const {
    client,
    getState,
    saveState,
    longShotChannel,
    killfeedChannel,
    killStreakChannel,
    createPlayerStatsEmbed,
    updateMatchRanking,
    updateLeaderboard,
    resetRankings,
    resetDaily,
    resetWeekly,
    resetStreaks,
    wipePlayer,
    sendOrEdit,
    deleteBotMessagesFromChannel,
    killfeedPageKey,
    killStreakPageKey,
    longShotPageKey,
    createKillFeedEmptyEmbed,
    createKillStreakEmptyEmbed,
    createLongShotEmptyEmbed,
  } = ctx;

  client.on("interactionCreate", async (interaction) => {
  try {
    if (await handleLinkAutocomplete(interaction, { getState, saveState })) return;
    if (await handleEconomyAdminAutocomplete(interaction, { getState, saveState })) return;
    if (await handleLinkComponentInteraction(interaction, { getState, saveState })) return;
    if (await handleMapVoteComponentInteraction(interaction, { getState, saveState })) return;

    if (interaction.isChatInputCommand()) {
      const commandState = await getState();
      if (SHOP_COMMAND_NAMES.has(interaction.commandName) && !isShopServiceEnabled(commandState)) {
        await interaction.reply({ content: "The shop is currently disabled on this server.", ephemeral: true });
        return;
      }
      if (!isDiscordCommandEnabled(commandState.discordCommandSettings, interaction.commandName)) {
        await interaction.reply({ content: DISABLED_COMMAND_MESSAGE, ephemeral: true });
        return;
      }
    }

    if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith("shop-")) {
      const commandState = await getState();
      if (!isShopServiceEnabled(commandState)) {
        await interaction.reply({ content: "The shop is currently disabled on this server.", ephemeral: true }).catch(() => undefined);
        return;
      }
    }

    if (await handleShopInteraction(interaction, { getState, saveState })) return;

    if (!interaction.isChatInputCommand()) return;
    if (await handleLinkCommand(interaction, { getState, saveState })) return;
    if (await handleEconomyCommand(interaction, { getState, saveState })) return;
    if (await handleEconomyAdminCommand(interaction, { getState, saveState })) return;
    if (interaction.commandName === "player-stats") {
      const player = interaction.options.getString("player", true);
      const state = await getState();

      await interaction.reply({
        embeds: [createPlayerStatsEmbed(state, player)],
        ephemeral: true,
      });

      return;
    }

    const acknowledged = await deferEphemeral(interaction);
    if (!acknowledged) return;

    if (!(await assertAdmin(interaction))) return;

    if (interaction.commandName === "shop-catalog") {
      await interaction.editReply(
        [
          "🛒 **Shop Catalog**",
          "",
          ...getShopItems(true).map(
            (item) =>
              `• **${item.name}** — class \`${item.className}\` — price \`${item.price}\` — ${item.enabled === false ? "disabled" : "enabled"}`,
          ),
        ].join("\n"),
      );
      return;
    }

    if (interaction.commandName === "shop-buy") {
      const state = await getState();
      const item = interaction.options.getString("item", true);
      const coordsInput = interaction.options.getString("coords", true);
      const yOverride = interaction.options.getNumber("y") ?? 0;
      const { x, y, z } = parseShopCoordinates(coordsInput, yOverride);

      const order = createShopOrder({
        state,
        discordUserId: interaction.user.id,
        itemInput: item,
        x,
        y,
        z,
      });

      await saveState(state);

      await interaction.editReply(
        [
          "✅ Shop order created for the next restart.",
          "",
          `Order: \`${order.id}\``,
          `Item: \`${order.itemClass}\``,
          `Position: \`${order.x}, ${order.y}, ${order.z}\``,
          `Status: \`${order.status}\``,
        ].join("\n"),
      );
      return;
    }

    if (interaction.commandName === "shop-queue") {
      const state = await getState();
      await interaction.editReply(formatShopQueue(state));
      return;
    }

    if (interaction.commandName === "shop-deploy") {
      const state = await getState();

      try {
        const result = await deployPendingShopOrders(state);

        if (!result) {
          await interaction.editReply(
            "⚠️ Shop deploy is currently unavailable because the shop or Nitrado system is disabled.",
          );
          return;
        }

        if (result.deployed <= 0) {
          await interaction.editReply(
            `⚠️ ${result.reason || "No pending shop orders to deploy."}`,
          );
          return;
        }

        await saveState(state);

        await interaction.editReply(
          [
            `✅ Injected and verified **${result.deployed}** shop order(s) in the Nitrado XML files.`,
            "",
            `Batch: \`${result.batchId || "unknown"}\``,
            `Path: \`${result.path}\``,
            "",
            "Restart the server after this upload. Orders are only marked as included after the SHOP_BOT blocks are verified on FTP.",
          ].join("\n"),
        );
      } catch (err) {
        console.error("❌ SHOP_BOT manual deploy failed:", err);
        await interaction.editReply(
          [
            "❌ Shop deploy failed before orders were marked as included.",
            "",
            `Reason: \`${String((err as Error)?.message || err).slice(0, 1500)}\``,
            "",
            "No order should be considered spawned from this failed deploy. Check Render logs for the full stack trace.",
          ].join("\n"),
        );
      }

      return;
    }

    if (interaction.commandName === "shop-clear") {
      const state = await getState();

      try {
        const result = await clearShopSpawnerAndMarkSpawned(state);
        await saveState(state);

        await interaction.editReply(
          [
            "✅ Removed verified SHOP_BOT XML blocks.",
            "",
            `Marked **${result.cleared}** included order(s) as spawned.`,
            `Cancelled **${result.cancelled}** pending order(s).`,
            `Path: \`${result.path}\``,
          ].join("\n"),
        );
      } catch (err) {
        console.error("❌ SHOP_BOT manual clear failed:", err);
        await interaction.editReply(
          [
            "❌ Shop clear failed. Orders were not marked as spawned.",
            "",
            `Reason: \`${String((err as Error)?.message || err).slice(0, 1500)}\``,
            "",
            "This usually means SHOP_BOT blocks were already missing from one or both XML files, so the clear was aborted to avoid a false spawned status.",
          ].join("\n"),
        );
      }

      return;
    }

    if (interaction.commandName === "clear-channel") {
      const amount = interaction.options.getInteger("amount") || 100;
      const channel = interaction.channel as any;

      if (!channel || !("messages" in channel)) {
        await interaction.editReply("❌ This channel cannot be cleared.");
        return;
      }

      try {
        const messages = await channel.messages.fetch({ limit: amount });

        const recentMessages = messages.filter((message: any) => {
          const ageMs = Date.now() - message.createdTimestamp;
          const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

          return ageMs < fourteenDaysMs;
        });

        if (recentMessages.size > 0) {
          await channel.bulkDelete(recentMessages, true);
        }

        await interaction.editReply(
          `✅ Cleared ${recentMessages.size} messages.`,
        );
      } catch (err) {
        console.error("❌ erro no /clear-channel:", err);

        await interaction.editReply("❌ Failed to clear channel.");
      }

      return;
    }
    if (interaction.commandName === "wipe-online") {
      const state = await getState();

      state.onlinePlayers = {};
      state.onlineSessions = {};

      await saveState(state);

      await interaction.editReply("✅ Online players cleared.");

      await updateLeaderboard();

      return;
    }

    if (interaction.commandName === "refresh-feeds") {
      const state = await getState();

      await updateLeaderboard();

      await interaction.editReply(
        `✅ Feeds refreshed. Global: ${Object.keys(state.players || {}).length} players • Online: ${Object.keys(state.onlinePlayers || {}).length}`,
      );
      return;
    }

    if (interaction.commandName === "bot-status") {
      const state = await getState();

      const activeMatch = state.activeMatch
        ? `${state.activeMatch.name || state.activeMatch.id} (${state.activeMatch.status || "unknown"})`
        : "None";

      await interaction.editReply(
        [
          "🤖 **Bot Status**",
          "",
          `Global players: **${Object.keys(state.players || {}).length}**`,
          `Daily players: **${Object.keys(state.dailyPlayers || {}).length}**`,
          `Weekly players: **${Object.keys(state.weeklyPlayers || {}).length}**`,
          `Online players: **${Object.keys(state.onlinePlayers || {}).length}**`,
          `Kill feed events: **${(state.killFeedEvents || []).length}**`,
          `Streak events: **${(state.killStreakEvents || []).length}**`,
          `Long shot events: **${(state.longShotEvents || []).length}**`,
          `Message IDs: **${Object.keys(state.discordMessageIds || {}).length}**`,
          `Active match: **${activeMatch}**`,
          "",
          `Daily reset key: **${state.lastDailyReset || "none"}**`,
          `Weekly reset key: **${state.lastWeeklyReset || "none"}**`,
        ].join("\n"),
      );

      return;
    }

    if (interaction.commandName === "wipe-longshots") {
      const state = await getState();

      state.longShotEvents = [];
      state.discordMessageIds = state.discordMessageIds || {};

      for (const key of Object.keys(state.discordMessageIds)) {
        if (
          key.startsWith("message_longshot_page_") ||
          key.includes("longshot")
        ) {
          delete state.discordMessageIds[key];
        }
      }

      if (longShotChannel) {
        await deleteBotMessagesFromChannel(longShotChannel);

        await sendOrEdit(state, longShotChannel, longShotPageKey(0), [
          createLongShotEmptyEmbed(),
        ]);
      }

      await saveState(state);
      await updateLeaderboard();

      await interaction.editReply("✅ Long shot feed and ranking cleared.");
      return;
    }

    if (interaction.commandName === "wipe-killfeed") {
      const state = await getState();

      state.killFeedEvents = [];
      state.discordMessageIds = state.discordMessageIds || {};

      for (const key of Object.keys(state.discordMessageIds)) {
        if (key.startsWith(KILLFEED_MESSAGE_PREFIX)) {
          delete state.discordMessageIds[key];
        }
      }

      if (killfeedChannel) {
        await deleteBotMessagesFromChannel(killfeedChannel);

        await sendOrEdit(state, killfeedChannel, killfeedPageKey(0), [
          createKillFeedEmptyEmbed(),
        ]);
      }

      await saveState(state);
      await updateLeaderboard();

      await interaction.editReply("✅ Kill feed cleared.");
      return;
    }

    if (interaction.commandName === "reset-ranking") {
      await resetRankings();
      await updateLeaderboard();
      await interaction.editReply("✅ Rankings successfully reset.");
      return;
    }

    if (interaction.commandName === "start-match") {
      const state = await getState();

      if (state.activeMatch) {
        await interaction.editReply(
          `❌ There is already a match saved: ${state.activeMatch.name}. Use /stop-match or /delete-match before starting another one.`,
        );
        return;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply(
          "❌ This command must be used inside a server.",
        );
        return;
      }

      const date = new Date().toISOString().slice(0, 10);
      const id = `${Date.now()}`;
      const channelName = `match-${date}`;
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: process.env.DISCORD_MATCH_CATEGORY_ID || undefined,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: client.user!.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ],
      });

      state.activeMatch = {
        id,
        name: channelName,
        channelId: channel.id,
        startedAt: new Date().toISOString(),
        status: "active",
        players: {},
      };

      await updateMatchRanking(state);
      await saveState(state);

      await interaction.editReply(`✅ Match started in <#${channel.id}>.`);
      return;
    }

    if (interaction.commandName === "stop-match") {
      const state = await getState();

      if (!state.activeMatch) {
        await interaction.editReply("❌ There is no match to stop.");
        return;
      }

      if (state.activeMatch.status === "finished") {
        await interaction.editReply(
          "⚠️ The current match is already finished.",
        );
        return;
      }

      state.activeMatch.status = "finished";
      state.activeMatch.endedAt = new Date().toISOString();

      await updateMatchRanking(state);
      await saveState(state);
      await interaction.editReply("🏁 Match stopped and ranking frozen.");
      return;
    }

    if (interaction.commandName === "delete-match") {
      const state = await getState();

      if (!state.activeMatch) {
        await interaction.editReply("❌ There is no match to delete.");
        return;
      }

      try {
        const channel = await client.channels.fetch(
          state.activeMatch.channelId,
        );
        if (channel && "delete" in channel) {
          await (channel as any).delete();
        }
      } catch (err) {
        console.error("❌ erro deletando canal da match", err);
      }

      const matchKeyPrefix = `match_${state.activeMatch.id}_`;
      for (const key of Object.keys(state.discordMessageIds || {})) {
        if (key.startsWith(matchKeyPrefix)) {
          delete state.discordMessageIds[key];
        }
      }

      state.activeMatch = null;
      await saveState(state);
      await interaction.editReply("🗑️ Match channel and data deleted.");
      return;
    }

    if (interaction.commandName === "wipe-daily") {
      const state = await getState();
      resetDaily(state);
      await saveState(state);
      await updateLeaderboard();
      await interaction.editReply("✅ Daily ranking wiped.");
      return;
    }

    if (interaction.commandName === "wipe-weekly") {
      const state = await getState();
      resetWeekly(state);
      await saveState(state);
      await updateLeaderboard();
      await interaction.editReply("✅ Weekly ranking wiped.");
      return;
    }
    if (interaction.commandName === "wipe-streaks") {
      const state = await getState();

      resetStreaks(state);

      state.discordMessageIds = state.discordMessageIds || {};

      for (const key of Object.keys(state.discordMessageIds)) {
        if (key.startsWith(KILLSTREAK_MESSAGE_PREFIX)) {
          delete state.discordMessageIds[key];
        }
      }

      if (killStreakChannel) {
        await deleteBotMessagesFromChannel(killStreakChannel);

        await sendOrEdit(state, killStreakChannel, killStreakPageKey(0), [
          createKillStreakEmptyEmbed(),
        ]);
      }

      await saveState(state);

      await interaction.editReply({
        content: "✅ Kill streak feed wiped successfully.",
      });

      return;
    }
    if (interaction.commandName === "wipe-all") {
      await resetRankings();
      await updateLeaderboard();
      await interaction.editReply("✅ All competitive stats wiped.");
      return;
    }

    if (interaction.commandName === "wipe-player") {
      const player = interaction.options.getString("player", true);
      const state = await getState();
      wipePlayer(state, player);
      await saveState(state);
      await updateLeaderboard();
      await interaction.editReply(`✅ Player wiped: ${player}`);
      return;
    }
  } catch (err) {
    console.error("❌ erro processando comando Discord:", err);
    await respondEphemeral(
      interaction,
      "❌ Command failed. Check Render logs for details.",
    );
  }
});

}
