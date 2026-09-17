import crypto from "crypto";
import fs from "fs";
import path from "path";
import { byteLengthOfBody, recordNetworkTransfer } from "./networkMetrics";
import { getManagedServerById } from "./serverRegistry";
import { getActiveServerId, getServerRuntimeContext } from "./serverRuntime";
import { getServerNitradoConfig } from "./serverNitrado";

export const LOG_DIR = path.resolve(process.cwd(), "adm_logs");
export const MANIFEST_FILE = path.resolve(process.cwd(), "adm_manifest.json");

const MAX_CANDIDATES = 6;
const ACTIVE_FILE_INDEX = 0;
const PREVIOUS_FILE_INDEX = 1;
const PREVIOUS_FILE_STABILITY_MS = 30 * 60 * 1000;
const AUDIT_INTERVAL_CYCLES = 12;

export type AdmDownloadMode = "legacy" | "shadow" | "optimized";

type AdmServerStrategyState = {
  mode: AdmDownloadMode;
  cycles: number;
  optimizedAuditCursor: number;
  previousFileTracker: { file?: string; stableSince?: number };
};

const admServerStrategies = new Map<string, AdmServerStrategyState>();

type AdmPerServerMetric = {
  startedAt: string;
  cycles: number;
  candidatesSeen: number;
  downloads: number;
  bytesDownloaded: number;
  downloadFailures: number;
  optimizedSkips: number;
  optimizedSavedBytes: number;
  lastCycleAt?: string;
  lastCycleDurationMs: number;
};

const admPerServerMetrics = new Map<string, AdmPerServerMetric>();

function getAdmPerServerMetric(serverId: string): AdmPerServerMetric {
  let metric = admPerServerMetrics.get(serverId);
  if (!metric) {
    metric = {
      startedAt: new Date().toISOString(),
      cycles: 0,
      candidatesSeen: 0,
      downloads: 0,
      bytesDownloaded: 0,
      downloadFailures: 0,
      optimizedSkips: 0,
      optimizedSavedBytes: 0,
      lastCycleDurationMs: 0,
    };
    admPerServerMetrics.set(serverId, metric);
  }
  return metric;
}

function getAdmServerStrategy(serverId = getActiveServerId()): AdmServerStrategyState {
  let state = admServerStrategies.get(serverId);
  if (!state) {
    state = { mode: "shadow", cycles: 0, optimizedAuditCursor: 0, previousFileTracker: {} };
    admServerStrategies.set(serverId, state);
  }
  return state;
}

export function setAdmDownloadMode(mode: AdmDownloadMode, serverId = getActiveServerId()) {
  getAdmServerStrategy(serverId).mode = mode;
  if (serverId === getActiveServerId()) admDownloadMetrics.strategy.mode = mode;
}

export function getAdmDownloadMode(serverId = getActiveServerId()): AdmDownloadMode {
  return getAdmServerStrategy(serverId).mode;
}

type AdmFileMetric = {
  downloads: number;
  bytes: number;
  failures: number;
  lastDownloadedAt?: string;
  lastBytes?: number;
  shadowWouldDownload: number;
  shadowWouldSkip: number;
  shadowSafeSkips: number;
  shadowDangerousSkips: number;
  shadowConservativeDownloads: number;
  shadowEstimatedBytes: number;
  shadowEstimatedSavedBytes: number;
  optimizedSkips: number;
  optimizedSavedBytes: number;
  optimizedAudits: number;
};

type AdmShadowDecision = {
  at: string;
  file: string;
  decision: "download" | "skip";
  reason: string;
  remoteSize: number | null;
  localSize: number | null;
  actualBytes: number;
  contentChanged: boolean | null;
  mismatch: boolean;
};

const admDownloadMetrics = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  listRequests: 0,
  listFailures: 0,
  candidatesSeen: 0,
  downloadUrlRequests: 0,
  fileDownloads: 0,
  downloadFailures: 0,
  bytesDownloaded: 0,
  lastCycleAt: undefined as string | undefined,
  lastCycleDurationMs: 0,
  maxCycleDurationMs: 0,
  lastCandidateCount: 0,
  lastDownloadedCount: 0,
  lastDownloadedBytes: 0,
  files: {} as Record<string, AdmFileMetric>,
  strategy: {
    mode: "shadow" as AdmDownloadMode,
    optimizedSkips: 0,
    optimizedDownloads: 0,
    optimizedSavedBytes: 0,
    auditDownloads: 0,
    auditMismatches: 0,
    automaticFallbacks: 0,
    previousGraceDownloads: 0,
    previousStableSkips: 0,
    lastFallbackAt: undefined as string | undefined,
    lastFallbackReason: undefined as string | undefined,
  },
  shadow: {
    mode: "legacy-with-shadow" as const,
    decisions: 0,
    wouldDownload: 0,
    wouldSkip: 0,
    safeSkips: 0,
    dangerousSkips: 0,
    conservativeDownloads: 0,
    metadataUnavailable: 0,
    localMissing: 0,
    sizeMismatch: 0,
    sameSize: 0,
    estimatedOptimizedBytes: 0,
    estimatedSavedBytes: 0,
    recentDecisions: [] as AdmShadowDecision[],
  },
};

function getAdmFileMetric(filePath: string): AdmFileMetric {
  const key = safeLocalName(filePath);
  return admDownloadMetrics.files[key] ||= {
    downloads: 0,
    bytes: 0,
    failures: 0,
    shadowWouldDownload: 0,
    shadowWouldSkip: 0,
    shadowSafeSkips: 0,
    shadowDangerousSkips: 0,
    shadowConservativeDownloads: 0,
    shadowEstimatedBytes: 0,
    shadowEstimatedSavedBytes: 0,
    optimizedSkips: 0,
    optimizedSavedBytes: 0,
    optimizedAudits: 0,
  };
}

export function getAdmDownloadMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(admDownloadMetrics.startedAt).getTime()) / 3_600_000);
  const bytesPerHour = admDownloadMetrics.bytesDownloaded / uptimeHours;
  return {
    ...admDownloadMetrics,
    averageBytesPerCycle: admDownloadMetrics.cycles > 0 ? Math.round(admDownloadMetrics.bytesDownloaded / admDownloadMetrics.cycles) : 0,
    projected30DayBytes: Math.round(bytesPerHour * 24 * 30),
    shadow: {
      ...admDownloadMetrics.shadow,
      estimatedReductionPercent: admDownloadMetrics.bytesDownloaded > 0
        ? Number(((admDownloadMetrics.shadow.estimatedSavedBytes / admDownloadMetrics.bytesDownloaded) * 100).toFixed(2))
        : 0,
      recentDecisions: [...admDownloadMetrics.shadow.recentDecisions],
    },
    servers: [...admPerServerMetrics.entries()].map(([serverId, metric]) => {
      const serverUptimeHours = Math.max(1 / 60, (Date.now() - new Date(metric.startedAt).getTime()) / 3_600_000);
      return {
        serverId,
        ...metric,
        averageBytesPerCycle: metric.cycles ? Math.round(metric.bytesDownloaded / metric.cycles) : 0,
        projected30DayBytes: Math.round((metric.bytesDownloaded / serverUptimeHours) * 24 * 30),
      };
    }),
    files: Object.entries(admDownloadMetrics.files)
      .map(([file, value]) => ({ file, ...value }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 20),
  };
}

export type NitradoEntry = {
  path: string;
  size?: number | string;
  type?: string;
  modified_at?: string;
  modified?: string;
  mtime?: string | number;
};

type Manifest = {
  files: string[];
  updatedAt: string;
};

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function safeLocalName(remotePath: string) {
  return path.basename(remotePath).replace(/[^\w.-]/g, "_");
}

function normalizeRemoteSize(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function addRecentShadowDecision(decision: AdmShadowDecision) {
  admDownloadMetrics.shadow.recentDecisions.push(decision);
  if (admDownloadMetrics.shadow.recentDecisions.length > 120) {
    admDownloadMetrics.shadow.recentDecisions.splice(0, admDownloadMetrics.shadow.recentDecisions.length - 120);
  }
}

function createShadowDecision(file: NitradoEntry, localFile: string) {
  const remoteSize = normalizeRemoteSize(file.size);
  const localExists = fs.existsSync(localFile);
  const localSize = localExists ? fs.statSync(localFile).size : null;

  if (!localExists) return { decision: "download" as const, reason: "local-missing", remoteSize, localSize };
  if (remoteSize === null) return { decision: "download" as const, reason: "remote-size-unavailable", remoteSize, localSize };
  if (localSize !== remoteSize) return { decision: "download" as const, reason: "size-changed", remoteSize, localSize };
  return { decision: "skip" as const, reason: "same-size", remoteSize, localSize };
}

function extractDateFromAdmPath(filePath: string) {
  const match = filePath.match(/_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
  if (!match) return 0;
  return new Date(`${match[1]}T${match[2].replace(/-/g, ":")}`).getTime();
}

async function trackedNitradoFetch(url: string, init: RequestInit = {}) {
  const outboundBytes = byteLengthOfBody(init.body);
  const started = Date.now();
  try {
    const res = await globalThis.fetch(url, init);
    recordNetworkTransfer({
      service: "nitrado",
      operation: `${String(init.method || "GET").toUpperCase()} ${new URL(url).pathname}`,
      direction: "outbound",
      bytes: outboundBytes,
      ok: res.ok,
    });
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > 0) {
      recordNetworkTransfer({
        service: "nitrado",
        operation: `${String(init.method || "GET").toUpperCase()} ${new URL(url).pathname}`,
        direction: "inbound",
        bytes: contentLength,
        ok: res.ok,
      });
    }
    return res;
  } catch (error) {
    recordNetworkTransfer({
      service: "nitrado",
      operation: `${String(init.method || "GET").toUpperCase()} ${new URL(url).pathname}`,
      direction: "outbound",
      bytes: outboundBytes,
      ok: false,
    });
    throw error;
  } finally {
    void started;
  }
}

function getNitradoToken(serverId = getActiveServerId()) {
  return getServerNitradoConfig(serverId).apiToken;
}

async function fetchJson(url: string, serverId = getActiveServerId()): Promise<any> {
  const token = getNitradoToken(serverId);
  const res = await trackedNitradoFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as any;
}

export type NitradoGameserverStatus = { status: string | null; raw: any };

function firstString(...values: any[]) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export async function getNitradoGameserverStatus(serverId = getActiveServerId()): Promise<NitradoGameserverStatus> {
  getNitradoToken(serverId);
  const serviceId = getNitradoServiceId(serverId);
  const candidates = [`https://api.nitrado.net/services/${serviceId}/gameservers`, `https://api.nitrado.net/services/${serviceId}`];
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const json = await fetchJson(url, serverId);
      const data = json?.data || json;
      const gameserver = data?.gameserver || data?.gameservers?.[0] || data;
      const service = data?.service || data?.services?.[0] || data;
      const status = firstString(gameserver?.status, gameserver?.status_text, gameserver?.query?.server_status, gameserver?.query?.status, service?.status, service?.status_text, data?.status);
      console.log(`🧭 Nitrado status: ${status || "unknown"}`);
      return { status, raw: json };
    } catch (err: any) {
      errors.push(`${url}: ${err?.message || String(err)}`);
    }
  }
  throw new Error(`Unable to read Nitrado server status. ${errors.join(" | ")}`);
}

async function getDownloadUrl(filePath: string, serverId = getActiveServerId()): Promise<string | null> {
  admDownloadMetrics.downloadUrlRequests += 1;
  const serviceId = getNitradoServiceId(serverId);
  const json = await fetchJson(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/download?file=${encodeURIComponent(filePath)}`, serverId);
  return json?.data?.token?.url || null;
}

async function downloadText(filePath: string, serverId = getActiveServerId()): Promise<string | null> {
  const url = await getDownloadUrl(filePath, serverId);
  if (!url) return null;
  const res = await trackedNitradoFetch(`${url}&t=${Date.now()}`);
  if (!res.ok) throw new Error(`ADM download HTTP ${res.status}: ${await res.text()}`);
  return res.text();
}
export async function downloadNitradoTextFile(
  filePath: string,
  serverId = getActiveServerId(),
): Promise<string> {
  const normalized = normalizeNitradoFileServerPath(filePath);
  const { path: directory, file } = splitRemoteFilePath(normalized);
  const noFtpRoot = getNoFtpRootFromAdmBaseDir(serverId);
  const ftpRoot = getFtpRootFromAdmBaseDir(serverId);
  const candidates: string[] = [normalized];

  for (const variant of withDayzMissionFolderVariants(directory)) {
    candidates.push(`${variant}/${file}`);
    if (noFtpRoot) candidates.push(`${noFtpRoot}/${variant}/${file}`);
    if (ftpRoot) candidates.push(`${ftpRoot}/${variant}/${file}`);
  }

  const errors: string[] = [];
  for (const candidate of uniqueStrings(candidates)) {
    try {
      const content = await downloadText(candidate, serverId);
      if (content !== null) return content;
      errors.push(`${candidate}: no download token`);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Nitrado text download failed for ${filePath}. Attempts: ${errors.join(" | ")}`);
}

function saveManifest(files: string[], manifestFile = MANIFEST_FILE) {
  const manifest: Manifest = { files, updatedAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
}

function updatePreviousFileStability(admFiles: NitradoEntry[], strategy: AdmServerStrategyState) {
  const previous = admFiles[PREVIOUS_FILE_INDEX]?.path;
  if (!previous) {
    strategy.previousFileTracker = {};
    return;
  }
  if (strategy.previousFileTracker.file !== previous) {
    strategy.previousFileTracker = { file: previous, stableSince: Date.now() };
  }
}

function triggerAutomaticFallback(reason: string, serverId: string) {
  const strategy = getAdmServerStrategy(serverId);
  if (strategy.mode !== "optimized") return;
  strategy.mode = "legacy";
  admDownloadMetrics.strategy.automaticFallbacks += 1;
  admDownloadMetrics.strategy.lastFallbackAt = new Date().toISOString();
  admDownloadMetrics.strategy.lastFallbackReason = reason;
  console.warn(`⚠️ ADM optimized mode fallback to legacy for ${serverId}: ${reason}`);
}

function optimizedDecision(file: NitradoEntry, localFile: string, index: number, strategy: AdmServerStrategyState) {
  const base = createShadowDecision(file, localFile);
  if (base.decision === "download") return base;
  if (index === ACTIVE_FILE_INDEX) return { ...base, decision: "download" as const, reason: "conservative-active-file" };
  if (index === PREVIOUS_FILE_INDEX) {
    const stableSince = strategy.previousFileTracker.stableSince || 0;
    if (Date.now() - stableSince < PREVIOUS_FILE_STABILITY_MS) {
      return { ...base, decision: "download" as const, reason: "previous-file-grace-window" };
    }
  }
  return base;
}

function maybeAuditFile(index: number, strategy: AdmServerStrategyState) {
  if (strategy.mode !== "optimized") return false;
  if (strategy.cycles % AUDIT_INTERVAL_CYCLES !== 0) return false;
  return index === strategy.optimizedAuditCursor;
}

function getAdmFilesFromList(entries: NitradoEntry[]) {
  return entries
    .filter((entry) => String(entry.type || "file").toLowerCase() !== "directory")
    .filter((entry) => /\.log$/i.test(entry.path || ""))
    .sort((a, b) => extractDateFromAdmPath(b.path) - extractDateFromAdmPath(a.path));
}

export async function downloadADM(serverId = getActiveServerId(), manifestFile = MANIFEST_FILE) {
  ensureLogDir();
  const cycleStarted = Date.now();
  const strategy = getAdmServerStrategy(serverId);
  strategy.cycles += 1;
  admDownloadMetrics.cycles += 1;
  admDownloadMetrics.lastCycleAt = new Date().toISOString();
  admDownloadMetrics.lastCandidateCount = 0;
  admDownloadMetrics.lastDownloadedCount = 0;
  admDownloadMetrics.lastDownloadedBytes = 0;

  const serverMetric = getAdmPerServerMetric(serverId);
  serverMetric.cycles += 1;
  serverMetric.lastCycleAt = admDownloadMetrics.lastCycleAt;

  const serviceId = getNitradoServiceId(serverId);
  const entries = await listNitradoDirectory(`gameservers/services/${serviceId}/file_server`, serverId).catch(async () => {
    try {
      const json = await fetchJson(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=`, serverId);
      return json?.data?.entries || [];
    } catch {
      return [];
    }
  });
  const admFiles = getAdmFilesFromList(entries);
  updatePreviousFileStability(admFiles, strategy);
  const candidates = admFiles.slice(0, MAX_CANDIDATES);
  admDownloadMetrics.candidatesSeen += candidates.length;
  admDownloadMetrics.lastCandidateCount = candidates.length;
  serverMetric.candidatesSeen += candidates.length;

  const availableLocalFiles: string[] = [];
  const skippableIndexes: number[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const file = candidates[index];
    const localFile = path.join(LOG_DIR, safeLocalName(file.path));
    const baseDecision = createShadowDecision(file, localFile);
    const optimized = optimizedDecision(file, localFile, index, strategy);
    const shouldAudit = maybeAuditFile(index, strategy);
    const shouldDownload = strategy.mode === "legacy" || optimized.decision === "download" || shouldAudit;

    if (!shouldDownload) {
      skippableIndexes.push(index);
      admDownloadMetrics.strategy.optimizedSkips += 1;
      const metric = getAdmFileMetric(file.path);
      metric.optimizedSkips += 1;
      metric.optimizedSavedBytes += baseDecision.remoteSize || 0;
      admDownloadMetrics.strategy.optimizedSavedBytes += baseDecision.remoteSize || 0;
      admDownloadMetrics.strategy.previousStableSkips += optimized.reason === "same-size" && index === PREVIOUS_FILE_INDEX ? 1 : 0;
      if (fs.existsSync(localFile)) availableLocalFiles.push(localFile);
      continue;
    }

    try {
      const text = await downloadText(file.path, serverId);
      if (text === null) throw new Error("no download token");
      const bytes = Buffer.byteLength(text, "utf8");
      const previousHash = fs.existsSync(localFile) ? hashText(fs.readFileSync(localFile, "utf8")) : null;
      const downloadedHash = hashText(text);
      const contentChanged = previousHash === null ? null : previousHash !== downloadedHash;
      const shadowMismatch = baseDecision.decision === "skip" && contentChanged === true;
      const metric = getAdmFileMetric(file.path);

      if (strategy.mode !== "legacy") {
        admDownloadMetrics.shadow.decisions += 1;
        const shadowDecision = optimized;
        if (shadowDecision.decision === "download") {
          admDownloadMetrics.shadow.wouldDownload += 1;
          admDownloadMetrics.shadow.estimatedOptimizedBytes += bytes;
          metric.shadowWouldDownload += 1;
          metric.shadowEstimatedBytes += bytes;
          if (shadowDecision.reason === "remote-size-unavailable") admDownloadMetrics.shadow.metadataUnavailable += 1;
          else if (shadowDecision.reason === "local-missing") admDownloadMetrics.shadow.localMissing += 1;
          else if (shadowDecision.reason === "size-changed") admDownloadMetrics.shadow.sizeMismatch += 1;
          else if (shadowDecision.reason === "conservative-active-file" || shadowDecision.reason === "previous-file-grace-window") {
            admDownloadMetrics.shadow.conservativeDownloads += 1;
            metric.shadowConservativeDownloads += 1;
            if (shadowDecision.reason === "previous-file-grace-window") admDownloadMetrics.strategy.previousGraceDownloads += 1;
          }
        } else {
          admDownloadMetrics.shadow.wouldSkip += 1;
          admDownloadMetrics.shadow.sameSize += 1;
          admDownloadMetrics.shadow.estimatedSavedBytes += bytes;
          metric.shadowWouldSkip += 1;
          metric.shadowEstimatedSavedBytes += bytes;
          if (shadowMismatch) {
            admDownloadMetrics.shadow.dangerousSkips += 1;
            metric.shadowDangerousSkips += 1;
          } else {
            admDownloadMetrics.shadow.safeSkips += 1;
            metric.shadowSafeSkips += 1;
          }
        }
        addRecentShadowDecision({ at: new Date().toISOString(), file: safeLocalName(file.path), decision: shadowDecision.decision, reason: shouldAudit ? "optimized-audit" : shadowDecision.reason, remoteSize: baseDecision.remoteSize, localSize: baseDecision.localSize, actualBytes: bytes, contentChanged, mismatch: shadowMismatch });
      }

      if (shouldAudit) {
        metric.optimizedAudits += 1;
        admDownloadMetrics.strategy.auditDownloads += 1;
        if (shadowMismatch) {
          admDownloadMetrics.strategy.auditMismatches += 1;
          triggerAutomaticFallback(`audit mismatch em ${safeLocalName(file.path)}`, serverId);
        }
      }

      fs.writeFileSync(localFile, text, "utf-8");
      availableLocalFiles.push(localFile);
      metric.downloads += 1;
      metric.bytes += bytes;
      metric.lastBytes = bytes;
      metric.lastDownloadedAt = new Date().toISOString();
      admDownloadMetrics.fileDownloads += 1;
      admDownloadMetrics.bytesDownloaded += bytes;
      serverMetric.downloads += 1;
      serverMetric.bytesDownloaded += bytes;
      admDownloadMetrics.lastDownloadedCount += 1;
      admDownloadMetrics.lastDownloadedBytes += bytes;
      if (strategy.mode === "optimized") admDownloadMetrics.strategy.optimizedDownloads += 1;
      console.log(`✅ ADM baixado: ${file.path} (${bytes} bytes)`);
    } catch (err) {
      const metric = getAdmFileMetric(file.path);
      metric.failures += 1;
      admDownloadMetrics.downloadFailures += 1;
      serverMetric.downloadFailures += 1;
      console.error(`❌ erro baixando ${file.path}:`, err);
      if (fs.existsSync(localFile)) availableLocalFiles.push(localFile);
    }
  }

  if (strategy.mode === "optimized" && skippableIndexes.length && strategy.cycles % AUDIT_INTERVAL_CYCLES === 0) strategy.optimizedAuditCursor = (strategy.optimizedAuditCursor + 1) % skippableIndexes.length;
  saveManifest(availableLocalFiles, manifestFile);
  admDownloadMetrics.lastCycleDurationMs = Date.now() - cycleStarted;
  serverMetric.lastCycleDurationMs = admDownloadMetrics.lastCycleDurationMs;
  admDownloadMetrics.maxCycleDurationMs = Math.max(admDownloadMetrics.maxCycleDurationMs, admDownloadMetrics.lastCycleDurationMs);
  console.log(`📦 ${availableLocalFiles.length} arquivos ADM disponíveis`);
}

function getNitradoServiceId(serverId = getActiveServerId()) {
  return getServerNitradoConfig(serverId).serviceId;
}

function normalizeNitradoFileServerPath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
}

function splitRemoteFilePath(filePath: string) {
  const normalized = normalizeNitradoFileServerPath(filePath);
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex === -1) return { path: "", file: normalized };
  return {
    path: normalized.slice(0, separatorIndex),
    file: normalized.slice(separatorIndex + 1),
  };
}

function getNoFtpRootFromAdmBaseDir(serverId = getActiveServerId()) {
  const baseDir = String(getServerRuntimeContext(serverId).nitrado.baseDir || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  const marker = "/noftp/";
  const index = baseDir.indexOf(marker);
  if (index === -1) return "";
  return baseDir.slice(0, index + marker.length - 1);
}

function getFtpRootFromAdmBaseDir(serverId = getActiveServerId()) {
  const baseDir = String(getServerRuntimeContext(serverId).nitrado.baseDir || "").replace(/\\/g, "/");
  const match = baseDir.match(/^(\/games\/[^/]+)\/(?:noftp|ftproot)(?:\/|$)/i);
  return match?.[1] ? `${match[1]}/ftproot` : "";
}

function withDayzMissionFolderVariants(pathValue: string) {
  const normalized = normalizeNitradoFileServerPath(pathValue);
  const variants = [normalized];
  if (normalized.startsWith("dayzps_missions/")) variants.push(normalized.replace(/^dayzps_missions\//, "dayzps_mission/"));
  if (normalized.startsWith("dayzps_mission/")) variants.push(normalized.replace(/^dayzps_mission\//, "dayzps_missions/"));
  return uniqueStrings(variants);
}

function resolveDayzUploadDirectory(pathValue: string, serverId = getActiveServerId()) {
  const normalized = normalizeNitradoFileServerPath(pathValue);
  const missionMatch = normalized.match(/(?:^|\/)(dayzps_missions\/.*)$/i);
  if (!missionMatch) return normalized;

  const noFtpRoot = getNoFtpRootFromAdmBaseDir(serverId);
  if (!noFtpRoot) return normalized;

  const resolved = `${noFtpRoot}/${missionMatch[1]}`;
  console.log("🧭 NITRADO DAYZ UPLOAD PATH", {
    serverId,
    configuredBaseDir: getServerRuntimeContext(serverId).nitrado.baseDir,
    noFtpRoot,
    requestedPath: normalized,
    resolvedPath: resolved,
  });
  return resolved;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function getUploadToken(filePath: string, serverId = getActiveServerId()): Promise<{ url: string; token: string }> {
  const serviceId = getNitradoServiceId(serverId);
  const { path: requestedDirectory, file } = splitRemoteFilePath(filePath);
  const directory = resolveDayzUploadDirectory(requestedDirectory, serverId);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;

  console.log(`📤 Nitrado upload token request: file=${file} path=${directory}`);

  const form = new URLSearchParams({ path: directory, file });
  const json = await postWithForm(url, form, serverId);
  const token = json?.data?.token;
  if (!token?.url || !token?.token) throw new Error(`Nitrado did not return an upload token for ${filePath}`);

  console.log(`✅ Nitrado upload token received: path=${directory} file=${file}`);
  return { url: token.url, token: token.token };
}

async function postWithForm(url: string, form: URLSearchParams, serverId: string): Promise<any> {
  const body = form.toString();
  const res = await trackedNitradoFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getNitradoToken(serverId)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as any;
}

export async function getNitradoFileServerBookmarks(serverId = getActiveServerId()): Promise<any[]> {
  getNitradoToken(serverId);
  const serviceId = getNitradoServiceId(serverId);
  const json = await fetchJson(
    `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/bookmarks`,
    serverId,
  );
  return Array.isArray(json?.data?.bookmarks) ? json.data.bookmarks : [];
}

export async function listNitradoDirectory(dir: string, serverId = getActiveServerId()): Promise<NitradoEntry[]> {
  getNitradoToken(serverId);
  const serviceId = getNitradoServiceId(serverId);
  const normalizedDir = normalizeNitradoFileServerPath(dir);
  console.log(`📂 Nitrado list request: dir=${normalizedDir || "/"}`);
  const json = await fetchJson(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(normalizedDir)}`, serverId);
  return json?.data?.entries || [];
}

export async function debugNitradoListRaw(dir: string, serverId = getActiveServerId()): Promise<{ dir: string; ok: boolean; status: number; statusText: string; text: string; entriesCount: number | null }> {
  getNitradoToken(serverId);
  const serviceId = getNitradoServiceId(serverId);
  const normalizedDir = normalizeNitradoFileServerPath(dir);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(normalizedDir)}`;
  const res = await trackedNitradoFetch(url, { headers: { Authorization: `Bearer ${getNitradoToken(serverId)}` } });
  const text = await res.text();
  let entriesCount: number | null = null;
  try {
    const parsed = JSON.parse(text);
    entriesCount = Array.isArray(parsed?.data?.entries) ? parsed.data.entries.length : null;
  } catch {
    entriesCount = null;
  }
  return { dir: normalizedDir, ok: res.ok, status: res.status, statusText: res.statusText, text, entriesCount };
}

export async function uploadNitradoTextFile(filePath: string, content: string, serverId = getActiveServerId()) {
  const { url, token } = await getUploadToken(filePath, serverId);
  const body = Buffer.from(content, "utf8");
  const res = await trackedNitradoFetch(url, {
    method: "POST",
    headers: {
      token,
      "content-type": "application/octet-stream",
    },
    body,
  });
  if (!res.ok) throw new Error(`Nitrado binary upload HTTP ${res.status}: ${await res.text()}`);
}
