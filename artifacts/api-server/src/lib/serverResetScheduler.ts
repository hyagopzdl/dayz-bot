import type { AppState } from "./state";
import { getServerResetScheduleConfig, getManagedServerById } from "./serverRegistry";
import { stopAndStartNitradoServer } from "./nitradoServerControl";

export type ScheduledServerReset = {
  at: Date;
  label: string;
};

const SERVER_RESET_RECOVERY_WINDOW_MS = 10 * 60_000;
const resetLocks = new Set<string>();
const resetTimers = new Map<string, NodeJS.Timeout>();

function getTimeZoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);

  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getTimeZoneParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0) - date.getTime();
}

function localDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  let candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidate), timeZone);
    const corrected = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset;
    if (corrected === candidate) break;
    candidate = corrected;
  }
  return new Date(candidate);
}

function parseConfiguredResetTimes(value: string) {
  return String(value || "")
    .split(",")
    .map((raw) => raw.trim())
    .map((raw) => {
      const match = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return { hour, minute, label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
    })
    .filter((entry): entry is { hour: number; minute: number; label: string } => Boolean(entry));
}

function getConfiguredResetTimes(serverId: string) {
  const schedule = getServerResetScheduleConfig(serverId);
  return {
    timeZone: schedule.timezone,
    times: parseConfiguredResetTimes(schedule.times),
  };
}

function getCandidate(now: Date, serverId: string, dayOffset: number): ScheduledServerReset[] {
  const { timeZone, times } = getConfiguredResetTimes(serverId);
  if (!times.length) return [];
  const local = getTimeZoneParts(now, timeZone);
  const baseUtc = Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0, 0);
  const day = new Date(baseUtc + dayOffset * 86_400_000);
  const dayParts = getTimeZoneParts(day, "UTC");
  return times.map((time) => ({
    at: localDateTimeToUtc(dayParts.year, dayParts.month, dayParts.day, time.hour, time.minute, timeZone),
    label: time.label,
  }));
}

export function getNextServerReset(now = new Date(), serverId: string): ScheduledServerReset | null {
  const candidates = [0, 1, 2]
    .flatMap((offset) => getCandidate(now, serverId, offset))
    .filter((candidate) => candidate.at.getTime() > now.getTime() - 30_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return candidates[0] || null;
}

export function getMostRecentServerReset(now = new Date(), serverId: string): ScheduledServerReset | null {
  const candidates = [0, -1, -2]
    .flatMap((offset) => getCandidate(now, serverId, offset))
    .filter((candidate) => candidate.at.getTime() <= now.getTime())
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return candidates[0] || null;
}

export function getServerResetSchedule(serverId: string) {
  const { timeZone, times } = getConfiguredResetTimes(serverId);
  return {
    serverId,
    timeZone,
    times: times.map((time) => time.label),
  };
}

export async function runConfiguredServerResetIfDue(state: AppState, serverId: string, now = new Date()) {
  const server = getManagedServerById(serverId);
  if (!server) return { due: false, executed: false, stateChanged: false };
  const recent = getMostRecentServerReset(now, serverId);
  if (!recent) return { due: false, executed: false, stateChanged: false };

  const ageMs = now.getTime() - recent.at.getTime();
  if (ageMs < 0 || ageMs > SERVER_RESET_RECOVERY_WINDOW_MS) {
    return { due: false, executed: false, stateChanged: false };
  }

  const resetState = state.serverReset || null;
  // An attempted reset is not a completed reset. If STOP/START fails, the
  // recovery window must keep retrying on the next runtime cycle instead of
  // treating the failed attempt as proof that this reset was handled.
  if (resetState?.lastCompletedAt === recent.at.toISOString()) {
    return { due: true, executed: false, stateChanged: false, scheduledReset: recent };
  }

  if (resetLocks.has(serverId)) {
    return { due: true, executed: false, stateChanged: false, scheduledReset: recent };
  }

  resetLocks.add(serverId);
  state.serverReset = {
    ...(state.serverReset || {}),
    lastAttemptedAt: recent.at.toISOString(),
    lastAttemptedLabel: recent.label,
    lastAttemptedAtRuntime: now.toISOString(),
    lastAction: "server_reset_started",
    lastError: undefined,
  };

  try {
    console.log(`♻️ SERVER RESET START [${serverId}] target=${recent.at.toISOString()} label=${recent.label}`);
    const result = await stopAndStartNitradoServer(serverId);
    const completedAt = new Date().toISOString();
    state.serverReset = {
      ...(state.serverReset || {}),
      lastCompletedAt: recent.at.toISOString(),
      lastCompletedAtRuntime: completedAt,
      lastAction: "server_reset_completed",
      lastStatus: String(result.startedStatus || "unknown").trim().toLowerCase(),
      lastError: undefined,
    };

    // Shop consumes the server reset lifecycle but does not own STOP/START.
    const monitor = state.shopResetMonitor;
    if (
      monitor?.autoRestartManaged &&
      monitor.targetRestartAt &&
      monitor.targetRestartAt === recent.at.toISOString()
    ) {
      monitor.sawOfflineAt = monitor.sawOfflineAt || state.serverReset.lastAttemptedAtRuntime;
      monitor.sawOnlineAt = completedAt;
      monitor.restartPhase = "completed";
      monitor.restartCompletedAt = completedAt;
      monitor.lastStatus = state.serverReset.lastStatus;
      monitor.lastCheckedAt = completedAt;
      monitor.restartError = undefined;
      monitor.confirmationReason = "server_reset_scheduler";
    }

    console.log(`✅ SERVER RESET COMPLETE [${serverId}] status=${state.serverReset.lastStatus}`);
    return { due: true, executed: true, stateChanged: true, scheduledReset: recent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.serverReset = {
      ...(state.serverReset || {}),
      lastAction: "server_reset_failed",
      lastError: message,
    };

    const monitor = state.shopResetMonitor;
    if (
      monitor?.autoRestartManaged &&
      monitor.targetRestartAt &&
      monitor.targetRestartAt === recent.at.toISOString()
    ) {
      monitor.restartPhase = "failed";
      monitor.restartError = message;
      monitor.lastCheckedAt = new Date().toISOString();
    }

    console.error(`❌ SERVER RESET FAILED [${serverId}]`, error);
    return { due: true, executed: false, stateChanged: true, scheduledReset: recent };
  } finally {
    resetLocks.delete(serverId);
  }
}

export function clearServerResetTimer(serverId: string) {
  const timer = resetTimers.get(serverId);
  if (timer) clearTimeout(timer);
  resetTimers.delete(serverId);
}

export function scheduleServerResetForServer(serverId: string, onResetWindow?: () => void) {
  clearServerResetTimer(serverId);
  const next = getNextServerReset(new Date(), serverId);
  if (!next) {
    console.log(`🗓️ SERVER RESET SCHEDULER [${serverId}] nenhum horário configurado`);
    return null;
  }

  const delay = Math.max(0, next.at.getTime() - Date.now());
  console.log(`🗓️ SERVER RESET SCHEDULER [${serverId}] próximo reset=${next.at.toISOString()} label=${next.label} delayMs=${delay}`);

  const timer = setTimeout(() => {
    console.log(`⏰ SERVER RESET TIMER FIRED [${serverId}] target=${next.at.toISOString()} label=${next.label}`);
    onResetWindow?.();
  }, delay);
  timer.unref?.();
  resetTimers.set(serverId, timer);
  return next;
}
