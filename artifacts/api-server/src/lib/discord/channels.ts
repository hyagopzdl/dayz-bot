import { Client, TextBasedChannel } from "discord.js";
import { getPrimaryServerId } from "../serverRegistry";
import { getServerRuntimeContext } from "../serverRuntime";

export type DiscordChannels = {
  globalChannel: TextBasedChannel;
  dailyChannel: TextBasedChannel;
  weeklyChannel: TextBasedChannel;
  onlineListChannel: TextBasedChannel | null;
  killfeedChannel: TextBasedChannel | null;
  killStreakChannel: TextBasedChannel | null;
  longShotChannel: TextBasedChannel | null;
  longShotRankingChannel: TextBasedChannel | null;
  streakRankingChannel: TextBasedChannel | null;
  categoryId: string;
};

async function fetchTextChannel(client: Client, channelId: string) {
  return (await client.channels.fetch(channelId)) as TextBasedChannel;
}

async function fetchOptionalTextChannel(client: Client, channelId?: string) {
  return channelId ? fetchTextChannel(client, channelId) : null;
}

export async function resolveDiscordChannels(client: Client, serverId = getPrimaryServerId()): Promise<DiscordChannels> {
  const config = getServerRuntimeContext(serverId).discord;
  if (!config.globalChannelId || !config.dailyChannelId || !config.weeklyChannelId || !config.onlineCategoryId) {
    throw new Error(`Discord channel routing is incomplete for server ${serverId}`);
  }
  return {
    globalChannel: await fetchTextChannel(client, config.globalChannelId),
    dailyChannel: await fetchTextChannel(client, config.dailyChannelId),
    weeklyChannel: await fetchTextChannel(client, config.weeklyChannelId),
    onlineListChannel: await fetchOptionalTextChannel(client, config.onlineListChannelId),
    killfeedChannel: await fetchOptionalTextChannel(client, config.killfeedChannelId),
    killStreakChannel: await fetchOptionalTextChannel(client, config.killStreakChannelId),
    longShotChannel: await fetchOptionalTextChannel(client, config.longShotChannelId),
    longShotRankingChannel: await fetchOptionalTextChannel(client, config.longShotRankingChannelId),
    streakRankingChannel: await fetchOptionalTextChannel(client, config.streakRankingChannelId),
    categoryId: config.onlineCategoryId,
  };
}
