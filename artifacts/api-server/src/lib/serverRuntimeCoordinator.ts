import { downloadADM, setAdmDownloadMode } from "./nitradoDownloader";
import { getLeaderboard } from "./parser";
import { flushServerRuntimePendingStateAsync, getStateAsync, saveStateAsync, setManagedServerRuntimeEnabled } from "./state";
import { isShopServiceEnabled, normalizeServiceSettings } from "./serviceSettings";
import { getNextConfiguredRestart, syncShopWithNitradoServer } from "./shop";
import { getPlaytimeRewardConfig, processPlaytimeRewards } from "./discord/modules/economy/rewards";
import { refreshDiscordFeedsForManagedServer } from "./discordBot";
import {
  getManagedServerById,
  hasManagedServerRuntimeActivation,
  hasMatchingActivationPreflight,
  hasMatchingManagedServerNitradoValidation,
  listExecutableManagedServers,
  listManagedServers,
  type ManagedServerDescriptor,
} from "./serverRegistry";
import { recordMainCycleCompleted, recordMainCycleSkippedOverlap, recordMainCycleStarted } from "./runtimeMetrics";
import { runManagedServerActivationPreflight } from "./serverPreflight";
import { hydrateKnownServerPlayers, scheduleTenantCommerceMirror } from "./tenantCommerceStore";
import { runInServerMaintenanceContext, runInServerRuntimeContext, runWithServerRuntimeLock } from "./serverRuntime";

const RUNTIME_CYCLE_INTERVAL_MS = 5 * 60 * 1000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;
const RUNTIME_STALE_AFTER_MS = 12 * 60 * 1000;

type RuntimeCycleReason = "scheduler" | "activation" | "manual";

type ServerRuntimeCycleStatus = {
  serverId: string;
  serverName: string;
  cycles: number;
  skippedOverlaps: number;
  failures: number;
  consecutiveFailures: number;
  circuitState: "closed" | "open" | "half-open";
  circuitSkips: number;
  circuitOpenedAt?: string;
  circuitRetryAt?: string;
  lastHealthyAt?: string;
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
const rewardLastTick = new Map<string, number>();
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
      consecutiveFailures: 0,
      circuitState: "closed",
      circuitSkips: 0,
    };
    statuses.set(serverId, status);
  } else if (descriptor?.name) {
    status.serverName = descriptor.name;
  }
  return status;
}

function closeCircuit(status: ServerRuntimeCycleStatus) {
  status.consecutiveFailures = 0;
  status.circuitState = "closed";
  status.circuitOpenedAt = undefined;
  status.circuitRetryAt = undefined;
  status.lastHealthyAt = new Date().toISOString();
}

function recordCycleFailure(serverId: string, error?: unknown) {
  const status = getStatus(serverId);
  status.consecutiveFailures += 1;
  if (error) status.lastError = error instanceof Error ? error.message : String(error);
  if (status.consecutiveFailures < CIRCUIT_FAILURE_THRESHOLD) return;

  const now = Date.now();
  status.circuitState = "open";
  status.circuitOpenedAt = new Date(now).toISOString();
  status.circuitRetryAt = new Date(now + CIRCUIT_COOLDOWN_MS).toISOString();
}

function shouldSkipForCircuit(serverId: string, forceCircuitProbe = false) {
  const status = getStatus(serverId);
  if (status.circuitState !== "open") return false;
  const retryAt = status.circuitRetryAt ? Date.parse(status.circuitRetryAt) : 0;
  if (forceCircuitProbe || !retryAt || Date.now() >= retryAt) {
    status.circuitState = "half-open";
    return false;
  }
  status.circuitSkips += 1;
  return true;
}

export function resetManagedServerRuntimeCircuit(serverId: string) {
  const status = getStatus(serverId);
  status.consecutiveFailures = 0;
  status.circuitState = "closed";
  status.circuitOpenedAt = undefined;
  status.circuitRetryAt = undefined;
  status.lastError = undefined;
}

export async function runManagedServerRuntimeCycle(
  serverId: string,
  reason: RuntimeCycleReason = "manual",
  options: { forceCircuitProbe?: boolean } = {},
) {
  const status = getStatus(serverId);
  if (shouldSkipForCircuit(serverId, options.forceCircuitProbe === true)) {
    console.warn(`🛡️ circuit breaker aberto [${serverId}] até ${status.circuitRetryAt || "o próximo probe"}`);
    return { skipped: true, circuitOpen: true };
  }

  let locked: { skipped: boolean; value?: unknown };
  try {
    locked = await runWithServerRuntimeLock(serverId, async () => runInServerRuntimeContext(serverId, async () => {
      const startedAt = new Date().toISOString();
      const cycleStarted = Date.now();
      let downloadDurationMs = 0;
      let parserDurationMs = 0;
      let downloadOk = true;
      let parserOk = true;

      status.lastReason = reason;
      status.lastStartedAt = startedAt;
      status.lastError = undefined;
      recordMainCycleStarted(serverId);
      console.log(`🔁 LOOP PRINCIPAL [${serverId}] (${reason})`);

      const state = await getStateAsync();
      await hydrateKnownServerPlayers(serverId).catch((err) => console.error(`❌ known players hydrate failed [${serverId}]`, err));
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

      // Shop reset/deploy housekeeping is independent from the parser. A parser,
      // leaderboard or feed failure must not leave a deployed batch stuck in
      // WAITING_RESET indefinitely.
      if (isShopServiceEnabled(state)) {
        try {
          const shopResult = await syncShopWithNitradoServer(state);
          if (shopResult?.stateChanged) {
            await saveStateAsync(state, `runtime:shop-housekeeping:${serverId}`);
          }
        } catch (shopError) {
          console.error(`❌ erro no housekeeping da shop [${serverId}]:`, shopError);
        }
      }

      const parserStarted = Date.now();
      try {
        console.log(`🔥 PARSER AUTOMÁTICO [${serverId}]`);
        await getLeaderboard();
        scheduleTenantCommerceMirror(state, serverId);

        try {
          await refreshDiscordFeedsForManagedServer(serverId);
        } catch (discordFeedError) {
          console.error(`❌ erro atualizando feeds Discord [${serverId}]:`, discordFeedError);
        }

        const rewardConfig = getPlaytimeRewardConfig();
        if (rewardConfig.enabled) {
          const now = Date.now();
          const intervalMs = Math.max(1, rewardConfig.tickMinutes) * 60_000;
          const lastTick = rewardLastTick.get(serverId) || 0;
          if (now - lastTick >= intervalMs) {
            rewardLastTick.set(serverId, now);
            try {
              const rewards = processPlaytimeRewards(state, rewardConfig);
              if (rewards.changed) await saveStateAsync(state, `runtime:economy-rewards:${serverId}`);
            } catch (rewardError) {
              console.error(`❌ erro nos rewards de economia [${serverId}]:`, rewardError);
            }
          }
        }
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
        recordMainCycleCompleted({ startedAt, finishedAt, durationMs, downloadDurationMs, parserDurationMs, downloadOk, parserOk }, serverId);
        if (downloadOk && parserOk) closeCircuit(status);
        else recordCycleFailure(serverId, status.lastError);
      }
    }));
  } catch (err) {
    status.cycles += 1;
    status.failures += 1;
    status.lastReason = reason;
    status.lastFinishedAt = new Date().toISOString();
    recordCycleFailure(serverId, err);
    throw err;
  }

  if (locked.skipped) {
    status.skippedOverlaps += 1;
    recordMainCycleSkippedOverlap(serverId);
    console.log(`⏭️ ciclo ignorado para ${serverId}: execução anterior ainda rodando`);
  }
  return { skipped: locked.skipped };
}

export async function reconcileManagedServerRuntimeActivation() {
  const candidates = listManagedServers().filter((server: ManagedServerDescriptor) => {
    if (!server.enabled || server.runtime.operations?.paused === true) return false;
    if (server.runtimeEnabled) return false;
    if (!hasMatchingManagedServerNitradoValidation(server)) return false;
    if (server.runtime.activation?.lastDisabledAt) return false;
    return true;
  });

  for (const candidate of candidates) {
    try {
      let server = getManagedServerById(candidate.id) || candidate;
      if (!hasMatchingActivationPreflight(server)) {
        const preflight = await runManagedServerActivationPreflight(server.id);
        if (!preflight.passed) {
          console.warn(`⚠️ runtime nao ativado [${server.id}]: preflight reprovado`, {
            failures: preflight.failureCount,
            warnings: preflight.warningCount,
          });
          continue;
        }
        server = getManagedServerById(server.id) || server;
      }

      if (!hasManagedServerRuntimeActivation(server) || !server.runtimeEnabled) {
        await setManagedServerRuntimeEnabled(server.id, true);
        console.log(`✅ runtime ativado automaticamente [${server.id}]`);
      }
    } catch (error) {
      console.error(`❌ falha reconciliando runtime [${candidate.id}]:`, error);
    }
  }
}

export async function runManagedServerRuntimeBatch(reason: RuntimeCycleReason = "scheduler") {
  // A single sequential queue prevents a growing number of linked servers from
  // producing concurrent Nitrado/FTP/DB bursts. Every server follows the same path.
  const executable: ManagedServerDescriptor[] = listExecutableManagedServers()
    .sort((a: ManagedServerDescriptor, b: ManagedServerDescriptor) => a.id.localeCompare(b.id));

  for (const server of executable) {
    try {
      await runManagedServerRuntimeCycle(server.id, reason);
    } catch (err) {
      const status = getStatus(server.id);
      status.lastError = err instanceof Error ? err.message : String(err);
      console.error(`❌ erro fatal no ciclo [${server.id}]:`, err);
    }
  }
}



const shopAutomationTimers = new Map<string, NodeJS.Timeout[]>();

function clearShopAutomationTimers(serverId: string) {
  for (const timer of shopAutomationTimers.get(serverId) || []) clearTimeout(timer);
  shopAutomationTimers.delete(serverId);
}

export function scheduleShopAutomationForServer(server: ManagedServerDescriptor) {
  const serverId = server.id;
  clearShopAutomationTimers(serverId);

  const restart = runInServerRuntimeContext(serverId, async () => getNextConfiguredRestart(new Date(), serverId));
  restart.then((nextRestart) => {
    if (!nextRestart) return;
    const deployAt = nextRestart.at.getTime() - 5 * 60_000;
    const resetAt = nextRestart.at.getTime();
    const now = Date.now();

    const schedule = (at: number, label: string) => {
      const delay = Math.max(0, at - now);
      const timer = setTimeout(() => {
        runManagedServerRuntimeCycle(serverId, "scheduler")
          .catch((error) => console.error(`❌ erro no Shop agendado [${serverId}] ${label}:`, error))
          .finally(() => {
            if (label === "reset") scheduleShopAutomationForServer(server);
          });
      }, delay);
      timer.unref?.();
      const timers = shopAutomationTimers.get(serverId) || [];
      timers.push(timer);
      shopAutomationTimers.set(serverId, timers);
    };

    if (deployAt > now) schedule(deployAt, "deploy");
    else if (now < resetAt) schedule(now, "deploy");
    if (resetAt > now) schedule(resetAt, "reset");
  }).catch((error) => {
    console.error(`❌ erro calculando próximo reset da Shop [${serverId}]:`, error);
  });
}

function scheduleShopAutomationForAllServers() {
  for (const server of listExecutableManagedServers()) {
    scheduleShopAutomationForServer(server);
  }
}

export function startManagedServerRuntimeScheduler() {
  if (!schedulerTimer) {
    schedulerTimer = setInterval(() => {
      runManagedServerRuntimeBatch("scheduler").catch((err) => {
        console.error("❌ erro no scheduler central multi-server:", err);
      });
    }, RUNTIME_CYCLE_INTERVAL_MS);
    schedulerTimer.unref?.();
  }

  scheduleShopAutomationForAllServers();
}
export function requestManagedServerRuntimeCycle(
  serverId: string,
  reason: RuntimeCycleReason = "activation",
  options: { forceCircuitProbe?: boolean } = {},
) {
  if (requestedImmediateRuns.has(serverId)) return false;
  requestedImmediateRuns.add(serverId);
  setImmediate(() => {
    runManagedServerRuntimeCycle(serverId, reason, options)
      .catch((err) => console.error(`❌ erro no ciclo solicitado [${serverId}]:`, err))
      .finally(() => requestedImmediateRuns.delete(serverId));
  });
  return true;
}

export async function flushExecutableManagedServerStates() {
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
  const executableIds = new Set(executableServers.map((server) => server.id));
  return {
    scheduler: "centralized",
    intervalMs: RUNTIME_CYCLE_INTERVAL_MS,
    shopServerWatchIntervalMs: SHOP_SERVER_WATCH_INTERVAL_MS,
    healthPolicy: {
      staleAfterMs: RUNTIME_STALE_AFTER_MS,
      circuitFailureThreshold: CIRCUIT_FAILURE_THRESHOLD,
      circuitCooldownMs: CIRCUIT_COOLDOWN_MS,
      backgroundHealthPollingAdded: false,
    },
    schedulerRunning: Boolean(schedulerTimer),
    activeRuntimeIds: executableServers.map((server) => server.id),
    activeRuntimes: executableServers.length,
    requestedImmediateRuns: [...requestedImmediateRuns],
    servers: servers.map((server) => {
      const status = statuses.get(server.id);
      return {
        ...(status || {
          cycles: 0,
          skippedOverlaps: 0,
          failures: 0,
          consecutiveFailures: 0,
          circuitState: "closed",
          circuitSkips: 0,
        }),
        serverId: server.id,
        serverName: server.name,
        runtimeEnabled: server.runtimeEnabled,
        paused: server.runtime.operations?.paused === true,
        executable: executableIds.has(server.id),
        health: (() => {
          if (!server.runtimeEnabled) return "stopped";
          if (server.runtime.operations?.paused === true) return "paused";
          if (status?.circuitState === "open") return "circuit-open";
          if (!executableIds.has(server.id)) return "blocked";
          if (!status?.lastFinishedAt) return "starting";
          if (status.consecutiveFailures > 0) return "degraded";
          const lastFinishedAt = Date.parse(status.lastFinishedAt);
          if (Number.isFinite(lastFinishedAt) && Date.now() - lastFinishedAt > RUNTIME_STALE_AFTER_MS) return "stale";
          return "healthy";
        })(),
      };
    }),
  };
}
