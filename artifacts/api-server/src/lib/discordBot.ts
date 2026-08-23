import { createDiscordClient } from "./discord/client";
import { resolveDiscordChannels } from "./discord/channels";
import { createDiscordStateAccess } from "./discord/stateAccess";
import { registerDiscordCommands } from "./discord/commands";
import { createDiscordFeedRuntime } from "./discord/modules/feeds/runtime";
import { registerInteractionHandlers } from "./discord/interactions";
import { registerSecondaryManagedServerInteractions } from "./discord/secondaryInteractions";
import { startShopStatusMonitor } from "./discord/shopStatusMonitor";
import { startEconomyRewardsLoop } from "./discord/modules/economy/rewardsLoop";
import { registerMemberFeed } from "./discord/modules/memberFeed";
import { applyServiceSettingsToCommandSettings } from "./serviceSettings";
import { canExecuteManagedServerRuntime, getPrimaryServerId, listExecutableManagedServers } from "./serverRegistry";
import { getServerRuntimeContext } from "./serverRuntime";

const client = createDiscordClient();

export function getDiscordClient() {
  return client;
}

export { registerKillStreakFromKill } from "./discord/modules/killstreak/service";

export async function syncDiscordCommandsForManagedServer(serverId: string) {
  const scope = serverId === getPrimaryServerId() ? "full" : "core";
  let settings: ReturnType<typeof applyServiceSettingsToCommandSettings> | undefined;

  // Discord is connected during onboarding, before a new DayZ runtime may be
  // active. Register the safe command surface immediately, but only read
  // server state/settings when the activation gate already allows execution.
  if (canExecuteManagedServerRuntime(serverId)) {
    const stateAccess = createDiscordStateAccess(serverId);
    const commandState = await stateAccess.getState();
    settings = applyServiceSettingsToCommandSettings(
      commandState.discordCommandSettings,
      commandState.serviceSettings,
    );
  }

  await registerDiscordCommands(client, settings, serverId, scope);
}

async function syncSecondaryManagedServerCommands() {
  const servers = listExecutableManagedServers().filter((server) => !server.primary && server.integrations.discordGuildId);
  for (const server of servers) {
    try {
      await syncDiscordCommandsForManagedServer(server.id);
    } catch (error) {
      console.error(`❌ erro sincronizando comandos Discord [${server.id}]:`, error);
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

    registerMemberFeed(client, serverId);

    registerSecondaryManagedServerInteractions(client);

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
    await syncSecondaryManagedServerCommands();
    await feeds.updateLeaderboard();

    startShopStatusMonitor(stateAccess);
    startEconomyRewardsLoop(stateAccess);
    setInterval(() => feeds.updateLeaderboard(), 5 * 60 * 1000);
  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
