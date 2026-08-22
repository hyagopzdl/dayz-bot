import fs from "fs";
import path from "path";
import crypto from "crypto";
import postgres from "postgres";
import type { ShopCatalog } from "./shopCatalog";
import type { DayzItemDefinition } from "./dayzItemDatabase";
import type { Locale } from "./i18n";
import { normalizeDiscordCommandSettings, type DiscordCommandSettings } from "./discord/commandSettings";
import { normalizeServiceSettings, type ServiceSettings } from "./serviceSettings";
import { recordNetworkTransfer } from "./networkMetrics";
import {
  getPrimaryServerDescriptor,
  getPrimaryServerId,
  setPersistedManagedServers,
  setServerRegistryPersistenceStatus,
  setServerNamespacePersistenceStatus,
  setServerRuntimeIsolationStatus,
  type ManagedServerDescriptor,
} from "./serverRegistry";
import { getActiveServerId, getServerStateStoragePath, runInServerRuntimeContext } from "./serverRuntime";

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

const granularPlayerStatsMetrics = {
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

type DomainMetric = {
  changes: number;
  writes: number;
  bytesWritten: number;
  currentBytes: number;
  lastWriteAt?: string;
};

const domainPersistenceMetrics = {
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

const discordRuntimeMetrics = {
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

const persistenceMetrics = {
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

let lastSectionHashes: Record<string, string> = {};
let lastSectionBytes: Record<string, number> = {};

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
let lastScopedReadSource: "server-scoped" | "legacy-fallback" | "legacy" = "legacy";

async function ensurePrimaryServerRegistryMetadata() {
  if (!sql) {
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
    try {
      // Phase 5 keeps the registry metadata behavior unchanged. No bot_state ids,
      // ADM cursors, granular stats, Discord routing or Nitrado routing are
      // renamed or moved in this deploy.
      await sql`
        CREATE TABLE IF NOT EXISTS managed_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          primary_server BOOLEAN NOT NULL DEFAULT FALSE,
          mode TEXT NOT NULL DEFAULT 'single-server-compat',
          nitrado_service_id TEXT,
          discord_guild_id TEXT,
          runtime_config JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS runtime_config JSONB`;
      setServerRegistryPersistenceStatus({ tableReady: true });

      // Never overwrite an existing registry row from environment variables.
      // This avoids a deploy unexpectedly remapping the production server.
      const inserted = await sql`
        INSERT INTO managed_servers (
          id, name, enabled, primary_server, mode, nitrado_service_id, discord_guild_id, runtime_config, created_at, updated_at
        )
        VALUES (
          ${primary.id}, ${primary.name}, TRUE, TRUE, ${primary.mode},
          ${primary.integrations.nitradoServiceId || null}, ${primary.integrations.discordGuildId || null}, ${JSON.stringify(primary.runtime)}::jsonb, NOW(), NOW()
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;

      const runtimeBackfill = await sql`
        UPDATE managed_servers
        SET
          nitrado_service_id = COALESCE(nitrado_service_id, ${primary.integrations.nitradoServiceId || null}),
          discord_guild_id = COALESCE(discord_guild_id, ${primary.integrations.discordGuildId || null}),
          runtime_config = CASE
            WHEN runtime_config IS NULL OR runtime_config = '{}'::jsonb THEN ${JSON.stringify(primary.runtime)}::jsonb
            ELSE runtime_config
          END,
          updated_at = NOW()
        WHERE id = ${primary.id}
          AND (
            nitrado_service_id IS NULL
            OR discord_guild_id IS NULL
            OR runtime_config IS NULL
            OR runtime_config = '{}'::jsonb
          )
        RETURNING id
      `;

      const rows = await sql`
        SELECT id, name, enabled, primary_server, mode, nitrado_service_id, discord_guild_id, runtime_config
        FROM managed_servers
        ORDER BY primary_server DESC, created_at ASC, id ASC
      `;

      const descriptors: ManagedServerDescriptor[] = (rows as any[]).map((row) => ({
        id: String(row.id || ""),
        name: String(row.name || row.id || "Server"),
        enabled: row.enabled !== false,
        primary: Boolean(row.primary_server),
        mode: "single-server-compat",
        integrations: {
          nitradoServiceId: String(row.nitrado_service_id || "").trim() || undefined,
          discordGuildId: String(row.discord_guild_id || "").trim() || undefined,
        },
        runtime: {
          nitradoBaseDir: String(row.runtime_config?.nitradoBaseDir || primary.runtime.nitradoBaseDir || "").trim() || undefined,
          discord: { ...(primary.runtime.discord || {}), ...(row.runtime_config?.discord || {}) },
        },
      }));
      setPersistedManagedServers(descriptors.length ? descriptors : [primary]);

      const persistedPrimary = descriptors.find((server) => server.id === primary.id) || descriptors.find((server) => server.primary);
      setServerRegistryPersistenceStatus({
        enabled: true,
        initialized: true,
        tableReady: true,
        primarySeeded: Boolean(persistedPrimary),
        rowsLoaded: descriptors.length,
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
      setServerRegistryPersistenceStatus({
        initialized: true,
        lastError: err instanceof Error ? err.message : String(err),
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

const playerPositionHistoryMetrics = {
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
    await sql`UPDATE player_stats_state SET server_id = ${getActiveServerId()} WHERE server_id IS NULL`;
    await sql`CREATE INDEX IF NOT EXISTS player_stats_state_updated_at_idx ON player_stats_state (updated_at)`;
    await sql`CREATE INDEX IF NOT EXISTS player_stats_state_server_id_idx ON player_stats_state (server_id)`;
    const namespaceCounts = await sql`
      SELECT
        COUNT(*) FILTER (WHERE server_id = ${getActiveServerId()})::int AS tagged_rows,
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
          await tx`
            INSERT INTO bot_state (id, data, updated_at, server_id)
            VALUES (${STATE_DOMAIN_IDS[domain]}, ${tx.json(entry.payload)}, NOW(), ${getActiveServerId()})
            ON CONFLICT (id)
            DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), server_id = EXCLUDED.server_id
          `;
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
          await tx`
            INSERT INTO player_stats_state (server_id, player_key, stats, current_streak, updated_at)
            SELECT incoming.server_id, incoming.player_key, incoming.stats, incoming.current_streak, NOW()
            FROM jsonb_to_recordset(${tx.json(playerPayload)}::jsonb)
              AS incoming(server_id TEXT, player_key TEXT, stats JSONB, current_streak INTEGER)
            ON CONFLICT (player_key)
            DO UPDATE SET
              server_id = EXCLUDED.server_id,
              stats = EXCLUDED.stats,
              current_streak = EXCLUDED.current_streak,
              updated_at = NOW()
          `;
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
  if (getPersistenceRuntime().domainFlushTimer) {
    clearTimeout(getPersistenceRuntime().domainFlushTimer);
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

  getPersistenceRuntime().domainFlushPromise = (async () => {
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
  return getPersistenceRuntime().domainFlushPromise;
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
    runInServerRuntimeContext(serverId, () => {
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
      await sql`
        INSERT INTO bot_state (id, data, updated_at, server_id)
        VALUES (${DISCORD_RUNTIME_STATE_ID}, ${sql.json(runtime)}, NOW(), ${getActiveServerId()})
        ON CONFLICT (id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), server_id = EXCLUDED.server_id
      `;
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
  if (getPersistenceRuntime().discordRuntimeSaveTimer) {
    clearTimeout(getPersistenceRuntime().discordRuntimeSaveTimer);
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
    runInServerRuntimeContext(serverId, () => {
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
      await sql`
        INSERT INTO bot_state (id, data, updated_at, server_id)
        VALUES (${STATE_ID}, ${sql.json(parsed)}, NOW(), ${getActiveServerId()})
        ON CONFLICT (id)
        DO UPDATE SET
          data = EXCLUDED.data,
          updated_at = NOW(),
          server_id = EXCLUDED.server_id
      `;
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

  if (getPersistenceRuntime().saveTimer) {
    clearTimeout(getPersistenceRuntime().saveTimer);
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
    runInServerRuntimeContext(serverId, () => {
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

export async function getStateAsync(): Promise<AppState> {
  await ensurePrimaryServerRegistryMetadata();
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
      if (!rows.some((row: any) => row.id === STATE_ID)) {
        scopedReadFallbacks += 1;
        lastScopedReadSource = "legacy-fallback";
        rows = await sql`
          SELECT id, data, updated_at, server_id
          FROM bot_state
          WHERE id IN (${stateIds[0]}, ${stateIds[1]}, ${stateIds[2]}, ${stateIds[3]}, ${stateIds[4]}, ${stateIds[5]}, ${stateIds[6]})
        ` as any[];
      }
    } else {
      lastScopedReadSource = "legacy";
      rows = await sql`
        SELECT id, data, updated_at, server_id
        FROM bot_state
        WHERE id IN (${stateIds[0]}, ${stateIds[1]}, ${stateIds[2]}, ${stateIds[3]}, ${stateIds[4]}, ${stateIds[5]}, ${stateIds[6]})
      ` as any[];
    }
    setServerNamespacePersistenceStatus({
      scopedReadsEnabled: botStateScopedPersistenceReady,
      scopedReadFallbacks,
      lastScopedReadSource,
    });
    const mainRow = rows.find((row: any) => row.id === STATE_ID);
    const runtimeRow = rows.find((row: any) => row.id === DISCORD_RUNTIME_STATE_ID);

    if (!mainRow) {
      domainPersistenceMetrics.bootSource = "fresh-main";
      const state = defaultState();
      const serialized = serializeState(state);
      const hash = hashState(serialized);

      if (botStateScopedPersistenceReady) {
        await sql`
          INSERT INTO bot_state (id, data, updated_at, server_id)
          VALUES (${STATE_ID}, ${sql.json(state)}, NOW(), ${getActiveServerId()})
          ON CONFLICT (server_id, id) DO NOTHING
        `;
      } else {
        await sql`
          INSERT INTO bot_state (id, data, updated_at, server_id)
          VALUES (${STATE_ID}, ${sql.json(state)}, NOW(), ${getActiveServerId()})
          ON CONFLICT (id) DO NOTHING
        `;
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
    if (STATE_PERSISTENCE_V2_ENABLED && GRANULAR_PLAYER_STATS_ENABLED) {
      await ensureGranularPlayerStatsTable();
      const granularRows = playerStatsScopedPersistenceReady
        ? await sql`
            SELECT player_key, stats, current_streak, updated_at
            FROM player_stats_state
            WHERE server_id = ${getActiveServerId()}
              AND updated_at > ${new Date(mainUpdatedAt || 0)}
          `
        : await sql`
            SELECT player_key, stats, current_streak, updated_at
            FROM player_stats_state
            WHERE updated_at > ${new Date(mainUpdatedAt || 0)}
          `;
      let newestGranularAt = 0;
      for (const row of granularRows as any[]) {
        const playerKey = String(row.player_key || "");
        if (!playerKey || !row.stats || typeof row.stats !== "object") continue;
        getCachedState()!.players[playerKey] = {
          kills: Number(row.stats.kills || 0),
          deaths: Number(row.stats.deaths || 0),
        };
        const streak = Number(row.current_streak || 0);
        if (streak > 0) getCachedState()!.currentKillStreaks[playerKey] = streak;
        else delete getCachedState()!.currentKillStreaks[playerKey];
        granularPlayerStatsMetrics.rowsAppliedAtBoot += 1;
        const rowAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        if (rowAt > newestGranularAt) newestGranularAt = rowAt;
      }
      granularPlayerStatsMetrics.newestRowAtBoot = newestGranularAt ? new Date(newestGranularAt).toISOString() : undefined;
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


export function getStatePersistenceMetrics() {
  const writes = Math.max(1, persistenceMetrics.writes);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(persistenceMetrics.startedAt).getTime()) / 3_600_000);
  const bytesPerHour = persistenceMetrics.totalPayloadBytesWritten / uptimeHours;
  return {
    ...persistenceMetrics,
    averagePayloadBytes: Math.round(persistenceMetrics.totalPayloadBytesWritten / writes),
    averageChangedBytes: Math.round(persistenceMetrics.totalChangedBytes / writes),
    averageWriteDurationMs: Math.round(persistenceMetrics.totalWriteDurationMs / writes),
    projected30DayPayloadBytes: Math.round(bytesPerHour * 24 * 30),
    writeRatePerHour: Number((persistenceMetrics.writes / uptimeHours).toFixed(2)),
    reasons: { ...persistenceMetrics.reasons },
    sections: { ...persistenceMetrics.sections },
    lastPayloadSections: [...persistenceMetrics.lastPayloadSections],
    detailedSections: [...persistenceMetrics.detailedSections],
    recentWrites: [...persistenceMetrics.recentWrites],
  };
}

export function getGranularPlayerStatsPersistenceMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(granularPlayerStatsMetrics.startedAt).getTime()) / 3_600_000);
  const batches = Math.max(1, granularPlayerStatsMetrics.batchesWritten);
  return {
    ...granularPlayerStatsMetrics,
    pendingPlayers: getPersistenceRuntime().pendingGranularPlayerStats.size,
    cadenceMinutes: Math.round(STATE_STATS_PERSIST_MS / 60_000),
    averageBatchBytes: Math.round(granularPlayerStatsMetrics.totalPayloadBytesWritten / batches),
    averageRowsPerBatch: Number((granularPlayerStatsMetrics.rowsWritten / batches).toFixed(1)),
    averageWriteDurationMs: Math.round(granularPlayerStatsMetrics.totalWriteDurationMs / batches),
    projected30DayPayloadBytes: Math.round((granularPlayerStatsMetrics.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
  };
}

export function getDiscordRuntimePersistenceMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(discordRuntimeMetrics.startedAt).getTime()) / 3_600_000);
  const writes = Math.max(1, discordRuntimeMetrics.writes);
  return {
    ...discordRuntimeMetrics,
    averagePayloadBytes: Math.round(discordRuntimeMetrics.totalPayloadBytesWritten / writes),
    averageWriteDurationMs: Math.round(discordRuntimeMetrics.totalWriteDurationMs / writes),
    writeRatePerHour: Number((discordRuntimeMetrics.writes / uptimeHours).toFixed(2)),
    projected30DayPayloadBytes: Math.round((discordRuntimeMetrics.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
  };
}

export function getStateDomainPersistenceMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(domainPersistenceMetrics.startedAt).getTime()) / 3_600_000);
  const flushes = Math.max(1, domainPersistenceMetrics.flushes);
  return {
    ...domainPersistenceMetrics,
    pendingDomains: getPersistenceRuntime().pendingDomains.size,
    backgroundCadenceMinutes: Math.round(STATE_BACKGROUND_PERSIST_MS / 60_000),
    processingCadenceMinutes: Math.round(STATE_PROCESSING_PERSIST_MS / 60_000),
    statsCadenceMinutes: Math.round(STATE_STATS_PERSIST_MS / 60_000),
    compatibilitySnapshotMinutes: Math.round(STATE_COMPAT_SNAPSHOT_MS / 60_000),
    schedulerPolicyVersion: STATE_SCHEDULER_POLICY_VERSION,
    averageFlushPayloadBytes: Math.round(domainPersistenceMetrics.totalPayloadBytesWritten / flushes),
    averageWriteDurationMs: Math.round(domainPersistenceMetrics.totalWriteDurationMs / flushes),
    writeRatePerHour: Number((domainPersistenceMetrics.flushes / uptimeHours).toFixed(2)),
    projected30DayPayloadBytes: Math.round((domainPersistenceMetrics.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
    domains: Object.fromEntries(Object.entries(domainPersistenceMetrics.domains).map(([key, value]) => [key, { ...value }])),
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
  if (getPlayerPositionRuntime().flushTimer) {
    clearTimeout(getPlayerPositionRuntime().flushTimer);
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
      runInServerRuntimeContext(serverId, () => {
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

export function getPlayerPositionHistoryMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(playerPositionHistoryMetrics.startedAt).getTime()) / 3_600_000);
  const batches = Math.max(1, playerPositionHistoryMetrics.batchesWritten);
  return {
    startedAt: playerPositionHistoryMetrics.startedAt,
    retentionHours: PLAYER_POSITION_RETENTION_HOURS,
    flushIntervalMinutes: PLAYER_POSITION_FLUSH_INTERVAL_MS / 60_000,
    minMovementMeters: PLAYER_POSITION_MIN_MOVEMENT_METERS,
    maxSampleIntervalMinutes: PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS / 60_000,
    observationsReceived: playerPositionHistoryMetrics.observationsReceived,
    positionEvents: playerPositionHistoryMetrics.positionEvents,
    queuedPositionEvents: playerPositionHistoryMetrics.queuedPositionEvents,
    suppressedPositionEvents: playerPositionHistoryMetrics.suppressedPositionEvents,
    positionReductionPercent: playerPositionHistoryMetrics.positionEvents > 0
      ? Number(((playerPositionHistoryMetrics.suppressedPositionEvents / playerPositionHistoryMetrics.positionEvents) * 100).toFixed(2))
      : 0,
    connectEvents: playerPositionHistoryMetrics.connectEvents,
    disconnectEvents: playerPositionHistoryMetrics.disconnectEvents,
    invalidPositions: playerPositionHistoryMetrics.invalidPositions,
    uniquePlayersObserved: playerPositionHistoryMetrics.observedPlayers.size,
    pendingObservations: getPlayerPositionRuntime().pendingObservations.size,
    batchesWritten: playerPositionHistoryMetrics.batchesWritten,
    rowsWritten: playerPositionHistoryMetrics.rowsWritten,
    failedBatches: playerPositionHistoryMetrics.failedBatches,
    totalPayloadBytesWritten: playerPositionHistoryMetrics.totalPayloadBytesWritten,
    averageBatchPayloadBytes: Math.round(playerPositionHistoryMetrics.totalPayloadBytesWritten / batches),
    averageWriteDurationMs: Math.round(playerPositionHistoryMetrics.totalWriteDurationMs / batches),
    projected30DayPayloadBytes: Math.round((playerPositionHistoryMetrics.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
    lastWriteAt: playerPositionHistoryMetrics.lastWriteAt,
    lastWriteDurationMs: playerPositionHistoryMetrics.lastWriteDurationMs,
    lastError: playerPositionHistoryMetrics.lastError,
    recentSamples: [...playerPositionHistoryMetrics.recentSamples],
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
