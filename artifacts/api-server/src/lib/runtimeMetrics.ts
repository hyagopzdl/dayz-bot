export type MainCycleSample = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  downloadDurationMs: number;
  parserDurationMs: number;
  downloadOk: boolean;
  parserOk: boolean;
};

const startedAt = new Date().toISOString();
const recentCycles: MainCycleSample[] = [];

const metrics = {
  startedAt,
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
  lastCycleStartedAt: undefined as string | undefined,
  lastCycleFinishedAt: undefined as string | undefined,
};

export function recordMainCycleStarted() {
  metrics.cyclesStarted += 1;
  metrics.lastCycleStartedAt = new Date().toISOString();
}

export function recordMainCycleSkippedOverlap() {
  metrics.cyclesSkippedOverlap += 1;
}

export function recordMainCycleCompleted(sample: MainCycleSample) {
  metrics.cyclesCompleted += 1;
  metrics.lastCycleFinishedAt = sample.finishedAt;
  metrics.totalCycleDurationMs += sample.durationMs;
  metrics.totalDownloadDurationMs += sample.downloadDurationMs;
  metrics.totalParserDurationMs += sample.parserDurationMs;
  metrics.maxCycleDurationMs = Math.max(metrics.maxCycleDurationMs, sample.durationMs);
  if (!sample.downloadOk) metrics.downloadFailures += 1;
  if (!sample.parserOk) metrics.parserFailures += 1;
  if (!sample.downloadOk || !sample.parserOk) metrics.cycleFailures += 1;
  recentCycles.push(sample);
  if (recentCycles.length > 48) recentCycles.splice(0, recentCycles.length - 48);
}

export function getRuntimePerformanceMetrics() {
  const completed = Math.max(1, metrics.cyclesCompleted);
  return {
    ...metrics,
    averageCycleDurationMs: Math.round(metrics.totalCycleDurationMs / completed),
    averageDownloadDurationMs: Math.round(metrics.totalDownloadDurationMs / completed),
    averageParserDurationMs: Math.round(metrics.totalParserDurationMs / completed),
    recentCycles: [...recentCycles],
  };
}
