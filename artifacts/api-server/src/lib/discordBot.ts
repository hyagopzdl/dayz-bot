import { createDiscordClient } from "./discord/client";
import { resolveDiscordChannels } from "./discord/channels";
import { createDiscordStateAccess } from "./discord/stateAccess";
import { registerDiscordCommands } from "./discord/commands";
import { createDiscordFeedRuntime } from "./discord/modules/feeds/runtime";
import { registerInteractionHandlers } from "./discord/interactions";
import { registerSecondaryManagedServerInteractions } from "./discord/secondaryInteractions";
import { registerMemberFeed } from "./discord/modules/memberFeed";
import { applyServiceSettingsToCommandSettings } from "./serviceSettings";
import { getPrimaryServerId, listManagedServers } from "./serverRegistry";
import { getServerRuntimeContext } from "./serverRuntime";

const client = createDiscordClient();
const managedFeedRuntimes = new Map<string, ReturnType<typeof createDiscordFeedRuntime>>();
const registeredMemberFeedServers = new Set<string>();

export function getDiscordClient() {
  return client;
}

export { registerKillStreakFromKill } from "./discord/modules/killstreak/service";

export async function syncDiscordCommandsForManagedServer(serverId: string) {
  const scope = serverId === getPrimaryServerId() ? "full" : "core";
  let settings: ReturnType<typeof applyServiceSettingsToCommandSettings> | undefined;

  // Phase 17B: command settings are data-plane state and do not require the
  // Nitrado runtime activation gate. Every bound guild can therefore use its
  // identity/economy/core command surface during onboarding or runtime pauses.
  const stateAccess = createDiscordStateAccess(serverId);
  const commandState = await stateAccess.getState();
  settings = applyServiceSettingsToCommandSettings(
    commandState.discordCommandSettings,
    commandState.serviceSettings,
  );

  await registerDiscordCommands(client, settings, serverId, scope);
  if (client.isReady?.() && serverId !== getPrimaryServerId()) {
    await ensureManagedServerFeedRuntime(serverId);
  }
}

async function ensureManagedServerFeedRuntime(serverId: string) {
  if (serverId === getPrimaryServerId()) return managedFeedRuntimes.get(serverId);
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
    await feeds.updateLeaderboard();
    console.log(`✅ Discord feed runtime server-scoped ativo [${serverId}]`);
    return feeds;
  } catch (error) {
    // Channels are optional during onboarding. Commands remain available and the
    // feed runtime will be retried by command sync / the next runtime cycle.
    console.log(`ℹ️ Discord feed runtime aguardando canais [${serverId}]`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function refreshDiscordFeedsForManagedServer(serverId: string) {
  if (!client.isReady?.()) return false;
  if (serverId === getPrimaryServerId()) {
    const feeds = managedFeedRuntimes.get(serverId);
    if (!feeds) return false;
    await feeds.updateLeaderboard();
    return true;
  }
  const feeds = managedFeedRuntimes.get(serverId) || await ensureManagedServerFeedRuntime(serverId);
  if (!feeds) return false;
  await feeds.updateLeaderboard();
  return true;
}

async function syncSecondaryManagedServerCommands() {
  const servers = listManagedServers().filter((server) => !server.primary && server.enabled && server.integrations.discordGuildId);
  for (const server of servers) {
    try {
      await syncDiscordCommandsForManagedServer(server.id);
      await ensureManagedServerFeedRuntime(server.id);
    } catch (error) {
      console.error(`❌ erro sincronizando comandos Discord [${server.id}]:`, error);
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

export async function startDiscordBot(serverId = getPrimaryServerId()) {
  const runtime = getServerRuntimeContext(serverId);
  if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não definido");
    return;
  }

  client.once("ready", async () => {
    console.log(`🤖 Discord conectado para ${runtime.server.name} (${serverId})`);

    // Register the secondary interaction router before any primary feed/channel
    // initialization. A failure while resolving the primary runtime must never
    // leave another connected guild with slash commands but no handler.
    registerSecondaryManagedServerInteractions(client);

    // Slash commands are an integration/onboarding concern, not a gameplay
    // runtime-readiness concern. Any enabled managed server with a bound guild
    // must receive its command surface after every bot restart.
    await syncSecondaryManagedServerCommands();
    registerManagedServerMemberFeeds();

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

    await syncDiscordCommandsForManagedServer(serverId);
    await feeds.updateLeaderboard();

  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
