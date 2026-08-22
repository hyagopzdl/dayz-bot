export type ServerFoundationMode = "single-server-compat";

export type ServerDiscordRuntimeConfig = {
  globalChannelId?: string;
  dailyChannelId?: string;
  weeklyChannelId?: string;
  onlineListChannelId?: string;
  killfeedChannelId?: string;
  killStreakChannelId?: string;
  longShotChannelId?: string;
  longShotRankingChannelId?: string;
  streakRankingChannelId?: string;
  onlineCategoryId?: string;
  matchCategoryId?: string;
  memberFeedChannelId?: string;
  memberFeedEnabled?: boolean;
};

export type ServerRuntimeConfig = {
  nitradoBaseDir?: string;
  discord: ServerDiscordRuntimeConfig;
};

export type ManagedServerDescriptor = {
  id: string;
  name: string;
  enabled: boolean;
  primary: boolean;
  mode: ServerFoundationMode;
  integrations: {
    nitradoServiceId?: string;
    discordGuildId?: string;
  };
  runtime: ServerRuntimeConfig;
};

export type ServerNamespacePersistenceStatus = {
  enabled: boolean;
  initialized: boolean;
  botStateTableReady: boolean;
  playerStatsTableReady: boolean;
  botStateCompositeKeyReady: boolean;
  playerStatsCompositeKeyReady: boolean;
  botStatePrimaryKeyReady: boolean;
  playerStatsPrimaryKeyReady: boolean;
  primaryKeyCutoverComplete: boolean;
  scopedReadsEnabled: boolean;
  scopedReadFallbacks: number;
  lastScopedReadSource?: "server-scoped" | "legacy-fallback" | "legacy";
  botStateTaggedRows: number;
  botStateUntaggedRows: number;
  playerStatsTaggedRows: number;
  playerStatsUntaggedRows: number;
  lastCheckedAt?: string;
  lastError?: string;
};

export type ServerRegistryPersistenceStatus = {
  enabled: boolean;
  initialized: boolean;
  tableReady: boolean;
  primarySeeded: boolean;
  rowsLoaded: number;
  lastLoadedAt?: string;
  lastError?: string;
  configDrift?: {
    name?: boolean;
    nitradoServiceId?: boolean;
    discordGuildId?: boolean;
  };
};

export type ServerRuntimeIsolationStatus = {
  initialized: boolean;
  contextServerId?: string;
  nitradoRoutingNamespaced: boolean;
  discordRoutingNamespaced: boolean;
  processingLockNamespaced: boolean;
  primaryLegacyAdmStoragePreserved: boolean;
  staggerOffsetMs: number;
  activeLocks: number;
  lockSkips: number;
  lastLockServerId?: string;
  lastError?: string;
  executionContextNamespaced?: boolean;
  stateCacheNamespaced?: boolean;
  schedulerCentralized?: boolean;
  admStrategyNamespaced?: boolean;
  contextRuns?: number;
  contextFallbacks?: number;
  lastContextServerId?: string;
};

const FALLBACK_SERVER_ID = "pz-deathmatch";
const FALLBACK_SERVER_NAME = "PZ Deathmatch";
const FALLBACK_NITRADO_SERVICE_ID = "19149785";

let persistedServers: ManagedServerDescriptor[] = [];
let namespacePersistenceStatus: ServerNamespacePersistenceStatus = {
  enabled: Boolean(process.env.DATABASE_URL),
  initialized: false,
  botStateTableReady: false,
  playerStatsTableReady: false,
  botStateCompositeKeyReady: false,
  playerStatsCompositeKeyReady: false,
  botStatePrimaryKeyReady: false,
  playerStatsPrimaryKeyReady: false,
  primaryKeyCutoverComplete: false,
  scopedReadsEnabled: false,
  scopedReadFallbacks: 0,
  botStateTaggedRows: 0,
  botStateUntaggedRows: 0,
  playerStatsTaggedRows: 0,
  playerStatsUntaggedRows: 0,
};

let registryPersistenceStatus: ServerRegistryPersistenceStatus = {
  enabled: Boolean(process.env.DATABASE_URL),
  initialized: false,
  tableReady: false,
  primarySeeded: false,
  rowsLoaded: 0,
};

let runtimeIsolationStatus: ServerRuntimeIsolationStatus = {
  initialized: false,
  nitradoRoutingNamespaced: false,
  discordRoutingNamespaced: false,
  processingLockNamespaced: false,
  primaryLegacyAdmStoragePreserved: true,
  staggerOffsetMs: 0,
  activeLocks: 0,
  lockSkips: 0,
};

function envString(name: string) {
  return String(process.env[name] || "").trim() || undefined;
}

function getPrimaryRuntimeConfig(): ServerRuntimeConfig {
  return {
    nitradoBaseDir: envString("NITRADO_BASE_DIR") || "/games/ni13029176_1/noftp/dayzps/config",
    discord: {
      globalChannelId: envString("DISCORD_CHANNEL_ID"),
      dailyChannelId: envString("DISCORD_CHANNEL_DAILY_ID"),
      weeklyChannelId: envString("DISCORD_CHANNEL_WEEKLY_ID"),
      onlineListChannelId: envString("DISCORD_ONLINE_LIST_CHANNEL_ID"),
      killfeedChannelId: envString("DISCORD_KILLFEED_CHANNEL_ID"),
      killStreakChannelId: envString("DISCORD_KILLSTREAK_CHANNEL_ID"),
      longShotChannelId: envString("DISCORD_LONGSHOT_CHANNEL_ID"),
      longShotRankingChannelId: envString("DISCORD_LONGSHOT_RANKING_CHANNEL_ID"),
      streakRankingChannelId: envString("DISCORD_STREAK_RANKING_CHANNEL_ID"),
      onlineCategoryId: envString("DISCORD_ONLINE_CHANNEL_ID"),
      matchCategoryId: envString("DISCORD_MATCH_CATEGORY_ID"),
      memberFeedChannelId: envString("DISCORD_MEMBER_FEED_CHANNEL_ID"),
      memberFeedEnabled: process.env.DISCORD_MEMBER_FEED_ENABLED !== "false",
    },
  };
}

function normalizeServerId(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || FALLBACK_SERVER_ID;
}

function normalizeServerName(value: unknown) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized || FALLBACK_SERVER_NAME;
}

export function getPrimaryServerId() {
  return normalizeServerId(process.env.DEFAULT_SERVER_ID || process.env.SERVER_ID || FALLBACK_SERVER_ID);
}

export function getPrimaryServerDescriptor(): ManagedServerDescriptor {
  return {
    id: getPrimaryServerId(),
    name: normalizeServerName(process.env.SERVER_DISPLAY_NAME || process.env.SERVER_NAME || FALLBACK_SERVER_NAME),
    enabled: true,
    primary: true,
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(process.env.NITRADO_SERVICE_ID || FALLBACK_NITRADO_SERVICE_ID).trim() || undefined,
      discordGuildId: String(process.env.DISCORD_SERVER_ID || process.env.DISCORD_GUILD_ID || "").trim() || undefined,
    },
    runtime: getPrimaryRuntimeConfig(),
  };
}

export function listManagedServers(): ManagedServerDescriptor[] {
  // Phase 5 still exposes only the primary server operationally. Composite
  // primary keys are being activated, but runtime/Nitrado/Discord routing is
  // not isolated yet, so additional servers remain blocked.
  if (persistedServers.length) return persistedServers.map((server) => ({ ...server, integrations: { ...server.integrations }, runtime: { ...server.runtime, discord: { ...server.runtime.discord } } }));
  return [getPrimaryServerDescriptor()];
}

export function setPersistedManagedServers(servers: ManagedServerDescriptor[]) {
  persistedServers = servers.map((server) => ({
    id: normalizeServerId(server.id),
    name: normalizeServerName(server.name),
    enabled: server.enabled !== false,
    primary: Boolean(server.primary),
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(server.integrations?.nitradoServiceId || "").trim() || undefined,
      discordGuildId: String(server.integrations?.discordGuildId || "").trim() || undefined,
    },
    runtime: {
      nitradoBaseDir: String(server.runtime?.nitradoBaseDir || "").trim() || undefined,
      discord: { ...(server.runtime?.discord || {}) },
    },
  }));
}

export function setServerRegistryPersistenceStatus(status: Partial<ServerRegistryPersistenceStatus>) {
  registryPersistenceStatus = {
    ...registryPersistenceStatus,
    ...status,
    configDrift: status.configDrift
      ? { ...(registryPersistenceStatus.configDrift || {}), ...status.configDrift }
      : registryPersistenceStatus.configDrift,
  };
}


export function setServerNamespacePersistenceStatus(status: Partial<ServerNamespacePersistenceStatus>) {
  namespacePersistenceStatus = {
    ...namespacePersistenceStatus,
    ...status,
  };
}

export function getServerNamespacePersistenceStatus(): ServerNamespacePersistenceStatus {
  return { ...namespacePersistenceStatus };
}

export function getServerRegistryPersistenceStatus(): ServerRegistryPersistenceStatus {
  return {
    ...registryPersistenceStatus,
    configDrift: registryPersistenceStatus.configDrift ? { ...registryPersistenceStatus.configDrift } : undefined,
  };
}

export function getManagedServerById(serverId: unknown): ManagedServerDescriptor | undefined {
  const normalized = normalizeServerId(serverId);
  return listManagedServers().find((server) => server.id === normalized);
}

export function setServerRuntimeIsolationStatus(status: Partial<ServerRuntimeIsolationStatus>) {
  runtimeIsolationStatus = { ...runtimeIsolationStatus, ...status };
}

export function getServerRuntimeIsolationStatus(): ServerRuntimeIsolationStatus {
  return { ...runtimeIsolationStatus };
}

export function resolveServerIdFromDiscordGuildId(guildId: unknown) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return undefined;
  const server = listManagedServers().find((candidate) => candidate.integrations.discordGuildId === normalizedGuildId);
  return server?.id;
}

export function getServerFoundationDiagnostics() {
  const server = getPrimaryServerDescriptor();
  const registry = getServerRegistryPersistenceStatus();
  const namespace = getServerNamespacePersistenceStatus();
  return {
    phase: 7,
    mode: server.mode,
    currentServerId: server.id,
    currentServerName: server.name,
    managedServers: listManagedServers().length,
    additionalServersEnabled: false,
    registryPersisted: registry.initialized && registry.tableReady && registry.primarySeeded,
    persistenceNamespaced: namespace.scopedReadsEnabled && namespace.botStateCompositeKeyReady,
    persistenceTaggedWithServerId: namespace.initialized && namespace.botStateTableReady && namespace.botStateUntaggedRows === 0 && (!namespace.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0),
    parserNamespaced: runtimeIsolationStatus.processingLockNamespaced && Boolean(runtimeIsolationStatus.executionContextNamespaced),
    discordRoutingNamespaced: runtimeIsolationStatus.discordRoutingNamespaced,
    nitradoRoutingNamespaced: runtimeIsolationStatus.nitradoRoutingNamespaced,
    currentDataPathChanged: namespace.scopedReadsEnabled && namespace.botStateCompositeKeyReady,
    registry,
    namespace,
    runtimeIsolation: getServerRuntimeIsolationStatus(),
    safety: {
      legacyStateIdsPreserved: true,
      legacyAdmCursorsPreserved: true,
      legacyDiscordGuildPreserved: true,
      legacyNitradoServicePreserved: true,
      operationalDatabaseWritesAdded: false,
      registryMetadataOnly: false,
      activeReadsStillLegacy: !namespace.scopedReadsEnabled,
      activePrimaryKeysPreserved: false,
      compositePrimaryKeysActive: namespace.primaryKeyCutoverComplete,
      serverIdTaggingOnly: false,
      legacyFallbackAvailable: true,
      compositeUniqueKeysPrepared: namespace.botStateCompositeKeyReady && (!namespace.playerStatsTableReady || namespace.playerStatsCompositeKeyReady),
      perServerExecutionContext: Boolean(runtimeIsolationStatus.executionContextNamespaced),
      perServerStateCache: Boolean(runtimeIsolationStatus.stateCacheNamespaced),
      centralizedScheduler: Boolean(runtimeIsolationStatus.schedulerCentralized),
      perServerAdmStrategy: Boolean(runtimeIsolationStatus.admStrategyNamespaced),
    },
    integrations: server.integrations,
  };
}

export function buildFutureServerScopedKey(serverId: string, key: string) {
  return `${normalizeServerId(serverId)}:${String(key || "").trim()}`;
}
