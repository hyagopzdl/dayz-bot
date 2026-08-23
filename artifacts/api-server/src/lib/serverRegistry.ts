import { getDefaultOrganizationId, getOrganizationFoundationDiagnostics } from "./organizationRegistry";
import { getOrganizationIntegrationStatus, getOrganizationIntegrationsDiagnostics } from "./organizationIntegrations";
export type ServerFoundationMode = "single-server-compat";
export type ServerOnboardingStatus = "active" | "draft" | "configured" | "ready";

export type ServerRuntimeActivation = {
  source: "phase12-admin";
  everActivated: true;
  firstActivatedAt: string;
  lastEnabledAt: string;
  lastDisabledAt?: string;
  activationCount: number;
};

export type ServerRuntimeOperations = {
  paused?: boolean;
  pausedAt?: string;
  resumedAt?: string;
  pauseReason?: string;
  source?: "phase14-admin";
};

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

export type ServerNitradoValidation = {
  serviceId: string;
  baseDir: string;
  validatedAt: string;
  source: "phase10-on-demand";
};

export type ServerActivationPreflight = {
  version: "phase11-v1";
  source: "phase11-on-demand";
  checkedAt: string;
  passed: true;
  configurationSignature: string;
  serviceId: string;
  baseDir: string;
  discordGuildId?: string;
  namespaceRows: {
    botState: number;
    playerStats: number;
    positionHistory: number;
  };
  warningCount: number;
};

export type ServerScopedSettings = {
  shopRestartTimes?: string;
  shopRestartTimezone?: string;
  dayzMissionDir?: string;
};

export type ServerRuntimeConfig = {
  nitradoBaseDir?: string;
  nitradoValidation?: ServerNitradoValidation;
  activationPreflight?: ServerActivationPreflight;
  activation?: ServerRuntimeActivation;
  operations?: ServerRuntimeOperations;
  settings?: ServerScopedSettings;
  discord: ServerDiscordRuntimeConfig;
};

export type ManagedServerDescriptor = {
  id: string;
  name: string;
  organizationId: string;
  enabled: boolean;
  primary: boolean;
  runtimeEnabled: boolean;
  onboardingStatus: ServerOnboardingStatus;
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
  draftRows?: number;
  configuredRows?: number;
  readyRows?: number;
  runtimeEnabledRows?: number;
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
  httpContextNamespaced?: boolean;
  playerPortalContextNamespaced?: boolean;
  persistenceRuntimeNamespaced?: boolean;
  positionHistoryNamespaced?: boolean;
  admParserStorageNamespaced?: boolean;
  activationReadiness?: boolean;
  ftpPrimaryGuarded?: boolean;
  discordLoopGuardsNamespaced?: boolean;
  mapSchedulersContextualized?: boolean;
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
    settings: {
      shopRestartTimes: envString("SHOP_RESTART_TIMES") || envString("SERVER_RESTART_TIMES") || "00:00,04:00,08:00,12:00,16:00,20:00",
      shopRestartTimezone: envString("SHOP_RESTART_TIMEZONE") || "America/Sao_Paulo",
      dayzMissionDir: envString("DAYZ_MISSION_DIR") || "dayzps_missions/dayzOffline.chernarusplus",
    },
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

export function buildManagedServerId(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeServerId(value: unknown) {
  const normalized = buildManagedServerId(value);
  return normalized || FALLBACK_SERVER_ID;
}

export function normalizeManagedServerName(value: unknown) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized || FALLBACK_SERVER_NAME;
}


function normalizeServerOnboardingStatus(value: unknown): ServerOnboardingStatus {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "active" || normalized === "configured" || normalized === "ready") return normalized;
  return "draft";
}

export function getServerScopedSettings(serverId = getPrimaryServerId()): Required<ServerScopedSettings> {
  const server = getManagedServerById(serverId) || (serverId === getPrimaryServerId() ? getPrimaryServerDescriptor() : undefined);
  const settings = server?.runtime.settings || {};
  return {
    shopRestartTimes: String(settings.shopRestartTimes || "00:00,04:00,08:00,12:00,16:00,20:00").trim(),
    shopRestartTimezone: String(settings.shopRestartTimezone || "America/Sao_Paulo").trim(),
    dayzMissionDir: String(settings.dayzMissionDir || "dayzps_missions/dayzOffline.chernarusplus").trim(),
  };
}

export function getManagedServerActivationConfigSignature(server: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  // Phase 16 treats Discord as an optional runtime integration. Connecting or
  // changing a guild must never invalidate an already-approved DayZ/Nitrado
  // runtime and silently stop ADM processing. The activation signature therefore
  // protects only the core game routing that can affect ADM/state isolation.
  const payload = {
    nitradoServiceId: String(server.integrations.nitradoServiceId || "").trim(),
    nitradoBaseDir: String(server.runtime.nitradoBaseDir || "").trim(),
  };
  const serialized = JSON.stringify(payload);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `phase16-core-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function hasMatchingManagedServerNitradoValidation(server: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  const serviceId = String(server.integrations.nitradoServiceId || "").trim();
  const baseDir = String(server.runtime.nitradoBaseDir || "").trim();
  const validation = server.runtime.nitradoValidation;
  return Boolean(
    serviceId
    && baseDir
    && validation
    && validation.serviceId === serviceId
    && validation.baseDir === baseDir
    && validation.validatedAt
  );
}

export function hasMatchingActivationPreflight(server: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  const preflight = server.runtime.activationPreflight;
  const serviceId = String(server.integrations.nitradoServiceId || "").trim();
  const baseDir = String(server.runtime.nitradoBaseDir || "").trim();
  return Boolean(
    preflight
    && preflight.passed === true
    && preflight.version === "phase11-v1"
    && serviceId
    && baseDir
    && preflight.serviceId === serviceId
    && preflight.baseDir === baseDir
  );
}


export function isManagedServerRuntimePaused(server: Pick<ManagedServerDescriptor, "runtime">) {
  return server.runtime.operations?.paused === true;
}

export function hasManagedServerRuntimeActivation(server: Pick<ManagedServerDescriptor, "runtime">) {
  const activation = server.runtime.activation;
  return Boolean(
    activation
    && activation.source === "phase12-admin"
    && activation.everActivated === true
    && activation.firstActivatedAt
    && activation.lastEnabledAt
    && Number(activation.activationCount || 0) >= 1
  );
}


export function isServerNamespaceRuntimeSafe() {
  const namespace = getServerNamespacePersistenceStatus();
  return Boolean(
    namespace.initialized
    && namespace.scopedReadsEnabled
    && namespace.botStatePrimaryKeyReady
    && (!namespace.playerStatsTableReady || namespace.playerStatsPrimaryKeyReady)
    && namespace.botStateUntaggedRows === 0
    && (!namespace.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0)
    && namespace.scopedReadFallbacks === 0
  );
}

export function canExecuteManagedServerRuntime(serverId: unknown) {
  const normalized = normalizeServerId(serverId);
  if (normalized === getPrimaryServerId()) return true;
  const server = getManagedServerById(normalized);
  return Boolean(
    server
    && server.enabled
    && server.runtimeEnabled
    && server.onboardingStatus === "ready"
    && hasMatchingManagedServerNitradoValidation(server)
    && hasMatchingActivationPreflight(server)
    && hasManagedServerRuntimeActivation(server)
    && !isManagedServerRuntimePaused(server)
    && isServerNamespaceRuntimeSafe()
  );
}

export function listExecutableManagedServers() {
  return listManagedServers().filter((server) => canExecuteManagedServerRuntime(server.id));
}

export function getPrimaryServerId() {
  return normalizeServerId(process.env.DEFAULT_SERVER_ID || process.env.SERVER_ID || FALLBACK_SERVER_ID);
}

export function getPrimaryServerDescriptor(): ManagedServerDescriptor {
  return {
    id: getPrimaryServerId(),
    name: normalizeManagedServerName(process.env.SERVER_DISPLAY_NAME || process.env.SERVER_NAME || FALLBACK_SERVER_NAME),
    organizationId: getDefaultOrganizationId(),
    enabled: true,
    primary: true,
    runtimeEnabled: true,
    onboardingStatus: "active",
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(process.env.NITRADO_SERVICE_ID || FALLBACK_NITRADO_SERVICE_ID).trim() || undefined,
      discordGuildId: String(process.env.DISCORD_SERVER_ID || process.env.DISCORD_GUILD_ID || "").trim() || undefined,
    },
    runtime: getPrimaryRuntimeConfig(),
  };
}

export function listManagedServers(): ManagedServerDescriptor[] {
  // Phase 11 allows additional servers to exist as draft/configured/ready registry rows,
  // while runtime execution remains explicitly primary-only.
  if (persistedServers.length) return persistedServers.map((server) => ({ ...server, integrations: { ...server.integrations }, runtime: { ...server.runtime, nitradoValidation: server.runtime.nitradoValidation ? { ...server.runtime.nitradoValidation } : undefined, activationPreflight: server.runtime.activationPreflight ? { ...server.runtime.activationPreflight, namespaceRows: { ...server.runtime.activationPreflight.namespaceRows } } : undefined, activation: server.runtime.activation ? { ...server.runtime.activation } : undefined, operations: server.runtime.operations ? { ...server.runtime.operations } : undefined, discord: { ...server.runtime.discord } } }));
  return [getPrimaryServerDescriptor()];
}

export function setPersistedManagedServers(servers: ManagedServerDescriptor[]) {
  persistedServers = servers.map((server) => ({
    id: normalizeServerId(server.id),
    name: normalizeManagedServerName(server.name),
    organizationId: String(server.organizationId || getDefaultOrganizationId()).trim() || getDefaultOrganizationId(),
    enabled: server.enabled !== false,
    primary: Boolean(server.primary),
    runtimeEnabled: Boolean(server.primary ? true : server.runtimeEnabled),
    onboardingStatus: server.primary ? "active" : normalizeServerOnboardingStatus(server.onboardingStatus),
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(server.integrations?.nitradoServiceId || "").trim() || undefined,
      discordGuildId: String(server.integrations?.discordGuildId || "").trim() || undefined,
    },
    runtime: {
      nitradoBaseDir: String(server.runtime?.nitradoBaseDir || "").trim() || undefined,
      nitradoValidation: server.runtime?.nitradoValidation ? { ...server.runtime.nitradoValidation } : undefined,
      activationPreflight: server.runtime?.activationPreflight ? { ...server.runtime.activationPreflight, namespaceRows: { ...server.runtime.activationPreflight.namespaceRows } } : undefined,
      activation: server.runtime?.activation ? { ...server.runtime.activation } : undefined,
      operations: server.runtime?.operations ? { ...server.runtime.operations } : undefined,
      settings: server.runtime?.settings ? { ...server.runtime.settings } : undefined,
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
  const managedServers = listManagedServers();
  const additionalServers = managedServers.filter((candidate) => !candidate.primary);
  return {
    phase: 16,
    mode: server.mode,
    currentServerId: server.id,
    currentServerName: server.name,
    managedServers: managedServers.length,
    additionalServersEnabled: true,
    onboarding: {
      registryWritesEnabled: Boolean(registry.enabled && registry.tableReady),
      canCreateDrafts: Boolean(registry.enabled && registry.tableReady),
      additionalServerRows: additionalServers.length,
      draftServers: additionalServers.filter((candidate) => candidate.onboardingStatus === "draft").length,
      configuredServers: additionalServers.filter((candidate) => candidate.onboardingStatus === "configured").length,
      readyServers: additionalServers.filter((candidate) => candidate.onboardingStatus === "ready").length,
      runtimeEnabledServers: managedServers.filter((candidate) => candidate.runtimeEnabled).length,
      activationPolicy: "ready-opt-in",
      secretsStoredInRegistry: false,
      nitradoDiscoveryEnabled: true,
      nitradoCredentialSource: getOrganizationIntegrationStatus(server.organizationId).credentialSource,
      discordDiscoveryEnabled: true,
      integrationValidationMode: "on-demand",
      activationPreflightEnabled: true,
      activationEndpointEnabled: true,
      playerPortalContextSwitchingEnabled: true,
      operationalHardeningEnabled: true,
      multiTenantFoundationEnabled: true,
      organizationAuthorizationEnabled: true,
      organizationCredentialIsolationEnabled: true,
      serverScopedCommerceSettingsEnabled: true,
      serverScopedShopCatalogEnabled: true,
      manualPauseAvailable: true,
      circuitBreakerMode: "secondary-only-in-memory",
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMinutes: 15,
      preflightMode: "on-demand",
      backgroundPollingAdded: false,
      backgroundRegistryWritesAdded: false,
    },
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
      operationalDatabaseWritesAdded: additionalServers.some((candidate) => canExecuteManagedServerRuntime(candidate.id)),
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
      httpContextNamespaced: Boolean(runtimeIsolationStatus.httpContextNamespaced),
      perServerPersistenceRuntime: Boolean(runtimeIsolationStatus.persistenceRuntimeNamespaced),
      perServerPositionHistory: Boolean(runtimeIsolationStatus.positionHistoryNamespaced),
      perServerAdmParserStorage: Boolean(runtimeIsolationStatus.admParserStorageNamespaced),
      activationReadiness: Boolean(runtimeIsolationStatus.activationReadiness),
      draftRegistrationAvailable: Boolean(registry.enabled && registry.tableReady),
      additionalRuntimeActivationBlocked: false,
      nonPrimaryConfigInheritanceBlocked: true,
      secretsStoredInRegistry: false,
      onDemandRegistryWritesOnly: true,
      backgroundRegistryPollingAdded: false,
      onDemandIntegrationDiscoveryOnly: true,
      nitradoTokenNeverReturnedToBrowser: true,
      activationPreflightGate: true,
      activationEndpointAvailable: true,
      playerPortalContextSwitching: true,
      perServerOperationalHealth: true,
      manualRuntimePause: true,
      secondaryCircuitBreaker: true,
      primaryCircuitBreakerDisabled: true,
      organizationOwnershipRequired: true,
      organizationRbacPrepared: true,
      organizationNitradoCredentialIsolation: true,
      discordCrossOrganizationDiscoveryBlocked: true,
      serverScopedCommerceSettings: true,
      serverScopedShopCatalog: true,
    },
    tenancy: (() => {
      const foundation = getOrganizationFoundationDiagnostics();
      const integrations = getOrganizationIntegrationsDiagnostics();
      return {
        ...foundation,
        phase: 16,
        integrations,
        thirdPartyOnboardingReady: Boolean(foundation.selfServiceEnabled && integrations.encryptionConfigured),
      };
    })(),
    integrations: server.integrations,
  };
}

export function buildFutureServerScopedKey(serverId: string, key: string) {
  return `${normalizeServerId(serverId)}:${String(key || "").trim()}`;
}
