import path from "path";
import { AsyncLocalStorage } from "async_hooks";
import {
  getManagedServerById,
  getPrimaryServerDescriptor,
  getPrimaryServerId,
  setServerRuntimeIsolationStatus,
  type ManagedServerDescriptor,
} from "./serverRegistry";

const LEGACY_LOG_DIR_NAME = "adm_logs";
const LEGACY_MANIFEST_NAME = "adm_manifest.json";
const runtimeLocks = new Set<string>();
const executionContext = new AsyncLocalStorage<{ serverId: string }>();
let lockSkips = 0;
let contextRuns = 0;
let contextFallbacks = 0;
let lastContextServerId: string | undefined;

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getServerRuntimeContext(serverId?: string) {
  const targetId = String(serverId || getPrimaryServerId()).trim();
  const descriptor = getManagedServerById(targetId) || (targetId === getPrimaryServerId() ? getPrimaryServerDescriptor() : undefined);
  if (!descriptor) throw new Error(`Unknown managed server: ${targetId}`);

  const isPrimary = descriptor.id === getPrimaryServerId();
  const staggerOffsetMs = isPrimary ? 0 : (stableHash(descriptor.id) % 10) * 30_000;
  setServerRuntimeIsolationStatus({
    initialized: true,
    contextServerId: descriptor.id,
    nitradoRoutingNamespaced: Boolean(descriptor.integrations.nitradoServiceId && descriptor.runtime.nitradoBaseDir),
    discordRoutingNamespaced: Boolean(
      descriptor.integrations.discordGuildId
      && descriptor.runtime.discord.globalChannelId
      && descriptor.runtime.discord.dailyChannelId
      && descriptor.runtime.discord.weeklyChannelId
      && descriptor.runtime.discord.onlineCategoryId
    ),
    processingLockNamespaced: true,
    primaryLegacyAdmStoragePreserved: true,
    staggerOffsetMs,
    activeLocks: runtimeLocks.size,
    lockSkips,
    executionContextNamespaced: true,
    contextRuns,
    contextFallbacks,
    lastContextServerId,
    stateCacheNamespaced: true,
    schedulerCentralized: true,
    admStrategyNamespaced: true,
    lastError: undefined,
  });

  return {
    server: descriptor,
    serverId: descriptor.id,
    isPrimary,
    staggerOffsetMs,
    nitrado: {
      serviceId: descriptor.integrations.nitradoServiceId,
      baseDir: descriptor.runtime.nitradoBaseDir,
    },
    discord: {
      guildId: descriptor.integrations.discordGuildId,
      ...descriptor.runtime.discord,
    },
    storage: getAdmStoragePaths(descriptor),
  };
}

function getAdmStoragePaths(descriptor: ManagedServerDescriptor) {
  const isPrimary = descriptor.id === getPrimaryServerId();
  if (isPrimary) {
    return {
      logDir: path.resolve(process.cwd(), LEGACY_LOG_DIR_NAME),
      manifestFile: path.resolve(process.cwd(), LEGACY_MANIFEST_NAME),
      legacyPreserved: true,
    };
  }
  const root = path.resolve(process.cwd(), "adm_servers", descriptor.id);
  return {
    logDir: path.join(root, "logs"),
    manifestFile: path.join(root, "manifest.json"),
    legacyPreserved: false,
  };
}


export function getActiveServerId() {
  const active = executionContext.getStore()?.serverId;
  if (active) return active;
  contextFallbacks += 1;
  return getPrimaryServerId();
}

export function runInServerRuntimeContext<T>(serverId: string, work: () => T): T {
  const context = getServerRuntimeContext(serverId);
  contextRuns += 1;
  lastContextServerId = context.serverId;
  setServerRuntimeIsolationStatus({
    executionContextNamespaced: true,
    contextRuns,
    contextFallbacks,
    lastContextServerId,
  });
  return executionContext.run({ serverId: context.serverId }, work);
}

export function getServerStateStoragePath(serverId = getActiveServerId()) {
  const context = getServerRuntimeContext(serverId);
  if (context.isPrimary) return path.resolve(process.cwd(), "state.json");
  return path.resolve(process.cwd(), "state_servers", context.serverId, "state.json");
}

export async function runWithServerRuntimeLock<T>(serverId: string, work: () => Promise<T>): Promise<{ skipped: boolean; value?: T }> {
  const context = getServerRuntimeContext(serverId);
  if (runtimeLocks.has(context.serverId)) {
    lockSkips += 1;
    setServerRuntimeIsolationStatus({ activeLocks: runtimeLocks.size, lockSkips, lastLockServerId: context.serverId });
    return { skipped: true };
  }

  runtimeLocks.add(context.serverId);
  setServerRuntimeIsolationStatus({ activeLocks: runtimeLocks.size, lockSkips, lastLockServerId: context.serverId });
  try {
    return { skipped: false, value: await work() };
  } finally {
    runtimeLocks.delete(context.serverId);
    setServerRuntimeIsolationStatus({ activeLocks: runtimeLocks.size, lockSkips, lastLockServerId: context.serverId });
  }
}

export function assertPrimaryRuntimeServer(serverId: string) {
  const primaryId = getPrimaryServerId();
  if (serverId !== primaryId) {
    throw new Error(`Server ${serverId} is registered but runtime activation is still blocked until Phase 8.`);
  }
}
