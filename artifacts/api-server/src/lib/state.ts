import fs from "fs";
import path from "path";
import crypto from "crypto";
import postgres from "postgres";
import { hydrateKnownServerPlayers, scheduleTenantCommerceMirror } from "./tenantCommerceStore";
import type { ShopCatalog } from "./shopCatalog";
import type { DayzItemDefinition } from "./dayzItemDatabase";
import type { Locale } from "./i18n";
import { normalizeDiscordCommandSettings, type DiscordCommandSettings } from "./discord/commandSettings";
import { normalizeServiceSettings, type ServiceSettings } from "./serviceSettings";
import { recordNetworkTransfer } from "./networkMetrics";
import {
  buildManagedServerId,
  getPrimaryServerDescriptor,
  getPrimaryServerId,
  getManagedServerActivationConfigSignature,
  getServerRegistryPersistenceStatus,
  getServerNamespacePersistenceStatus,
  hasMatchingActivationPreflight,
  hasMatchingManagedServerNitradoValidation,
  hasManagedServerRuntimeActivation,
  normalizeManagedServerName,
  setPersistedManagedServers,
  setServerRegistryPersistenceStatus,
  setServerNamespacePersistenceStatus,
  setServerRuntimeIsolationStatus,
  type ManagedServerDescriptor,
  type ServerActivationPreflight,
  type ServerDiscordRuntimeConfig,
  type ServerNitradoValidation,
  type ServerRuntimeActivation,
  type ServerRuntimeOperations,
  type ServerScopedSettings,
} from "./serverRegistry";
import { getActiveServerId, getServerStateStoragePath, runInServerMaintenanceContext, runInServerRuntimeContext } from "./serverRuntime";
import {
  buildOrganizationId,
  getDefaultOrganizationDescriptor,
  getDefaultOrganizationId,
  getManagedOrganizationById,
  normalizeOrganizationName,
  normalizeOrganizationRole,
  setOrganizationRegistryPersistenceStatus,
  setPersistedOrganizations,
  type ManagedOrganization,
  type OrganizationMembership,
} from "./organizationRegistry";
import {
  encryptOrganizationSecret,
  setPersistedOrganizationIntegrations,
  type OrganizationIntegrationRecord,
} from "./organizationIntegrations";

const LEGACY_FILE = path.resolve(process.cwd(), "state.json");
const STATE_ID = "main";
const DISCORD_RUNTIME_STATE_ID = "discord_runtime";

const STATE_SAVE_DEBOUNCE_MS = Number(process.env.STATE_SAVE_DEBOUNCE_MS || 15000);
const STATE_FORCE_SAVE_AFTER_MS = Number(process.env.STATE_FORCE_SAVE_AFTER_MS || 60000);
const STATE_DEBUG = process.env.STATE_DEBUG === "true";

// Persistence V2 stores independent domains as separate bot_state rows. Background
// game/runtime changes are intentionally coalesced so Neon can spend meaningful
// time idle between bursts instead of being touched every few minutes. Social,
// commerce and configuration changes still flush immediately.
const STATE_PERSISTENCE_V2_ENABLED = process.env.STATE_PERSISTENCE_V2 !== "false";
// Safe minimums are intentional. Older Render env vars from previous iterations
// must not silently restore the 5-minute/60-minute behavior we are replacing.
const STATE_BACKGROUND_PERSIST_MS = Math.max(10 * 60_000, Number(process.env.STATE_BACKGROUND_PERSIST_MS || 10 * 60 * 1000));
const STATE_PROCESSING_PERSIST_MS = Math.max(10 * 60_000, Number(process.env.STATE_PROCESSING_PERSIST_MS || 10 * 60 * 1000));
const STATE_STATS_PERSIST_MS = Math.max(20 * 60_000, Number(process.env.STATE_STATS_PERSIST_MS || 20 * 60 * 1000));
const STATE_COMPAT_SNAPSHOT_MS = Math.max(6 * 60 * 60_000, Number(process.env.STATE_COMPAT_SNAPSHOT_MS || 6 * 60 * 60 * 1000));
const STATE_SCHEDULER_POLICY_VERSION = "v2-safe-2026-08-11";
const GRANULAR_PLAYER_STATS_ENABLED = process.env.GRANULAR_PLAYER_STATS !== "false";

const cachedStates = new Map<string, AppState>();

type ServerScopedMetricStore<T extends object> = {
  proxy: T;
  get: (serverId?: string) => T;
  entries: () => Array<[string, T]>;
};

function createServerScopedMetricStore<T extends object>(factory: () => T): ServerScopedMetricStore<T> {
  const buckets = new Map<string, T>();
  const get = (serverId = getActiveServerId()) => {
    let bucket = buckets.get(serverId);
    if (!bucket) {
      bucket = factory();
      buckets.set(serverId, bucket);
    }
    return bucket;
  };
  const proxy = new Proxy({} as T, {
    get: (_target, property) => Reflect.get(get(), property),
    set: (_target, property, value) => Reflect.set(get(), property, value),
    has: (_target, property) => Reflect.has(get(), property),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(get(), property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  return { proxy, get, entries: () => [...buckets.entries()] };
}

function getCachedState(): AppState | null {
  return cachedStates.get(getActiveServerId()) || null;
}

function setCachedState(state: AppState) {
  cachedStates.set(getActiveServerId(), state);
}

function getLocalStateFile() {
  const serverId = getActiveServerId();
  return serverId === getPrimaryServerId() ? LEGACY_FILE : getServerStateStoragePath(serverId);
}

type StateDomainName = "stats" | "processing" | "social" | "commerce" | "config";
type StateDomainPayload = Record<string, unknown>;

type PendingDomainState = {
  payload: StateDomainPayload;
  serialized: string;
  hash: string;
  reasons: Set<string>;
  dueAt: number;
};

const STATE_DOMAIN_IDS: Record<StateDomainName, string> = {
  stats: "v2_stats",
  processing: "v2_processing",
  social: "v2_social",
  commerce: "v2_commerce",
  config: "v2_config",
};


type PendingGranularPlayerStats = {
  stats: PlayerStats;
  currentStreak: number;
  signature: string;
  dueAt: number;
};

type ServerPersistenceRuntime = {
  lastPersistedHash: string;
  lastPersistedJson: string;
  pendingPersistJson: string;
  pendingPersistHash: string;
  pendingPersistStartedAt: number;
  saveTimer: NodeJS.Timeout | null;
  flushPromise: Promise<void> | null;
  pendingPersistReasons: Set<string>;
  lastCoreHash: string;
  lastDiscordRuntimeHash: string;
  pendingDiscordRuntimeJson: string;
  pendingDiscordRuntimeHash: string;
  discordRuntimeSaveTimer: NodeJS.Timeout | null;
  discordRuntimeFlushPromise: Promise<void> | null;
  lastDomainHashes: Partial<Record<StateDomainName, string>>;
  pendingDomains: Map<StateDomainName, PendingDomainState>;
  domainFlushTimer: NodeJS.Timeout | null;
  domainFlushPromise: Promise<void> | null;
  lastCompatibilitySnapshotAt: number;
  lastGranularPlayerSignatures: Map<string, string>;
  pendingGranularPlayerStats: Map<string, PendingGranularPlayerStats>;
};

const serverPersistenceRuntimes = new Map<string, ServerPersistenceRuntime>();

function getPersistenceRuntime(serverId = getActiveServerId()): ServerPersistenceRuntime {
  let runtime = serverPersistenceRuntimes.get(serverId);
  if (!runtime) {
    runtime = {
      lastPersistedHash: "",
      lastPersistedJson: "",
      pendingPersistJson: "",
      pendingPersistHash: "",
      pendingPersistStartedAt: 0,
      saveTimer: null,
      flushPromise: null,
      pendingPersistReasons: new Set<string>(),
      lastCoreHash: "",
      lastDiscordRuntimeHash: "",
      pendingDiscordRuntimeJson: "",
      pendingDiscordRuntimeHash: "",
      discordRuntimeSaveTimer: null,
      discordRuntimeFlushPromise: null,
      lastDomainHashes: {},
      pendingDomains: new Map<StateDomainName, PendingDomainState>(),
      domainFlushTimer: null,
      domainFlushPromise: null,
      lastCompatibilitySnapshotAt: 0,
      lastGranularPlayerSignatures: new Map<string, string>(),
      pendingGranularPlayerStats: new Map<string, PendingGranularPlayerStats>(),
    };
    serverPersistenceRuntimes.set(serverId, runtime);
    setServerRuntimeIsolationStatus({ persistenceRuntimeNamespaced: true });
  }
  return runtime;
}

let granularPlayerStatsTableReadyPromise: Promise<void> | null = null;

function createGranularPlayerStatsMetrics() {
  return {
    startedAt: new Date().toISOString(),
    enabled: GRANULAR_PLAYER_STATS_ENABLED,
    changes: 0,
    batchesWritten: 0,
    rowsWritten: 0,
    failedBatches: 0,
    totalPayloadBytesWritten: 0,
    totalWriteDurationMs: 0,
    lastWriteDurationMs: 0,
    lastWriteAt: undefined as string | undefined,
    lastError: undefined as string | undefined,
    rowsAppliedAtBoot: 0,
    newestRowAtBoot: undefined as string | undefined,
  };
}

const granularPlayerStatsMetricsStore = createServerScopedMetricStore(createGranularPlayerStatsMetrics);
const granularPlayerStatsMetrics = granularPlayerStatsMetricsStore.proxy;

type DomainMetric = {
  changes: number;
  writes: number;
  bytesWritten: number;
  currentBytes: number;
  lastWriteAt?: string;
};

function createDomainPersistenceMetrics() {
  return {
    startedAt: new Date().toISOString(),
    enabled: STATE_PERSISTENCE_V2_ENABLED,
    schedulerPolicyVersion: STATE_SCHEDULER_POLICY_VERSION,
    backgroundCadenceMs: STATE_BACKGROUND_PERSIST_MS,
    processingCadenceMs: STATE_PROCESSING_PERSIST_MS,
    statsCadenceMs: STATE_STATS_PERSIST_MS,
    compatibilitySnapshotMs: STATE_COMPAT_SNAPSHOT_MS,
    saveRequests: 0,
    backgroundQueued: 0,
    immediateFlushes: 0,
    backgroundFlushes: 0,
    forcedFlushes: 0,
    lastFlushTrigger: "none",
    flushes: 0,
    rowsWritten: 0,
    failedFlushes: 0,
    compatibilitySnapshots: 0,
    totalPayloadBytesWritten: 0,
    totalWriteDurationMs: 0,
    lastWriteDurationMs: 0,
    lastWriteAt: undefined as string | undefined,
    lastError: undefined as string | undefined,
    bootSource: "pending" as "pending" | "persistence-v2" | "compat-main" | "legacy-main" | "fresh-main" | "local-file" | "local-fallback",
    domainRowsFoundAtBoot: 0,
    domainRowsAppliedAtBoot: 0,
    mainUpdatedAtAtBoot: undefined as string | undefined,
    newestDomainUpdatedAtAtBoot: undefined as string | undefined,
    domains: {
      stats: { changes: 0, writes: 0, bytesWritten: 0, currentBytes: 0 },
      processing: { changes: 0, writes: 0, bytesWritten: 0, currentBytes: 0 },
      social: { changes: 0, writes: 0, bytesWritten: 0, currentBytes: 0 },
      commerce: { changes: 0, writes: 0, bytesWritten: 0, currentBytes: 0 },
      config: { changes: 0, writes: 0, bytesWritten: 0, currentBytes: 0 },
    } as Record<StateDomainName, DomainMetric>,
  };
}

const domainPersistenceMetricsStore = createServerScopedMetricStore(createDomainPersistenceMetrics);
const domainPersistenceMetrics = domainPersistenceMetricsStore.proxy;

function createDiscordRuntimeMetrics() {
  return {
    startedAt: new Date().toISOString(),
    saveRequests: 0,
    explicitRuntimeRequests: 0,
    fallbackToCore: 0,
    writes: 0,
    skippedWrites: 0,
    failedWrites: 0,
    totalPayloadBytesWritten: 0,
    totalWriteDurationMs: 0,
    lastPayloadBytes: 0,
    lastWriteDurationMs: 0,
    lastWriteAt: undefined as string | undefined,
    lastWriteError: undefined as string | undefined,
  };
}

const discordRuntimeMetricsStore = createServerScopedMetricStore(createDiscordRuntimeMetrics);
const discordRuntimeMetrics = discordRuntimeMetricsStore.proxy;

type PersistenceReasonMetric = {
  saveRequests: number;
  skippedRequests: number;
  contributedWrites: number;
  estimatedBytesWritten: number;
  lastRequestedAt?: string;
  lastWriteAt?: string;
};

type PersistenceSectionMetric = {
  currentBytes: number;
  currentEntries: number;
  changedWrites: number;
  cumulativeBytesWritten: number;
  lastChangedAt?: string;
  lastDeltaBytes?: number;
};

type PayloadFieldMetric = {
  field: string;
  bytes: number;
  presentIn: number;
};

type PayloadSectionAnalysis = {
  key: string;
  bytes: number;
  entries: number;
  averageEntryBytes: number;
  maxEntryBytes: number;
  topFields: PayloadFieldMetric[];
};

type PersistenceWriteSample = {
  at: string;
  bytes: number;
  durationMs: number;
  reasons: string[];
  changedSections: string[];
  changedBytes: number;
};

function createPersistenceMetrics() {
  return {
    startedAt: new Date().toISOString(),
    reads: 0,
    writes: 0,
    failedWrites: 0,
    saveRequests: 0,
    skippedWrites: 0,
    consolidatedWrites: 0,
    totalPayloadBytesWritten: 0,
    totalChangedBytes: 0,
    totalWriteDurationMs: 0,
    maxWriteDurationMs: 0,
    lastWriteDurationMs: 0,
    lastReadAt: undefined as string | undefined,
    lastWriteAt: undefined as string | undefined,
    lastWriteError: undefined as string | undefined,
    lastPayloadBytes: 0,
    lastChangedBytes: 0,
    lastChangedSections: [] as string[],
    lastWriteReasons: [] as string[],
    reasons: {} as Record<string, PersistenceReasonMetric>,
    sections: {} as Record<string, PersistenceSectionMetric>,
    lastPayloadSections: [] as Array<{ key: string; bytes: number; entries: number }>,
    detailedSections: [] as PayloadSectionAnalysis[],
    recentWrites: [] as PersistenceWriteSample[],
  };
}

const persistenceMetricsStore = createServerScopedMetricStore(createPersistenceMetrics);
const persistenceMetrics = persistenceMetricsStore.proxy;
const lastSectionHashesByServer = new Map<string, Record<string, string>>();
const lastSectionBytesByServer = new Map<string, Record<string, number>>();

function getLastSectionHashes(serverId = getActiveServerId()) {
  let value = lastSectionHashesByServer.get(serverId);
  if (!value) {
    value = {};
    lastSectionHashesByServer.set(serverId, value);
  }
  return value;
}

function getLastSectionBytes(serverId = getActiveServerId()) {
  let value = lastSectionBytesByServer.get(serverId);
  if (!value) {
    value = {};
    lastSectionBytesByServer.set(serverId, value);
  }
  return value;
}

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      ssl: "require",
      max: 1,
    })
  : null;

let serverRegistryReadyPromise: Promise<void> | null = null;
let botStateScopedPersistenceReady = false;
let playerStatsScopedPersistenceReady = false;
let botStatePrimaryKeyReady = false;
let playerStatsPrimaryKeyReady = false;
let scopedReadFallbacks = 0;
let lastScopedReadSource: "server-scoped" | "legacy-fallback" | "legacy" | "server-id-safe-fallback" | "primary-untagged-fallback" = "legacy";

type ManagedServerDraftInput = {
  id?: unknown;
  name?: unknown;
  organizationId?: unknown;
  nitradoServiceId?: unknown;
  nitradoBaseDir?: unknown;
  discordGuildId?: unknown;
  settings?: Partial<Record<keyof ServerScopedSettings, unknown>>;
  discord?: Partial<Record<keyof ServerDiscordRuntimeConfig, unknown>>;
};

const SERVER_SECRET_KEY_PATTERN = /(token|password|secret|api[_-]?key|authorization|credentials)/i;

function assertNoServerSecrets(value: unknown, pathName = "server") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SERVER_SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Server onboarding does not persist secrets in managed_servers (${pathName}.${key}). Nitrado credentials stay server-side and are never accepted by this registry form.`);
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      assertNoServerSecrets(child, `${pathName}.${key}`);
    }
  }
}

function optionalServerText(value: unknown, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength) || undefined;
}

function parseManagedServerRuntimeConfig(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string" || !value.trim()) return {};

  // JSONB is normally returned as an object, but keep the registry resilient to
  // drivers/adapters that surface it as text (or as a JSON-encoded JSON string).
  // Losing this object would make a persisted Nitrado validation look like a Draft
  // even though the validation write itself succeeded.
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function normalizeServerDiscordDraft(value: unknown, existing: ServerDiscordRuntimeConfig = {}): ServerDiscordRuntimeConfig {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next: ServerDiscordRuntimeConfig = { ...existing };
  const textKeys = [
    "globalChannelId", "dailyChannelId", "weeklyChannelId", "onlineListChannelId",
    "killfeedChannelId", "killStreakChannelId", "longShotChannelId", "longShotRankingChannelId",
    "streakRankingChannelId", "onlineCategoryId", "matchCategoryId", "memberFeedChannelId",
  ] as const;
  for (const key of textKeys) {
    if (!(key in source)) continue;
    const normalized = optionalServerText(source[key], 64);
    if (normalized) (next as Record<string, unknown>)[key] = normalized;
    else delete (next as Record<string, unknown>)[key];
  }
  if ("memberFeedEnabled" in source) next.memberFeedEnabled = source.memberFeedEnabled !== false;
  return next;
}

function normalizeServerScopedSettingsDraft(value: unknown, existing: ServerScopedSettings = {}): ServerScopedSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next: ServerScopedSettings = { ...existing };
  if ("shopRestartTimes" in source) {
    const normalized = optionalServerText(source.shopRestartTimes, 240);
    if (normalized) next.shopRestartTimes = normalized; else delete next.shopRestartTimes;
  }
  if ("shopRestartTimezone" in source) {
    const normalized = optionalServerText(source.shopRestartTimezone, 100);
    if (normalized) next.shopRestartTimezone = normalized; else delete next.shopRestartTimezone;
  }
  if ("dayzMissionDir" in source) {
    const normalized = optionalServerText(source.dayzMissionDir, 300);
    if (normalized) next.dayzMissionDir = normalized.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); else delete next.dayzMissionDir;
  }
  return next;
}

function deriveServerOnboardingStatus(descriptor: Pick<ManagedServerDescriptor, "integrations" | "runtime">) {
  // Discord remains optional. Phase 11 promotes a future server to Ready only
  // after an explicit activation preflight passes against the exact saved
  // integration configuration. Nitrado validation alone remains Configured.
  if (hasMatchingManagedServerNitradoValidation(descriptor) && hasMatchingActivationPreflight(descriptor)) return "ready" as const;
  return hasMatchingManagedServerNitradoValidation(descriptor) ? "configured" as const : "draft" as const;
}

function mapManagedServerRow(row: any, primary: ManagedServerDescriptor): ManagedServerDescriptor {
  const id = String(row.id || "").trim();
  const isPrimary = id === primary.id;
  const runtimeConfig = parseManagedServerRuntimeConfig(row.runtime_config);
  const descriptor: ManagedServerDescriptor = {
    id,
    name: String(row.name || row.id || "Server"),
    organizationId: buildOrganizationId(row.organization_id || (isPrimary ? getDefaultOrganizationId() : "")) || getDefaultOrganizationId(),
    enabled: row.enabled !== false,
    primary: isPrimary,
    runtimeEnabled: isPrimary ? true : Boolean(row.runtime_enabled),
    onboardingStatus: isPrimary ? "active" : "draft",
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(row.nitrado_service_id || "").trim() || undefined,
      discordGuildId: String(row.discord_guild_id || "").trim() || undefined,
    },
    runtime: {
      // Only the production primary may inherit legacy ENV defaults. A draft
      // must stay empty when a field is not explicitly configured, otherwise
      // it could silently point at PZ paths/channels during a future activation.
      nitradoBaseDir: String(runtimeConfig?.nitradoBaseDir || (isPrimary ? primary.runtime.nitradoBaseDir : "") || "").trim() || undefined,
      nitradoValidation: !isPrimary && runtimeConfig?.nitradoValidation && typeof runtimeConfig.nitradoValidation === "object"
        ? {
            serviceId: String(runtimeConfig.nitradoValidation.serviceId || "").trim(),
            baseDir: String(runtimeConfig.nitradoValidation.baseDir || "").trim(),
            validatedAt: String(runtimeConfig.nitradoValidation.validatedAt || "").trim(),
            source: "phase10-on-demand",
          }
        : undefined,
      activationPreflight: !isPrimary
        && runtimeConfig?.activationPreflight
        && typeof runtimeConfig.activationPreflight === "object"
        && runtimeConfig.activationPreflight.passed === true
        ? {
            version: "phase11-v1",
            source: "phase11-on-demand",
            checkedAt: String(runtimeConfig.activationPreflight.checkedAt || "").trim(),
            passed: true,
            configurationSignature: String(runtimeConfig.activationPreflight.configurationSignature || "").trim(),
            serviceId: String(runtimeConfig.activationPreflight.serviceId || "").trim(),
            baseDir: String(runtimeConfig.activationPreflight.baseDir || "").trim(),
            discordGuildId: String(runtimeConfig.activationPreflight.discordGuildId || "").trim() || undefined,
            namespaceRows: {
              botState: Number(runtimeConfig.activationPreflight.namespaceRows?.botState || 0),
              playerStats: Number(runtimeConfig.activationPreflight.namespaceRows?.playerStats || 0),
              positionHistory: Number(runtimeConfig.activationPreflight.namespaceRows?.positionHistory || 0),
            },
            warningCount: Number(runtimeConfig.activationPreflight.warningCount || 0),
          }
        : undefined,
      activation: !isPrimary
        && runtimeConfig?.activation
        && typeof runtimeConfig.activation === "object"
        && runtimeConfig.activation.everActivated === true
        ? {
            source: "phase12-admin",
            everActivated: true,
            firstActivatedAt: String(runtimeConfig.activation.firstActivatedAt || "").trim(),
            lastEnabledAt: String(runtimeConfig.activation.lastEnabledAt || "").trim(),
            lastDisabledAt: String(runtimeConfig.activation.lastDisabledAt || "").trim() || undefined,
            activationCount: Math.max(1, Number(runtimeConfig.activation.activationCount || 1)),
          }
        : undefined,
      operations: !isPrimary
        && runtimeConfig?.operations
        && typeof runtimeConfig.operations === "object"
        ? {
            paused: runtimeConfig.operations.paused === true,
            pausedAt: String(runtimeConfig.operations.pausedAt || "").trim() || undefined,
            resumedAt: String(runtimeConfig.operations.resumedAt || "").trim() || undefined,
            pauseReason: String(runtimeConfig.operations.pauseReason || "").trim().slice(0, 240) || undefined,
            source: runtimeConfig.operations.source === "phase14-admin" ? "phase14-admin" : undefined,
          }
        : undefined,
      settings: normalizeServerScopedSettingsDraft(
        runtimeConfig?.settings,
        {
          ...(isPrimary ? primary.runtime.settings || {} : {}),
          ...(String(runtimeConfig?.settings?.shopDeliveryConfiguredAt || "").trim()
            ? { shopDeliveryConfiguredAt: String(runtimeConfig.settings.shopDeliveryConfiguredAt).trim() }
            : {}),
        },
      ),
      discord: isPrimary
        ? { ...(primary.runtime.discord || {}), ...(runtimeConfig?.discord || {}) }
        : { ...(runtimeConfig?.discord || {}) },
    },
  };

  if (!isPrimary) {
    const storedStatus = String(row.onboarding_status || "draft").trim().toLowerCase();
    descriptor.onboardingStatus = storedStatus === "ready"
      && hasMatchingManagedServerNitradoValidation(descriptor)
      && hasMatchingActivationPreflight(descriptor)
      ? "ready"
      : deriveServerOnboardingStatus(descriptor);
  }
  return descriptor;
}

async function reloadManagedServerRegistryFromDb(primary = getPrimaryServerDescriptor()) {
  if (!sql) return [primary];
  const rows = await sql`
    SELECT id, name, organization_id, enabled, primary_server, runtime_enabled, onboarding_status,
           mode, nitrado_service_id, discord_guild_id, runtime_config
    FROM managed_servers
    ORDER BY primary_server DESC, created_at ASC, id ASC
  `;
  const descriptors = (rows as any[]).map((row) => mapManagedServerRow(row, primary));
  const next = descriptors.length ? descriptors : [primary];
  setPersistedManagedServers(next);
  setServerRegistryPersistenceStatus({
    rowsLoaded: next.length,
    draftRows: next.filter((server) => !server.primary && server.onboardingStatus === "draft").length,
    configuredRows: next.filter((server) => !server.primary && server.onboardingStatus === "configured").length,
    readyRows: next.filter((server) => !server.primary && server.onboardingStatus === "ready").length,
    runtimeEnabledRows: next.filter((server) => server.runtimeEnabled).length,
    lastLoadedAt: new Date().toISOString(),
  });
  return next;
}

export async function refreshManagedServerRegistryFromDb() {
  return reloadManagedServerRegistryFromDb();
}

async function reloadOrganizationRegistryFromDb() {
  if (!sql) {
    setPersistedOrganizations([getDefaultOrganizationDescriptor()], []);
    return;
  }
  const organizationRows = await sql`
    SELECT id, name, active, created_at, updated_at
    FROM organizations
    ORDER BY created_at ASC, id ASC
  `;
  const membershipRows = await sql`
    SELECT organization_id, discord_id, role, created_at, updated_at
    FROM organization_members
    ORDER BY organization_id ASC, created_at ASC, discord_id ASC
  `;
  const integrationRows = await sql`
    SELECT organization_id, provider, encrypted_secret, iv, auth_tag, key_version, metadata, active, created_at, updated_at
    FROM organization_integrations
    ORDER BY organization_id ASC, provider ASC
  `;
  const nextOrganizations: ManagedOrganization[] = (organizationRows as any[]).map((row) => ({
    id: buildOrganizationId(row.id),
    name: normalizeOrganizationName(row.name),
    active: row.active !== false,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  }));
  const nextMemberships: OrganizationMembership[] = (membershipRows as any[]).map((row) => ({
    organizationId: buildOrganizationId(row.organization_id),
    discordId: String(row.discord_id || "").trim(),
    role: normalizeOrganizationRole(row.role),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  }));
  const nextIntegrations: OrganizationIntegrationRecord[] = (integrationRows as any[]).map((row) => ({
    organizationId: buildOrganizationId(row.organization_id),
    provider: "nitrado" as const,
    encryptedSecret: String(row.encrypted_secret || ""),
    iv: String(row.iv || ""),
    authTag: String(row.auth_tag || ""),
    keyVersion: Number(row.key_version || 1),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    active: row.active !== false,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  })).filter((row) => row.organizationId && row.encryptedSecret && row.iv && row.authTag);
  setPersistedOrganizations(nextOrganizations, nextMemberships);
  setPersistedOrganizationIntegrations(nextIntegrations);
  setOrganizationRegistryPersistenceStatus({
    organizationsLoaded: nextOrganizations.length,
    membershipsLoaded: nextMemberships.length,
    lastLoadedAt: new Date().toISOString(),
    lastError: undefined,
  });
}

async function ensurePrimaryServerRegistryMetadata() {
  if (!sql) {
    setOrganizationRegistryPersistenceStatus({ enabled: false, initialized: true });
    setPersistedOrganizations([getDefaultOrganizationDescriptor()], []);
    setServerRegistryPersistenceStatus({
      enabled: false,
      initialized: true,
      tableReady: false,
      primarySeeded: false,
      rowsLoaded: 0,
    });
    return;
  }
  if (serverRegistryReadyPromise) return serverRegistryReadyPromise;

  serverRegistryReadyPromise = (async () => {
    const primary = getPrimaryServerDescriptor();
    const defaultOrganization = getDefaultOrganizationDescriptor();
    try {
      // Phase 16 keeps ownership around the existing server-scoped runtime. It does
      // not rename state rows, ADM paths, parser cursors or runtime identifiers.
      await sql`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS organization_members (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          discord_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','moderator','viewer')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (organization_id, discord_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS organization_members_discord_id_idx ON organization_members (discord_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS organization_integrations (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider IN ('nitrado')),
          encrypted_secret TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          key_version INTEGER NOT NULL DEFAULT 1,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (organization_id, provider)
        )
      `;
      await sql`
        INSERT INTO organizations (id, name, active, created_at, updated_at)
        VALUES (${defaultOrganization.id}, ${defaultOrganization.name}, TRUE, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      setOrganizationRegistryPersistenceStatus({
        enabled: true,
        organizationsTableReady: true,
        membershipsTableReady: true,
        defaultOrganizationSeeded: true,
      });

      // Phase 5 keeps the registry metadata behavior unchanged. No bot_state ids,
      // ADM cursors, granular stats, Discord routing or Nitrado routing are
      // renamed or moved in this deploy.
      await sql`
        CREATE TABLE IF NOT EXISTS managed_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          organization_id TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          primary_server BOOLEAN NOT NULL DEFAULT FALSE,
          runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          onboarding_status TEXT NOT NULL DEFAULT 'draft',
          mode TEXT NOT NULL DEFAULT 'single-server-compat',
          nitrado_service_id TEXT,
          discord_guild_id TEXT,
          runtime_config JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS runtime_config JSONB`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'draft'`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS organization_id TEXT`;
      const ownershipBackfill = await sql`
        UPDATE managed_servers
        SET organization_id = ${defaultOrganization.id}, updated_at = NOW()
        WHERE organization_id IS NULL OR BTRIM(organization_id) = ''
        RETURNING id
      `;
      await sql`ALTER TABLE managed_servers ALTER COLUMN organization_id SET NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS managed_servers_organization_id_idx ON managed_servers (organization_id)`;
      const ownershipCounts = await sql`
        SELECT COUNT(*)::int AS missing
        FROM managed_servers
        WHERE organization_id IS NULL OR BTRIM(organization_id) = ''
      `;
      const missingOwnership = Number((ownershipCounts as any[])[0]?.missing || 0);
      setOrganizationRegistryPersistenceStatus({
        serverOwnershipColumnReady: missingOwnership === 0,
        serversBackfilled: (ownershipBackfill as any[]).length,
        serversWithoutOrganization: missingOwnership,
      });
      setServerRegistryPersistenceStatus({ tableReady: true });

      // Never overwrite an existing registry row from environment variables.
      // This avoids a deploy unexpectedly remapping the production server.
      const inserted = await sql`
        INSERT INTO managed_servers (
          id, name, organization_id, enabled, primary_server, runtime_enabled, onboarding_status, mode, nitrado_service_id, discord_guild_id, runtime_config, created_at, updated_at
        )
        VALUES (
          ${primary.id}, ${primary.name}, ${defaultOrganization.id}, TRUE, TRUE, TRUE, 'active', ${primary.mode},
          ${primary.integrations.nitradoServiceId || null}, ${primary.integrations.discordGuildId || null}, ${JSON.stringify(primary.runtime)}::jsonb, NOW(), NOW()
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;

      const runtimeBackfill = await sql`
        UPDATE managed_servers
        SET
          organization_id = COALESCE(NULLIF(BTRIM(organization_id), ''), ${defaultOrganization.id}),
          nitrado_service_id = COALESCE(nitrado_service_id, ${primary.integrations.nitradoServiceId || null}),
          discord_guild_id = COALESCE(discord_guild_id, ${primary.integrations.discordGuildId || null}),
          runtime_config = CASE
            WHEN runtime_config IS NULL OR runtime_config = '{}'::jsonb THEN ${JSON.stringify(primary.runtime)}::jsonb
            ELSE runtime_config
          END,
          runtime_enabled = TRUE,
          onboarding_status = 'active',
          updated_at = NOW()
        WHERE id = ${primary.id}
          AND (
            organization_id IS NULL
            OR BTRIM(organization_id) = ''
            OR nitrado_service_id IS NULL
            OR discord_guild_id IS NULL
            OR runtime_config IS NULL
            OR runtime_config = '{}'::jsonb
            OR runtime_enabled IS DISTINCT FROM TRUE
            OR onboarding_status IS DISTINCT FROM 'active'
          )
        RETURNING id
      `;


      // Phase 16 snapshots the legacy process-wide commerce settings into each
      // existing server row once. From this point forward they can diverge
      // without one server inheriting changes made for another tenant.
      const defaultServerSettings = primary.runtime.settings || {
        shopRestartTimes: String(process.env.SHOP_RESTART_TIMES || process.env.SERVER_RESTART_TIMES || "00:00,04:00,08:00,12:00,16:00,20:00"),
        shopRestartTimezone: String(process.env.SHOP_RESTART_TIMEZONE || "America/Sao_Paulo"),
        dayzMissionDir: String(process.env.DAYZ_MISSION_DIR || "dayzps_missions/dayzOffline.chernarusplus"),
      };
      await sql`
        UPDATE managed_servers
        SET runtime_config = jsonb_set(
              COALESCE(runtime_config, '{}'::jsonb),
              '{settings}',
              ${JSON.stringify(defaultServerSettings)}::jsonb,
              TRUE
            ),
            updated_at = NOW()
        WHERE runtime_config IS NULL OR runtime_config->'settings' IS NULL
      `;
      const bootstrapAdminIds = Array.from(new Set(
        String(process.env.DISCORD_ADMIN_USER_IDS || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ));
      let seededOwnerMemberships = 0;
      const existingMembershipCountRows = await sql`
        SELECT COUNT(*)::int AS count
        FROM organization_members
        WHERE organization_id = ${defaultOrganization.id}
      `;
      const existingMembershipCount = Number((existingMembershipCountRows as any[])[0]?.count || 0);
      // Environment admins are a one-time bootstrap only. Once the organization
      // has persisted memberships, later removals/demotions must not be silently
      // reversed by a Render restart or deploy.
      if (existingMembershipCount === 0) {
        for (const discordId of bootstrapAdminIds) {
          const insertedMembership = await sql`
            INSERT INTO organization_members (organization_id, discord_id, role, created_at, updated_at)
            VALUES (${defaultOrganization.id}, ${discordId}, 'owner', NOW(), NOW())
            ON CONFLICT (organization_id, discord_id) DO NOTHING
            RETURNING discord_id
          `;
          seededOwnerMemberships += (insertedMembership as any[]).length;
        }
      }
      await reloadOrganizationRegistryFromDb();
      setOrganizationRegistryPersistenceStatus({
        initialized: true,
        seededOwnerMemberships,
      });

      // Phase 12 preserves explicitly activated runtimes across deploys, but still
      // fails closed on stale/manual runtime_enabled values that do not have a
      // matching Nitrado validation + Phase 11 preflight for the saved config.
      let descriptors = await reloadManagedServerRegistryFromDb(primary);
      const invalidRuntimeIds = descriptors
        .filter((server) => !server.primary && server.runtimeEnabled)
        .filter((server) => !(
          server.enabled
          && server.onboardingStatus === "ready"
          && hasMatchingManagedServerNitradoValidation(server)
          && hasMatchingActivationPreflight(server)
          && hasManagedServerRuntimeActivation(server)
        ))
        .map((server) => server.id);
      for (const invalidRuntimeId of invalidRuntimeIds) {
        await sql`
          UPDATE managed_servers
          SET runtime_enabled = FALSE, updated_at = NOW()
          WHERE id = ${invalidRuntimeId} AND id <> ${primary.id}
        `;
      }
      if (invalidRuntimeIds.length) descriptors = await reloadManagedServerRegistryFromDb(primary);

      const persistedPrimary = descriptors.find((server) => server.id === primary.id) || descriptors.find((server) => server.primary);
      setServerRegistryPersistenceStatus({
        enabled: true,
        initialized: true,
        tableReady: true,
        primarySeeded: Boolean(persistedPrimary),
        rowsLoaded: descriptors.length,
        draftRows: descriptors.filter((server) => !server.primary && server.onboardingStatus === "draft").length,
        configuredRows: descriptors.filter((server) => !server.primary && server.onboardingStatus === "configured").length,
        readyRows: descriptors.filter((server) => !server.primary && server.onboardingStatus === "ready").length,
        runtimeEnabledRows: descriptors.filter((server) => server.runtimeEnabled).length,
        lastLoadedAt: new Date().toISOString(),
        lastError: undefined,
        configDrift: persistedPrimary ? {
          name: persistedPrimary.name !== primary.name,
          nitradoServiceId: (persistedPrimary.integrations.nitradoServiceId || "") !== (primary.integrations.nitradoServiceId || ""),
          discordGuildId: (persistedPrimary.integrations.discordGuildId || "") !== (primary.integrations.discordGuildId || ""),
        } : undefined,
      });

      // One tiny metadata INSERT is expected only on the first Phase 2 boot.
      // Existing deployments thereafter perform reads only here.
      if ((inserted as any[]).length || (runtimeBackfill as any[]).length) {
        recordNetworkTransfer({
          service: "neon-server-registry",
          operation: (inserted as any[]).length ? "seed_primary_server_metadata" : "backfill_primary_runtime_config",
          direction: "outbound",
          bytes: Buffer.byteLength(JSON.stringify(primary), "utf8"),
          ok: true,
        });
      }

      // Phase 5 promotes the prepared (server_id, id) namespace to the real
      // primary key. The migration is transactional and only runs after every
      // existing row has a server_id, so a failure leaves the old key intact.
      try {
        const tableCheck = await sql`SELECT to_regclass('public.bot_state') IS NOT NULL AS exists`;
        const botStateExists = Boolean((tableCheck as any[])[0]?.exists);
        let taggedRows = 0;
        let untaggedRows = 0;
        if (botStateExists) {
          await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS server_id TEXT`;
          await sql`UPDATE bot_state SET server_id = ${primary.id} WHERE server_id IS NULL`;
          await sql`CREATE INDEX IF NOT EXISTS bot_state_server_id_idx ON bot_state (server_id)`;
          const counts = await sql`
            SELECT
              COUNT(*) FILTER (WHERE server_id = ${primary.id})::int AS tagged_rows,
              COUNT(*) FILTER (WHERE server_id IS NULL)::int AS untagged_rows
            FROM bot_state
          `;
          taggedRows = Number((counts as any[])[0]?.tagged_rows || 0);
          untaggedRows = Number((counts as any[])[0]?.untagged_rows || 0);

          const pkRows = await sql`
            SELECT array_agg(a.attname ORDER BY keycols.ordinality) AS columns
            FROM pg_index i
            JOIN pg_class t ON t.oid = i.indrelid
            JOIN unnest(i.indkey) WITH ORDINALITY AS keycols(attnum, ordinality) ON TRUE
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keycols.attnum
            WHERE t.relname = 'bot_state' AND i.indisprimary
            GROUP BY i.indexrelid
          `;
          const pkColumns = Array.isArray((pkRows as any[])[0]?.columns)
            ? (pkRows as any[])[0].columns.map((value: unknown) => String(value))
            : [];

          if (pkColumns.join(',') === 'server_id,id') {
            botStatePrimaryKeyReady = true;
          } else if (pkColumns.join(',') === 'id' && untaggedRows === 0) {
            await sql`CREATE UNIQUE INDEX IF NOT EXISTS bot_state_server_id_id_uidx ON bot_state (server_id, id)`;
            await sql.begin(async (tx: any) => {
              await tx`ALTER TABLE bot_state ALTER COLUMN server_id SET NOT NULL`;
              await tx`ALTER TABLE bot_state DROP CONSTRAINT bot_state_pkey`;
              await tx`ALTER TABLE bot_state ADD CONSTRAINT bot_state_pkey PRIMARY KEY USING INDEX bot_state_server_id_id_uidx`;
            });
            botStatePrimaryKeyReady = true;
          } else if (pkColumns.length === 0 && untaggedRows === 0) {
            await sql.begin(async (tx: any) => {
              await tx`ALTER TABLE bot_state ALTER COLUMN server_id SET NOT NULL`;
              await tx`ALTER TABLE bot_state ADD CONSTRAINT bot_state_pkey PRIMARY KEY (server_id, id)`;
            });
            botStatePrimaryKeyReady = true;
          } else {
            throw new Error(`bot_state primary key is not safe to migrate: ${pkColumns.join(',') || 'none'}; untagged=${untaggedRows}`);
          }
          botStateScopedPersistenceReady = botStatePrimaryKeyReady;
        }
        setServerNamespacePersistenceStatus({
          enabled: true,
          initialized: true,
          botStateTableReady: botStateExists,
          botStateCompositeKeyReady: botStateExists && botStateScopedPersistenceReady,
          botStatePrimaryKeyReady,
          primaryKeyCutoverComplete: botStatePrimaryKeyReady && (!GRANULAR_PLAYER_STATS_ENABLED || playerStatsPrimaryKeyReady),
          scopedReadsEnabled: botStateExists && botStateScopedPersistenceReady,
          scopedReadFallbacks,
          lastScopedReadSource,
          botStateTaggedRows: taggedRows,
          botStateUntaggedRows: untaggedRows,
          lastCheckedAt: new Date().toISOString(),
          lastError: undefined,
        });
      } catch (namespaceErr) {
        setServerNamespacePersistenceStatus({
          initialized: true,
          lastCheckedAt: new Date().toISOString(),
          lastError: namespaceErr instanceof Error ? namespaceErr.message : String(namespaceErr),
        });
        // Primary-key promotion is non-blocking in Phase 5. Because the DDL is
        // transactional, failure keeps the Phase 4 single-server key/path valid.
        console.error("❌ erro preparando namespace multi-server:", namespaceErr);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOrganizationRegistryPersistenceStatus({ initialized: true, lastError: message });
      setServerRegistryPersistenceStatus({
        initialized: true,
        lastError: message,
      });
      // Registry metadata must never block the current production state path.
      console.error("❌ erro inicializando metadata multi-server:", err);
    }
  })().finally(() => {
    // Keep the resolved promise cached so repeated getStateAsync calls do not
    // query Neon again during the lifetime of this process.
  });

  return serverRegistryReadyPromise;
}


export type PlayerPositionHistoryEventType = "position" | "connect" | "disconnect";

export type PlayerPositionHistoryObservation = {
  sourceKey: string;
  playerName: string;
  playerNormalized: string;
  eventType: PlayerPositionHistoryEventType;
  x?: number;
  z?: number;
  y?: number;
  observedAt: string;
  sourceFile?: string;
};

const PLAYER_POSITION_RETENTION_HOURS = 24;
const PLAYER_POSITION_FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const PLAYER_POSITION_MAX_PENDING = 1000;
const PLAYER_POSITION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PLAYER_POSITION_MIN_MOVEMENT_METERS = 25;
const PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS = 2 * 60 * 1000;

let playerPositionTableReadyPromise: Promise<void> | null = null;

type RetainedPlayerPosition = { x: number; z: number; observedAtMs: number };
type ServerPlayerPositionRuntime = {
  pendingObservations: Map<string, PlayerPositionHistoryObservation>;
  flushTimer: NodeJS.Timeout | null;
  lastCleanupAt: number;
  retainedPositions: Map<string, RetainedPlayerPosition>;
};

const serverPlayerPositionRuntimes = new Map<string, ServerPlayerPositionRuntime>();

function getPlayerPositionRuntime(serverId = getActiveServerId()): ServerPlayerPositionRuntime {
  let runtime = serverPlayerPositionRuntimes.get(serverId);
  if (!runtime) {
    runtime = {
      pendingObservations: new Map<string, PlayerPositionHistoryObservation>(),
      flushTimer: null,
      lastCleanupAt: 0,
      retainedPositions: new Map<string, RetainedPlayerPosition>(),
    };
    serverPlayerPositionRuntimes.set(serverId, runtime);
    setServerRuntimeIsolationStatus({ positionHistoryNamespaced: true });
  }
  return runtime;
}

function createPlayerPositionHistoryMetrics() {
  return {
    startedAt: new Date().toISOString(),
    observationsReceived: 0,
    positionEvents: 0,
    queuedPositionEvents: 0,
    suppressedPositionEvents: 0,
    connectEvents: 0,
    disconnectEvents: 0,
    invalidPositions: 0,
    batchesWritten: 0,
    rowsWritten: 0,
    failedBatches: 0,
    totalPayloadBytesWritten: 0,
    totalWriteDurationMs: 0,
    lastWriteDurationMs: 0,
    lastWriteAt: undefined as string | undefined,
    lastError: undefined as string | undefined,
    recentSamples: [] as PlayerPositionHistoryObservation[],
    observedPlayers: new Set<string>(),
  };
}

const playerPositionHistoryMetricsStore = createServerScopedMetricStore(createPlayerPositionHistoryMetrics);
const playerPositionHistoryMetrics = playerPositionHistoryMetricsStore.proxy;

export type PlayerStats = {
  kills: number;
  deaths: number;
};

export type OnlineSession = {
  connectedAt?: string;
  lastSeenAt?: string;
  kills?: number;
  deaths?: number;
  streak?: number;
};

type OnlinePlayer = {
  online: true;
  connectedAt?: string;
  lastSeenAt: string;
  sessionKills?: number;
  sessionDeaths?: number;
  sessionStreak?: number;
};

export type FileCursor = {
  lastLine: number;
  lastProcessedAt: string;
};

export type KillFeedEvent = {
  killer: string;
  victim: string;
  weapon?: string;
  distance?: number | null;
  at: string;
};

export type LongShotEvent = {
  killer: string;
  victim: string;
  weapon: string;
  distance: number;
  timestamp: number;
};

export type KillStreakEvent =
  | {
      type: "streak";
      player: string;
      streak: number;
      timestamp: number;
    }
  | {
      type: "ended";
      player: string;
      streak: number;
      killer: string;
      timestamp: number;
    };

export type ShopOrderStatus =
  | "pending_spawn"
  | "included_in_restart"
  | "spawned"
  | "failed";


export type ShopResetMonitor = {
  batchId?: string;
  deployedAt?: string;
  sawOfflineAt?: string;
  sawOnlineAt?: string;
  lastStatus?: string | null;
  lastCheckedAt?: string;
  clearedAt?: string;
  /**
   * Restart detection on DayZ console/Nitrado is not always exposed as a
   * visible status transition. These fields keep the monitor recoverable and
   * prevent WAITING_RESET from blocking checkout forever.
   */
  expectedRestartAt?: string;
  restartFallbackAt?: string;
  autoConfirmedAt?: string;
  confirmationReason?: string;
};

export type ShopAutoDeployState = {
  lastWindowId?: string;
  lastCheckedAt?: string;
  lastDeployAt?: string;
};

export type ShopSavedLocation = {
  id: string;
  discordUserId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  createdAt: string;
  lastUsedAt?: string;
};

export type ShopPendingCheckout = {
  id: string;
  serverId?: string;
  discordUserId: string;
  itemId: string;
  itemClass: string;
  itemName?: string;
  price?: number;
  spawnEventName?: string;
  deliveryKind?: "item" | "vehicle";
  x: number;
  y: number;
  z: number;
  saveLocationName?: string;
  createdAt: string;
  expiresAt: string;
};

export type ShopOrder = {
  id: string;
  serverId?: string;
  discordUserId: string;
  itemClass: string;
  itemName?: string;
  spawnEventName?: string;
  deliveryKind?: "item" | "vehicle";
  x: number;
  y: number;
  z: number;
  status: ShopOrderStatus;
  restartTarget?: string;
  createdAt: string;
  includedAt?: string;
  spawnedAt?: string;
  failedAt?: string;
  failReason?: string;
  price?: number;
  locationName?: string;
  balanceBefore?: number;
  balanceAfter?: number;
};


export type ClanRole = "owner" | "officer" | "member";

export type ClanMember = {
  discordId: string;
  gamertag: string;
  role: ClanRole;
  joinedAt: string;
};

export type ClanActivityEvent = {
  id: string;
  type: "created" | "updated" | "invited" | "joined" | "left" | "removed" | "promoted" | "demoted" | "ownership_transferred";
  actorDiscordId: string;
  actorGamertag: string;
  subject?: string;
  createdAt: string;
};

export type Clan = {
  id: string;
  name: string;
  tag: string;
  description?: string;
  ownerDiscordId: string;
  createdAt: string;
  updatedAt: string;
  members: ClanMember[];
  activity?: ClanActivityEvent[];
};

export type ClanInvite = {
  id: string;
  clanId: string;
  invitedDiscordId: string;
  invitedGamertag: string;
  invitedByDiscordId: string;
  invitedByGamertag: string;
  createdAt: string;
  expiresAt: string;
};

export type PlayerLink = {
  discordId: string;
  gamertag: string;
  gamertagNormalized: string;
  locale: Locale;
  linkedAt: string;
  updatedAt: string;
};

export type Wallet = {
  discordId: string;
  gamertag: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  /**
   * Accumulated online minutes that have not been converted into coins yet.
   * This persists across bot/server restarts so a player at 58/60 minutes
   * keeps that progress and receives the reward after the remaining time.
   */
  onlineRewardMinutes?: number;
  lastPlaytimeRewardAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EconomyTransactionType =
  | "ADMIN_ADD"
  | "ADMIN_REMOVE"
  | "ADMIN_SET"
  | "SHOP_PURCHASE"
  | "PLAYTIME_REWARD"
  | "EVENT_REWARD"
  | "DONATION_REWARD";

export type EconomyTransaction = {
  id: string;
  serverId?: string;
  discordId: string;
  gamertag: string;
  type: EconomyTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason?: string;
  createdAt: string;
  createdBy?: string;
};

export type ActiveMatch = {
  id: string;
  name: string;
  channelId: string;
  messageId?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "finished";
  players: Record<string, PlayerStats>;
};


export type OnlineActivitySample = {
  bucket: string;
  online: number;
};

export type AppState = {
  players: Record<string, PlayerStats>;
  dailyPlayers: Record<string, PlayerStats>;
  weeklyPlayers: Record<string, PlayerStats>;
  onlinePlayers: Record<string, OnlinePlayer>;
  onlineSessions: Record<string, OnlineSession>;
  onlineActivitySamples?: OnlineActivitySample[];

  playerLinks: Record<string, PlayerLink>;
  playerLinksByGamertag: Record<string, string>;
  playerAlts?: Record<string, string[]>;

  clans?: Record<string, Clan>;
  clanMemberships?: Record<string, string>;
  clanInvites?: ClanInvite[];

  wallets: Record<string, Wallet>;
  economyTransactions: EconomyTransaction[];

  shopOrders: ShopOrder[];
  shopSavedLocations?: ShopSavedLocation[];
  shopPendingCheckouts?: ShopPendingCheckout[];
  shopCatalog?: ShopCatalog;
  dayzItems?: DayzItemDefinition[];
  shopResetMonitor?: ShopResetMonitor | null;
  shopAutoDeploy?: ShopAutoDeployState | null;

  files: Record<string, FileCursor>;
  recentEventIds: string[];

  killFeedEvents: KillFeedEvent[];
  // Recent kills for the Player Portal. Unlike killFeedEvents, Discord never consumes this ring buffer.
  portalKillFeedEvents: KillFeedEvent[];
  longShotEvents: LongShotEvent[];

  currentKillStreaks: Record<string, number>;
  killStreakEvents: KillStreakEvent[];

  discordMessageIds: Record<string, string>;

  activeMatch?: ActiveMatch | null;

  lastDailyReset: string;
  lastWeeklyReset: string;

  globalStartedAt?: string;
  dailyStartedAt?: string;
  weeklyStartedAt?: string;

  lastLine?: number;
  lastFileName?: string;

  mapRotation?: any;
  mapVoteUserLocales?: Record<string, { locale: Locale; updatedAt: string }>;
  discordCommandSettings?: DiscordCommandSettings;
  serviceSettings?: ServiceSettings;
};

export type DiscordRuntimeState = {
  killFeedEvents: KillFeedEvent[];
  killStreakEvents: KillStreakEvent[];
  discordMessageIds: Record<string, string>;
  mapRotation?: any;
};

function defaultDiscordRuntimeState(): DiscordRuntimeState {
  return {
    killFeedEvents: [],
    killStreakEvents: [],
    discordMessageIds: {},
    mapRotation: undefined,
  };
}

function normalizeDiscordRuntimeState(data: Partial<AppState> | Partial<DiscordRuntimeState> | null | undefined): DiscordRuntimeState {
  const source = data || {};
  return {
    killFeedEvents: Array.isArray(source.killFeedEvents) ? source.killFeedEvents.slice(-60) : [],
    killStreakEvents: Array.isArray(source.killStreakEvents)
      ? source.killStreakEvents.map(normalizeKillStreakEvent).filter(Boolean).slice(-100) as KillStreakEvent[]
      : [],
    discordMessageIds: source.discordMessageIds && typeof source.discordMessageIds === "object" ? source.discordMessageIds : {},
    mapRotation: source.mapRotation,
  };
}

function applyDiscordRuntimeState(state: AppState, runtime: DiscordRuntimeState): AppState {
  state.killFeedEvents = runtime.killFeedEvents;
  state.killStreakEvents = runtime.killStreakEvents;
  state.discordMessageIds = runtime.discordMessageIds;
  state.mapRotation = runtime.mapRotation;
  return state;
}

function defaultState(): AppState {
  return {
    players: {},
    dailyPlayers: {},
    weeklyPlayers: {},
    onlinePlayers: {},
    onlineSessions: {},
    onlineActivitySamples: [],
    playerLinks: {},
    playerLinksByGamertag: {},
    playerAlts: {},
    clans: {},
    clanMemberships: {},
    clanInvites: [],
    wallets: {},
    economyTransactions: [],
    shopOrders: [],
    shopSavedLocations: [],
    shopPendingCheckouts: [],
    shopCatalog: undefined,
    dayzItems: undefined,
    shopResetMonitor: null,
    shopAutoDeploy: null,
    files: {},
    recentEventIds: [],
    killFeedEvents: [],
    portalKillFeedEvents: [],
    longShotEvents: [],
    currentKillStreaks: {},
    killStreakEvents: [],
    discordMessageIds: {},
    activeMatch: null,
    mapRotation: undefined,
    mapVoteUserLocales: {},
    discordCommandSettings: {},
    serviceSettings: normalizeServiceSettings(undefined),
    lastDailyReset: "",
    lastWeeklyReset: "",
  };
}

function normalizeKillStreakEvent(event: any): KillStreakEvent | null {
  if (!event || typeof event !== "object") return null;

  const timestamp =
    typeof event.timestamp === "number"
      ? event.timestamp
      : event.at
        ? Math.floor(new Date(event.at).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

  if (event.type === "streak" || event.type === "milestone") {
    return {
      type: "streak",
      player: event.player || "Unknown",
      streak: Number(event.streak || 0),
      timestamp,
    };
  }

  if (event.type === "ended") {
    return {
      type: "ended",
      player: event.player || "Unknown",
      streak: Number(event.streak || 0),
      killer: event.killer || event.endedBy || "Unknown",
      timestamp,
    };
  }

  return null;
}

function migrateLegacyState(data: any): AppState {
  const state = defaultState();

  state.players = data.players || {};
  state.dailyPlayers = data.dailyPlayers || {};
  state.weeklyPlayers = data.weeklyPlayers || {};
  state.recentEventIds = data.recentEventIds || [];
  state.killFeedEvents = data.killFeedEvents || [];
  state.portalKillFeedEvents = (data.portalKillFeedEvents || data.killFeedEvents || []).slice(-99);
  state.longShotEvents = (data.longShotEvents || []).slice(-150);

  state.currentKillStreaks = data.currentKillStreaks || data.killStreaks || {};

  state.killStreakEvents = (data.killStreakEvents || [])
    .map(normalizeKillStreakEvent)
    .filter(Boolean)
    .slice(-150) as KillStreakEvent[];

  state.discordMessageIds = data.discordMessageIds || {};
  state.files = data.files || {};
  state.lastDailyReset = data.lastDailyReset || "";
  state.lastWeeklyReset = data.lastWeeklyReset || "";

  state.globalStartedAt = data.globalStartedAt;
  state.dailyStartedAt = data.dailyStartedAt;
  state.weeklyStartedAt = data.weeklyStartedAt;

  state.activeMatch = data.activeMatch || null;

  state.lastLine = data.lastLine;
  state.lastFileName = data.lastFileName;

  state.onlineSessions = data.onlineSessions || {};
  state.playerLinks = data.playerLinks || {};
  state.playerLinksByGamertag = {};
  const playerAlts: Record<string, string[]> = data.playerAlts && typeof data.playerAlts === "object"
    ? (data.playerAlts as Record<string, string[]>)
    : {};
  state.playerAlts = playerAlts;
  state.clans = data.clans && typeof data.clans === "object" ? data.clans : {};
  state.clanMemberships = data.clanMemberships && typeof data.clanMemberships === "object" ? data.clanMemberships : {};
  state.clanInvites = Array.isArray(data.clanInvites) ? data.clanInvites : [];

  for (const [discordId, link] of Object.entries(state.playerLinks)) {
    const existing = link as any;
    const gamertag = String(existing.gamertag || "").trim();
    if (!gamertag) {
      delete state.playerLinks[discordId];
      continue;
    }

    const normalized = String(existing.gamertagNormalized || gamertag.toLowerCase()).trim().toLowerCase();
    state.playerLinks[discordId] = {
      discordId: String(existing.discordId || discordId),
      gamertag,
      gamertagNormalized: normalized,
      locale: existing.locale === "pt" ? "pt" : existing.locale === "es" ? "es" : "en",
      linkedAt: existing.linkedAt || existing.createdAt || new Date().toISOString(),
      updatedAt: existing.updatedAt || existing.linkedAt || new Date().toISOString(),
    };
    state.playerLinksByGamertag[normalized] = discordId;
  }

  for (const [discordId, rawAlts] of Object.entries(playerAlts)) {
    const mainLink = state.playerLinks[discordId];
    if (!mainLink) {
      delete playerAlts[discordId];
      continue;
    }
    const mainNormalized = mainLink.gamertagNormalized || "";
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const raw of Array.isArray(rawAlts) ? rawAlts : []) {
      const gamertag = String(raw || "").trim();
      const normalized = gamertag.toLowerCase();
      if (!gamertag || !normalized || normalized === mainNormalized || seen.has(normalized)) continue;
      const owner = state.playerLinksByGamertag[normalized];
      if (owner && owner !== discordId) continue;
      seen.add(normalized);
      clean.push(gamertag);
      state.playerLinksByGamertag[normalized] = discordId;
    }
    playerAlts[discordId] = clean.slice(0, 5);
  }

  state.wallets = {};
  for (const [discordId, wallet] of Object.entries(data.wallets || {})) {
    const existing = wallet as any;
    const balance = Math.max(0, Math.floor(Number(existing.balance || 0)));
    const totalEarned = Math.max(0, Math.floor(Number(existing.totalEarned || 0)));
    const totalSpent = Math.max(0, Math.floor(Number(existing.totalSpent || 0)));
    const linkedGamertag = state.playerLinks[discordId]?.gamertag;
    const gamertag = String(existing.gamertag || linkedGamertag || "Unknown").trim();
    const now = new Date().toISOString();

    state.wallets[discordId] = {
      discordId: String(existing.discordId || discordId),
      gamertag,
      balance,
      totalEarned,
      totalSpent,
      onlineRewardMinutes: Math.max(0, Math.floor(Number(existing.onlineRewardMinutes || 0))),
      lastPlaytimeRewardAt: existing.lastPlaytimeRewardAt,
      createdAt: existing.createdAt || existing.linkedAt || now,
      updatedAt: existing.updatedAt || now,
    };
  }

  state.economyTransactions = Array.isArray(data.economyTransactions)
    ? data.economyTransactions.slice(-1000)
    : [];

  state.shopOrders = Array.isArray(data.shopOrders) ? data.shopOrders : [];
  state.shopSavedLocations = Array.isArray(data.shopSavedLocations) ? data.shopSavedLocations : [];
  state.shopPendingCheckouts = Array.isArray(data.shopPendingCheckouts) ? data.shopPendingCheckouts : [];
  state.shopCatalog = data.shopCatalog;
  state.dayzItems = Array.isArray(data.dayzItems) ? data.dayzItems : undefined;
  state.shopResetMonitor = data.shopResetMonitor || null;
  state.shopAutoDeploy = data.shopAutoDeploy || null;
  state.mapRotation = data.mapRotation;
  state.mapVoteUserLocales = data.mapVoteUserLocales && typeof data.mapVoteUserLocales === "object" ? data.mapVoteUserLocales : {};
  state.discordCommandSettings = normalizeDiscordCommandSettings(data.discordCommandSettings);
  state.serviceSettings = normalizeServiceSettings(data.serviceSettings);

  const rawOnlinePlayers = data.onlinePlayers || {};
  const now = new Date().toISOString();

  for (const [name, value] of Object.entries(rawOnlinePlayers)) {
    if (value === true) {
      state.onlinePlayers[name] = {
        online: true,
        connectedAt: now,
        lastSeenAt: now,
      };

      state.onlineSessions[name] = {
        connectedAt: now,
        lastSeenAt: now,
        kills: 0,
        deaths: 0,
        streak: 0,
      };
    } else if (typeof value === "object" && value) {
      const existing = value as any;

      if (existing.online === false) continue;

      const connectedAt = existing.connectedAt || existing.lastSeenAt || now;
      const lastSeenAt = existing.lastSeenAt || now;

      state.onlinePlayers[name] = {
        online: true,
        connectedAt,
        lastSeenAt,
      };

      state.onlineSessions[name] = {
        connectedAt,
        lastSeenAt,
        kills: Number(existing.sessionKills || existing.kills || 0),
        deaths: Number(existing.sessionDeaths || existing.deaths || 0),
        streak: Number(existing.sessionStreak || existing.streak || 0),
      };
    }
  }

  return state;
}




function hasPersistedSpawnZones(value: any) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.zones) && value.zones.length > 0);
}

function parseLastPersistedState(): Partial<AppState> | null {
  if (!getPersistenceRuntime().lastPersistedJson) return null;
  try {
    return JSON.parse(getPersistenceRuntime().lastPersistedJson) as Partial<AppState>;
  } catch {
    return null;
  }
}

function serializeState(data: AppState): string {
  return JSON.stringify(data);
}

function hashState(serialized: string): string {
  return crypto.createHash("sha1").update(serialized).digest("hex");
}

function serializeCoreState(data: AppState): string {
  const { killFeedEvents: _killFeedEvents, killStreakEvents: _killStreakEvents, discordMessageIds: _discordMessageIds, mapRotation: _mapRotation, ...core } = data;
  return JSON.stringify(core);
}

function hashCoreState(data: AppState): string {
  return hashState(serializeCoreState(data));
}

export function getCoreStateFingerprint(data: AppState): string {
  return hashCoreState(data);
}

function serializeDiscordRuntime(data: Partial<AppState> | Partial<DiscordRuntimeState>): string {
  return JSON.stringify(normalizeDiscordRuntimeState(data));
}

function buildStateDomains(data: AppState): Record<StateDomainName, StateDomainPayload> {
  return {
    stats: {
      // Global player totals and current streaks are persisted granularly in
      // player_stats_state. Keeping them out of this blob prevents every kill
      // from retransmitting the full historical player population. The env
      // fallback restores the old V2 blob shape without a rollback deploy.
      ...(GRANULAR_PLAYER_STATS_ENABLED ? {} : {
        players: data.players || {},
        currentKillStreaks: data.currentKillStreaks || {},
      }),
      dailyPlayers: data.dailyPlayers || {},
      weeklyPlayers: data.weeklyPlayers || {},
      portalKillFeedEvents: (data.portalKillFeedEvents || []).slice(-99),
      longShotEvents: (data.longShotEvents || []).slice(-100),
      lastDailyReset: data.lastDailyReset || "",
      lastWeeklyReset: data.lastWeeklyReset || "",
      globalStartedAt: data.globalStartedAt,
      dailyStartedAt: data.dailyStartedAt,
      weeklyStartedAt: data.weeklyStartedAt,
    },
    processing: {
      onlinePlayers: data.onlinePlayers || {},
      onlineSessions: data.onlineSessions || {},
      onlineActivitySamples: Array.isArray(data.onlineActivitySamples) ? data.onlineActivitySamples : [],
      files: data.files || {},
      recentEventIds: (data.recentEventIds || []).slice(-3000),
      activeMatch: data.activeMatch || null,
      lastLine: data.lastLine,
      lastFileName: data.lastFileName,
    },
    social: {
      playerLinks: data.playerLinks || {},
      playerLinksByGamertag: data.playerLinksByGamertag || {},
      playerAlts: data.playerAlts && typeof data.playerAlts === "object" ? data.playerAlts : {},
      clans: data.clans && typeof data.clans === "object" ? data.clans : {},
      clanMemberships: data.clanMemberships && typeof data.clanMemberships === "object" ? data.clanMemberships : {},
      clanInvites: Array.isArray(data.clanInvites) ? data.clanInvites : [],
    },
    commerce: {
      wallets: data.wallets || {},
      economyTransactions: Array.isArray(data.economyTransactions) ? data.economyTransactions.slice(-1000) : [],
      shopOrders: Array.isArray(data.shopOrders) ? data.shopOrders : [],
      shopSavedLocations: Array.isArray(data.shopSavedLocations) ? data.shopSavedLocations : [],
      shopPendingCheckouts: Array.isArray(data.shopPendingCheckouts) ? data.shopPendingCheckouts : [],
      shopCatalog: data.shopCatalog,
      dayzItems: Array.isArray(data.dayzItems) ? data.dayzItems : undefined,
      shopResetMonitor: data.shopResetMonitor || null,
      shopAutoDeploy: data.shopAutoDeploy || null,
    },
    config: {
      mapVoteUserLocales: data.mapVoteUserLocales && typeof data.mapVoteUserLocales === "object" ? data.mapVoteUserLocales : {},
      discordCommandSettings: normalizeDiscordCommandSettings(data.discordCommandSettings),
      serviceSettings: normalizeServiceSettings(data.serviceSettings),
    },
  };
}

function applyStateDomain(state: AppState, domain: StateDomainName, payload: any): AppState {
  if (!payload || typeof payload !== "object") return state;
  if (domain === "stats") {
    // Older V2 rows contained players/currentKillStreaks. Apply them when
    // present so rollout/rollback stays safe, but never wipe the compatibility
    // snapshot when a newer V3 stats row intentionally omits them.
    if (payload.players && typeof payload.players === "object") state.players = payload.players;
    state.dailyPlayers = payload.dailyPlayers || {};
    state.weeklyPlayers = payload.weeklyPlayers || {};
    state.portalKillFeedEvents = Array.isArray(payload.portalKillFeedEvents) ? payload.portalKillFeedEvents.slice(-99) : [];
    state.longShotEvents = Array.isArray(payload.longShotEvents) ? payload.longShotEvents.slice(-100) : [];
    if (payload.currentKillStreaks && typeof payload.currentKillStreaks === "object") state.currentKillStreaks = payload.currentKillStreaks;
    state.lastDailyReset = payload.lastDailyReset || "";
    state.lastWeeklyReset = payload.lastWeeklyReset || "";
    state.globalStartedAt = payload.globalStartedAt;
    state.dailyStartedAt = payload.dailyStartedAt;
    state.weeklyStartedAt = payload.weeklyStartedAt;
  } else if (domain === "processing") {
    state.onlinePlayers = payload.onlinePlayers || {};
    state.onlineSessions = payload.onlineSessions || {};
    state.onlineActivitySamples = Array.isArray(payload.onlineActivitySamples) ? payload.onlineActivitySamples : [];
    state.files = payload.files || {};
    state.recentEventIds = Array.isArray(payload.recentEventIds) ? payload.recentEventIds.slice(-3000) : [];
    state.activeMatch = payload.activeMatch || null;
    state.lastLine = payload.lastLine;
    state.lastFileName = payload.lastFileName;
  } else if (domain === "social") {
    state.playerLinks = payload.playerLinks || {};
    state.playerLinksByGamertag = payload.playerLinksByGamertag || {};
    state.playerAlts = payload.playerAlts && typeof payload.playerAlts === "object" ? payload.playerAlts : {};
    state.clans = payload.clans && typeof payload.clans === "object" ? payload.clans : {};
    state.clanMemberships = payload.clanMemberships && typeof payload.clanMemberships === "object" ? payload.clanMemberships : {};
    state.clanInvites = Array.isArray(payload.clanInvites) ? payload.clanInvites : [];
  } else if (domain === "commerce") {
    state.wallets = payload.wallets || {};
    state.economyTransactions = Array.isArray(payload.economyTransactions) ? payload.economyTransactions.slice(-1000) : [];
    state.shopOrders = Array.isArray(payload.shopOrders) ? payload.shopOrders : [];
    state.shopSavedLocations = Array.isArray(payload.shopSavedLocations) ? payload.shopSavedLocations : [];
    state.shopPendingCheckouts = Array.isArray(payload.shopPendingCheckouts) ? payload.shopPendingCheckouts : [];
    state.shopCatalog = payload.shopCatalog;
    state.dayzItems = Array.isArray(payload.dayzItems) ? payload.dayzItems : undefined;
    state.shopResetMonitor = payload.shopResetMonitor || null;
    state.shopAutoDeploy = payload.shopAutoDeploy || null;
  } else if (domain === "config") {
    state.mapVoteUserLocales = payload.mapVoteUserLocales && typeof payload.mapVoteUserLocales === "object" ? payload.mapVoteUserLocales : {};
    state.discordCommandSettings = normalizeDiscordCommandSettings(payload.discordCommandSettings);
    state.serviceSettings = normalizeServiceSettings(payload.serviceSettings);
  }
  return state;
}

function initializeDomainHashes(data: AppState) {
  const domains = buildStateDomains(data);
  for (const domain of Object.keys(STATE_DOMAIN_IDS) as StateDomainName[]) {
    const serialized = JSON.stringify(domains[domain]);
    getPersistenceRuntime().lastDomainHashes[domain] = hashState(serialized);
    domainPersistenceMetrics.domains[domain].currentBytes = Buffer.byteLength(serialized, "utf8");
  }
}

function nextAlignedDelay(intervalMs: number, now = Date.now()) {
  const remainder = now % intervalMs;
  return Math.max(1000, intervalMs - remainder);
}

function nextAlignedBackgroundDelay() {
  return nextAlignedDelay(STATE_BACKGROUND_PERSIST_MS);
}

function domainPersistIntervalMs(domain: StateDomainName) {
  if (domain === "stats") return STATE_STATS_PERSIST_MS;
  if (domain === "processing") return STATE_PROCESSING_PERSIST_MS;
  return 0;
}

function domainDueAt(domain: StateDomainName, now = Date.now()) {
  const intervalMs = domainPersistIntervalMs(domain);
  return intervalMs > 0 ? now + nextAlignedDelay(intervalMs, now) : now;
}

function canonicalPersistenceReason(reason: string) {
  const normalized = String(reason || "").replace(/\\/g, "/").trim();
  if (!normalized) return "unknown";
  if (normalized === "parser" || /(?:^|\/)lib\/parser(?:\.|$|\/)/.test(normalized)) return "parser";
  const discordMatch = normalized.match(/(?:^|\/)lib\/discord\/([^/:]+)(?:\.|\/|$)/);
  if (discordMatch) return `discord:${discordMatch[1].replace(/\.(ts|js)$/, "")}`;
  if (/(?:^|\/)routes\/adminPanel(?:\.|$|\/)/.test(normalized)) return "admin-panel";
  if (/(?:^|\/)routes\/playerPortal(?:\.|$|\/)/.test(normalized)) return "player-portal";
  if (/(?:^|\/)routes\/admin(?:\.|$|\/)/.test(normalized)) return "admin-api";
  return normalized.slice(0, 120);
}

function isBackgroundPersistenceReason(reason: string) {
  const canonical = canonicalPersistenceReason(reason);
  return canonical === "parser" || canonical.startsWith("discord:") || canonical.startsWith("lib:discord:");
}

function domainNeedsImmediateFlush(domain: StateDomainName) {
  return domain === "social" || domain === "commerce" || domain === "config";
}

function granularPlayerSignature(stats: PlayerStats, currentStreak: number) {
  return `${Number(stats.kills || 0)}:${Number(stats.deaths || 0)}:${Number(currentStreak || 0)}`;
}

function initializeGranularPlayerSignatures(data: AppState) {
  getPersistenceRuntime().lastGranularPlayerSignatures = new Map<string, string>();
  for (const [playerKey, stats] of Object.entries(data.players || {})) {
    const currentStreak = Number((data.currentKillStreaks || {})[playerKey] || 0);
    getPersistenceRuntime().lastGranularPlayerSignatures.set(playerKey, granularPlayerSignature(stats, currentStreak));
  }
  getPersistenceRuntime().pendingGranularPlayerStats.clear();
}

function queueGranularPlayerStats(data: AppState) {
  if (!GRANULAR_PLAYER_STATS_ENABLED) return 0;
  let changed = 0;
  const dueAt = domainDueAt("stats");
  for (const [playerKey, stats] of Object.entries(data.players || {})) {
    const currentStreak = Number((data.currentKillStreaks || {})[playerKey] || 0);
    const signature = granularPlayerSignature(stats, currentStreak);
    const pending = getPersistenceRuntime().pendingGranularPlayerStats.get(playerKey);
    if (signature === getPersistenceRuntime().lastGranularPlayerSignatures.get(playerKey) || signature === pending?.signature) continue;
    getPersistenceRuntime().pendingGranularPlayerStats.set(playerKey, {
      stats: { kills: Number(stats.kills || 0), deaths: Number(stats.deaths || 0) },
      currentStreak,
      signature,
      dueAt: pending?.dueAt ?? dueAt,
    });
    changed += 1;
    granularPlayerStatsMetrics.changes += 1;
  }
  return changed;
}

export async function createManagedServerDraft(input: ManagedServerDraftInput) {
  assertNoServerSecrets(input);
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const rawName = String(input?.name || "").trim();
  if (!rawName) throw new Error("Informe o nome do servidor.");
  const name = normalizeManagedServerName(rawName);
  const id = buildManagedServerId(input?.id || name);
  if (!id) throw new Error("Informe um nome ou Server ID valido.");
  if (id === getPrimaryServerId()) throw new Error("O Server ID do PZ Deathmatch e reservado e nao pode ser reutilizado.");

  if (input?.discordGuildId !== undefined || input?.discord !== undefined) {
    throw new Error("Discord nao aceita Guild ID/Channel IDs manuais. Crie o servidor primeiro e use Connect Discord.");
  }
  const requestedOrganizationId = buildOrganizationId(input?.organizationId || getDefaultOrganizationId()) || getDefaultOrganizationId();
  if (!getManagedOrganizationById(requestedOrganizationId)) throw new Error("Organization ID invalido ou nao encontrado.");

  const descriptor: ManagedServerDescriptor = {
    id,
    name,
    organizationId: requestedOrganizationId,
    enabled: true,
    primary: false,
    runtimeEnabled: false,
    onboardingStatus: "draft",
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: optionalServerText(input?.nitradoServiceId, 64),
      discordGuildId: undefined,
    },
    runtime: {
      nitradoBaseDir: optionalServerText(input?.nitradoBaseDir, 512),
      settings: normalizeServerScopedSettingsDraft(input?.settings, {}),
      discord: {},
    },
  };
  descriptor.onboardingStatus = deriveServerOnboardingStatus(descriptor);

  const existingServers = await reloadManagedServerRegistryFromDb();
  if (descriptor.integrations.nitradoServiceId && existingServers.some((server) => server.integrations.nitradoServiceId === descriptor.integrations.nitradoServiceId)) {
    throw new Error("Este Nitrado Service ID ja esta vinculado a outro servidor.");
  }
  if (descriptor.integrations.discordGuildId && existingServers.some((server) => server.integrations.discordGuildId === descriptor.integrations.discordGuildId)) {
    throw new Error("Este Discord Guild ID ja esta vinculado a outro servidor.");
  }

  const inserted = await sql`
    INSERT INTO managed_servers (
      id, name, organization_id, enabled, primary_server, runtime_enabled, onboarding_status,
      mode, nitrado_service_id, discord_guild_id, runtime_config, created_at, updated_at
    ) VALUES (
      ${descriptor.id}, ${descriptor.name}, ${descriptor.organizationId}, TRUE, FALSE, FALSE, ${descriptor.onboardingStatus},
      ${descriptor.mode}, ${descriptor.integrations.nitradoServiceId || null}, ${descriptor.integrations.discordGuildId || null},
      ${JSON.stringify(descriptor.runtime)}::jsonb, NOW(), NOW()
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (!(inserted as any[]).length) throw new Error(`Server ID ${descriptor.id} ja existe.`);

  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: "create_server_draft",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify(descriptor), "utf8"),
    ok: true,
  });
  return servers.find((server) => server.id === descriptor.id) || descriptor;
}

export async function updateManagedServerDraft(serverId: string, input: ManagedServerDraftInput) {
  assertNoServerSecrets(input);
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const id = buildManagedServerId(serverId);
  if (!id || id === getPrimaryServerId()) throw new Error("O servidor primario nao pode ser alterado pelo onboarding da Fase 11.");
  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);
  if (current.runtimeEnabled) throw new Error("Desative o runtime antes de alterar a configuracao deste servidor.");
  if (input?.discordGuildId !== undefined || input?.discord !== undefined) {
    throw new Error("Discord nao aceita Guild ID/Channel IDs manuais. Use Connect Discord e a configuracao guiada de canais.");
  }

  const nextNitradoServiceId = input?.nitradoServiceId === undefined
    ? current.integrations.nitradoServiceId
    : optionalServerText(input.nitradoServiceId, 64);
  const nextNitradoBaseDir = input?.nitradoBaseDir === undefined
    ? current.runtime.nitradoBaseDir
    : optionalServerText(input.nitradoBaseDir, 512);
  const nitradoRoutingUnchanged = nextNitradoServiceId === current.integrations.nitradoServiceId
    && nextNitradoBaseDir === current.runtime.nitradoBaseDir;

  const next: ManagedServerDescriptor = {
    ...current,
    name: input?.name === undefined ? current.name : normalizeManagedServerName(input.name),
    enabled: true,
    primary: false,
    runtimeEnabled: false,
    onboardingStatus: "draft",
    integrations: {
      nitradoServiceId: nextNitradoServiceId,
      discordGuildId: current.integrations.discordGuildId,
    },
    runtime: {
      nitradoBaseDir: nextNitradoBaseDir,
      nitradoValidation: nitradoRoutingUnchanged && current.runtime.nitradoValidation
        ? { ...current.runtime.nitradoValidation }
        : undefined,
      activationPreflight: undefined,
      activation: current.runtime.activation ? { ...current.runtime.activation } : undefined,
      operations: current.runtime.operations ? { ...current.runtime.operations, paused: false } : undefined,
      settings: normalizeServerScopedSettingsDraft(input?.settings, current.runtime.settings || {}),
      discord: { ...(current.runtime.discord || {}) },
    },
  };
  next.onboardingStatus = deriveServerOnboardingStatus(next);

  const allServers = currentServers;
  if (next.integrations.nitradoServiceId && allServers.some((server) => server.id !== id && server.integrations.nitradoServiceId === next.integrations.nitradoServiceId)) {
    throw new Error("Este Nitrado Service ID ja esta vinculado a outro servidor.");
  }
  if (next.integrations.discordGuildId && allServers.some((server) => server.id !== id && server.integrations.discordGuildId === next.integrations.discordGuildId)) {
    throw new Error("Este Discord Guild ID ja esta vinculado a outro servidor.");
  }

  await sql`
    UPDATE managed_servers
    SET name = ${next.name},
        enabled = TRUE,
        primary_server = FALSE,
        runtime_enabled = FALSE,
        onboarding_status = ${next.onboardingStatus},
        mode = ${next.mode},
        nitrado_service_id = ${next.integrations.nitradoServiceId || null},
        discord_guild_id = ${next.integrations.discordGuildId || null},
        runtime_config = ${JSON.stringify(next.runtime)}::jsonb,
        updated_at = NOW()
    WHERE id = ${id} AND id <> ${getPrimaryServerId()}
  `;

  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: "update_server_draft",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify(next), "utf8"),
    ok: true,
  });
  return servers.find((server) => server.id === id) || next;
}

export async function bindManagedServerDiscordGuild(serverIdInput: unknown, guildIdInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const id = buildManagedServerId(serverIdInput);
  const guildId = optionalServerText(guildIdInput, 64);
  if (!id) throw new Error("Server ID invalido.");
  if (!guildId) throw new Error("Discord Guild ID invalido.");

  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);
  const duplicate = currentServers.find((server) => server.id !== id && server.integrations.discordGuildId === guildId);
  if (duplicate) throw new Error(`Este Discord ja esta vinculado ao servidor ${duplicate.name}.`);

  const guildChanged = Boolean(current.integrations.discordGuildId && current.integrations.discordGuildId !== guildId);
  const nextRuntime = {
    ...current.runtime,
    // Channel IDs belong to one guild. If an existing server is deliberately
    // moved to another guild, fail closed instead of carrying channel IDs from
    // the old Discord into the new one. Core slash commands need no channels.
    discord: guildChanged ? {} : { ...(current.runtime.discord || {}) },
  };

  await sql`
    UPDATE managed_servers
    SET discord_guild_id = ${guildId},
        runtime_config = ${JSON.stringify(nextRuntime)}::jsonb,
        updated_at = NOW()
    WHERE id = ${id}
  `;

  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: "bind_discord_guild",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, guildId }), "utf8"),
    ok: true,
  });
  return servers.find((server) => server.id === id);
}

export async function updateManagedServerDiscordChannels(serverIdInput: unknown, discordInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) throw new Error("Server registry is unavailable.");
  const id = buildManagedServerId(serverIdInput);
  if (!id) throw new Error("Server ID invalido.");
  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);
  if (!current.integrations.discordGuildId) throw new Error("Conecte o Discord deste servidor antes de configurar canais.");

  const discord = normalizeServerDiscordDraft(discordInput, current.runtime.discord || {});
  const runtime = { ...current.runtime, discord };
  await sql`
    UPDATE managed_servers
    SET runtime_config = ${JSON.stringify(runtime)}::jsonb, updated_at = NOW()
    WHERE id = ${id}
  `;
  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry", operation: "update_server_discord_channels", direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, discord }), "utf8"), ok: true,
  });
  return servers.find((server) => server.id === id);
}

export async function updateManagedServerScopedSettings(serverIdInput: unknown, settingsInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) throw new Error("Server registry is unavailable.");
  const id = buildManagedServerId(serverIdInput);
  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id || String(serverIdInput || "")} nao encontrado.`);
  if (current.runtimeEnabled && !current.runtime.operations?.paused) {
    throw new Error("Pause o processamento deste servidor antes de alterar restart/timezone/mission path.");
  }
  const settings = normalizeServerScopedSettingsDraft(settingsInput, current.runtime.settings || {});
  const restartTimes = String(settings.shopRestartTimes || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!restartTimes.length || restartTimes.some((value) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new Error("Restart times deve usar HH:MM separado por virgulas.");
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: settings.shopRestartTimezone || "UTC" }).format(new Date()); }
  catch { throw new Error("Timezone invalido. Use um timezone IANA, por exemplo America/Sao_Paulo."); }
  const missionDir = String(settings.dayzMissionDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!missionDir || missionDir.includes("..")) throw new Error("Mission dir invalido.");
  settings.dayzMissionDir = missionDir;
  settings.shopDeliveryConfiguredAt = new Date().toISOString();
  const runtime = { ...current.runtime, settings };
  await sql`
    UPDATE managed_servers
    SET runtime_config = ${JSON.stringify(runtime)}::jsonb, updated_at = NOW()
    WHERE id = ${id}
  `;
  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry", operation: "update_server_scoped_settings", direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, settings }), "utf8"), ok: true,
  });
  return servers.find((server) => server.id === id);
}

export async function ensureManagedServerShopDeliveryConfiguration(
  serverIdInput: unknown,
  input: { missionDir: string; restartTimes?: string; restartTimezone?: string },
) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) throw new Error("Server registry is unavailable.");
  const id = buildManagedServerId(serverIdInput);
  if (!id || id === getPrimaryServerId()) return getPrimaryServerDescriptor();

  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);

  const existing = current.runtime.settings || {};
  const missionDir = String(existing.dayzMissionDir || input.missionDir || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!missionDir || missionDir.includes("..")) throw new Error("Mission dir invalido para Shop delivery.");

  // Initial bootstrap is fill-only: never overwrite explicit tenant settings.
  const settings: ServerScopedSettings = {
    ...existing,
    dayzMissionDir: missionDir,
    shopRestartTimes: String(existing.shopRestartTimes || input.restartTimes || "00:00,04:00,08:00,12:00,16:00,20:00").trim(),
    shopRestartTimezone: String(existing.shopRestartTimezone || input.restartTimezone || "America/Sao_Paulo").trim(),
    shopDeliveryConfiguredAt: String(existing.shopDeliveryConfiguredAt || new Date().toISOString()).trim(),
  };

  const runtime = { ...current.runtime, settings };
  await sql`
    UPDATE managed_servers
    SET runtime_config = ${JSON.stringify(runtime)}::jsonb, updated_at = NOW()
    WHERE id = ${id}
  `;
  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry", operation: "bootstrap_shop_delivery_settings", direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, settings }), "utf8"), ok: true,
  });
  return servers.find((server) => server.id === id);
}

export async function markManagedServerNitradoValidated(
  serverId: string,
  validation: { serviceId: string; baseDir: string; missionDir?: string },
) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const id = buildManagedServerId(serverId);
  if (!id || id === getPrimaryServerId()) {
    throw new Error("O servidor primario nao usa o fluxo de validacao da Fase 11.");
  }

  const serviceId = optionalServerText(validation?.serviceId, 64);
  const baseDir = optionalServerText(validation?.baseDir, 512);
  if (!serviceId || !baseDir) throw new Error("Service ID e base dir sao obrigatorios para validar o Nitrado.");

  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);
  if (current.runtimeEnabled) throw new Error("Desative o runtime antes de revalidar a integracao Nitrado.");
  if (currentServers.some((server) => server.id !== id && server.integrations.nitradoServiceId === serviceId)) {
    throw new Error("Este Nitrado Service ID ja esta vinculado a outro servidor.");
  }

  const discoveredMissionDir = String(validation?.missionDir || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const currentSettings = current.runtime.settings || {};
  const initialSettings: ServerScopedSettings = discoveredMissionDir
    ? {
        ...currentSettings,
        dayzMissionDir: currentSettings.dayzMissionDir || discoveredMissionDir,
        shopRestartTimes: currentSettings.shopRestartTimes || "00:00,04:00,08:00,12:00,16:00,20:00",
        shopRestartTimezone: currentSettings.shopRestartTimezone || "America/Sao_Paulo",
        shopDeliveryConfiguredAt: currentSettings.shopDeliveryConfiguredAt || new Date().toISOString(),
      }
    : { ...currentSettings };

  const nitradoValidation: ServerNitradoValidation = {
    serviceId,
    baseDir,
    validatedAt: new Date().toISOString(),
    source: "phase10-on-demand",
  };
  const next: ManagedServerDescriptor = {
    ...current,
    enabled: true,
    primary: false,
    runtimeEnabled: false,
    onboardingStatus: "configured",
    integrations: { ...current.integrations, nitradoServiceId: serviceId },
    runtime: {
      ...current.runtime,
      nitradoBaseDir: baseDir,
      nitradoValidation,
      activationPreflight: undefined,
      activation: current.runtime.activation ? { ...current.runtime.activation } : undefined,
      operations: current.runtime.operations ? { ...current.runtime.operations, paused: false } : undefined,
      settings: initialSettings,
      discord: { ...(current.runtime.discord || {}) },
    },
  };
  next.onboardingStatus = deriveServerOnboardingStatus(next);

  await sql`
    UPDATE managed_servers
    SET enabled = TRUE,
        primary_server = FALSE,
        runtime_enabled = FALSE,
        onboarding_status = ${next.onboardingStatus},
        nitrado_service_id = ${serviceId},
        runtime_config = ${JSON.stringify(next.runtime)}::jsonb,
        updated_at = NOW()
    WHERE id = ${id} AND id <> ${getPrimaryServerId()}
  `;

  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: "validate_server_nitrado",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, serviceId, baseDir, validatedAt: nitradoValidation.validatedAt }), "utf8"),
    ok: true,
  });
  return servers.find((server) => server.id === id) || next;
}

export async function inspectManagedServerNamespaceRows(serverId: string) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("DATABASE_URL nao esta disponivel para o preflight.");
  const id = buildManagedServerId(serverId);
  if (!id || id === getPrimaryServerId()) throw new Error("O preflight de namespace aceita somente servidores adicionais.");

  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM bot_state WHERE server_id = ${id}) AS bot_state_rows,
      (SELECT COUNT(*)::int FROM player_stats_state WHERE server_id = ${id}) AS player_stats_rows,
      (SELECT COUNT(*)::int FROM player_position_history WHERE server_id = ${id}) AS position_history_rows
  `;
  const row = (rows as any[])[0] || {};
  return {
    botState: Number(row.bot_state_rows || 0),
    playerStats: Number(row.player_stats_rows || 0),
    positionHistory: Number(row.position_history_rows || 0),
  };
}

export async function markManagedServerActivationPreflightReady(
  serverId: string,
  preflight: ServerActivationPreflight,
) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const id = buildManagedServerId(serverId);
  if (!id || id === getPrimaryServerId()) throw new Error("O servidor primario nao usa o activation preflight da Fase 11.");
  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);
  if (!hasMatchingManagedServerNitradoValidation(current)) throw new Error("Valide o Nitrado antes de executar o activation preflight.");
  if (!preflight?.passed || preflight.version !== "phase11-v1") throw new Error("O activation preflight nao foi aprovado.");

  const expectedSignature = getManagedServerActivationConfigSignature(current);
  if (preflight.configurationSignature !== expectedSignature) {
    throw new Error("A configuracao do servidor mudou durante o preflight. Execute novamente.");
  }

  const next: ManagedServerDescriptor = {
    ...current,
    enabled: true,
    primary: false,
    runtimeEnabled: false,
    onboardingStatus: "ready",
    integrations: { ...current.integrations },
    runtime: {
      ...current.runtime,
      activationPreflight: { ...preflight, namespaceRows: { ...preflight.namespaceRows } },
      activation: current.runtime.activation ? { ...current.runtime.activation } : undefined,
      operations: current.runtime.operations ? { ...current.runtime.operations, paused: false } : undefined,
      discord: { ...(current.runtime.discord || {}) },
    },
  };

  await sql`
    UPDATE managed_servers
    SET enabled = TRUE,
        primary_server = FALSE,
        runtime_enabled = FALSE,
        onboarding_status = 'ready',
        runtime_config = ${JSON.stringify(next.runtime)}::jsonb,
        updated_at = NOW()
    WHERE id = ${id} AND id <> ${getPrimaryServerId()}
  `;

  const servers = await reloadManagedServerRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: "mark_server_preflight_ready",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify(preflight), "utf8"),
    ok: true,
  });
  return servers.find((server) => server.id === id) || next;
}

export async function setManagedServerRuntimeEnabled(serverId: string, enabled: boolean) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const id = buildManagedServerId(serverId);
  if (!id || id === getPrimaryServerId()) throw new Error("O runtime do servidor primario nao pode ser alterado por este controle.");
  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);

  if (enabled) {
    const namespace = getServerNamespacePersistenceStatus();
    const namespaceReady = namespace.initialized
      && namespace.scopedReadsEnabled
      && namespace.botStatePrimaryKeyReady
      && (!namespace.playerStatsTableReady || namespace.playerStatsPrimaryKeyReady)
      && namespace.botStateUntaggedRows === 0
      && (!namespace.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0)
      && namespace.scopedReadFallbacks === 0;
    if (!namespaceReady) throw new Error("Ativacao bloqueada: o namespace persistente nao esta no estado server-scoped esperado.");
    if (!current.enabled) throw new Error("O servidor esta desabilitado no registry.");
    if (current.onboardingStatus !== "ready") throw new Error("Execute e aprove o activation preflight antes de ativar o runtime.");
    if (!hasMatchingManagedServerNitradoValidation(current)) throw new Error("A validacao Nitrado nao corresponde mais a configuracao salva.");
    if (!hasMatchingActivationPreflight(current)) throw new Error("O activation preflight nao corresponde mais a configuracao salva.");

    if (!current.runtime.activation?.everActivated) {
      // Phase 17B permits rows created by tenant-safe data access before the ADM
      // runtime starts. Composite server_id PKs and scoped-read safety are the
      // security boundary; an empty namespace is no longer required.
      const namespaceRows = await inspectManagedServerNamespaceRows(id);
      if (namespaceRows.botState || namespaceRows.playerStats || namespaceRows.positionHistory) {
        console.log(`🧭 reutilizando namespace preexistente e server-scoped na primeira ativacao [${id}]`, namespaceRows);
      }
    }
  }

  const now = new Date().toISOString();
  const previousActivation = current.runtime.activation;
  const activation: ServerRuntimeActivation | undefined = enabled || previousActivation
    ? {
        source: "phase12-admin",
        everActivated: true,
        firstActivatedAt: previousActivation?.firstActivatedAt || now,
        lastEnabledAt: enabled ? now : (previousActivation?.lastEnabledAt || now),
        ...(enabled ? {} : { lastDisabledAt: now }),
        activationCount: enabled
          ? Math.max(0, Number(previousActivation?.activationCount || 0)) + (current.runtimeEnabled ? 0 : 1)
          : Math.max(1, Number(previousActivation?.activationCount || 1)),
      }
    : undefined;

  const previousOperations = current.runtime.operations;
  const nextRuntime = {
    ...current.runtime,
    activation,
    operations: previousOperations
      ? {
          ...previousOperations,
          paused: false,
          ...(previousOperations.paused ? { resumedAt: now } : {}),
        }
      : undefined,
    discord: { ...(current.runtime.discord || {}) },
  };

  await sql`
    UPDATE managed_servers
    SET runtime_enabled = ${enabled},
        onboarding_status = 'ready',
        runtime_config = ${JSON.stringify(nextRuntime)}::jsonb,
        updated_at = NOW()
    WHERE id = ${id} AND id <> ${getPrimaryServerId()}
  `;

  const servers = await reloadManagedServerRegistryFromDb();
  const next = servers.find((server) => server.id === id);
  if (!next) throw new Error(`Servidor ${id} nao encontrado apos atualizar o runtime.`);
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: enabled ? "activate_server_runtime" : "deactivate_server_runtime",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, runtimeEnabled: enabled, activation }), "utf8"),
    ok: true,
  });
  return next;
}

export async function setManagedServerRuntimePaused(serverId: string, paused: boolean, reason?: string) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql || !getServerRegistryPersistenceStatus().tableReady) {
    throw new Error("Server registry is unavailable. DATABASE_URL and managed_servers must be ready.");
  }

  const id = buildManagedServerId(serverId);
  if (!id || id === getPrimaryServerId()) throw new Error("O runtime primario nao pode ser pausado por este controle.");
  const currentServers = await reloadManagedServerRegistryFromDb();
  const current = currentServers.find((server) => server.id === id);
  if (!current) throw new Error(`Servidor ${id} nao encontrado.`);
  if (!current.runtimeEnabled) throw new Error("Ative o runtime antes de usar pause/resume operacional.");
  if (!hasManagedServerRuntimeActivation(current)) throw new Error("Este runtime ainda nao possui uma ativacao valida.");

  const now = new Date().toISOString();
  const previous: ServerRuntimeOperations = current.runtime.operations ? { ...current.runtime.operations } : {};
  const operations: ServerRuntimeOperations = paused
    ? {
        ...previous,
        paused: true,
        pausedAt: now,
        pauseReason: String(reason || "Pausa manual pelo admin").trim().slice(0, 240) || "Pausa manual pelo admin",
        source: "phase14-admin",
      }
    : {
        ...previous,
        paused: false,
        resumedAt: now,
        source: "phase14-admin",
      };

  const nextRuntime = {
    ...current.runtime,
    operations,
    discord: { ...(current.runtime.discord || {}) },
  };

  const updated = await sql`
    UPDATE managed_servers
    SET runtime_config = ${JSON.stringify(nextRuntime)}::jsonb,
        updated_at = NOW()
    WHERE id = ${id} AND id <> ${getPrimaryServerId()} AND runtime_enabled = TRUE
    RETURNING id
  `;
  if (!(updated as any[]).length) throw new Error("O runtime mudou de estado durante o pause/resume. Atualize o painel e tente novamente.");

  const servers = await reloadManagedServerRegistryFromDb();
  const next = servers.find((server) => server.id === id);
  if (!next) throw new Error(`Servidor ${id} nao encontrado apos atualizar pause/resume.`);
  recordNetworkTransfer({
    service: "neon-server-registry",
    operation: paused ? "pause_server_runtime" : "resume_server_runtime",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ serverId: id, paused, operations }), "utf8"),
    ok: true,
  });
  return next;
}

export async function createManagedOrganization(input: { id?: unknown; name?: unknown }) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("Organization registry is unavailable.");
  const name = normalizeOrganizationName(input?.name);
  const id = buildOrganizationId(input?.id || name);
  if (!id) throw new Error("Informe um Organization ID valido.");
  await sql`
    INSERT INTO organizations (id, name, active, created_at, updated_at)
    VALUES (${id}, ${name}, TRUE, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        active = TRUE,
        updated_at = NOW()
  `;
  await reloadOrganizationRegistryFromDb();
  recordNetworkTransfer({ service: "neon-organization-registry", operation: "create_organization", direction: "outbound", bytes: Buffer.byteLength(JSON.stringify({ id, name }), "utf8"), ok: true });
  return getManagedOrganizationById(id);
}

export async function saveOrganizationNitradoCredential(organizationIdInput: unknown, tokenInput: unknown, metadata: Record<string, unknown> = {}) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("Organization integration registry is unavailable.");
  const organizationId = buildOrganizationId(organizationIdInput);
  if (!organizationId || !getManagedOrganizationById(organizationId)) throw new Error("Organization nao encontrada.");
  const encrypted = encryptOrganizationSecret(tokenInput);
  await sql`
    INSERT INTO organization_integrations (
      organization_id, provider, encrypted_secret, iv, auth_tag, key_version, metadata, active, created_at, updated_at
    ) VALUES (
      ${organizationId}, 'nitrado', ${encrypted.encryptedSecret}, ${encrypted.iv}, ${encrypted.authTag}, ${encrypted.keyVersion},
      ${JSON.stringify(metadata || {})}::jsonb, TRUE, NOW(), NOW()
    )
    ON CONFLICT (organization_id, provider) DO UPDATE
    SET encrypted_secret = EXCLUDED.encrypted_secret,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        key_version = EXCLUDED.key_version,
        metadata = EXCLUDED.metadata,
        active = TRUE,
        updated_at = NOW()
  `;
  await reloadOrganizationRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-organization-integrations",
    operation: "save_nitrado_credential",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ organizationId, provider: "nitrado", metadata }), "utf8"),
    ok: true,
  });
}

export async function removeOrganizationNitradoCredential(organizationIdInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("Organization integration registry is unavailable.");
  const organizationId = buildOrganizationId(organizationIdInput);
  if (!organizationId) throw new Error("Organization nao encontrada.");
  await sql`DELETE FROM organization_integrations WHERE organization_id = ${organizationId} AND provider = 'nitrado'`;
  await reloadOrganizationRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-organization-integrations",
    operation: "remove_nitrado_credential",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ organizationId, provider: "nitrado" }), "utf8"),
    ok: true,
  });
}

export async function createManagedOrganizationForOwner(input: { id?: unknown; name?: unknown }, ownerDiscordIdInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("Organization registry is unavailable.");
  const ownerDiscordId = String(ownerDiscordIdInput || "").trim();
  if (!/^\d{5,32}$/.test(ownerDiscordId)) throw new Error("Discord ID invalido.");
  const name = normalizeOrganizationName(input?.name);
  const id = buildOrganizationId(input?.id || `${name}-${ownerDiscordId.slice(-6)}`);
  if (!id) throw new Error("Informe um Organization ID valido.");
  await sql.begin(async (tx: any) => {
    const inserted = await tx`
      INSERT INTO organizations (id, name, active, created_at, updated_at)
      VALUES (${id}, ${name}, TRUE, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (!(inserted as any[]).length) throw new Error(`Organization ID ${id} ja existe.`);
    await tx`
      INSERT INTO organization_members (organization_id, discord_id, role, created_at, updated_at)
      VALUES (${id}, ${ownerDiscordId}, 'owner', NOW(), NOW())
      ON CONFLICT (organization_id, discord_id) DO UPDATE SET role = 'owner', updated_at = NOW()
    `;
  });
  await reloadOrganizationRegistryFromDb();
  recordNetworkTransfer({
    service: "neon-organization-registry",
    operation: "self_service_organization",
    direction: "outbound",
    bytes: Buffer.byteLength(JSON.stringify({ id, name, ownerDiscordId }), "utf8"),
    ok: true,
  });
  return getManagedOrganizationById(id);
}

export async function upsertOrganizationMembership(organizationIdInput: unknown, discordIdInput: unknown, roleInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("Organization registry is unavailable.");
  const organizationId = buildOrganizationId(organizationIdInput);
  const discordId = String(discordIdInput || "").trim();
  const role = normalizeOrganizationRole(roleInput);
  if (!organizationId || !getManagedOrganizationById(organizationId)) throw new Error("Organization nao encontrada.");
  if (!/^\d{5,32}$/.test(discordId)) throw new Error("Discord ID invalido.");
  await sql.begin(async (tx: any) => {
    const owners = await tx`
      SELECT discord_id FROM organization_members
      WHERE organization_id = ${organizationId} AND role = 'owner'
      FOR UPDATE
    `;
    if (!(owners as any[]).length && role !== "owner") {
      throw new Error("O primeiro membro da organizacao precisa ser owner.");
    }
    const targetIsOnlyOwner = role !== "owner"
      && (owners as any[]).length === 1
      && String((owners as any[])[0]?.discord_id || "") === discordId;
    if (targetIsOnlyOwner) throw new Error("Nao e permitido rebaixar o ultimo owner da organizacao.");
    await tx`
      INSERT INTO organization_members (organization_id, discord_id, role, created_at, updated_at)
      VALUES (${organizationId}, ${discordId}, ${role}, NOW(), NOW())
      ON CONFLICT (organization_id, discord_id) DO UPDATE
      SET role = EXCLUDED.role, updated_at = NOW()
    `;
  });
  await reloadOrganizationRegistryFromDb();
  recordNetworkTransfer({ service: "neon-organization-registry", operation: "upsert_membership", direction: "outbound", bytes: Buffer.byteLength(JSON.stringify({ organizationId, discordId, role }), "utf8"), ok: true });
  return { organizationId, discordId, role } as OrganizationMembership;
}

export async function removeOrganizationMembership(organizationIdInput: unknown, discordIdInput: unknown) {
  await ensurePrimaryServerRegistryMetadata();
  if (!sql) throw new Error("Organization registry is unavailable.");
  const organizationId = buildOrganizationId(organizationIdInput);
  const discordId = String(discordIdInput || "").trim();
  if (!organizationId || !discordId) throw new Error("Organization e Discord ID sao obrigatorios.");
  await sql.begin(async (tx: any) => {
    const owners = await tx`
      SELECT discord_id FROM organization_members
      WHERE organization_id = ${organizationId} AND role = 'owner'
      FOR UPDATE
    `;
    if ((owners as any[]).length <= 1 && String((owners as any[])[0]?.discord_id || "") === discordId) {
      throw new Error("Nao e permitido remover o ultimo owner da organizacao.");
    }
    await tx`DELETE FROM organization_members WHERE organization_id = ${organizationId} AND discord_id = ${discordId}`;
  });
  await reloadOrganizationRegistryFromDb();
  recordNetworkTransfer({ service: "neon-organization-registry", operation: "remove_membership", direction: "outbound", bytes: Buffer.byteLength(JSON.stringify({ organizationId, discordId }), "utf8"), ok: true });
}

async function ensureGranularPlayerStatsTable() {
  if (!sql || !GRANULAR_PLAYER_STATS_ENABLED) return;
  if (granularPlayerStatsTableReadyPromise) return granularPlayerStatsTableReadyPromise;
  granularPlayerStatsTableReadyPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS player_stats_state (
        server_id TEXT NOT NULL,
        player_key TEXT NOT NULL,
        stats JSONB NOT NULL,
        current_streak INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (server_id, player_key)
      )
    `;
    await sql`ALTER TABLE player_stats_state ADD COLUMN IF NOT EXISTS server_id TEXT`;
    // Any row without server_id predates multi-server and therefore belongs to
    // the production primary. Never derive this migration from the active
    // AsyncLocalStorage context: a secondary/admin request must not be able to
    // retag legacy Deathmatch player stats.
    const legacyPlayerStatsOwner = getPrimaryServerId();
    await sql`UPDATE player_stats_state SET server_id = ${legacyPlayerStatsOwner} WHERE server_id IS NULL`;
    await sql`CREATE INDEX IF NOT EXISTS player_stats_state_updated_at_idx ON player_stats_state (updated_at)`;
    await sql`CREATE INDEX IF NOT EXISTS player_stats_state_server_id_idx ON player_stats_state (server_id)`;
    const namespaceCounts = await sql`
      SELECT
        COUNT(*) FILTER (WHERE server_id = ${legacyPlayerStatsOwner})::int AS tagged_rows,
        COUNT(*) FILTER (WHERE server_id IS NULL)::int AS untagged_rows
      FROM player_stats_state
    `;
    const untaggedRows = Number((namespaceCounts as any[])[0]?.untagged_rows || 0);
    const pkRows = await sql`
      SELECT array_agg(a.attname ORDER BY keycols.ordinality) AS columns
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN unnest(i.indkey) WITH ORDINALITY AS keycols(attnum, ordinality) ON TRUE
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keycols.attnum
      WHERE t.relname = 'player_stats_state' AND i.indisprimary
      GROUP BY i.indexrelid
    `;
    const pkColumns = Array.isArray((pkRows as any[])[0]?.columns)
      ? (pkRows as any[])[0].columns.map((value: unknown) => String(value))
      : [];

    if (pkColumns.join(',') === 'server_id,player_key') {
      playerStatsPrimaryKeyReady = true;
    } else if (pkColumns.join(',') === 'player_key' && untaggedRows === 0) {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS player_stats_state_server_id_player_key_uidx ON player_stats_state (server_id, player_key)`;
      await sql.begin(async (tx: any) => {
        await tx`ALTER TABLE player_stats_state ALTER COLUMN server_id SET NOT NULL`;
        await tx`ALTER TABLE player_stats_state DROP CONSTRAINT player_stats_state_pkey`;
        await tx`ALTER TABLE player_stats_state ADD CONSTRAINT player_stats_state_pkey PRIMARY KEY USING INDEX player_stats_state_server_id_player_key_uidx`;
      });
      playerStatsPrimaryKeyReady = true;
    } else if (pkColumns.length === 0 && untaggedRows === 0) {
      await sql.begin(async (tx: any) => {
        await tx`ALTER TABLE player_stats_state ALTER COLUMN server_id SET NOT NULL`;
        await tx`ALTER TABLE player_stats_state ADD CONSTRAINT player_stats_state_pkey PRIMARY KEY (server_id, player_key)`;
      });
      playerStatsPrimaryKeyReady = true;
    } else {
      throw new Error(`player_stats_state primary key is not safe to migrate: ${pkColumns.join(',') || 'none'}; untagged=${untaggedRows}`);
    }

    playerStatsScopedPersistenceReady = playerStatsPrimaryKeyReady;
    setServerNamespacePersistenceStatus({
      enabled: true,
      initialized: true,
      playerStatsTableReady: true,
      playerStatsCompositeKeyReady: playerStatsScopedPersistenceReady,
      playerStatsPrimaryKeyReady,
      botStatePrimaryKeyReady,
      primaryKeyCutoverComplete: botStatePrimaryKeyReady && playerStatsPrimaryKeyReady,
      scopedReadsEnabled: botStateScopedPersistenceReady,
      scopedReadFallbacks,
      lastScopedReadSource,
      playerStatsTaggedRows: Number((namespaceCounts as any[])[0]?.tagged_rows || 0),
      playerStatsUntaggedRows: untaggedRows,
      lastCheckedAt: new Date().toISOString(),
    });
  })().catch((err) => {
    granularPlayerStatsTableReadyPromise = null;
    throw err;
  });
  return granularPlayerStatsTableReadyPromise;
}

function queueStateDomains(data: AppState, reason: string) {
  const domains = buildStateDomains(data);
  const changed: StateDomainName[] = [];
  for (const domain of Object.keys(STATE_DOMAIN_IDS) as StateDomainName[]) {
    const payload = domains[domain];
    const serialized = JSON.stringify(payload);
    const hash = hashState(serialized);
    const currentPending = getPersistenceRuntime().pendingDomains.get(domain);
    domainPersistenceMetrics.domains[domain].currentBytes = Buffer.byteLength(serialized, "utf8");
    if (hash === getPersistenceRuntime().lastDomainHashes[domain] || hash === currentPending?.hash) continue;
    const reasons = new Set(currentPending?.reasons || []);
    reasons.add(reason);
    const dueAt = currentPending?.dueAt ?? domainDueAt(domain);
    getPersistenceRuntime().pendingDomains.set(domain, { payload, serialized, hash, reasons, dueAt });
    domainPersistenceMetrics.domains[domain].changes += 1;
    changed.push(domain);
  }
  return changed;
}

function logStateDebug(message: string, meta?: Record<string, unknown>) {
  if (!STATE_DEBUG) return;
  if (meta) {
    console.log(message, meta);
  } else {
    console.log(message);
  }
}

function normalizePersistenceReason(value?: string): string {
  const explicit = String(value || "").trim();
  if (explicit) return canonicalPersistenceReason(explicit);

  const stack = new Error().stack || "";
  const line = stack
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes("/src/") && !entry.includes("/src/lib/state."));

  if (!line) return "unknown";
  const match = line.match(/\/src\/(.+?)(?::\d+:\d+|\)?$)/);
  const source = (match?.[1] || line).replace(/\\/g, "/");
  if (source.startsWith("lib/parser")) return "parser";
  if (source.startsWith("lib/discord/")) return `discord:${source.split("/").slice(2, 4).join(":").replace(/\.(ts|js)$/, "")}`;
  if (source.startsWith("routes/adminPanel")) return "admin-panel";
  if (source.startsWith("routes/playerPortal")) return "player-portal";
  if (source.startsWith("routes/admin")) return "admin-api";
  return source.replace(/\.(ts|js)$/, "").slice(0, 120);
}

function getReasonMetric(reason: string): PersistenceReasonMetric {
  return persistenceMetrics.reasons[reason] ||= {
    saveRequests: 0,
    skippedRequests: 0,
    contributedWrites: 0,
    estimatedBytesWritten: 0,
  };
}

function recordSaveRequest(reason: string) {
  const now = new Date().toISOString();
  persistenceMetrics.saveRequests += 1;
  const metric = getReasonMetric(reason);
  metric.saveRequests += 1;
  metric.lastRequestedAt = now;
}

function countSectionEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return value == null ? 0 : 1;
}

function analyzeSectionFields(value: unknown): { topFields: PayloadFieldMetric[]; averageEntryBytes: number; maxEntryBytes: number } {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : [];
  if (!entries.length) return { topFields: [], averageEntryBytes: 0, maxEntryBytes: 0 };

  const fieldTotals: Record<string, { bytes: number; presentIn: number }> = {};
  let totalEntryBytes = 0;
  let maxEntryBytes = 0;
  for (const entry of entries.slice(0, 10000)) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry ?? null), "utf8");
    totalEntryBytes += entryBytes;
    maxEntryBytes = Math.max(maxEntryBytes, entryBytes);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const [field, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
      const current = fieldTotals[field] ||= { bytes: 0, presentIn: 0 };
      current.bytes += Buffer.byteLength(JSON.stringify(fieldValue ?? null), "utf8");
      current.presentIn += 1;
    }
  }

  return {
    averageEntryBytes: Math.round(totalEntryBytes / entries.length),
    maxEntryBytes,
    topFields: Object.entries(fieldTotals)
      .map(([field, metric]) => ({ field, ...metric }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12),
  };
}

function analyzePayload(parsed: AppState, now: string) {
  const lastSectionHashes = getLastSectionHashes();
  const lastSectionBytes = getLastSectionBytes();
  const allSections = Object.entries(parsed).map(([key, value]) => {
    const serialized = JSON.stringify(value ?? null);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const hash = crypto.createHash("sha1").update(serialized).digest("hex");
    const changed = lastSectionHashes[key] !== hash;
    const previousBytes = lastSectionBytes[key] || 0;
    const entries = countSectionEntries(value);
    const metric = persistenceMetrics.sections[key] ||= {
      currentBytes: 0,
      currentEntries: 0,
      changedWrites: 0,
      cumulativeBytesWritten: 0,
    };
    metric.currentBytes = bytes;
    metric.currentEntries = entries;
    if (changed) {
      metric.changedWrites += 1;
      metric.cumulativeBytesWritten += bytes;
      metric.lastChangedAt = now;
      metric.lastDeltaBytes = bytes - previousBytes;
    }
    lastSectionHashes[key] = hash;
    lastSectionBytes[key] = bytes;
    return { key, bytes, entries, changed, value };
  });

  const changed = allSections.filter((section) => section.changed);
  const detailedKeys = new Set([
    "players",
    "currentKillStreaks",
    "recentEventIds",
    "dayzItems",
    "files",
    "economyTransactions",
    "shopOrders",
    "longShotEvents",
    "killStreakEvents",
  ]);

  return {
    sections: allSections
      .map(({ key, bytes, entries }) => ({ key, bytes, entries }))
      .sort((a, b) => b.bytes - a.bytes),
    changedSections: changed.map((section) => section.key),
    changedBytes: changed.reduce((sum, section) => sum + section.bytes, 0),
    detailedSections: allSections
      .filter((section) => detailedKeys.has(section.key))
      .map((section) => {
        const fieldAnalysis = analyzeSectionFields(section.value);
        return {
          key: section.key,
          bytes: section.bytes,
          entries: section.entries,
          averageEntryBytes: fieldAnalysis.averageEntryBytes,
          maxEntryBytes: fieldAnalysis.maxEntryBytes,
          topFields: fieldAnalysis.topFields,
        };
      })
      .sort((a, b) => b.bytes - a.bytes),
  };
}

async function persistDomainBatchToNeon(
  entries: Array<[StateDomainName, PendingDomainState]>,
  trigger: string,
  playerEntries: Array<[string, PendingGranularPlayerStats]> = [],
) {
  if (!sql || (!entries.length && !playerEntries.length)) return;
  const startedAt = Date.now();
  const now = new Date().toISOString();
  const domainPayloadBytes = entries.reduce((total, [, entry]) => total + Buffer.byteLength(entry.serialized, "utf8"), 0);
  const playerPayload = playerEntries.map(([playerKey, entry]) => ({
    server_id: getActiveServerId(),
    player_key: playerKey,
    stats: entry.stats,
    current_streak: entry.currentStreak,
  }));
  const playerPayloadBytes = Buffer.byteLength(JSON.stringify(playerPayload), "utf8");

  try {
    if (playerEntries.length) await ensureGranularPlayerStatsTable();
    await sql.begin(async (tx: any) => {
      for (const [domain, entry] of entries) {
        if (botStateScopedPersistenceReady) {
          await tx`
            INSERT INTO bot_state (id, data, updated_at, server_id)
            VALUES (${STATE_DOMAIN_IDS[domain]}, ${tx.json(entry.payload)}, NOW(), ${getActiveServerId()})
            ON CONFLICT (server_id, id)
            DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), server_id = EXCLUDED.server_id
          `;
        } else {
          throw new Error(`Refusing unscoped bot_state domain write for ${getActiveServerId()}`);
        }
      }
      if (playerPayload.length) {
        if (playerStatsScopedPersistenceReady) {
          await tx`
            INSERT INTO player_stats_state (server_id, player_key, stats, current_streak, updated_at)
            SELECT incoming.server_id, incoming.player_key, incoming.stats, incoming.current_streak, NOW()
            FROM jsonb_to_recordset(${tx.json(playerPayload)}::jsonb)
              AS incoming(server_id TEXT, player_key TEXT, stats JSONB, current_streak INTEGER)
            ON CONFLICT (server_id, player_key)
            DO UPDATE SET
              server_id = EXCLUDED.server_id,
              stats = EXCLUDED.stats,
              current_streak = EXCLUDED.current_streak,
              updated_at = NOW()
          `;
        } else {
          throw new Error(`Refusing unscoped player_stats_state write for ${getActiveServerId()}`);
        }
      }
    });

    domainPersistenceMetrics.flushes += 1;
    domainPersistenceMetrics.lastFlushTrigger = trigger;
    if (trigger.startsWith("background:")) domainPersistenceMetrics.backgroundFlushes += 1;
    if (trigger.startsWith("forced:")) domainPersistenceMetrics.forcedFlushes += 1;
    domainPersistenceMetrics.rowsWritten += entries.length;
    domainPersistenceMetrics.totalPayloadBytesWritten += domainPayloadBytes;
    domainPersistenceMetrics.lastWriteAt = now;
    domainPersistenceMetrics.lastError = undefined;
    for (const [domain, entry] of entries) {
      const metric = domainPersistenceMetrics.domains[domain];
      const bytes = Buffer.byteLength(entry.serialized, "utf8");
      metric.writes += 1;
      metric.bytesWritten += bytes;
      metric.currentBytes = bytes;
      metric.lastWriteAt = now;
      getPersistenceRuntime().lastDomainHashes[domain] = entry.hash;
    }
    if (playerEntries.length) {
      granularPlayerStatsMetrics.batchesWritten += 1;
      granularPlayerStatsMetrics.rowsWritten += playerEntries.length;
      granularPlayerStatsMetrics.totalPayloadBytesWritten += playerPayloadBytes;
      granularPlayerStatsMetrics.lastWriteAt = now;
      granularPlayerStatsMetrics.lastError = undefined;
      for (const [playerKey, entry] of playerEntries) {
        getPersistenceRuntime().lastGranularPlayerSignatures.set(playerKey, entry.signature);
      }
      recordNetworkTransfer({
        service: "neon-player-stats",
        operation: "player_stats_batch_upsert",
        direction: "outbound",
        bytes: playerPayloadBytes,
        ok: true,
      });
    }
    recordNetworkTransfer({
      service: "neon-domain",
      operation: "state_domain_batch_write",
      direction: "outbound",
      bytes: domainPayloadBytes,
      ok: true,
    });
  } catch (err) {
    domainPersistenceMetrics.failedFlushes += 1;
    if (playerEntries.length) {
      granularPlayerStatsMetrics.failedBatches += 1;
      granularPlayerStatsMetrics.lastError = err instanceof Error ? err.message : String(err);
      recordNetworkTransfer({
        service: "neon-player-stats",
        operation: "player_stats_batch_upsert",
        direction: "outbound",
        bytes: playerPayloadBytes,
        ok: false,
      });
    }
    domainPersistenceMetrics.lastError = err instanceof Error ? err.message : String(err);
    recordNetworkTransfer({
      service: "neon-domain",
      operation: "state_domain_batch_write",
      direction: "outbound",
      bytes: domainPayloadBytes,
      ok: false,
    });
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;
    domainPersistenceMetrics.lastWriteDurationMs = durationMs;
    domainPersistenceMetrics.totalWriteDurationMs += durationMs;
    if (playerEntries.length) {
      granularPlayerStatsMetrics.lastWriteDurationMs = durationMs;
      granularPlayerStatsMetrics.totalWriteDurationMs += durationMs;
    }
  }
}

async function maybeWriteCompatibilitySnapshot(force = false) {
  const cachedState = getCachedState();
  if (!sql || !cachedState) return;
  const now = Date.now();
  if (!force && getPersistenceRuntime().lastCompatibilitySnapshotAt > 0 && now - getPersistenceRuntime().lastCompatibilitySnapshotAt < STATE_COMPAT_SNAPSHOT_MS) return;
  const serialized = serializeState(cachedState);
  const hash = hashState(serialized);
  await persistStateToNeon(serialized, hash, ["v2:compat-snapshot"]);
  getPersistenceRuntime().lastCompatibilitySnapshotAt = Date.now();
  domainPersistenceMetrics.compatibilitySnapshots += 1;
}

async function flushPendingDomains(
  forceCompatibilitySnapshot = false,
  onlyDomains?: StateDomainName[],
  forceAllPending = false,
  trigger = "background:scheduled",
): Promise<void> {
  if (!STATE_PERSISTENCE_V2_ENABLED || !sql) return;
  if (getPersistenceRuntime().domainFlushPromise) {
    await getPersistenceRuntime().domainFlushPromise;
    if (onlyDomains?.length || forceAllPending || forceCompatibilitySnapshot) {
      return flushPendingDomains(forceCompatibilitySnapshot, onlyDomains, forceAllPending, trigger);
    }
    return;
  }
  const domainFlushTimer = getPersistenceRuntime().domainFlushTimer;
  if (domainFlushTimer) {
    clearTimeout(domainFlushTimer);
    getPersistenceRuntime().domainFlushTimer = null;
  }

  const now = Date.now();
  const only = onlyDomains?.length ? new Set(onlyDomains) : null;
  const entries = [...getPersistenceRuntime().pendingDomains.entries()].filter(([domain, entry]) => {
    if (only) return only.has(domain);
    if (forceAllPending) return true;
    return entry.dueAt <= now + 250;
  });
  const playerEntries = only ? [] : [...getPersistenceRuntime().pendingGranularPlayerStats.entries()].filter(([, entry]) => {
    if (forceAllPending) return true;
    return entry.dueAt <= now + 250;
  });

  if (!entries.length && !playerEntries.length && !forceCompatibilitySnapshot) {
    if (getPersistenceRuntime().pendingDomains.size || getPersistenceRuntime().pendingGranularPlayerStats.size) scheduleDomainFlush();
    return;
  }
  for (const [domain] of entries) getPersistenceRuntime().pendingDomains.delete(domain);
  for (const [playerKey] of playerEntries) getPersistenceRuntime().pendingGranularPlayerStats.delete(playerKey);

  const domainFlushPromise = (async () => {
    try {
      if (entries.length || playerEntries.length) {
        try {
          await persistDomainBatchToNeon(entries, trigger, playerEntries);
        } catch (err) {
          const retryAt = Date.now() + 30_000;
          for (const [domain, entry] of entries) {
            const existing = getPersistenceRuntime().pendingDomains.get(domain);
            if (!existing || existing.hash === entry.hash) {
              getPersistenceRuntime().pendingDomains.set(domain, { ...entry, dueAt: Math.max(entry.dueAt, retryAt) });
            }
          }
          for (const [playerKey, entry] of playerEntries) {
            const existing = getPersistenceRuntime().pendingGranularPlayerStats.get(playerKey);
            if (!existing || existing.signature === entry.signature) {
              getPersistenceRuntime().pendingGranularPlayerStats.set(playerKey, { ...entry, dueAt: Math.max(entry.dueAt, retryAt) });
            }
          }
          scheduleDomainFlush();
          throw err;
        }
      }

      if (forceCompatibilitySnapshot || (getCachedState() && Date.now() - getPersistenceRuntime().lastCompatibilitySnapshotAt >= STATE_COMPAT_SNAPSHOT_MS)) {
        // Compatibility is only a rollback safety net. V2 domain rows remain
        // the source of truth and the snapshot is intentionally infrequent.
        await maybeWriteCompatibilitySnapshot(forceCompatibilitySnapshot);
      }
    } finally {
      getPersistenceRuntime().domainFlushPromise = null;
      if (getPersistenceRuntime().pendingDomains.size || getPersistenceRuntime().pendingGranularPlayerStats.size) scheduleDomainFlush();
    }
  })();
  getPersistenceRuntime().domainFlushPromise = domainFlushPromise;
  return domainFlushPromise;
}

function scheduleDomainFlush() {
  if (!STATE_PERSISTENCE_V2_ENABLED || !sql || (!getPersistenceRuntime().pendingDomains.size && !getPersistenceRuntime().pendingGranularPlayerStats.size) || getPersistenceRuntime().domainFlushTimer) return;
  domainPersistenceMetrics.backgroundQueued += 1;
  const dueTimes = [
    ...[...getPersistenceRuntime().pendingDomains.values()].map((entry) => entry.dueAt),
    ...[...getPersistenceRuntime().pendingGranularPlayerStats.values()].map((entry) => entry.dueAt),
  ];
  const nextDueAt = Math.min(...dueTimes);
  const delay = Math.max(1000, nextDueAt - Date.now());
  const serverId = getActiveServerId();
  getPersistenceRuntime().domainFlushTimer = setTimeout(() => {
    runInServerMaintenanceContext(serverId, () => {
      getPersistenceRuntime().domainFlushTimer = null;
      Promise.all([flushPendingDomains(false, undefined, false, "background:timer"), flushPendingDiscordRuntime()]).catch((err) => {
        console.error("❌ erro no flush V2 em background:", err);
      });
    });
  }, delay);
}

async function queueAndPersistStateDomains(data: AppState, reason: string) {
  domainPersistenceMetrics.saveRequests += 1;
  const changed = queueStateDomains(data, reason);
  const granularPlayerChanges = queueGranularPlayerStats(data);
  if (!changed.length && !granularPlayerChanges) return false;

  const backgroundReason = isBackgroundPersistenceReason(reason);
  const immediateDomains = changed.filter((domain) => domainNeedsImmediateFlush(domain));

  // Stats and processing are a consistency pair for parser work: when stats
  // changed, never persist an ADM cursor earlier than the corresponding stats.
  // Processing-only cycles may still flush every 10 minutes, while kill/stat
  // cycles coalesce both rows on the 20-minute stats boundary.
  const pendingStats = getPersistenceRuntime().pendingDomains.get("stats");
  const pendingProcessing = getPersistenceRuntime().pendingDomains.get("processing");
  const granularStatsDueAt = getPersistenceRuntime().pendingGranularPlayerStats.size
    ? Math.max(...[...getPersistenceRuntime().pendingGranularPlayerStats.values()].map((entry) => entry.dueAt))
    : 0;
  if (pendingProcessing && (pendingStats || granularStatsDueAt)) {
    pendingProcessing.dueAt = Math.max(pendingProcessing.dueAt, pendingStats?.dueAt || 0, granularStatsDueAt);
  }
  if (pendingStats && granularStatsDueAt) {
    pendingStats.dueAt = Math.max(pendingStats.dueAt, granularStatsDueAt);
  }

  // Parser/Discord telemetry is recoverable and must not wake Neon on every
  // five-minute cycle. User-facing durable mutations (shop, economy, clans,
  // config) remain immediate. Crucially, an immediate commerce/social write no
  // longer drags pending stats/processing along with it.
  if (!backgroundReason && immediateDomains.length) {
    domainPersistenceMetrics.immediateFlushes += 1;
    await flushPendingDomains(false, immediateDomains, false, `immediate:${canonicalPersistenceReason(reason)}`);
  }

  if (getPersistenceRuntime().pendingDomains.size || getPersistenceRuntime().pendingGranularPlayerStats.size) scheduleDomainFlush();
  return true;
}

async function persistDiscordRuntimeToNeon(serialized: string, hash: string) {
  if (!sql) return;
  if (hash === getPersistenceRuntime().lastDiscordRuntimeHash) {
    discordRuntimeMetrics.skippedWrites += 1;
    return;
  }

  const runtime = JSON.parse(serialized) as DiscordRuntimeState;
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  const startedAt = Date.now();
  discordRuntimeMetrics.writes += 1;
  discordRuntimeMetrics.lastPayloadBytes = payloadBytes;
  discordRuntimeMetrics.totalPayloadBytesWritten += payloadBytes;
  discordRuntimeMetrics.lastWriteAt = new Date().toISOString();

  try {
    if (botStateScopedPersistenceReady) {
      await sql`
        INSERT INTO bot_state (id, data, updated_at, server_id)
        VALUES (${DISCORD_RUNTIME_STATE_ID}, ${sql.json(runtime)}, NOW(), ${getActiveServerId()})
        ON CONFLICT (server_id, id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), server_id = EXCLUDED.server_id
      `;
    } else {
      throw new Error(`Refusing unscoped Discord runtime write for ${getActiveServerId()}`);
    }
    recordNetworkTransfer({
      service: "neon-runtime",
      operation: "discord_runtime_write",
      direction: "outbound",
      bytes: payloadBytes,
      ok: true,
    });
    getPersistenceRuntime().lastDiscordRuntimeHash = hash;
  } catch (err) {
    discordRuntimeMetrics.failedWrites += 1;
    discordRuntimeMetrics.lastWriteError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;
    discordRuntimeMetrics.lastWriteDurationMs = durationMs;
    discordRuntimeMetrics.totalWriteDurationMs += durationMs;
  }
}

async function flushPendingDiscordRuntime() {
  if (!getPersistenceRuntime().pendingDiscordRuntimeJson || !getPersistenceRuntime().pendingDiscordRuntimeHash) return;
  if (getPersistenceRuntime().discordRuntimeFlushPromise) return getPersistenceRuntime().discordRuntimeFlushPromise;

  const serialized = getPersistenceRuntime().pendingDiscordRuntimeJson;
  const hash = getPersistenceRuntime().pendingDiscordRuntimeHash;
  getPersistenceRuntime().pendingDiscordRuntimeJson = "";
  getPersistenceRuntime().pendingDiscordRuntimeHash = "";
  const discordRuntimeSaveTimer = getPersistenceRuntime().discordRuntimeSaveTimer;
  if (discordRuntimeSaveTimer) {
    clearTimeout(discordRuntimeSaveTimer);
    getPersistenceRuntime().discordRuntimeSaveTimer = null;
  }

  getPersistenceRuntime().discordRuntimeFlushPromise = persistDiscordRuntimeToNeon(serialized, hash)
    .catch((err) => {
      console.error("❌ erro salvando discord_runtime no Neon:", err);
      getPersistenceRuntime().pendingDiscordRuntimeJson = serialized;
      getPersistenceRuntime().pendingDiscordRuntimeHash = hash;
      scheduleDiscordRuntimePersist();
    })
    .finally(() => {
      getPersistenceRuntime().discordRuntimeFlushPromise = null;
      if (getPersistenceRuntime().pendingDiscordRuntimeJson) scheduleDiscordRuntimePersist();
    });

  return getPersistenceRuntime().discordRuntimeFlushPromise;
}

function scheduleDiscordRuntimePersist() {
  if (!sql || !getPersistenceRuntime().pendingDiscordRuntimeJson || getPersistenceRuntime().discordRuntimeSaveTimer) return;
  const delay = STATE_PERSISTENCE_V2_ENABLED ? nextAlignedBackgroundDelay() : STATE_SAVE_DEBOUNCE_MS;
  const serverId = getActiveServerId();
  getPersistenceRuntime().discordRuntimeSaveTimer = setTimeout(() => {
    runInServerMaintenanceContext(serverId, () => {
      getPersistenceRuntime().discordRuntimeSaveTimer = null;
      Promise.all([flushPendingDiscordRuntime(), flushPendingDomains()]).catch((err) => console.error("❌ erro no flush do discord_runtime:", err));
    });
  }, delay);
}

async function persistStateToNeon(serialized: string, hash: string, reasons: string[]) {
  if (!sql) return;

  if (hash === getPersistenceRuntime().lastPersistedHash) {
    persistenceMetrics.skippedWrites += 1;
    logStateDebug("⏭️ STATE NEON ignorado: sem alterações");
    return;
  }

  const parsed = JSON.parse(serialized) as AppState;

  // Incident guard: never allow the production primary compatibility snapshot
  // to collapse a large historical population. The old single-server runtime
  // had this protection; multi-server/V2 must preserve it server-scoped.
  if (getActiveServerId() === getPrimaryServerId()) {
    try {
      const existingRows = botStateScopedPersistenceReady
        ? await sql`SELECT data FROM bot_state WHERE server_id = ${getPrimaryServerId()} AND id = ${STATE_ID} LIMIT 1`
        : await sql`SELECT data FROM bot_state WHERE server_id = ${getPrimaryServerId()} AND id = ${STATE_ID} LIMIT 1`;
      if (existingRows.length) {
        const previousCount = Object.keys(((existingRows[0].data || {}) as Partial<AppState>).players || {}).length;
        const incomingCount = Object.keys(parsed.players || {}).length;
        if (previousCount >= 1000 && incomingCount < Math.floor(previousCount * 0.7) && process.env.ALLOW_DESTRUCTIVE_STATE_SAVE !== "true") {
          throw new Error(`Destructive PZ Deathmatch state save blocked: players would shrink from ${previousCount} to ${incomingCount}`);
        }
      }
    } catch (guardError) {
      if (guardError instanceof Error && guardError.message.startsWith("Destructive PZ Deathmatch state save blocked:")) throw guardError;
      console.error("❌ unable to verify Deathmatch shrink guard; refusing compatibility snapshot", guardError);
      throw new Error("PZ Deathmatch compatibility snapshot blocked because the historical-size guard could not be verified");
    }
  }

  const now = new Date().toISOString();
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  const uniqueReasons = [...new Set(reasons.length ? reasons : ["unknown"])];

  const analysis = analyzePayload(parsed, now);
  persistenceMetrics.writes += 1;
  persistenceMetrics.lastWriteAt = now;
  persistenceMetrics.lastPayloadBytes = payloadBytes;
  persistenceMetrics.lastChangedBytes = analysis.changedBytes;
  persistenceMetrics.lastChangedSections = analysis.changedSections;
  persistenceMetrics.lastWriteReasons = uniqueReasons;
  persistenceMetrics.lastPayloadSections = analysis.sections.slice(0, 24);
  persistenceMetrics.detailedSections = analysis.detailedSections;
  persistenceMetrics.totalPayloadBytesWritten += payloadBytes;
  persistenceMetrics.totalChangedBytes += analysis.changedBytes;
  if (uniqueReasons.length > 1) persistenceMetrics.consolidatedWrites += 1;

  const byteShare = Math.round(payloadBytes / uniqueReasons.length);
  for (const reason of uniqueReasons) {
    const metric = getReasonMetric(reason);
    metric.contributedWrites += 1;
    metric.estimatedBytesWritten += byteShare;
    metric.lastWriteAt = now;
  }

  const writeStarted = Date.now();
  try {
    if (botStateScopedPersistenceReady) {
      await sql`
        INSERT INTO bot_state (id, data, updated_at, server_id)
        VALUES (${STATE_ID}, ${sql.json(parsed)}, NOW(), ${getActiveServerId()})
        ON CONFLICT (server_id, id)
        DO UPDATE SET
          data = EXCLUDED.data,
          updated_at = NOW(),
          server_id = EXCLUDED.server_id
      `;
    } else {
      throw new Error(`Refusing unscoped compatibility snapshot write for ${getActiveServerId()}`);
    }
    // The serialized JSON dominates the outbound payload to Neon. This counter
    // intentionally measures application bytes, not PostgreSQL/TLS overhead.
    recordNetworkTransfer({
      service: "neon",
      operation: "bot_state_write",
      direction: "outbound",
      bytes: payloadBytes,
      ok: true,
    });
  } catch (err) {
    persistenceMetrics.failedWrites += 1;
    persistenceMetrics.lastWriteError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - writeStarted;
    persistenceMetrics.lastWriteDurationMs = durationMs;
    persistenceMetrics.totalWriteDurationMs += durationMs;
    persistenceMetrics.maxWriteDurationMs = Math.max(persistenceMetrics.maxWriteDurationMs, durationMs);
  }

  persistenceMetrics.recentWrites.push({
    at: now,
    bytes: payloadBytes,
    durationMs: persistenceMetrics.lastWriteDurationMs,
    reasons: uniqueReasons,
    changedSections: analysis.changedSections,
    changedBytes: analysis.changedBytes,
  });
  if (persistenceMetrics.recentWrites.length > 100) {
    persistenceMetrics.recentWrites.splice(0, persistenceMetrics.recentWrites.length - 100);
  }

  getPersistenceRuntime().lastPersistedHash = hash;
  getPersistenceRuntime().lastPersistedJson = serialized;
  logStateDebug("💾 STATE SALVO NO NEON", { bytes: payloadBytes, changedBytes: analysis.changedBytes, changedSections: analysis.changedSections });
}

async function flushPendingState() {
  if (!getPersistenceRuntime().pendingPersistJson || !getPersistenceRuntime().pendingPersistHash) return;
  if (getPersistenceRuntime().flushPromise) return getPersistenceRuntime().flushPromise;

  const serialized = getPersistenceRuntime().pendingPersistJson;
  const hash = getPersistenceRuntime().pendingPersistHash;
  const reasons = [...getPersistenceRuntime().pendingPersistReasons];
  getPersistenceRuntime().pendingPersistJson = "";
  getPersistenceRuntime().pendingPersistHash = "";
  getPersistenceRuntime().pendingPersistReasons = new Set<string>();
  getPersistenceRuntime().pendingPersistStartedAt = 0;

  const saveTimer = getPersistenceRuntime().saveTimer;
  if (saveTimer) {
    clearTimeout(saveTimer);
    getPersistenceRuntime().saveTimer = null;
  }

  getPersistenceRuntime().flushPromise = persistStateToNeon(serialized, hash, reasons)
    .catch((err) => {
      console.error("❌ erro salvando state no Neon:", err);
      getPersistenceRuntime().pendingPersistJson = serialized;
      getPersistenceRuntime().pendingPersistHash = hash;
      getPersistenceRuntime().pendingPersistReasons = new Set([...getPersistenceRuntime().pendingPersistReasons, ...reasons]);
      getPersistenceRuntime().pendingPersistStartedAt = getPersistenceRuntime().pendingPersistStartedAt || Date.now();
      scheduleNeonPersist();
    })
    .finally(() => {
      getPersistenceRuntime().flushPromise = null;
    });

  return getPersistenceRuntime().flushPromise;
}

function scheduleNeonPersist() {
  if (!sql || !getPersistenceRuntime().pendingPersistJson) return;
  if (getPersistenceRuntime().saveTimer) return;

  const elapsed = getPersistenceRuntime().pendingPersistStartedAt ? Date.now() - getPersistenceRuntime().pendingPersistStartedAt : 0;
  const delay = elapsed >= STATE_FORCE_SAVE_AFTER_MS ? 0 : STATE_SAVE_DEBOUNCE_MS;

  const serverId = getActiveServerId();
  getPersistenceRuntime().saveTimer = setTimeout(() => {
    runInServerMaintenanceContext(serverId, () => {
      getPersistenceRuntime().saveTimer = null;
      flushPendingState().catch((err) => {
        console.error("❌ erro no flush agendado do state:", err);
      });
    });
  }, delay);
}

export async function flushStateAsync(forceCompatibilitySnapshot = false) {
  if (STATE_PERSISTENCE_V2_ENABLED) {
    await Promise.all([
      flushPendingDomains(forceCompatibilitySnapshot, undefined, forceCompatibilitySnapshot, forceCompatibilitySnapshot ? "forced:compat" : "forced:flush-state"),
      flushPendingDiscordRuntime(),
      flushPlayerPositionHistoryBatch(),
    ]);
    return;
  }
  await Promise.all([flushPendingState(), flushPendingDiscordRuntime(), flushPlayerPositionHistoryBatch()]);
}

// Runtime stop/shutdown must not lose coalesced server-scoped changes, but it
// also must not turn a normal stop into a large compatibility snapshot write.
export async function flushServerRuntimePendingStateAsync() {
  if (STATE_PERSISTENCE_V2_ENABLED) {
    await Promise.all([
      flushPendingDomains(false, undefined, true, "forced:runtime-stop"),
      flushPendingDiscordRuntime(),
      flushPlayerPositionHistoryBatch(),
    ]);
    return;
  }
  await Promise.all([flushPendingState(), flushPendingDiscordRuntime(), flushPlayerPositionHistoryBatch()]);
}

function readLocalState(): AppState {
  const file = getLocalStateFile();
  if (!fs.existsSync(file)) {
    return defaultState();
  }

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return migrateLegacyState(data);
  } catch (err) {
    console.error("❌ erro lendo state local:", { serverId: getActiveServerId(), file, err });
    return defaultState();
  }
}

function writeLocalState(data: AppState) {
  const file = getLocalStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}


type PlayerTotalsSummary = { players: number; kills: number; deaths: number };

function summarizeGlobalPlayers(players: Record<string, PlayerStats> | undefined): PlayerTotalsSummary {
  const entries = Object.values(players || {});
  return entries.reduce<PlayerTotalsSummary>((summary, stats) => {
    summary.players += 1;
    summary.kills += Number(stats?.kills || 0);
    summary.deaths += Number(stats?.deaths || 0);
    return summary;
  }, { players: 0, kills: 0, deaths: 0 });
}

function applyGranularPlayerRows(state: AppState, rows: any[]) {
  let newestGranularAt = 0;
  let applied = 0;
  for (const row of rows || []) {
    const playerKey = String(row.player_key || "");
    if (!playerKey || !row.stats || typeof row.stats !== "object") continue;
    state.players[playerKey] = {
      kills: Number(row.stats.kills || 0),
      deaths: Number(row.stats.deaths || 0),
    };
    const streak = Number(row.current_streak || 0);
    if (streak > 0) state.currentKillStreaks[playerKey] = streak;
    else delete state.currentKillStreaks[playerKey];
    applied += 1;
    const rowAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    if (rowAt > newestGranularAt) newestGranularAt = rowAt;
  }
  granularPlayerStatsMetrics.rowsAppliedAtBoot += applied;
  if (newestGranularAt) granularPlayerStatsMetrics.newestRowAtBoot = new Date(newestGranularAt).toISOString();
  return { applied, newestGranularAt };
}

async function loadAllGranularPlayerRowsForActiveServer() {
  if (!sql) return [] as any[];
  return playerStatsScopedPersistenceReady
    ? await sql`
        SELECT player_key, stats, current_streak, updated_at
        FROM player_stats_state
        WHERE server_id = ${getActiveServerId()}
        ORDER BY player_key ASC
      ` as any[]
    : await sql`
        SELECT player_key, stats, current_streak, updated_at
        FROM player_stats_state
        WHERE server_id = ${getActiveServerId()}
        ORDER BY player_key ASC
      ` as any[];
}

async function readGranularPlayerSummaryForActiveServer(): Promise<PlayerTotalsSummary> {
  if (!sql) return { players: 0, kills: 0, deaths: 0 };
  const rows = playerStatsScopedPersistenceReady
    ? await sql`
        SELECT
          COUNT(*)::int AS players,
          COALESCE(SUM(CASE WHEN COALESCE(stats->>'kills','') ~ '^[0-9]+$' THEN (stats->>'kills')::bigint ELSE 0 END), 0)::bigint AS kills,
          COALESCE(SUM(CASE WHEN COALESCE(stats->>'deaths','') ~ '^[0-9]+$' THEN (stats->>'deaths')::bigint ELSE 0 END), 0)::bigint AS deaths
        FROM player_stats_state
        WHERE server_id = ${getActiveServerId()}
      `
    : await sql`
        SELECT
          COUNT(*)::int AS players,
          COALESCE(SUM(CASE WHEN COALESCE(stats->>'kills','') ~ '^[0-9]+$' THEN (stats->>'kills')::bigint ELSE 0 END), 0)::bigint AS kills,
          COALESCE(SUM(CASE WHEN COALESCE(stats->>'deaths','') ~ '^[0-9]+$' THEN (stats->>'deaths')::bigint ELSE 0 END), 0)::bigint AS deaths
        FROM player_stats_state
        WHERE server_id = ${getActiveServerId()}
      `;
  const row = (rows as any[])[0] || {};
  return { players: Number(row.players || 0), kills: Number(row.kills || 0), deaths: Number(row.deaths || 0) };
}

async function persistRecoveredPrimarySnapshot(state: AppState, previousMainRow?: any) {
  if (!sql || getActiveServerId() !== getPrimaryServerId() || !botStateScopedPersistenceReady) return;
  const recoveryAt = new Date().toISOString();
  if (previousMainRow?.data) {
    const backupId = `recovery_backup_main_${Date.now()}`;
    await sql`
      INSERT INTO bot_state (id, data, updated_at, server_id)
      VALUES (${backupId}, ${sql.json(previousMainRow.data)}, NOW(), ${getPrimaryServerId()})
      ON CONFLICT (server_id, id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO bot_state (id, data, updated_at, server_id)
    VALUES (${STATE_ID}, ${sql.json(state)}, NOW(), ${getPrimaryServerId()})
    ON CONFLICT (server_id, id)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `;
  console.warn("🛟 PZ Deathmatch state recovered from same-server persistence sources", {
    serverId: getPrimaryServerId(),
    recoveryAt,
    totals: summarizeGlobalPlayers(state.players),
    backupCreated: Boolean(previousMainRow?.data),
  });
}

async function refreshBotStateScopedReadCapability() {
  if (!sql) return;
  try {
    const indexes = await sql`
      SELECT array_agg(a.attname ORDER BY keycols.ordinality) AS columns
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN unnest(i.indkey) WITH ORDINALITY AS keycols(attnum, ordinality) ON TRUE
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keycols.attnum
      WHERE t.relname = 'bot_state' AND i.indisunique
      GROUP BY i.indexrelid
    `;
    const hasScopedUniqueKey = (indexes as any[]).some((row: any) => {
      const columns = Array.isArray(row?.columns) ? row.columns.map((value: unknown) => String(value)) : [];
      return columns.join(',') === 'server_id,id';
    });
    if (hasScopedUniqueKey) {
      botStatePrimaryKeyReady = true;
      botStateScopedPersistenceReady = true;
      setServerNamespacePersistenceStatus({
        botStateCompositeKeyReady: true,
        botStatePrimaryKeyReady: true,
        scopedReadsEnabled: true,
        lastScopedReadSource,
        lastCheckedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error('❌ unable to independently verify bot_state scoped key:', error);
  }
}

export async function getStateAsync(): Promise<AppState> {
  await ensurePrimaryServerRegistryMetadata();
  // Registry onboarding can fail independently from gameplay persistence.
  // Re-probe the already-existing bot_state unique key so a registry failure
  // can never downgrade gameplay reads to an ambiguous cross-server scan.
  await refreshBotStateScopedReadCapability();
  const existingCachedState = getCachedState();
  if (existingCachedState) {
    return existingCachedState;
  }

  if (!sql) {
    domainPersistenceMetrics.bootSource = "local-file";
    setCachedState(readLocalState());
    getPersistenceRuntime().lastPersistedJson = serializeState(getCachedState()!);
    getPersistenceRuntime().lastPersistedHash = hashState(getPersistenceRuntime().lastPersistedJson);
    getPersistenceRuntime().lastCoreHash = hashCoreState(getCachedState()!);
    getPersistenceRuntime().lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(getCachedState()!));
    initializeDomainHashes(getCachedState()!);
    initializeGranularPlayerSignatures(getCachedState()!);
    return getCachedState()!;
  }

  try {
    persistenceMetrics.reads += 1;
    persistenceMetrics.lastReadAt = new Date().toISOString();
    const domainIds = Object.values(STATE_DOMAIN_IDS);
    const stateIds = [STATE_ID, DISCORD_RUNTIME_STATE_ID, domainIds[0], domainIds[1], domainIds[2], domainIds[3], domainIds[4]];
    let rows: any[] = [];
    if (botStateScopedPersistenceReady) {
      rows = await sql`
        SELECT id, data, updated_at, server_id
        FROM bot_state
        WHERE server_id = ${getActiveServerId()}
          AND id IN (${stateIds[0]}, ${stateIds[1]}, ${stateIds[2]}, ${stateIds[3]}, ${stateIds[4]}, ${stateIds[5]}, ${stateIds[6]})
      ` as any[];
      lastScopedReadSource = "server-scoped";
      if (!rows.some((row: any) => row.id === STATE_ID) && getActiveServerId() === getPrimaryServerId()) {
        // Legacy fallback exists only for the production primary. A fresh
        // secondary namespace must NEVER read another server's rows.
        scopedReadFallbacks += 1;
        lastScopedReadSource = "legacy-fallback";
        rows = await sql`
          SELECT id, data, updated_at, server_id
          FROM bot_state
          WHERE (server_id = ${getPrimaryServerId()} OR server_id IS NULL)
            AND id IN (${stateIds[0]}, ${stateIds[1]}, ${stateIds[2]}, ${stateIds[3]}, ${stateIds[4]}, ${stateIds[5]}, ${stateIds[6]})
        ` as any[];
      }
    } else {
      // Fail closed even when schema-readiness metadata is stale. The table may
      // already contain one `main` per server, so an unscoped SELECT + find()
      // is nondeterministic and can load another server's empty state.
      lastScopedReadSource = "server-id-safe-fallback";
      rows = await sql`
        SELECT id, data, updated_at, server_id
        FROM bot_state
        WHERE server_id = ${getActiveServerId()}
          AND id IN (${stateIds[0]}, ${stateIds[1]}, ${stateIds[2]}, ${stateIds[3]}, ${stateIds[4]}, ${stateIds[5]}, ${stateIds[6]})
      ` as any[];
      if (!rows.some((row: any) => row.id === STATE_ID) && getActiveServerId() === getPrimaryServerId()) {
        // A truly legacy untagged row belongs only to the production primary.
        // It is considered only when no explicit pz-deathmatch row exists.
        scopedReadFallbacks += 1;
        lastScopedReadSource = "primary-untagged-fallback";
        rows = await sql`
          SELECT id, data, updated_at, server_id
          FROM bot_state
          WHERE server_id IS NULL
            AND id IN (${stateIds[0]}, ${stateIds[1]}, ${stateIds[2]}, ${stateIds[3]}, ${stateIds[4]}, ${stateIds[5]}, ${stateIds[6]})
        ` as any[];
      }
    }
    setServerNamespacePersistenceStatus({
      scopedReadsEnabled: botStateScopedPersistenceReady,
      scopedReadFallbacks,
      lastScopedReadSource,
    });
    const foreignRows = rows.filter((row: any) => row.server_id != null && String(row.server_id) !== getActiveServerId());
    if (foreignRows.length) {
      throw new Error(`Cross-server bot_state read blocked for ${getActiveServerId()}: ${foreignRows.map((row: any) => `${row.id}@${row.server_id}`).join(', ')}`);
    }
    const mainRow = rows.find((row: any) => row.id === STATE_ID);
    const runtimeRow = rows.find((row: any) => row.id === DISCORD_RUNTIME_STATE_ID);

    if (!mainRow) {
      const isPrimary = getActiveServerId() === getPrimaryServerId();
      let state = defaultState();
      let recoveredPrimary = false;

      if (isPrimary) {
        // A missing primary main row is never allowed to silently become an
        // empty production snapshot. Rebuild only from sources that are already
        // owned by pz-deathmatch: local legacy state, primary V2 domains and
        // primary granular player rows. Secondary rows are never considered.
        const local = readLocalState();
        if (summarizeGlobalPlayers(local.players).players > 0) {
          state = local;
          recoveredPrimary = true;
        }
        if (STATE_PERSISTENCE_V2_ENABLED) {
          for (const domain of Object.keys(STATE_DOMAIN_IDS) as StateDomainName[]) {
            const row = rows.find((candidate: any) => candidate.id === STATE_DOMAIN_IDS[domain]);
            if (!row) continue;
            applyStateDomain(state, domain, row.data || {});
            recoveredPrimary = true;
          }
        }
        if (GRANULAR_PLAYER_STATS_ENABLED) {
          await ensureGranularPlayerStatsTable();
          const granularRows = await loadAllGranularPlayerRowsForActiveServer();
          if (granularRows.length) {
            applyGranularPlayerRows(state, granularRows);
            recoveredPrimary = true;
          }
        }
      } else {
        // New runtimes start directly in the proven optimized ADM strategy so
        // they do not retransmit every historical candidate every 5 minutes.
        state.serviceSettings = normalizeServiceSettings({ ...state.serviceSettings, admDownloadMode: "optimized" });
      }

      domainPersistenceMetrics.bootSource = recoveredPrimary ? "persistence-v2" : "fresh-main";
      await hydrateKnownServerPlayers(getActiveServerId()).catch((err) => console.error(`❌ known players hydrate failed [${getActiveServerId()}]`, err));
      const serialized = serializeState(state);
      const hash = hashState(serialized);

      if (recoveredPrimary) {
        await persistRecoveredPrimarySnapshot(state);
      } else if (botStateScopedPersistenceReady) {
        await sql`
          INSERT INTO bot_state (id, data, updated_at, server_id)
          VALUES (${STATE_ID}, ${sql.json(state)}, NOW(), ${getActiveServerId()})
          ON CONFLICT (server_id, id) DO NOTHING
        `;
      } else {
        throw new Error(`Refusing to create unscoped main state for ${getActiveServerId()}`);
      }

      setCachedState(state);
      getPersistenceRuntime().lastPersistedJson = serialized;
      getPersistenceRuntime().lastPersistedHash = hash;
      getPersistenceRuntime().lastCoreHash = hashCoreState(state);
      getPersistenceRuntime().lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(state));
      initializeDomainHashes(state);
      initializeGranularPlayerSignatures(state);
      getPersistenceRuntime().lastCompatibilitySnapshotAt = Date.now();
      return getCachedState()!;
    }

    setCachedState(migrateLegacyState(mainRow.data || {}));
    const mainPersistedHash = hashState(serializeState(getCachedState()!));
    const mainUpdatedAt = mainRow.updated_at ? new Date(mainRow.updated_at).getTime() : 0;
    getPersistenceRuntime().lastCompatibilitySnapshotAt = mainUpdatedAt || Date.now();
    domainPersistenceMetrics.mainUpdatedAtAtBoot = mainUpdatedAt ? new Date(mainUpdatedAt).toISOString() : undefined;

    let domainRowsFoundAtBoot = 0;
    let domainRowsAppliedAtBoot = 0;
    let newestDomainUpdatedAt = 0;
    if (STATE_PERSISTENCE_V2_ENABLED) {
      for (const domain of Object.keys(STATE_DOMAIN_IDS) as StateDomainName[]) {
        const row = rows.find((candidate: any) => candidate.id === STATE_DOMAIN_IDS[domain]);
        const domainUpdatedAt = row?.updated_at ? new Date(row.updated_at).getTime() : 0;
        if (row) domainRowsFoundAtBoot += 1;
        if (domainUpdatedAt > newestDomainUpdatedAt) newestDomainUpdatedAt = domainUpdatedAt;
        // A compatibility snapshot may be newer than a domain row. In that case
        // the snapshot already contains the fresher domain value and must win.
        if (row && domainUpdatedAt > mainUpdatedAt) {
          applyStateDomain(getCachedState()!, domain, row.data || {});
          domainRowsAppliedAtBoot += 1;
        }
      }
    }
    let primaryStatsRecovered = false;
    if (STATE_PERSISTENCE_V2_ENABLED && GRANULAR_PLAYER_STATS_ENABLED) {
      await ensureGranularPlayerStatsTable();
      const inMemoryTotals = summarizeGlobalPlayers(getCachedState()!.players);
      const granularTotals = await readGranularPlayerSummaryForActiveServer();
      const granularHasMoreAuthoritativeData =
        granularTotals.players > inMemoryTotals.players
        || granularTotals.kills > inMemoryTotals.kills
        || granularTotals.deaths > inMemoryTotals.deaths;

      const granularRows = granularHasMoreAuthoritativeData
        ? await loadAllGranularPlayerRowsForActiveServer()
        : playerStatsScopedPersistenceReady
          ? await sql`
              SELECT player_key, stats, current_streak, updated_at
              FROM player_stats_state
              WHERE server_id = ${getActiveServerId()}
                AND updated_at > ${new Date(mainUpdatedAt || 0)}
            ` as any[]
          : await sql`
              SELECT player_key, stats, current_streak, updated_at
              FROM player_stats_state
              WHERE server_id = ${getActiveServerId()}
                AND updated_at > ${new Date(mainUpdatedAt || 0)}
            ` as any[];

      applyGranularPlayerRows(getCachedState()!, granularRows as any[]);
      primaryStatsRecovered = getActiveServerId() === getPrimaryServerId() && granularHasMoreAuthoritativeData;
      if (primaryStatsRecovered) {
        console.warn("🛟 detected reduced PZ Deathmatch compatibility snapshot; restoring global players from primary granular rows", {
          before: inMemoryTotals,
          granular: granularTotals,
          after: summarizeGlobalPlayers(getCachedState()!.players),
        });
      }
    }
    domainPersistenceMetrics.domainRowsFoundAtBoot = domainRowsFoundAtBoot;
    domainPersistenceMetrics.domainRowsAppliedAtBoot = domainRowsAppliedAtBoot;
    domainPersistenceMetrics.newestDomainUpdatedAtAtBoot = newestDomainUpdatedAt ? new Date(newestDomainUpdatedAt).toISOString() : undefined;
    domainPersistenceMetrics.bootSource = STATE_PERSISTENCE_V2_ENABLED
      ? ((domainRowsAppliedAtBoot > 0 || granularPlayerStatsMetrics.rowsAppliedAtBoot > 0) ? "persistence-v2" : "compat-main")
      : "legacy-main";

    const runtimeUpdatedAt = runtimeRow?.updated_at ? new Date(runtimeRow.updated_at).getTime() : 0;
    if (runtimeRow && runtimeUpdatedAt >= mainUpdatedAt) {
      applyDiscordRuntimeState(getCachedState()!, normalizeDiscordRuntimeState(runtimeRow.data || defaultDiscordRuntimeState()));
    }
    if (primaryStatsRecovered) {
      await persistRecoveredPrimarySnapshot(getCachedState()!, mainRow);
    }
    await hydrateKnownServerPlayers(getActiveServerId()).catch((err) => console.error(`❌ known players hydrate failed [${getActiveServerId()}]`, err));
    const loadedStateJson = serializeState(getCachedState()!);
    recordNetworkTransfer({
      service: "neon",
      operation: "bot_state_read",
      direction: "inbound",
      bytes: Buffer.byteLength(loadedStateJson, "utf8"),
      ok: true,
    });
    getPersistenceRuntime().lastPersistedJson = loadedStateJson;
    // Track the actual compatibility row, not the merged V2 view. Otherwise an
    // hourly compatibility snapshot could be incorrectly skipped after restart.
    getPersistenceRuntime().lastPersistedHash = mainPersistedHash;
    getPersistenceRuntime().lastCoreHash = hashCoreState(getCachedState()!);
    getPersistenceRuntime().lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(getCachedState()!));
    initializeDomainHashes(getCachedState()!);
    initializeGranularPlayerSignatures(getCachedState()!);
    return getCachedState()!;
  } catch (err) {
    console.error("❌ erro lendo state no Neon, usando state.json local:", err);
    domainPersistenceMetrics.bootSource = "local-fallback";
    setCachedState(readLocalState());
    getPersistenceRuntime().lastPersistedJson = serializeState(getCachedState()!);
    getPersistenceRuntime().lastPersistedHash = hashState(getPersistenceRuntime().lastPersistedJson);
    getPersistenceRuntime().lastCoreHash = hashCoreState(getCachedState()!);
    getPersistenceRuntime().lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(getCachedState()!));
    initializeDomainHashes(getCachedState()!);
    initializeGranularPlayerSignatures(getCachedState()!);
    return getCachedState()!;
  }
}


export function getStatePersistenceMetrics(serverId = getActiveServerId()) {
  const metric = persistenceMetricsStore.get(serverId);
  const writes = Math.max(1, metric.writes);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(metric.startedAt).getTime()) / 3_600_000);
  const bytesPerHour = metric.totalPayloadBytesWritten / uptimeHours;
  return {
    serverId,
    ...metric,
    averagePayloadBytes: Math.round(metric.totalPayloadBytesWritten / writes),
    averageChangedBytes: Math.round(metric.totalChangedBytes / writes),
    averageWriteDurationMs: Math.round(metric.totalWriteDurationMs / writes),
    projected30DayPayloadBytes: Math.round(bytesPerHour * 24 * 30),
    writeRatePerHour: Number((metric.writes / uptimeHours).toFixed(2)),
    reasons: { ...metric.reasons },
    sections: { ...metric.sections },
    lastPayloadSections: [...metric.lastPayloadSections],
    detailedSections: [...metric.detailedSections],
    recentWrites: [...metric.recentWrites],
  };
}

export function getGranularPlayerStatsPersistenceMetrics(serverId = getActiveServerId()) {
  const metric = granularPlayerStatsMetricsStore.get(serverId);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(metric.startedAt).getTime()) / 3_600_000);
  const batches = Math.max(1, metric.batchesWritten);
  return {
    serverId,
    ...metric,
    pendingPlayers: getPersistenceRuntime(serverId).pendingGranularPlayerStats.size,
    cadenceMinutes: Math.round(STATE_STATS_PERSIST_MS / 60_000),
    averageBatchBytes: Math.round(metric.totalPayloadBytesWritten / batches),
    averageRowsPerBatch: Number((metric.rowsWritten / batches).toFixed(1)),
    averageWriteDurationMs: Math.round(metric.totalWriteDurationMs / batches),
    projected30DayPayloadBytes: Math.round((metric.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
  };
}

export function getDiscordRuntimePersistenceMetrics(serverId = getActiveServerId()) {
  const metric = discordRuntimeMetricsStore.get(serverId);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(metric.startedAt).getTime()) / 3_600_000);
  const writes = Math.max(1, metric.writes);
  return {
    serverId,
    ...metric,
    averagePayloadBytes: Math.round(metric.totalPayloadBytesWritten / writes),
    averageWriteDurationMs: Math.round(metric.totalWriteDurationMs / writes),
    writeRatePerHour: Number((metric.writes / uptimeHours).toFixed(2)),
    projected30DayPayloadBytes: Math.round((metric.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
  };
}

export function getStateDomainPersistenceMetrics(serverId = getActiveServerId()) {
  const metric = domainPersistenceMetricsStore.get(serverId);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(metric.startedAt).getTime()) / 3_600_000);
  const flushes = Math.max(1, metric.flushes);
  return {
    serverId,
    ...metric,
    pendingDomains: getPersistenceRuntime(serverId).pendingDomains.size,
    backgroundCadenceMinutes: Math.round(STATE_BACKGROUND_PERSIST_MS / 60_000),
    processingCadenceMinutes: Math.round(STATE_PROCESSING_PERSIST_MS / 60_000),
    statsCadenceMinutes: Math.round(STATE_STATS_PERSIST_MS / 60_000),
    compatibilitySnapshotMinutes: Math.round(STATE_COMPAT_SNAPSHOT_MS / 60_000),
    schedulerPolicyVersion: STATE_SCHEDULER_POLICY_VERSION,
    averageFlushPayloadBytes: Math.round(metric.totalPayloadBytesWritten / flushes),
    averageWriteDurationMs: Math.round(metric.totalWriteDurationMs / flushes),
    writeRatePerHour: Number((metric.flushes / uptimeHours).toFixed(2)),
    projected30DayPayloadBytes: Math.round((metric.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
    domains: Object.fromEntries(Object.entries(metric.domains).map(([key, value]) => [key, { ...value }])),
  };
}


async function ensurePlayerPositionHistoryTable() {
  if (!sql) return;
  if (playerPositionTableReadyPromise) return playerPositionTableReadyPromise;

  playerPositionTableReadyPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS player_position_history (
        id BIGSERIAL PRIMARY KEY,
        server_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        player_name TEXT NOT NULL,
        player_normalized TEXT NOT NULL,
        event_type TEXT NOT NULL,
        x DOUBLE PRECISION,
        z DOUBLE PRECISION,
        y DOUBLE PRECISION,
        observed_at TIMESTAMPTZ NOT NULL,
        source_file TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (server_id, source_key)
      )
    `;
    // Existing Phase 7 installs used a global source_key. Tag those rows as the
    // primary server before promoting uniqueness to (server_id, source_key).
    await sql`ALTER TABLE player_position_history ADD COLUMN IF NOT EXISTS server_id TEXT`;
    await sql`UPDATE player_position_history SET server_id = ${getPrimaryServerId()} WHERE server_id IS NULL`;
    await sql`ALTER TABLE player_position_history ALTER COLUMN server_id SET NOT NULL`;
    await sql`ALTER TABLE player_position_history DROP CONSTRAINT IF EXISTS player_position_history_source_key_key`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS player_position_history_server_source_key_uidx ON player_position_history (server_id, source_key)`;
    await sql`CREATE INDEX IF NOT EXISTS player_position_history_server_observed_at_idx ON player_position_history (server_id, observed_at)`;
    await sql`CREATE INDEX IF NOT EXISTS player_position_history_server_player_time_idx ON player_position_history (server_id, player_normalized, observed_at)`;
  })().catch((err) => {
    playerPositionTableReadyPromise = null;
    throw err;
  });

  return playerPositionTableReadyPromise;
}

async function flushPlayerPositionHistoryBatch() {
  const playerPositionFlushTimer = getPlayerPositionRuntime().flushTimer;
  if (playerPositionFlushTimer) {
    clearTimeout(playerPositionFlushTimer);
    getPlayerPositionRuntime().flushTimer = null;
  }
  if (!sql || !getPlayerPositionRuntime().pendingObservations.size) return;

  const rows = [...getPlayerPositionRuntime().pendingObservations.values()];
  getPlayerPositionRuntime().pendingObservations = new Map<string, PlayerPositionHistoryObservation>();
  const startedAt = Date.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");

  try {
    await ensurePlayerPositionHistoryTable();
    const serverId = getActiveServerId();
    const values = rows.map((row) => ({
      server_id: serverId,
      source_key: row.sourceKey,
      player_name: row.playerName,
      player_normalized: row.playerNormalized,
      event_type: row.eventType,
      x: row.x ?? null,
      z: row.z ?? null,
      y: row.y ?? null,
      observed_at: row.observedAt,
      source_file: row.sourceFile || null,
    }));
    const result = await sql`
      INSERT INTO player_position_history ${sql(values)}
      ON CONFLICT (server_id, source_key) DO NOTHING
    `;

    const inserted = Number((result as any).count ?? rows.length);
    const now = Date.now();
    playerPositionHistoryMetrics.batchesWritten += 1;
    playerPositionHistoryMetrics.rowsWritten += inserted;
    playerPositionHistoryMetrics.totalPayloadBytesWritten += payloadBytes;
    playerPositionHistoryMetrics.lastWriteAt = new Date(now).toISOString();
    recordNetworkTransfer({
      service: "neon-position-history",
      operation: "player_position_history_batch",
      direction: "outbound",
      bytes: payloadBytes,
      ok: true,
    });

    if (now - getPlayerPositionRuntime().lastCleanupAt >= PLAYER_POSITION_CLEANUP_INTERVAL_MS) {
      await sql`DELETE FROM player_position_history WHERE observed_at < NOW() - INTERVAL '24 hours'`;
      getPlayerPositionRuntime().lastCleanupAt = now;
    }
  } catch (err) {
    playerPositionHistoryMetrics.failedBatches += 1;
    playerPositionHistoryMetrics.lastError = err instanceof Error ? err.message : String(err);
    for (const row of rows) getPlayerPositionRuntime().pendingObservations.set(row.sourceKey, row);
    recordNetworkTransfer({
      service: "neon-position-history",
      operation: "player_position_history_batch",
      direction: "outbound",
      bytes: payloadBytes,
      ok: false,
    });
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;
    playerPositionHistoryMetrics.lastWriteDurationMs = durationMs;
    playerPositionHistoryMetrics.totalWriteDurationMs += durationMs;
  }
}

export async function queuePlayerPositionHistoryObservations(observations: PlayerPositionHistoryObservation[]) {
  if (!observations.length) return;

  for (const observation of observations) {
    playerPositionHistoryMetrics.observationsReceived += 1;
    playerPositionHistoryMetrics.observedPlayers.add(observation.playerNormalized);

    if (observation.eventType === "connect") {
      playerPositionHistoryMetrics.connectEvents += 1;
      // A reconnect starts a new forensic session. If the ADM exposes coordinates
      // on the connect line, use them as the baseline for movement sampling.
      getPlayerPositionRuntime().retainedPositions.delete(observation.playerNormalized);
      if (observation.x != null && observation.z != null) {
        const observedAtMs = Date.parse(observation.observedAt);
        getPlayerPositionRuntime().retainedPositions.set(observation.playerNormalized, {
          x: observation.x,
          z: observation.z,
          observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : Date.now(),
        });
      }
      getPlayerPositionRuntime().pendingObservations.set(observation.sourceKey, observation);
      playerPositionHistoryMetrics.recentSamples.push(observation);
      continue;
    }

    if (observation.eventType === "disconnect") {
      playerPositionHistoryMetrics.disconnectEvents += 1;
      getPlayerPositionRuntime().pendingObservations.set(observation.sourceKey, observation);
      playerPositionHistoryMetrics.recentSamples.push(observation);
      // Never carry a location baseline across sessions.
      getPlayerPositionRuntime().retainedPositions.delete(observation.playerNormalized);
      continue;
    }

    playerPositionHistoryMetrics.positionEvents += 1;
    if (observation.x == null || observation.z == null) continue;

    const observedAtMsRaw = Date.parse(observation.observedAt);
    const observedAtMs = Number.isFinite(observedAtMsRaw) ? observedAtMsRaw : Date.now();
    const previous = getPlayerPositionRuntime().retainedPositions.get(observation.playerNormalized);
    let shouldRetain = !previous;

    if (previous) {
      const dx = observation.x - previous.x;
      const dz = observation.z - previous.z;
      const movedMeters = Math.hypot(dx, dz);
      const elapsedMs = Math.max(0, observedAtMs - previous.observedAtMs);
      shouldRetain =
        movedMeters >= PLAYER_POSITION_MIN_MOVEMENT_METERS ||
        elapsedMs >= PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS;
    }

    if (!shouldRetain) {
      playerPositionHistoryMetrics.suppressedPositionEvents += 1;
      continue;
    }

    playerPositionHistoryMetrics.queuedPositionEvents += 1;
    getPlayerPositionRuntime().retainedPositions.set(observation.playerNormalized, {
      x: observation.x,
      z: observation.z,
      observedAtMs,
    });
    getPlayerPositionRuntime().pendingObservations.set(observation.sourceKey, observation);
    playerPositionHistoryMetrics.recentSamples.push(observation);
  }

  if (playerPositionHistoryMetrics.recentSamples.length > 80) {
    playerPositionHistoryMetrics.recentSamples.splice(0, playerPositionHistoryMetrics.recentSamples.length - 80);
  }

  if (!sql) return;
  if (getPlayerPositionRuntime().pendingObservations.size >= PLAYER_POSITION_MAX_PENDING) {
    await flushPlayerPositionHistoryBatch();
    return;
  }

  if (!getPlayerPositionRuntime().flushTimer) {
    const remainder = Date.now() % PLAYER_POSITION_FLUSH_INTERVAL_MS;
    const delay = Math.max(1000, PLAYER_POSITION_FLUSH_INTERVAL_MS - remainder);
    const serverId = getActiveServerId();
    getPlayerPositionRuntime().flushTimer = setTimeout(() => {
      runInServerMaintenanceContext(serverId, () => {
        getPlayerPositionRuntime().flushTimer = null;
        flushPlayerPositionHistoryBatch().catch((err) => console.error("❌ erro no flush alinhado do histórico de posições:", err));
      });
    }, delay);
  }
}

export function recordInvalidPlayerPositionObservation() {
  playerPositionHistoryMetrics.invalidPositions += 1;
}

export type PlayerPositionSnapshot = {
  playerName: string;
  playerNormalized: string;
  x: number;
  z: number;
  observedAt: string;
  source: "memory" | "database";
};

export async function getLatestPlayerPositionSnapshot(playerNames: string[]): Promise<PlayerPositionSnapshot[]> {
  const requested = new Map<string, string>();
  for (const rawName of playerNames) {
    const playerName = String(rawName || "").trim();
    if (!playerName) continue;
    requested.set(playerName.toLowerCase(), playerName);
  }
  if (!requested.size) return [];

  const byPlayer = new Map<string, PlayerPositionSnapshot>();

  // Prefer the most recent retained in-memory point. This lets the admin map
  // reflect the latest parser cycle without forcing the pending forensic batch
  // to be written to Neon first.
  for (const [playerNormalized, playerName] of requested.entries()) {
    const retained = getPlayerPositionRuntime().retainedPositions.get(playerNormalized);
    if (!retained) continue;
    byPlayer.set(playerNormalized, {
      playerName,
      playerNormalized,
      x: retained.x,
      z: retained.z,
      observedAt: new Date(retained.observedAtMs).toISOString(),
      source: "memory",
    });
  }

  if (sql) {
    try {
      await ensurePlayerPositionHistoryTable();
      const normalizedNames = [...requested.keys()];
      const rows = await sql`
        SELECT DISTINCT ON (player_normalized)
          player_name, player_normalized, x, z, observed_at
        FROM player_position_history
        WHERE server_id = ${getActiveServerId()}
          AND event_type = 'position'
          AND x IS NOT NULL
          AND z IS NOT NULL
          AND observed_at >= NOW() - INTERVAL '24 hours'
          AND player_normalized IN ${sql(normalizedNames)}
        ORDER BY player_normalized, observed_at DESC
      `;

      for (const row of rows as any[]) {
        const playerNormalized = String(row.player_normalized || "").toLowerCase();
        if (!requested.has(playerNormalized)) continue;
        const observedAt = row.observed_at instanceof Date
          ? row.observed_at.toISOString()
          : new Date(row.observed_at).toISOString();
        const candidate: PlayerPositionSnapshot = {
          playerName: String(row.player_name || requested.get(playerNormalized) || playerNormalized),
          playerNormalized,
          x: Number(row.x),
          z: Number(row.z),
          observedAt,
          source: "database",
        };
        const current = byPlayer.get(playerNormalized);
        if (!current || Date.parse(candidate.observedAt) > Date.parse(current.observedAt)) {
          byPlayer.set(playerNormalized, candidate);
        }
      }
    } catch (err) {
      // The admin map is observational only. A read failure must never affect
      // parser, rankings, killfeed or the position-history writer.
      console.warn("Failed to read latest player position snapshot", err);
    }
  }

  return [...byPlayer.values()];
}

export function getPlayerPositionHistoryMetrics(serverId = getActiveServerId()) {
  const metric = playerPositionHistoryMetricsStore.get(serverId);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(metric.startedAt).getTime()) / 3_600_000);
  const batches = Math.max(1, metric.batchesWritten);
  return {
    serverId,
    startedAt: metric.startedAt,
    retentionHours: PLAYER_POSITION_RETENTION_HOURS,
    flushIntervalMinutes: PLAYER_POSITION_FLUSH_INTERVAL_MS / 60_000,
    minMovementMeters: PLAYER_POSITION_MIN_MOVEMENT_METERS,
    maxSampleIntervalMinutes: PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS / 60_000,
    observationsReceived: metric.observationsReceived,
    positionEvents: metric.positionEvents,
    queuedPositionEvents: metric.queuedPositionEvents,
    suppressedPositionEvents: metric.suppressedPositionEvents,
    positionReductionPercent: metric.positionEvents > 0
      ? Number(((metric.suppressedPositionEvents / metric.positionEvents) * 100).toFixed(2))
      : 0,
    connectEvents: metric.connectEvents,
    disconnectEvents: metric.disconnectEvents,
    invalidPositions: metric.invalidPositions,
    uniquePlayersObserved: metric.observedPlayers.size,
    pendingObservations: getPlayerPositionRuntime(serverId).pendingObservations.size,
    batchesWritten: metric.batchesWritten,
    rowsWritten: metric.rowsWritten,
    failedBatches: metric.failedBatches,
    totalPayloadBytesWritten: metric.totalPayloadBytesWritten,
    averageBatchPayloadBytes: Math.round(metric.totalPayloadBytesWritten / batches),
    averageWriteDurationMs: Math.round(metric.totalWriteDurationMs / batches),
    projected30DayPayloadBytes: Math.round((metric.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
    lastWriteAt: metric.lastWriteAt,
    lastWriteDurationMs: metric.lastWriteDurationMs,
    lastError: metric.lastError,
    recentSamples: [...metric.recentSamples],
  };
}

export async function saveDiscordRuntimeStateOnlyAsync(data: AppState, reason?: string) {
  const runtimeReason = normalizePersistenceReason(reason);
  discordRuntimeMetrics.saveRequests += 1;
  discordRuntimeMetrics.explicitRuntimeRequests += 1;
  await persistDiscordRuntimeOnly(data, runtimeReason);
}

async function persistDiscordRuntimeOnly(data: AppState, runtimeReason: string) {
  const runtime = normalizeDiscordRuntimeState(data);
  const cachedState = getCachedState();
  if (cachedState) applyDiscordRuntimeState(cachedState, runtime);
  else setCachedState(data);
  writeLocalState(getCachedState()!);

  if (!sql) {
    // Local-only environments keep the established single-file behavior.
    await saveStateAsync(getCachedState()!, runtimeReason);
    return;
  }

  const serialized = JSON.stringify(runtime);
  const hash = hashState(serialized);
  if (hash === getPersistenceRuntime().lastDiscordRuntimeHash || hash === getPersistenceRuntime().pendingDiscordRuntimeHash) {
    discordRuntimeMetrics.skippedWrites += 1;
    return;
  }

  getPersistenceRuntime().pendingDiscordRuntimeJson = serialized;
  getPersistenceRuntime().pendingDiscordRuntimeHash = hash;
  scheduleDiscordRuntimePersist();
}

export async function saveDiscordStateAsync(data: AppState, reason?: string) {
  const runtimeReason = normalizePersistenceReason(reason);
  discordRuntimeMetrics.saveRequests += 1;

  // Generic Discord mutations remain conservative: if core state changed, persist it fully.
  // The periodic feed loop uses saveDiscordRuntimeStateOnlyAsync only after verifying that
  // the loop itself did not change core state.
  if (!getPersistenceRuntime().lastCoreHash || hashCoreState(data) !== getPersistenceRuntime().lastCoreHash) {
    discordRuntimeMetrics.fallbackToCore += 1;
    await saveStateAsync(data, runtimeReason);
    return;
  }

  await persistDiscordRuntimeOnly(data, runtimeReason);
}

export async function saveStateAsync(data: AppState, reason?: string) {
  const persistenceReason = normalizePersistenceReason(reason);
  recordSaveRequest(persistenceReason);
  const persistedState = parseLastPersistedState();
  const shouldProtectMapRotation = !data.mapRotation && hasPersistedSpawnZones(persistedState?.mapRotation);

  const safeData: AppState = {
    players: data.players || {},
    dailyPlayers: data.dailyPlayers || {},
    weeklyPlayers: data.weeklyPlayers || {},
    onlinePlayers: data.onlinePlayers || {},
    onlineSessions: data.onlineSessions || {},
    onlineActivitySamples: Array.isArray(data.onlineActivitySamples) ? data.onlineActivitySamples : [],
    playerLinks: data.playerLinks || {},
    playerLinksByGamertag: data.playerLinksByGamertag || {},
    playerAlts: data.playerAlts && typeof data.playerAlts === "object" ? data.playerAlts : {},
    clans: data.clans && typeof data.clans === "object" ? data.clans : {},
    clanMemberships: data.clanMemberships && typeof data.clanMemberships === "object" ? data.clanMemberships : {},
    clanInvites: Array.isArray(data.clanInvites) ? data.clanInvites : [],
    wallets: data.wallets || {},
    economyTransactions: Array.isArray(data.economyTransactions) ? data.economyTransactions.slice(-1000) : [],
    shopOrders: Array.isArray(data.shopOrders) ? data.shopOrders : [],
    shopSavedLocations: Array.isArray(data.shopSavedLocations) ? data.shopSavedLocations : [],
    shopPendingCheckouts: Array.isArray(data.shopPendingCheckouts) ? data.shopPendingCheckouts : [],
    shopCatalog: data.shopCatalog,
    dayzItems: Array.isArray(data.dayzItems) ? data.dayzItems : undefined,
    shopResetMonitor: data.shopResetMonitor || null,
    shopAutoDeploy: data.shopAutoDeploy || null,
    mapRotation: shouldProtectMapRotation ? persistedState?.mapRotation : data.mapRotation || undefined,
    mapVoteUserLocales: data.mapVoteUserLocales && typeof data.mapVoteUserLocales === "object" ? data.mapVoteUserLocales : {},
    discordCommandSettings: normalizeDiscordCommandSettings(data.discordCommandSettings),
    serviceSettings: normalizeServiceSettings(data.serviceSettings),
    files: data.files || {},
    recentEventIds: (data.recentEventIds || []).slice(-3000),
    killFeedEvents: (data.killFeedEvents || []).slice(-60),
    portalKillFeedEvents: (data.portalKillFeedEvents || []).slice(-99),
    longShotEvents: (data.longShotEvents || []).slice(-100),

    currentKillStreaks: data.currentKillStreaks || {},
    killStreakEvents: (data.killStreakEvents || []).slice(-100),

    discordMessageIds: data.discordMessageIds || {},
    activeMatch: data.activeMatch || null,

    lastDailyReset: data.lastDailyReset || "",
    lastWeeklyReset: data.lastWeeklyReset || "",

    globalStartedAt: data.globalStartedAt,
    dailyStartedAt: data.dailyStartedAt,
    weeklyStartedAt: data.weeklyStartedAt,

    lastLine: data.lastLine,
    lastFileName: data.lastFileName,
  };

  setCachedState(safeData);
  getPersistenceRuntime().lastCoreHash = hashCoreState(safeData);

  // If a runtime-only write was waiting while a full/core save became necessary,
  // refresh that pending payload so an older runtime snapshot can never become
  // newer than the full row after a race.
  if (getPersistenceRuntime().pendingDiscordRuntimeJson) {
    getPersistenceRuntime().pendingDiscordRuntimeJson = serializeDiscordRuntime(safeData);
    getPersistenceRuntime().pendingDiscordRuntimeHash = hashState(getPersistenceRuntime().pendingDiscordRuntimeJson);
  }

  const serialized = serializeState(safeData);
  const hash = hashState(serialized);

  writeLocalState(safeData);
  scheduleTenantCommerceMirror(safeData, getActiveServerId());

  if (!sql) {
    getPersistenceRuntime().lastPersistedJson = serialized;
    getPersistenceRuntime().lastPersistedHash = hash;
    initializeDomainHashes(safeData);
    logStateDebug("💾 STATE SALVO EM", { file: getLocalStateFile(), serverId: getActiveServerId() });
    return;
  }

  if (STATE_PERSISTENCE_V2_ENABLED) {
    // Runtime fields are persisted independently as well, even when the caller
    // used the generic save API (for example admin/config paths touching mapRotation).
    const runtimeSerialized = serializeDiscordRuntime(safeData);
    const runtimeHash = hashState(runtimeSerialized);
    const runtimeChanged = runtimeHash !== getPersistenceRuntime().lastDiscordRuntimeHash && runtimeHash !== getPersistenceRuntime().pendingDiscordRuntimeHash;
    if (runtimeChanged) {
      getPersistenceRuntime().pendingDiscordRuntimeJson = runtimeSerialized;
      getPersistenceRuntime().pendingDiscordRuntimeHash = runtimeHash;
      scheduleDiscordRuntimePersist();
    }

    const changed = await queueAndPersistStateDomains(safeData, persistenceReason);
    if (!changed && !runtimeChanged) {
      persistenceMetrics.skippedWrites += 1;
      getReasonMetric(persistenceReason).skippedRequests += 1;
      logStateDebug("⏭️ STATE V2 ignorado: sem alterações", { reason: persistenceReason });
    }
    // Keep the latest in-memory/full JSON for local diagnostics and the hourly
    // compatibility snapshot, but do not treat it as already persisted in Neon.
    getPersistenceRuntime().lastPersistedJson = serialized;
    return;
  }

  if (hash === getPersistenceRuntime().lastPersistedHash || serialized === getPersistenceRuntime().lastPersistedJson) {
    persistenceMetrics.skippedWrites += 1;
    getReasonMetric(persistenceReason).skippedRequests += 1;
    logStateDebug("⏭️ STATE ignorado: sem alterações", { reason: persistenceReason });
    return;
  }

  getPersistenceRuntime().pendingPersistJson = serialized;
  getPersistenceRuntime().pendingPersistHash = hash;
  getPersistenceRuntime().pendingPersistReasons.add(persistenceReason);
  getPersistenceRuntime().pendingPersistStartedAt = getPersistenceRuntime().pendingPersistStartedAt || Date.now();
  scheduleNeonPersist();
}

export function getState(): AppState {
  const cachedState = getCachedState();
  if (cachedState) return cachedState;
  setCachedState(readLocalState());
  getPersistenceRuntime().lastPersistedJson = serializeState(getCachedState()!);
  getPersistenceRuntime().lastPersistedHash = hashState(getPersistenceRuntime().lastPersistedJson);
  getPersistenceRuntime().lastCoreHash = hashCoreState(getCachedState()!);
  getPersistenceRuntime().lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(getCachedState()!));
  initializeDomainHashes(getCachedState()!);
  return getCachedState()!;
}

export function saveState(data: AppState) {
  setCachedState(data);
  const serialized = serializeState(data);
  getPersistenceRuntime().lastPersistedJson = serialized;
  getPersistenceRuntime().lastPersistedHash = hashState(serialized);
  getPersistenceRuntime().lastCoreHash = hashCoreState(data);
  getPersistenceRuntime().lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(data));
  initializeDomainHashes(data);
  writeLocalState(data);
  logStateDebug("💾 STATE SALVO LOCALMENTE", { file: getLocalStateFile(), serverId: getActiveServerId() });
}
