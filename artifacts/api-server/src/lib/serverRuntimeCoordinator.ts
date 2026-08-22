import { downloadADM, setAdmDownloadMode } from "./nitradoDownloader";
import { getLeaderboard } from "./parser";
import { flushServerRuntimePendingStateAsync, getStateAsync } from "./state";
import { normalizeServiceSettings } from "./serviceSettings";
import {
  getManagedServerById,
  getPrimaryServerId,
  listExecutableManagedServers,
  listManagedServers,
  type ManagedServerDescriptor,
} from "./serverRegistry";
import {
  recordMainCycleCompleted,
  recordMainCycleSkippedOverlap,
  recordMainCycleStarted,
} from "./runtimeMetrics";
import {
  runInServerMaintenanceContext,
  runInServerRuntimeContext,
  runWithServerRuntimeLock,
} from "./serverRuntime";

const RUNTIME_CYCLE_INTERVAL_MS = 5 * 60 * 1000;

type RuntimeCycleReason = "startup" | "scheduler" | "activation" | "manual";

type ServerRuntimeCycleStatus = {
  serverId: string;
  serverName: string;
  cycles: number;
  skippedOverlaps: number;
  failures: number;
  lastReason?: RuntimeCycleReason;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastDownloadDurationMs?: number;
  lastParserDurationMs?: number;
  lastDownloadOk?: boolean;
  lastParserOk?: boolean;
  lastError?: string;
};

const statuses = new Map<string, ServerRuntimeCycleStatus>();
const requestedImmediateRuns = new Set<string>();
let schedulerTimer: NodeJS.Timeout | null = null;

function getStatus(serverId: string) {
  const descriptor = getManagedServerById(serverId);
  let status = statuses.get(serverId);
  if (!status) {
    status = {
      serverId,
      serverName: descriptor?.name || serverId,
      cycles: 0,
      skippedOverlaps: 0,
      failures: 0,
    };
    statuses.set(serverId, status);
  } else if (descriptor?.name) {
    status.serverName = descriptor.name;
  }
  return status;
}

export async function runManagedServerRuntimeCycle(
  serverId: string,
  reason: RuntimeCycleReason = "manual",
) {
  const status = getStatus(serverId);
  const locked = await runWithServerRuntimeLock(serverId, async () => runInServerRuntimeContext(serverId, async () => {
    const startedAt = new Date().toISOString();
    const cycleStarted = Date.now();
    let downloadDurationMs = 0;
    let parserDurationMs = 0;
    let downloadOk = true;
    let parserOk = true;

    status.lastReason = reason;
    status.lastStartedAt = startedAt;
    status.lastError = undefined;
    recordMainCycleStarted();
    console.log(`🔁 LOOP PRINCIPAL [${serverId}] (${reason})`);

    // Loading the server-scoped state first initializes a brand-new namespace
    // without touching the primary and gives each runtime its own ADM strategy.
    const state = await getStateAsync();
    const settings = normalizeServiceSettings(state.serviceSettings);
    setAdmDownloadMode(settings.admDownloadMode, serverId);

    const downloadStarted = Date.now();
    try {
      await downloadADM(serverId);
    } catch (err) {
      downloadOk = false;
      status.lastError = err instanceof Error ? err.message : String(err);
      console.error(`❌ erro download [${serverId}]:`, err);
    } finally {
      downloadDurationMs = Date.now() - downloadStarted;
    }

    const parserStarted = Date.now();
    try {
      console.log(`🔥 PARSER AUTOMÁTICO [${serverId}]`);
      await getLeaderboard();
    } catch (err) {
      parserOk = false;
      status.lastError = err instanceof Error ? err.message : String(err);
      console.error(`❌ erro parser [${serverId}]:`, err);
    } finally {
      parserDurationMs = Date.now() - parserStarted;
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - cycleStarted;
      status.cycles += 1;
      if (!downloadOk || !parserOk) status.failures += 1;
      status.lastFinishedAt = finishedAt;
      status.lastDurationMs = durationMs;
      status.lastDownloadDurationMs = downloadDurationMs;
      status.lastParserDurationMs = parserDurationMs;
      status.lastDownloadOk = downloadOk;
      status.lastParserOk = parserOk;
      recordMainCycleCompleted({
        startedAt,
        finishedAt,
        durationMs,
        downloadDurationMs,
        parserDurationMs,
        downloadOk,
        parserOk,
      });
    }
  }));

  if (locked.skipped) {
    status.skippedOverlaps += 1;
    recordMainCycleSkippedOverlap();
    console.log(`⏭️ ciclo ignorado para ${serverId}: execução anterior ainda rodando`);
  }
  return { skipped: locked.skipped };
}

export async function runManagedServerRuntimeBatch(
  reason: RuntimeCycleReason = "scheduler",
  options: { includePrimary?: boolean } = {},
) {
  // One coordinator, one registry snapshot. Servers run sequentially so adding a
  // runtime does not create concurrent Nitrado bursts or an independent poller.
  // Startup may run the PZ first and then start secondary runtimes in the
  // background so a large first secondary download never delays the PZ Discord.
  const includePrimary = options.includePrimary !== false;
  const executable: ManagedServerDescriptor[] = listExecutableManagedServers()
    .filter((server: ManagedServerDescriptor) => includePrimary || server.id !== getPrimaryServerId())
    .sort((a: ManagedServerDescriptor, b: ManagedServerDescriptor) => {
    if (a.id === getPrimaryServerId()) return -1;
    if (b.id === getPrimaryServerId()) return 1;
    return a.id.localeCompare(b.id);
  });

  for (const server of executable) {
    try {
      await runManagedServerRuntimeCycle(server.id, reason);
    } catch (err) {
      const status = getStatus(server.id);
      status.failures += 1;
      status.lastError = err instanceof Error ? err.message : String(err);
      // A secondary failure must never prevent the coordinator from moving on
      // or affect the primary runtime on the next scheduler tick.
      console.error(`❌ erro fatal no ciclo [${server.id}]:`, err);
    }
  }
}

export function startManagedServerRuntimeScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    runManagedServerRuntimeBatch("scheduler").catch((err) => {
      console.error("❌ erro no scheduler central multi-server:", err);
    });
  }, RUNTIME_CYCLE_INTERVAL_MS);
  schedulerTimer.unref?.();
}

export function requestManagedServerRuntimeCycle(serverId: string, reason: RuntimeCycleReason = "activation") {
  if (requestedImmediateRuns.has(serverId)) return false;
  requestedImmediateRuns.add(serverId);
  setImmediate(() => {
    runManagedServerRuntimeCycle(serverId, reason)
      .catch((err) => console.error(`❌ erro no ciclo solicitado [${serverId}]:`, err))
      .finally(() => requestedImmediateRuns.delete(serverId));
  });
  return true;
}

export async function flushExecutableManagedServerStates() {
  // Flush every registry row that is still marked runtime-enabled, even if a
  // safety gate became unhealthy after its last successful cycle. Maintenance
  // context is scoped but does not authorize new ADM/Nitrado work.
  for (const server of listManagedServers().filter((candidate: ManagedServerDescriptor) => candidate.runtimeEnabled)) {
    try {
      await runInServerMaintenanceContext(server.id, () => flushServerRuntimePendingStateAsync());
    } catch (err) {
      console.error(`❌ erro no flush final [${server.id}]:`, err);
    }
  }
}

export function getManagedServerRuntimeCoordinatorDiagnostics() {
  const servers: ManagedServerDescriptor[] = listManagedServers();
  const executableServers: ManagedServerDescriptor[] = listExecutableManagedServers();
  const executableIds = new Set(executableServers.map((server: ManagedServerDescriptor) => server.id));
  return {
    scheduler: "centralized",
    intervalMs: RUNTIME_CYCLE_INTERVAL_MS,
    schedulerRunning: Boolean(schedulerTimer),
    activeRuntimeIds: executableServers.map((server: ManagedServerDescriptor) => server.id),
    activeRuntimes: executableServers.length,
    requestedImmediateRuns: [...requestedImmediateRuns],
    servers: servers.map((server: ManagedServerDescriptor) => {
      const status = statuses.get(server.id);
      return {
        ...(status || {
          cycles: 0,
          skippedOverlaps: 0,
          failures: 0,
        }),
        serverId: server.id,
        serverName: server.name,
        primary: server.primary,
        runtimeEnabled: server.runtimeEnabled,
        executable: executableIds.has(server.id),
      };
    }),
  };
}
