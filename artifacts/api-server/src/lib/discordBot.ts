import { createDiscordClient } from "./discord/client";
import { resolveDiscordChannels } from "./discord/channels";
import { createDiscordStateAccess } from "./discord/stateAccess";
import { registerDiscordCommands } from "./discord/commands";
import { createDiscordFeedRuntime } from "./discord/modules/feeds/runtime";
import { registerInteractionHandlers } from "./discord/interactions";
import { registerManagedServerDataInteractions } from "./discord/secondaryInteractions";
import { registerMemberFeed } from "./discord/modules/memberFeed";
import { applyServiceSettingsToCommandSettings, DEFAULT_SERVICE_SETTINGS } from "./serviceSettings";
import { normalizeDiscordCommandSettings } from "./discord/commandSettings";
import { listManagedServers } from "./serverRegistry";
import { getServerRuntimeContext } from "./serverRuntime";

const client = createDiscordClient();
const managedFeedRuntimes = new Map<string, ReturnType<typeof createDiscordFeedRuntime>>();
const registeredMemberFeedServers = new Set<string>();
const registeredInteractionServers = new Set<string>();
let discordLoginInFlight: Promise<unknown> | null = null;
let discordReadyAt: string | null = null;
let discordLastLoginError: string | null = null;
let discordGatewayReady = false;

function getDiscordToken() {
  return String(process.env.DISCORD_TOKEN || "").trim();
}

function describeDiscordError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function getRequestedIntentBitfield() {
  const intents = client.options.intents as unknown as { bitfield?: unknown };
  return typeof intents?.bitfield === "bigint" || typeof intents?.bitfield === "number" || typeof intents?.bitfield === "string"
    ? String(intents.bitfield)
    : null;
}

function isDiscordReady() {
  return discordGatewayReady && client.isReady();
}

client.on("error", (error) => console.error("❌ Discord client error:", describeDiscordError(error)));
client.on("shardError", (error, shardId) => console.error(`❌ Discord shard error [${shardId}]:`, describeDiscordError(error)));
client.on("warn", (message) => console.warn("⚠️ Discord warning:", message));
client.on("invalidated", () => {
  discordGatewayReady = false;
  console.error("❌ Discord session invalidated; Gateway authentication/session was rejected.");
});
client.on("disconnect", (event) => {
  discordGatewayReady = false;
  console.warn("⚠️ Discord Gateway disconnected:", event);
});
client.on("debug", (message) => {
  if (/4014|privileged|intent|invalid token|authentication|session/i.test(message)) {
    console.warn("🔎 Discord Gateway diagnostic:", message);
  }
});

export function getDiscordClient() {
  return client;
}

export function getDiscordGatewayDiagnostics() {
  return {
    ready: isDiscordReady(),
    clientIsReady: client.isReady(),
    gatewayReadyFlag: discordGatewayReady,
    readyAt: discordReadyAt,
    loginInFlight: Boolean(discordLoginInFlight),
    tokenConfigured: Boolean(getDiscordToken()),
    requestedIntentBitfield: getRequestedIntentBitfield(),
    guildCount: client.guilds.cache.size,
    botUserId: client.user?.id || null,
    lastLoginError: discordLastLoginError,
  };
}

export { registerKillStreakFromKill } from "./discord/modules/killstreak/service";

export async function syncDiscordCommandsForServer(serverId: string) {
  const server = listManagedServers().find((item) => item.id === serverId);
  if (!server?.enabled || !server.integrations.discordGuildId) return false;
  const settings = applyServiceSettingsToCommandSettings(
    normalizeDiscordCommandSettings({}),
    DEFAULT_SERVICE_SETTINGS,
  );
  await registerDiscordCommands(
    client,
    settings,
    serverId,
    "all",
    server.integrations.discordGuildId,
  );
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
    console.log(`ℹ️ Discord feed runtime aguardando canais [${serverId}]`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function refreshDiscordFeedsForManagedServer(serverId: string) {
  if (!isDiscordReady()) return false;
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
      client, serverId, getState: stateAccess.getState, saveState: stateAccess.saveState,
      longShotChannel: channels.longShotChannel, killfeedChannel: channels.killfeedChannel,
      killStreakChannel: channels.killStreakChannel, createPlayerStatsEmbed: feeds.createPlayerStatsEmbed,
      updateMatchRanking: feeds.updateMatchRanking, updateLeaderboard: feeds.updateLeaderboard,
      resetRankings: feeds.resetRankings, resetDaily: feeds.resetDaily, resetWeekly: feeds.resetWeekly,
      resetStreaks: feeds.resetStreaks, wipePlayer: feeds.wipePlayer, sendOrEdit: feeds.sendOrEdit,
      deleteBotMessagesFromChannel: feeds.deleteBotMessagesFromChannel, killfeedPageKey: feeds.killfeedPageKey,
      killStreakPageKey: feeds.killStreakPageKey, longShotPageKey: feeds.longShotPageKey,
      createKillFeedEmptyEmbed: feeds.createKillFeedEmptyEmbed, createKillStreakEmptyEmbed: feeds.createKillStreakEmptyEmbed,
      createLongShotEmptyEmbed: feeds.createLongShotEmptyEmbed,
    });
    registeredInteractionServers.add(serverId);
  } catch (error) {
    console.log(`ℹ️ interações Discord aguardando configuração [${serverId}]`, error instanceof Error ? error.message : String(error));
  }
}

async function syncAllManagedServers() {
  const servers = listManagedServers().filter((server) => server.enabled && server.integrations.discordGuildId);
  for (const server of servers) {
    try {
      await syncDiscordCommandsForServer(server.id);
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

async function handleDiscordReady() {
  discordGatewayReady = true;
  discordReadyAt = new Date().toISOString();
  discordLastLoginError = null;
  console.log("🤖 Discord conectado; inicializando servidores vinculados...", {
    botUserId: client.user?.id || null,
    botUsername: client.user?.username || null,
    applicationId: client.application?.id || null,
    oauthClientId: process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_CLIENT_ID || null,
    requestedIntentBitfield: getRequestedIntentBitfield(),
    guildCount: client.guilds.cache.size,
    diagnostics: getDiscordGatewayDiagnostics(),
  });
  try {
    registerManagedServerDataInteractions(client);
    registerManagedServerMemberFeeds();
    await syncAllManagedServers();
    console.log(`✅ Discord multi-tenant pronto (${listManagedServers().length} servidores registrados)`);
  } catch (error) {
    console.error("❌ erro inicializando recursos Discord após READY:", describeDiscordError(error));
  }
}

client.once("clientReady", handleDiscordReady);

export async function startDiscordBot() {
  const token = getDiscordToken();
  if (!token) {
    console.error("❌ DISCORD_TOKEN não definido; OAuth do Discord não substitui o token do bot Gateway.");
    return;
  }
  if (isDiscordReady()) return;
  if (discordLoginInFlight) return discordLoginInFlight;
  discordLoginInFlight = (async () => {
    try {
      console.log("🔐 iniciando login Discord Gateway...", { requestedIntentBitfield: getRequestedIntentBitfield() });
      await client.login(token);
      console.log("✅ login Discord OK; aguardando READY...", getDiscordGatewayDiagnostics());
    } catch (error) {
      discordLastLoginError = describeDiscordError(error);
      console.error("❌ erro ao logar no Discord:", discordLastLoginError);
      throw error;
    } finally {
      discordLoginInFlight = null;
    }
  })();
  return discordLoginInFlight;
}


/** @deprecated Use syncDiscordCommandsForServer. */
export const syncDiscordCommandsForManagedServer = syncDiscordCommandsForServer;
