import path from "path";
import { AsyncLocalStorage } from "async_hooks";
import {
  canExecuteManagedServerRuntime,
  getManagedServerById,
  setServerRuntimeIsolationStatus,
  type ManagedServerDescriptor,
} from "./serverRegistry";

const runtimeLocks = new Set<string>();
type ServerContextPurpose = "data" | "runtime" | "maintenance";
type ServerExecutionContext = { serverId: string; organizationId: string; purpose: ServerContextPurpose };
const executionContext = new AsyncLocalStorage<ServerExecutionContext>();
let lockSkips = 0;
let contextRuns = 0;
let contextFallbacks = 0;
let lastContextServerId: string | undefined;

function stableHash(value: string) { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return hash >>> 0; }

export function getServerRuntimeContext(serverId?: string) {
  const targetId = String(serverId || executionContext.getStore()?.serverId || "").trim();
  if (!targetId) throw new Error("TENANT_CONTEXT_REQUIRED");
  const descriptor = getManagedServerById(targetId);
  if (!descriptor) throw new Error(`Unknown managed server: ${targetId}`);
  const staggerOffsetMs = (stableHash(descriptor.id) % 10) * 30_000;
  setServerRuntimeIsolationStatus({ initialized: true, contextServerId: descriptor.id, nitradoRoutingNamespaced: Boolean(descriptor.integrations.nitradoServiceId && descriptor.runtime.nitradoBaseDir), discordRoutingNamespaced: true, processingLockNamespaced: true, staggerOffsetMs, activeLocks: runtimeLocks.size, lockSkips, executionContextNamespaced: true, contextRuns, contextFallbacks, lastContextServerId, stateCacheNamespaced: true, schedulerCentralized: true, admStrategyNamespaced: true, admParserStorageNamespaced: true, persistenceRuntimeNamespaced: true, positionHistoryNamespaced: true, discordLoopGuardsNamespaced: true, mapSchedulersContextualized: true, activationReadiness: true, lastError: undefined });
  return { server: descriptor, serverId: descriptor.id, isPrimary: false, staggerOffsetMs, nitrado: { serviceId: descriptor.integrations.nitradoServiceId, baseDir: descriptor.runtime.nitradoBaseDir }, discord: { guildId: descriptor.integrations.discordGuildId, ...descriptor.runtime.discord }, storage: getAdmStoragePaths(descriptor) };
}

function getAdmStoragePaths(descriptor: ManagedServerDescriptor) {
  const root = path.resolve(process.cwd(), "adm_servers", descriptor.id);
  return { logDir: path.join(root, "logs"), manifestFile: path.join(root, "manifest.json"), legacyPreserved: false };
}

export function getServerStoragePlan(serverId: string) {
  const targetId = String(serverId || "").trim();
  const descriptor = getManagedServerById(targetId);
  if (!descriptor) throw new Error(`Unknown managed server: ${targetId}`);
  const storage = getAdmStoragePaths(descriptor);
  return { serverId: descriptor.id, isPrimary: false, admLogDir: storage.logDir, admManifestFile: storage.manifestFile, stateFile: path.resolve(process.cwd(), "state_servers", descriptor.id, "state.json") };
}

export function getActiveServerId() {
  const active = executionContext.getStore()?.serverId;
  if (active) return active;
  contextFallbacks += 1;
  throw new Error("TENANT_CONTEXT_REQUIRED");
}
export function requireActiveServerId() { const active = executionContext.getStore()?.serverId; if (!active) throw new Error("TENANT_CONTEXT_REQUIRED"); return active; }
export function getActiveServerOrganizationId() { const organizationId = executionContext.getStore()?.organizationId; if (!organizationId) throw new Error("TENANT_CONTEXT_REQUIRED"); return organizationId; }
export function getActiveServerContext() { const context = executionContext.getStore(); if (!context) throw new Error("TENANT_CONTEXT_REQUIRED"); return { ...context }; }

function runInKnownServerContext<T>(serverId: string, work: () => T, purpose: ServerContextPurpose, requireExecutable: boolean): T {
  const context = getServerRuntimeContext(serverId);
  if (requireExecutable && !canExecuteManagedServerRuntime(context.serverId)) throw new Error(`Server ${context.serverId} runtime is disabled or has not passed the activation gate.`);
  contextRuns += 1;
  lastContextServerId = context.serverId;
  setServerRuntimeIsolationStatus({ executionContextNamespaced: true, contextRuns, contextFallbacks, lastContextServerId });
  return executionContext.run({ serverId: context.serverId, organizationId: context.server.organizationId, purpose }, work);
}
export function runInServerDataContext<T>(serverId: string, work: () => T): T { return runInKnownServerContext(serverId, work, "data", false); }
export function runInServerRuntimeContext<T>(serverId: string, work: () => T): T { return runInKnownServerContext(serverId, work, "runtime", true); }
export function runInServerMaintenanceContext<T>(serverId: string, work: () => T): T { return runInKnownServerContext(serverId, work, "maintenance", false); }

export function getTenantContextDiagnostics() { const active = executionContext.getStore(); return { explicitDataContextAvailable: Boolean(active), activeServerId: active?.serverId, activeOrganizationId: active?.organizationId, purpose: active?.purpose, contextFallbacks, policy: "tenant-context-required;no-primary-fallback" }; }
export function getServerStateStoragePath(serverId = getActiveServerId()) { const context = getServerRuntimeContext(serverId); return path.resolve(process.cwd(), "state_servers", context.serverId, "state.json"); }
export function isServerRuntimeLocked(serverId: string) { return runtimeLocks.has(String(serverId || "").trim()); }

async function runWithServerLock<T>(serverId: string, work: () => Promise<T>): Promise<{ skipped: boolean; value?: T }> {
  const context = getServerRuntimeContext(serverId);
  if (runtimeLocks.has(context.serverId)) { lockSkips += 1; setServerRuntimeIsolationStatus({ activeLocks: runtimeLocks.size, lockSkips, lastLockServerId: context.serverId }); return { skipped: true }; }
  runtimeLocks.add(context.serverId); setServerRuntimeIsolationStatus({ activeLocks: runtimeLocks.size, lockSkips, lastLockServerId: context.serverId });
  try { return { skipped: false, value: await work() }; } finally { runtimeLocks.delete(context.serverId); setServerRuntimeIsolationStatus({ activeLocks: runtimeLocks.size, lockSkips, lastLockServerId: context.serverId }); }
}
export async function runWithServerRuntimeLock<T>(serverId: string, work: () => Promise<T>): Promise<{ skipped: boolean; value?: T }> { const context = getServerRuntimeContext(serverId); if (!canExecuteManagedServerRuntime(context.serverId)) throw new Error(`Server ${context.serverId} runtime is disabled or has not passed the activation gate.`); return runWithServerLock(context.serverId, work); }
export async function runWithServerMaintenanceLock<T>(serverId: string, work: () => Promise<T>): Promise<{ skipped: boolean; value?: T }> { const context = getServerRuntimeContext(serverId); return runWithServerMaintenanceLock(context.serverId, work); }
