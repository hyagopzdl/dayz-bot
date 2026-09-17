import { getDefaultOrganizationId, getOrganizationFoundationDiagnostics } from "./organizationRegistry";
import { getOrganizationIntegrationStatus, getOrganizationIntegrationsDiagnostics } from "./organizationIntegrations";

export type ServerFoundationMode = "multi-server-native";
export type ServerOnboardingStatus = "active" | "draft" | "configured" | "ready";
export type ServerRuntimeActivation = {
  source: "phase12-admin";
  everActivated: true;
  firstActivatedAt: string;
  lastEnabledAt: string;
  lastDisabledAt?: string;
  activationCount: number;
};
export type ServerRuntimeOperations = { paused?: boolean; pausedAt?: string; resumedAt?: string; pauseReason?: string; source?: "phase14-admin" };
export type ServerDiscordRuntimeConfig = {
  globalChannelId?: string; dailyChannelId?: string; weeklyChannelId?: string; onlineListChannelId?: string;
  killfeedChannelId?: string; killStreakChannelId?: string; longShotChannelId?: string; longShotRankingChannelId?: string;
  streakRankingChannelId?: string; onlineCategoryId?: string; matchCategoryId?: string; memberFeedChannelId?: string;
  memberFeedEnabled?: boolean;
};
export type ServerNitradoValidation = { serviceId: string; baseDir: string; validatedAt: string; source: "phase10-on-demand" };
export type ServerActivationPreflight = {
  version: "phase11-v1"; source: "phase11-on-demand"; checkedAt: string; passed: true; configurationSignature: string;
  serviceId: string; baseDir: string; discordGuildId?: string;
  namespaceRows: { botState: number; playerStats: number; positionHistory: number }; warningCount: number;
};
export type ServerScopedSettings = { shopRestartTimes?: string; shopRestartTimezone?: string; dayzMissionDir?: string; shopDeliveryConfiguredAt?: string };
export type ServerRuntimeConfig = {
  nitradoBaseDir?: string;
  nitradoApiTokenEncrypted?: { encryptedSecret: string; iv: string; authTag: string; keyVersion: number };
  nitradoFtp?: { host: string; port: number; user: string; passwordEncrypted: { encryptedSecret: string; iv: string; authTag: string; keyVersion: number }; root?: string; secure?: boolean };
  nitradoValidation?: ServerNitradoValidation; activationPreflight?: ServerActivationPreflight;
  activation?: ServerRuntimeActivation; operations?: ServerRuntimeOperations; settings?: ServerScopedSettings; discord: ServerDiscordRuntimeConfig;
};
export type ManagedServerDescriptor = {
  id: string; name: string; organizationId: string; enabled: boolean; runtimeEnabled: boolean;
  onboardingStatus: ServerOnboardingStatus; mode: ServerFoundationMode;
  integrations: { nitradoServiceId?: string; discordGuildId?: string }; runtime: ServerRuntimeConfig;
  /** @deprecated Persistence no longer creates or selects a primary server. */
  primary?: boolean;
};
export type ServerNamespacePersistenceStatus = {
  enabled: boolean; initialized: boolean; botStateTableReady: boolean; playerStatsTableReady: boolean;
  botStateCompositeKeyReady: boolean; playerStatsCompositeKeyReady: boolean; botStatePrimaryKeyReady: boolean;
  playerStatsPrimaryKeyReady: boolean; primaryKeyCutoverComplete: boolean; scopedReadsEnabled: boolean;
  scopedReadFallbacks: number; lastScopedReadSource?: "server-scoped" | "legacy-fallback" | "legacy" | "server-id-safe-fallback" | "primary-untagged-fallback";
  botStateTaggedRows: number; botStateUntaggedRows: number; playerStatsTaggedRows: number; playerStatsUntaggedRows: number;
  lastCheckedAt?: string; lastError?: string;
};
export type ServerRegistryPersistenceStatus = {
  enabled: boolean; initialized: boolean; tableReady: boolean; rowsLoaded: number;
  draftRows?: number; configuredRows?: number; readyRows?: number; runtimeEnabledRows?: number;
  lastLoadedAt?: string; lastError?: string;
  configDrift?: { name?: boolean; nitradoServiceId?: boolean; discordGuildId?: boolean };
  /** @deprecated No longer seeded; retained for persisted diagnostic compatibility. */
  primarySeeded?: boolean;
};
export type ServerRuntimeIsolationStatus = {
  initialized: boolean; contextServerId?: string; nitradoRoutingNamespaced: boolean; discordRoutingNamespaced: boolean;
  processingLockNamespaced: boolean; staggerOffsetMs: number; activeLocks: number; lockSkips: number; lastLockServerId?: string;
  lastError?: string; executionContextNamespaced?: boolean; stateCacheNamespaced?: boolean; schedulerCentralized?: boolean;
  admStrategyNamespaced?: boolean; httpContextNamespaced?: boolean; playerPortalContextNamespaced?: boolean;
  persistenceRuntimeNamespaced?: boolean; positionHistoryNamespaced?: boolean; admParserStorageNamespaced?: boolean;
  activationReadiness?: boolean; discordLoopGuardsNamespaced?: boolean; mapSchedulersContextualized?: boolean;
  contextRuns?: number; contextFallbacks?: number; lastContextServerId?: string;
};

let persistedServers: ManagedServerDescriptor[] = [];
let namespacePersistenceStatus: ServerNamespacePersistenceStatus = {
  enabled: Boolean(process.env.DATABASE_URL), initialized: false, botStateTableReady: false, playerStatsTableReady: false,
  botStateCompositeKeyReady: false, playerStatsCompositeKeyReady: false, botStatePrimaryKeyReady: false, playerStatsPrimaryKeyReady: false,
  primaryKeyCutoverComplete: false, scopedReadsEnabled: false, scopedReadFallbacks: 0, botStateTaggedRows: 0, botStateUntaggedRows: 0,
  playerStatsTaggedRows: 0, playerStatsUntaggedRows: 0,
};
let registryPersistenceStatus: ServerRegistryPersistenceStatus = { enabled: Boolean(process.env.DATABASE_URL), initialized: false, tableReady: false, rowsLoaded: 0 };
let runtimeIsolationStatus: ServerRuntimeIsolationStatus = {
  initialized: false, nitradoRoutingNamespaced: false, discordRoutingNamespaced: false, processingLockNamespaced: false,
  staggerOffsetMs: 0, activeLocks: 0, lockSkips: 0,
};

export function buildManagedServerId(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function normalizeServerId(value: unknown) { return buildManagedServerId(value); }
export function normalizeManagedServerName(value: unknown) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80) || "Servidor"; }
export function normalizeServerOnboardingStatus(value: unknown): ServerOnboardingStatus {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "active" || normalized === "configured" || normalized === "ready") return normalized;
  return "draft";
}

function cloneServer(server: ManagedServerDescriptor): ManagedServerDescriptor {
  return {
    ...server,
    integrations: { ...server.integrations },
    runtime: {
      ...server.runtime,
      nitradoApiTokenEncrypted: server.runtime.nitradoApiTokenEncrypted ? { ...server.runtime.nitradoApiTokenEncrypted } : undefined,
      nitradoFtp: server.runtime.nitradoFtp ? { ...server.runtime.nitradoFtp, passwordEncrypted: { ...server.runtime.nitradoFtp.passwordEncrypted } } : undefined,
      nitradoValidation: server.runtime.nitradoValidation ? { ...server.runtime.nitradoValidation } : undefined,
      activationPreflight: server.runtime.activationPreflight ? { ...server.runtime.activationPreflight, namespaceRows: { ...server.runtime.activationPreflight.namespaceRows } } : undefined,
      activation: server.runtime.activation ? { ...server.runtime.activation } : undefined,
      operations: server.runtime.operations ? { ...server.runtime.operations } : undefined,
      settings: server.runtime.settings ? { ...server.runtime.settings } : undefined,
      discord: { ...server.runtime.discord },
    },
  };
}

export function getServerScopedSettings(serverId?: string): Required<ServerScopedSettings> {
  const requested = normalizeServerId(serverId);
  const resolved = requested || (persistedServers.length === 1 ? persistedServers[0].id : "");
  if (!resolved) throw new Error("Contexto de servidor obrigatorio para resolver configuracoes.");
  const server = getManagedServerById(resolved);
  if (!server) throw new Error(`Servidor ${resolved} nao encontrado para resolver configuracoes.`);
  const settings = server.runtime.settings || {};
  return {
    shopRestartTimes: String(settings.shopRestartTimes || "00:00,04:00,08:00,12:00,16:00,20:00").trim(),
    shopRestartTimezone: String(settings.shopRestartTimezone || "America/Sao_Paulo").trim(),
    dayzMissionDir: String(settings.dayzMissionDir || "dayzps_missions/dayzOffline.chernarusplus").trim(),
    shopDeliveryConfiguredAt: String(settings.shopDeliveryConfiguredAt || "").trim(),
  };
}

export function getManagedServerActivationConfigSignature(server: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  const serialized = JSON.stringify({ nitradoServiceId: String(server.integrations.nitradoServiceId || "").trim(), nitradoBaseDir: String(server.runtime.nitradoBaseDir || "").trim() });
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) { hash ^= serialized.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `phase16-core-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
export function hasMatchingManagedServerNitradoValidation(server: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  const serviceId = String(server.integrations.nitradoServiceId || "").trim(); const baseDir = String(server.runtime.nitradoBaseDir || "").trim(); const validation = server.runtime.nitradoValidation;
  return Boolean(serviceId && baseDir && validation && validation.serviceId === serviceId && validation.baseDir === baseDir && validation.validatedAt);
}
export function hasMatchingActivationPreflight(server: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  const preflight = server.runtime.activationPreflight; const serviceId = String(server.integrations.nitradoServiceId || "").trim(); const baseDir = String(server.runtime.nitradoBaseDir || "").trim();
  return Boolean(preflight?.passed === true && preflight.version === "phase11-v1" && serviceId && baseDir && preflight.serviceId === serviceId && preflight.baseDir === baseDir);
}
export function isManagedServerRuntimePaused(server: Pick<ManagedServerDescriptor, "runtime">) { return server.runtime.operations?.paused === true; }
export function hasManagedServerRuntimeActivation(server: Pick<ManagedServerDescriptor, "runtime">) {
  const activation = server.runtime.activation;
  return Boolean(activation?.source === "phase12-admin" && activation.everActivated === true && activation.firstActivatedAt && activation.lastEnabledAt && Number(activation.activationCount || 0) >= 1);
}
export function isServerNamespaceRuntimeSafe() {
  const namespace = getServerNamespacePersistenceStatus();
  return Boolean(namespace.initialized && namespace.scopedReadsEnabled && namespace.botStatePrimaryKeyReady && (!namespace.playerStatsTableReady || namespace.playerStatsPrimaryKeyReady) && namespace.botStateUntaggedRows === 0 && (!namespace.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0) && namespace.scopedReadFallbacks === 0);
}
export function canExecuteManagedServerRuntime(serverId: unknown) {
  const server = getManagedServerById(serverId); return Boolean(server && server.enabled && server.runtimeEnabled && server.onboardingStatus === "ready" && hasMatchingManagedServerNitradoValidation(server) && hasMatchingActivationPreflight(server) && hasManagedServerRuntimeActivation(server) && !isManagedServerRuntimePaused(server) && isServerNamespaceRuntimeSafe());
}
export function listExecutableManagedServers() { return listManagedServers().filter((server) => canExecuteManagedServerRuntime(server.id)); }


export function getPrimaryServerId() { return ""; }

export function listManagedServers() { return persistedServers.map(cloneServer); }
export function setPersistedManagedServers(servers: ManagedServerDescriptor[]) {
  const seen = new Set<string>();
  persistedServers = servers.map((server) => {
    const id = normalizeServerId(server.id);
    if (!id || seen.has(id)) throw new Error(`ID de servidor invalido ou duplicado: ${id || "vazio"}`);
    seen.add(id);
    return {
      id, name: normalizeManagedServerName(server.name), organizationId: String(server.organizationId || getDefaultOrganizationId()).trim() || getDefaultOrganizationId(),
      enabled: server.enabled !== false, runtimeEnabled: server.runtimeEnabled === true, onboardingStatus: normalizeServerOnboardingStatus(server.onboardingStatus), mode: "multi-server-native",
      integrations: { nitradoServiceId: String(server.integrations?.nitradoServiceId || "").trim() || undefined, discordGuildId: String(server.integrations?.discordGuildId || "").trim() || undefined },
      runtime: {
        nitradoBaseDir: String(server.runtime?.nitradoBaseDir || "").trim() || undefined,
        nitradoApiTokenEncrypted: server.runtime?.nitradoApiTokenEncrypted ? { ...server.runtime.nitradoApiTokenEncrypted } : undefined,
        nitradoFtp: server.runtime?.nitradoFtp ? { ...server.runtime.nitradoFtp, host: String(server.runtime.nitradoFtp.host || "").trim(), user: String(server.runtime.nitradoFtp.user || "").trim(), port: Number(server.runtime.nitradoFtp.port || 21), passwordEncrypted: { ...server.runtime.nitradoFtp.passwordEncrypted } } : undefined,
        nitradoValidation: server.runtime?.nitradoValidation ? { ...server.runtime.nitradoValidation } : undefined,
        activationPreflight: server.runtime?.activationPreflight ? { ...server.runtime.activationPreflight, namespaceRows: { ...server.runtime.activationPreflight.namespaceRows } } : undefined,
        activation: server.runtime?.activation ? { ...server.runtime.activation } : undefined,
        operations: server.runtime?.operations ? { ...server.runtime.operations } : undefined,
        settings: server.runtime?.settings ? { ...server.runtime.settings } : undefined,
        discord: { ...(server.runtime?.discord || {}) },
      },
    } satisfies ManagedServerDescriptor;
  });
}
export function setServerRegistryPersistenceStatus(status: Partial<ServerRegistryPersistenceStatus>) { registryPersistenceStatus = { ...registryPersistenceStatus, ...status, configDrift: status.configDrift ? { ...(registryPersistenceStatus.configDrift || {}), ...status.configDrift } : registryPersistenceStatus.configDrift }; }
export function setServerNamespacePersistenceStatus(status: Partial<ServerNamespacePersistenceStatus>) { namespacePersistenceStatus = { ...namespacePersistenceStatus, ...status }; }
export function getServerNamespacePersistenceStatus() { return { ...namespacePersistenceStatus }; }
export function getServerRegistryPersistenceStatus() { return { ...registryPersistenceStatus, configDrift: registryPersistenceStatus.configDrift ? { ...registryPersistenceStatus.configDrift } : undefined }; }
export function getManagedServerById(serverId: unknown) { const normalized = normalizeServerId(serverId); return normalized ? persistedServers.find((server) => server.id === normalized) : undefined; }
export function setServerRuntimeIsolationStatus(status: Partial<ServerRuntimeIsolationStatus>) { runtimeIsolationStatus = { ...runtimeIsolationStatus, ...status }; }
export function getServerRuntimeIsolationStatus() { return { ...runtimeIsolationStatus }; }
export function resolveServerIdFromDiscordGuildId(guildId: unknown) { const normalized = String(guildId || "").trim(); return persistedServers.find((server) => server.integrations.discordGuildId === normalized)?.id; }

export function getServerFoundationDiagnostics() {
  const registry = getServerRegistryPersistenceStatus(); const namespace = getServerNamespacePersistenceStatus(); const servers = listManagedServers();
  const secrets = servers.some((server) => Boolean(server.runtime.nitradoApiTokenEncrypted || server.runtime.nitradoFtp?.passwordEncrypted));
  const foundation = getOrganizationFoundationDiagnostics(); const integrations = getOrganizationIntegrationsDiagnostics();
  return {
    phase: 18, mode: "multi-server-native", managedServers: servers.length,
    activeServers: servers.filter((server) => server.enabled && server.runtimeEnabled).length,
    additionalServersEnabled: true,
    onboarding: {
      registryWritesEnabled: Boolean(registry.enabled && registry.tableReady), canCreateDrafts: Boolean(registry.enabled && registry.tableReady),
      draftServers: servers.filter((server) => server.onboardingStatus === "draft").length,
      configuredServers: servers.filter((server) => server.onboardingStatus === "configured").length,
      readyServers: servers.filter((server) => server.onboardingStatus === "ready").length,
      runtimeEnabledServers: servers.filter((server) => server.runtimeEnabled).length, activationPolicy: "ready-opt-in",
      secretsStoredInRegistry: secrets, nitradoDiscoveryEnabled: true, nitradoCredentialSource: secrets ? "server-scoped-encrypted" : "organization-scoped",
      discordDiscoveryEnabled: true, integrationValidationMode: "on-demand", activationPreflightEnabled: true, activationEndpointEnabled: true,
      playerPortalContextSwitchingEnabled: true, additionalServersEnabled: true, operationalHardeningEnabled: true,
      multiTenantFoundationEnabled: true, organizationAuthorizationEnabled: true,
      organizationCredentialIsolationEnabled: true, serverScopedCommerceSettingsEnabled: true, serverScopedShopCatalogEnabled: true, manualPauseAvailable: true,
    },
    registryPersisted: registry.initialized && registry.tableReady,
    persistenceNamespaced: namespace.scopedReadsEnabled && namespace.botStateCompositeKeyReady,
    persistenceTaggedWithServerId: namespace.initialized && namespace.botStateTableReady && namespace.botStateUntaggedRows === 0 && (!namespace.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0),
    parserNamespaced: runtimeIsolationStatus.processingLockNamespaced && Boolean(runtimeIsolationStatus.executionContextNamespaced),
    discordRoutingNamespaced: runtimeIsolationStatus.discordRoutingNamespaced, nitradoRoutingNamespaced: runtimeIsolationStatus.nitradoRoutingNamespaced,
    currentDataPathChanged: namespace.scopedReadsEnabled && namespace.botStateCompositeKeyReady, registry, namespace, runtimeIsolation: getServerRuntimeIsolationStatus(),
    safety: {
      legacyStateIdsPreserved: false, legacyAdmCursorsPreserved: false, legacyDiscordGuildPreserved: false, legacyNitradoServicePreserved: false,
      operationalDatabaseWritesAdded: servers.some((server) => canExecuteManagedServerRuntime(server.id)), registryMetadataOnly: false,
      activeReadsStillLegacy: !namespace.scopedReadsEnabled, compositePrimaryKeysActive: namespace.primaryKeyCutoverComplete,
      serverIdTaggingOnly: false, legacyFallbackAvailable: false, compositeUniqueKeysPrepared: namespace.botStateCompositeKeyReady && (!namespace.playerStatsTableReady || namespace.playerStatsCompositeKeyReady),
      perServerExecutionContext: Boolean(runtimeIsolationStatus.executionContextNamespaced), perServerStateCache: Boolean(runtimeIsolationStatus.stateCacheNamespaced),
      centralizedScheduler: Boolean(runtimeIsolationStatus.schedulerCentralized), perServerAdmStrategy: Boolean(runtimeIsolationStatus.admStrategyNamespaced),
      httpContextNamespaced: Boolean(runtimeIsolationStatus.httpContextNamespaced), perServerPersistenceRuntime: Boolean(runtimeIsolationStatus.persistenceRuntimeNamespaced),
      perServerPositionHistory: Boolean(runtimeIsolationStatus.positionHistoryNamespaced), perServerAdmParserStorage: Boolean(runtimeIsolationStatus.admParserStorageNamespaced),
      activationReadiness: Boolean(runtimeIsolationStatus.activationReadiness), onDemandRegistryWritesOnly: true, onDemandIntegrationDiscoveryOnly: true,
      nitradoTokenNeverReturnedToBrowser: true, activationPreflightGate: true, activationEndpointAvailable: true, playerPortalContextSwitching: true,
      perServerOperationalHealth: true, manualRuntimePause: true, organizationOwnershipRequired: true, organizationRbacPrepared: true,
      organizationNitradoCredentialIsolation: true, discordCrossOrganizationDiscoveryBlocked: true, serverScopedCommerceSettings: true, serverScopedShopCatalog: true,
    },
    tenancy: { ...foundation, phase: 18, integrations, thirdPartyOnboardingReady: Boolean(foundation.selfServiceEnabled && integrations.encryptionConfigured) },
  };
}
export function buildFutureServerScopedKey(serverId: string, key: string) { const normalized = normalizeServerId(serverId); if (!normalized) throw new Error("serverId obrigatorio"); return `${normalized}:${String(key || "").trim()}`; }
export function getOrganizationForServer(serverId: string) { return getManagedServerById(serverId)?.organizationId; }
export function getOrganizationIntegrationStatusForServer(serverId: string) { const organizationId = getOrganizationForServer(serverId); return organizationId ? getOrganizationIntegrationStatus(organizationId) : undefined; }
