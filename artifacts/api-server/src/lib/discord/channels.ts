import { Client, TextBasedChannel } from "discord.js";

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

export async function resolveDiscordChannels(client: Client): Promise<DiscordChannels> {
  return {
    globalChannel: await fetchTextChannel(client, process.env.DISCORD_CHANNEL_ID!),
    dailyChannel: await fetchTextChannel(client, process.env.DISCORD_CHANNEL_DAILY_ID!),
    weeklyChannel: await fetchTextChannel(client, process.env.DISCORD_CHANNEL_WEEKLY_ID!),
    onlineListChannel: await fetchOptionalTextChannel(client, process.env.DISCORD_ONLINE_LIST_CHANNEL_ID),
    killfeedChannel: await fetchOptionalTextChannel(client, process.env.DISCORD_KILLFEED_CHANNEL_ID),
    killStreakChannel: await fetchOptionalTextChannel(client, process.env.DISCORD_KILLSTREAK_CHANNEL_ID),
    longShotChannel: await fetchOptionalTextChannel(client, process.env.DISCORD_LONGSHOT_CHANNEL_ID),
    longShotRankingChannel: await fetchOptionalTextChannel(client, process.env.DISCORD_LONGSHOT_RANKING_CHANNEL_ID),
    streakRankingChannel: await fetchOptionalTextChannel(client, process.env.DISCORD_STREAK_RANKING_CHANNEL_ID),
    categoryId: process.env.DISCORD_ONLINE_CHANNEL_ID!,
  };
}
