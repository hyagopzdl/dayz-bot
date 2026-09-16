import { createDiscordClient } from "./discord/client";
import { resolveDiscordChannels } from "./discord/channels";
import { createDiscordStateAccess } from "./discord/stateAccess";
import { registerDiscordCommands } from "./discord/commands";
import { createDiscordFeedRuntime } from "./discord/modules/feeds/runtime";
import { registerInteractionHandlers } from "./discord/interactions";
import { registerSecondaryManagedServerInteractions } from "./discord/secondaryInteractions";
import { registerMemberFeed } from "./discord/modules/memberFeed";
import { applyServiceSettingsToCommandSettings, DEFAULT_SERVICE_SETTINGS } from "./serviceSettings";
import { normalizeDiscordCommandSettings } from "./discord/commandSettings";
import { listManagedServers } from "./serverRegistry";
import { getServerRuntimeContext } from "./serverRuntime";

const client = createDiscordClient();
const managedFeedRuntimes = new Map<string, ReturnType<typeof createDiscordFeedRuntime>>();
const registeredMemberFeedServers = new Set<string>();
const registeredInteractionServers = new Set<string>();

export function getDiscordClient() {
  return client;
}

export { registerKillStreakFromKill } from "./discord/modules/killstreak/service";

/**
 * Command registration is deliberately state-free. Every server has the same
 * command surface and tenant state is hydrated only when a real interaction or
 * runtime cycle needs it. This keeps Discord READY cheap as the number of
 * linked servers grows.
 */
export async function syncDiscordCommandsForManagedServer(serverId: string) {
  const server = listManagedServers().find((item) => item.id === serverId);
  if (!server?.enabled || !server.integrations.discordGuildId) return false;

  const settings = applyServiceSettingsToCommandSettings(
    normalizeDiscordCommandSettings({}),
    DEFAULT_SERVICE_SETTINGS,
  );

  await registerDiscordCommands(client, settings, serverId, "core");
  return true;
}

async function ensureManagedServerFeedRuntime(serverId: string) {
  if (managedFeedRuntimes.has(serverId)) return managedFeedRuntimes.get(serverId);

  const server = listManagedServers().find((item) => item.id === serverId);
  if (!server?.enabled || !server.integrations.discordGuildId) return undefined;

  try {
    const channels = await resolveDiscordChannels(client, serverId);
    const stateAccess = createDiscordStateAccess(serverId);
    const feeds = createDiscordFeedRuntime({
      serverId,
      client,
      categoryId: channels.categoryId,
      globalChannel: channels.globalChannel,
      dailyChannel: channels.dailyChannel,
      weeklyChannel: channels.weeklyChannel,
      onlineListChannel: channels.onlineListChannel,
      killfeedChannel: channels.killfeedChannel,
      killStreakChannel: channels.killStreakChannel,
      longShotChannel: channels.longShotChannel,
      longShotRankingChannel: channels.longShotRankingChannel,
      streakRankingChannel: channels.streakRankingChannel,
      getState: stateAccess.getState,
      saveState: stateAccess.saveState,
      saveRuntimeState: stateAccess.saveRuntimeState,
    });

    managedFeedRuntimes.set(serverId, feeds);

    const memberConfig = getServerRuntimeContext(serverId).discord;
    if (!registeredMemberFeedServers.has(serverId) && memberConfig.memberFeedEnabled !== false && memberConfig.memberFeedChannelId) {
      registerMemberFeed(client, serverId);
      registeredMemberFeedServers.add(serverId);
    }

    console.log(`✅ Discord feed runtime preparado [${serverId}]`);
    return feeds;
  } catch (error) {
    console.log(
      `ℹ️ Discord feed runtime aguardando canais [${serverId}]`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

export async function refreshDiscordFeedsForManagedServer(serverId: string) {
  if (!client.isReady?.()) return false;
  const feeds = managedFeedRuntimes.get(serverId) || await ensureManagedServerFeedRuntime(serverId);
  if (!feeds) return false;
  await feeds.updateLeaderboard();
  return true;
}

async function registerManagedServerInteractions(serverId: string) {
  if (registeredInteractionServers.has(serverId)) return;

  const server = listManagedServers().find((item) => item.id === serverId);
  if (!server?.enabled || !server.integrations.discordGuildId) return;

  try {
    const channels = await resolveDiscordChannels(client, serverId);
    const stateAccess = createDiscordStateAccess(serverId);
    const feeds = await ensureManagedServerFeedRuntime(serverId);
    if (!feeds) return;

    registerInteractionHandlers({
      client,
      serverId,
      getState: stateAccess.getState,
      saveState: stateAccess.saveState,
      longShotChannel: channels.longShotChannel,
      killfeedChannel: channels.killfeedChannel,
      killStreakChannel: channels.killStreakChannel,
      createPlayerStatsEmbed: feeds.createPlayerStatsEmbed,
      updateMatchRanking: feeds.updateMatchRanking,
      updateLeaderboard: feeds.updateLeaderboard,
      resetRankings: feeds.resetRankings,
      resetDaily: feeds.resetDaily,
      resetWeekly: feeds.resetWeekly,
      resetStreaks: feeds.resetStreaks,
      wipePlayer: feeds.wipePlayer,
      sendOrEdit: feeds.sendOrEdit,
      deleteBotMessagesFromChannel: feeds.deleteBotMessagesFromChannel,
      killfeedPageKey: feeds.killfeedPageKey,
      killStreakPageKey: feeds.killStreakPageKey,
      longShotPageKey: feeds.longShotPageKey,
      createKillFeedEmptyEmbed: feeds.createKillFeedEmptyEmbed,
      createKillStreakEmptyEmbed: feeds.createKillStreakEmptyEmbed,
      createLongShotEmptyEmbed: feeds.createLongShotEmptyEmbed,
    });

    registeredInteractionServers.add(serverId);
  } catch (error) {
    console.log(
      `ℹ️ interações Discord aguardando configuração [${serverId}]`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function syncAllManagedServers() {
  const servers = listManagedServers().filter(
    (server) => server.enabled && server.integrations.discordGuildId,
  );

  for (const server of servers) {
    try {
      // Keep READY bounded: registration uses persisted configuration only.
      // State-heavy feed updates belong to the runtime scheduler.
      await syncDiscordCommandsForManagedServer(server.id);
      await registerManagedServerInteractions(server.id);
    } catch (error) {
      console.error(`❌ erro inicializando Discord [${server.id}]:`, error);
    }
  }
}

function registerManagedServerMemberFeeds() {
  for (const server of listManagedServers().filter((item) => item.enabled && item.integrations.discordGuildId)) {
    if (registeredMemberFeedServers.has(server.id)) continue;
    const memberConfig = getServerRuntimeContext(server.id).discord;
    if (memberConfig.memberFeedEnabled === false || !memberConfig.memberFeedChannelId) continue;
    try {
      registerMemberFeed(client, server.id);
      registeredMemberFeedServers.add(server.id);
    } catch (error) {
      console.error(`❌ erro inicializando member feed [${server.id}]:`, error);
    }
  }
}

export async function startDiscordBot() {
  if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não definido");
    return;
  }

  if (client.isReady?.()) return;

  client.once("ready", async () => {
    console.log("🤖 Discord conectado; inicializando servidores vinculados...");

    registerSecondaryManagedServerInteractions(client);
    registerManagedServerMemberFeeds();
    await syncAllManagedServers();

    console.log(`✅ Discord multi-tenant pronto (${listManagedServers().length} servidores registrados)`);
  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
