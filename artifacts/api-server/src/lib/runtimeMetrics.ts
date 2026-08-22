import { getActiveServerId } from "./serverRuntime";

export type MainCycleSample = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  downloadDurationMs: number;
  parserDurationMs: number;
  downloadOk: boolean;
  parserOk: boolean;
};

type RuntimeMetricBucket = {
  startedAt: string;
  cyclesStarted: number;
  cyclesCompleted: number;
  cyclesSkippedOverlap: number;
  cycleFailures: number;
  downloadFailures: number;
  parserFailures: number;
  totalCycleDurationMs: number;
  totalDownloadDurationMs: number;
  totalParserDurationMs: number;
  maxCycleDurationMs: number;
  lastCycleStartedAt?: string;
  lastCycleFinishedAt?: string;
  recentCycles: MainCycleSample[];
};

const metricsByServer = new Map<string, RuntimeMetricBucket>();

function getMetrics(serverId = getActiveServerId()) {
  let metrics = metricsByServer.get(serverId);
  if (!metrics) {
    metrics = {
      startedAt: new Date().toISOString(),
      cyclesStarted: 0,
      cyclesCompleted: 0,
      cyclesSkippedOverlap: 0,
      cycleFailures: 0,
      downloadFailures: 0,
      parserFailures: 0,
      totalCycleDurationMs: 0,
      totalDownloadDurationMs: 0,
      totalParserDurationMs: 0,
      maxCycleDurationMs: 0,
      recentCycles: [],
    };
    metricsByServer.set(serverId, metrics);
  }
  return metrics;
}

export function recordMainCycleStarted(serverId = getActiveServerId()) {
  const metrics = getMetrics(serverId);
  metrics.cyclesStarted += 1;
  metrics.lastCycleStartedAt = new Date().toISOString();
}

export function recordMainCycleSkippedOverlap(serverId = getActiveServerId()) {
  getMetrics(serverId).cyclesSkippedOverlap += 1;
}

export function recordMainCycleCompleted(sample: MainCycleSample, serverId = getActiveServerId()) {
  const metrics = getMetrics(serverId);
  metrics.cyclesCompleted += 1;
  metrics.lastCycleFinishedAt = sample.finishedAt;
  metrics.totalCycleDurationMs += sample.durationMs;
  metrics.totalDownloadDurationMs += sample.downloadDurationMs;
  metrics.totalParserDurationMs += sample.parserDurationMs;
  metrics.maxCycleDurationMs = Math.max(metrics.maxCycleDurationMs, sample.durationMs);
  if (!sample.downloadOk) metrics.downloadFailures += 1;
  if (!sample.parserOk) metrics.parserFailures += 1;
  if (!sample.downloadOk || !sample.parserOk) metrics.cycleFailures += 1;
  metrics.recentCycles.push(sample);
  if (metrics.recentCycles.length > 48) metrics.recentCycles.splice(0, metrics.recentCycles.length - 48);
}

export function getRuntimePerformanceMetrics(serverId = getActiveServerId()) {
  const metrics = getMetrics(serverId);
  const completed = Math.max(1, metrics.cyclesCompleted);
  return {
    serverId,
    ...metrics,
    averageCycleDurationMs: Math.round(metrics.totalCycleDurationMs / completed),
    averageDownloadDurationMs: Math.round(metrics.totalDownloadDurationMs / completed),
    averageParserDurationMs: Math.round(metrics.totalParserDurationMs / completed),
    recentCycles: [...metrics.recentCycles],
  };
}
