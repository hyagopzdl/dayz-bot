import crypto from "crypto";
import fs from "fs";
import path from "path";
import { byteLengthOfBody, recordNetworkTransfer } from "./networkMetrics";
import { getPrimaryServerId } from "./serverRegistry";
import { getServerRuntimeContext } from "./serverRuntime";

const LEGACY_SERVICE_ID = "19149785";
const LEGACY_BASE_DIR = "/games/ni13029176_1/noftp/dayzps/config";

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
  optimizedAuditCursor: number;
  previousFileTracker: { file?: string; stableSince?: number };
};

const admServerStrategies = new Map<string, AdmServerStrategyState>();

function getAdmServerStrategy(serverId = getPrimaryServerId()): AdmServerStrategyState {
  let state = admServerStrategies.get(serverId);
  if (!state) {
    state = { mode: "shadow", optimizedAuditCursor: 0, previousFileTracker: {} };
    admServerStrategies.set(serverId, state);
  }
  return state;
}

export function setAdmDownloadMode(mode: AdmDownloadMode, serverId = getPrimaryServerId()) {
  getAdmServerStrategy(serverId).mode = mode;
  if (serverId === getPrimaryServerId()) admDownloadMetrics.strategy.mode = mode;
}

export function getAdmDownloadMode(serverId = getPrimaryServerId()): AdmDownloadMode {
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

async function fetchJson(url: string): Promise<any> {
  const res = await trackedNitradoFetch(url, { headers: { Authorization: `Bearer ${process.env.NITRADO_TOKEN}` } });
  if (!res.ok) throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as any;
}

export type NitradoGameserverStatus = { status: string | null; raw: any };

function firstString(...values: any[]) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export async function getNitradoGameserverStatus(serverId = getPrimaryServerId()): Promise<NitradoGameserverStatus> {
  if (!process.env.NITRADO_TOKEN) throw new Error("NITRADO_TOKEN não definido");
  const serviceId = getNitradoServiceId(serverId);
  const candidates = [`https://api.nitrado.net/services/${serviceId}/gameservers`, `https://api.nitrado.net/services/${serviceId}`];
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const json = await fetchJson(url);
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

async function getDownloadUrl(filePath: string, serverId = getPrimaryServerId()): Promise<string | null> {
  admDownloadMetrics.downloadUrlRequests += 1;
  const serviceId = getNitradoServiceId(serverId);
  const json = await fetchJson(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/download?file=${encodeURIComponent(filePath)}`);
  return json?.data?.token?.url || null;
}

async function downloadText(filePath: string, serverId = getPrimaryServerId()): Promise<string | null> {
  const url = await getDownloadUrl(filePath, serverId);
  if (!url) return null;
  const res = await trackedNitradoFetch(`${url}&t=${Date.now()}`);
  if (!res.ok) throw new Error(`ADM download HTTP ${res.status}: ${await res.text()}`);
  return res.text();
}

function saveManifest(files: string[], manifestFile = MANIFEST_FILE) {
  const manifest: Manifest = { files, updatedAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
}

function updatePreviousFileStability(admFiles: NitradoEntry[], strategy: AdmServerStrategyState) {
  const previous = admFiles[PREVIOUS_FILE_INDEX];
  const previousPath = previous?.path;

  if (!previousPath) {
    strategy.previousFileTracker = {};
    return;
  }

  if (strategy.previousFileTracker.file !== previousPath) {
    strategy.previousFileTracker = { file: previousPath };
  }
}

function getOptimizedDecision(
  file: NitradoEntry,
  index: number,
  baseDecision: ReturnType<typeof createShadowDecision>,
  strategy: AdmServerStrategyState,
) {
  if (index === ACTIVE_FILE_INDEX) {
    return { decision: "download" as const, reason: "conservative-active-file" };
  }

  if (baseDecision.decision === "download") {
    if (index === PREVIOUS_FILE_INDEX && strategy.previousFileTracker.file === file.path) {
      strategy.previousFileTracker.stableSince = undefined;
    }
    return baseDecision;
  }

  if (index === PREVIOUS_FILE_INDEX) {
    const now = Date.now();
    if (strategy.previousFileTracker.file !== file.path) {
      strategy.previousFileTracker = { file: file.path, stableSince: now };
      return { decision: "download" as const, reason: "previous-file-grace-window" };
    }

    if (!strategy.previousFileTracker.stableSince) {
      strategy.previousFileTracker.stableSince = now;
      return { decision: "download" as const, reason: "previous-file-grace-window" };
    }

    if (now - strategy.previousFileTracker.stableSince < PREVIOUS_FILE_STABILITY_MS) {
      return { decision: "download" as const, reason: "previous-file-grace-window" };
    }

    return { decision: "skip" as const, reason: "optimized-stable-previous-file" };
  }

  return { decision: "skip" as const, reason: "optimized-stable-old-file" };
}

function triggerAutomaticFallback(reason: string, serverId = getPrimaryServerId()) {
  admDownloadMetrics.strategy.automaticFallbacks += 1;
  admDownloadMetrics.strategy.lastFallbackAt = new Date().toISOString();
  admDownloadMetrics.strategy.lastFallbackReason = reason;
  setAdmDownloadMode("legacy", serverId);
  console.error(`🚨 ADM optimized downloader fallback para Legacy: ${reason}`);
}

export async function downloadADM(serverId = getPrimaryServerId()) {
  const runtime = getServerRuntimeContext(serverId);
  const strategy = getAdmServerStrategy(serverId);
  const logDir = runtime.storage.logDir;
  const manifestFile = runtime.storage.manifestFile;
  const serviceId = getNitradoServiceId(serverId);
  const baseDir = runtime.nitrado.baseDir || LEGACY_BASE_DIR;
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const cycleStarted = Date.now();
  admDownloadMetrics.cycles += 1;
  admDownloadMetrics.lastCycleAt = new Date().toISOString();
  admDownloadMetrics.lastDownloadedCount = 0;
  admDownloadMetrics.lastDownloadedBytes = 0;
  admDownloadMetrics.strategy.mode = strategy.mode;

  if (!process.env.NITRADO_TOKEN) {
    console.error("❌ NITRADO_TOKEN não definido");
    return;
  }

  console.log(`📂 Listando arquivos ADM... server=${serverId} modo=${strategy.mode}`);
  let listJson: any;
  try {
    admDownloadMetrics.listRequests += 1;
    listJson = await fetchJson(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(baseDir)}`);
  } catch (err) {
    admDownloadMetrics.listFailures += 1;
    throw err;
  }

  const files: NitradoEntry[] = listJson?.data?.entries || [];
  const admFiles = files
    .filter((f) => f.path?.endsWith(".ADM"))
    .sort((a, b) => extractDateFromAdmPath(b.path) - extractDateFromAdmPath(a.path))
    .slice(0, MAX_CANDIDATES);

  admDownloadMetrics.candidatesSeen += admFiles.length;
  admDownloadMetrics.lastCandidateCount = admFiles.length;

  if (!admFiles.length) {
    console.log("⚠️ nenhum .ADM encontrado");
    saveManifest([], manifestFile);
    admDownloadMetrics.lastCycleDurationMs = Date.now() - cycleStarted;
    admDownloadMetrics.maxCycleDurationMs = Math.max(admDownloadMetrics.maxCycleDurationMs, admDownloadMetrics.lastCycleDurationMs);
    return;
  }

  const availableLocalFiles: string[] = [];
  updatePreviousFileStability(admFiles, strategy);

  const candidateDecisions = admFiles.map((file, index) => {
    const localFile = path.join(logDir, safeLocalName(file.path));
    const baseDecision = createShadowDecision(file, localFile);
    const optimizedDecision = getOptimizedDecision(file, index, baseDecision, strategy);
    return { file, index, localFile, baseDecision, optimizedDecision };
  });

  const skippableIndexes = candidateDecisions
    .filter((item) => item.optimizedDecision.decision === "skip")
    .map((item) => item.index);
  const auditIndex = skippableIndexes.length ? skippableIndexes[strategy.optimizedAuditCursor % skippableIndexes.length] : -1;

  for (const candidate of candidateDecisions) {
    const { file, index, localFile, baseDecision, optimizedDecision } = candidate;
    const shouldAudit = strategy.mode === "optimized" && index === auditIndex && admDownloadMetrics.cycles % AUDIT_INTERVAL_CYCLES === 0;
    const optimizedSkip = strategy.mode === "optimized" && !shouldAudit && optimizedDecision.decision === "skip";

    if (optimizedSkip) {
      const metric = getAdmFileMetric(file.path);
      const saved = baseDecision.remoteSize || baseDecision.localSize || 0;
      metric.optimizedSkips += 1;
      metric.optimizedSavedBytes += saved;
      admDownloadMetrics.strategy.optimizedSkips += 1;
      admDownloadMetrics.strategy.optimizedSavedBytes += saved;
      if (index === PREVIOUS_FILE_INDEX) admDownloadMetrics.strategy.previousStableSkips += 1;
      availableLocalFiles.push(localFile);
      addRecentShadowDecision({
        at: new Date().toISOString(), file: safeLocalName(file.path), decision: "skip", reason: optimizedDecision.reason,
        remoteSize: baseDecision.remoteSize, localSize: baseDecision.localSize, actualBytes: 0, contentChanged: null, mismatch: false,
      });
      console.log(`⏭️ ADM estável reutilizado: ${file.path}`);
      continue;
    }

    try {
      const previousText = fs.existsSync(localFile) ? fs.readFileSync(localFile, "utf8") : null;
      const previousHash = previousText === null ? null : hashText(previousText);
      const text = await downloadText(file.path, serverId);
      if (!text) {
        console.log(`⚠️ sem URL de download: ${file.path}`);
        if (fs.existsSync(localFile)) availableLocalFiles.push(localFile);
        continue;
      }

      const bytes = Buffer.byteLength(text, "utf8");
      const downloadedHash = hashText(text);
      const contentChanged = previousHash === null ? null : previousHash !== downloadedHash;
      const shadowMismatch = baseDecision.decision === "skip" && contentChanged === true;
      const metric = getAdmFileMetric(file.path);

      if (strategy.mode !== "legacy") {
        admDownloadMetrics.shadow.decisions += 1;
        const shadowDecision = optimizedDecision;
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
            if (shadowDecision.reason === "previous-file-grace-window") {
              admDownloadMetrics.strategy.previousGraceDownloads += 1;
            }
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

        addRecentShadowDecision({
          at: new Date().toISOString(), file: safeLocalName(file.path), decision: shadowDecision.decision, reason: shouldAudit ? "optimized-audit" : shadowDecision.reason,
          remoteSize: baseDecision.remoteSize, localSize: baseDecision.localSize, actualBytes: bytes, contentChanged, mismatch: shadowMismatch,
        });
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
      admDownloadMetrics.lastDownloadedCount += 1;
      admDownloadMetrics.lastDownloadedBytes += bytes;
      if (strategy.mode === "optimized") admDownloadMetrics.strategy.optimizedDownloads += 1;
      console.log(`✅ ADM baixado: ${file.path} (${bytes} bytes)`);
    } catch (err) {
      const metric = getAdmFileMetric(file.path);
      metric.failures += 1;
      admDownloadMetrics.downloadFailures += 1;
      console.error(`❌ erro baixando ${file.path}:`, err);
      if (fs.existsSync(localFile)) availableLocalFiles.push(localFile);
    }
  }

  if (strategy.mode === "optimized" && skippableIndexes.length && admDownloadMetrics.cycles % AUDIT_INTERVAL_CYCLES === 0) {
    strategy.optimizedAuditCursor = (strategy.optimizedAuditCursor + 1) % skippableIndexes.length;
  }

  saveManifest(availableLocalFiles, manifestFile);
  admDownloadMetrics.lastCycleDurationMs = Date.now() - cycleStarted;
  admDownloadMetrics.maxCycleDurationMs = Math.max(admDownloadMetrics.maxCycleDurationMs, admDownloadMetrics.lastCycleDurationMs);
  console.log(`📦 ${availableLocalFiles.length} arquivos ADM disponíveis`);
}

function getNitradoServiceId(serverId = getPrimaryServerId()) {
  const runtime = getServerRuntimeContext(serverId);
  return runtime.nitrado.serviceId || process.env.NITRADO_SERVICE_ID || LEGACY_SERVICE_ID;
}

function normalizeNitradoFileServerPath(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

export async function listNitradoDirectory(
  dir: string,
): Promise<NitradoEntry[]> {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const serviceId = getNitradoServiceId();
  const normalizedDir = normalizeNitradoFileServerPath(dir);

  console.log(`📂 Nitrado list request: dir=${normalizedDir || "/"}`);

  const json = await fetchJson(
    `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(
      normalizedDir,
    )}`,
  );

  return json?.data?.entries || [];
}

export async function debugNitradoListRaw(dir: string): Promise<{
  dir: string;
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  entriesCount: number | null;
}> {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const serviceId = getNitradoServiceId();
  const normalizedDir = normalizeNitradoFileServerPath(dir);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(
    normalizedDir,
  )}`;

  const res = await trackedNitradoFetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  const text = await res.text();
  let entriesCount: number | null = null;

  try {
    const json = JSON.parse(text);
    const entries = json?.data?.entries;
    entriesCount = Array.isArray(entries) ? entries.length : null;
  } catch {
    entriesCount = null;
  }

  return {
    dir: normalizedDir || "/",
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text: text.slice(0, 900),
    entriesCount,
  };
}

export async function probeNitradoUploadTokenForDirectory(
  dir: string,
  file = "shop_pending.json",
): Promise<{
  dir: string;
  file: string;
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}> {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const serviceId = getNitradoServiceId();
  const normalizedDir = String(dir || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  const baseUrl = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;
  const url = `${baseUrl}?${new URLSearchParams({ path: normalizedDir, file }).toString()}`;

  const res = await trackedNitradoFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  const text = await res.text();

  return {
    dir: normalizedDir || "/",
    file,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text: text.slice(0, 700),
  };
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<any> {
  const form = new URLSearchParams(body);

  const res = await trackedNitradoFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as any;
}

async function postWithQueryParams(
  url: string,
  params: Record<string, string>,
): Promise<any> {
  const fullUrl = `${url}?${new URLSearchParams(params).toString()}`;

  const res = await trackedNitradoFetch(fullUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as any;
}

function splitRemoteFilePath(filePath: string) {
  const normalized = normalizeNitradoFileServerPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.pop();

  if (!file) {
    throw new Error(`Invalid Nitrado file path: ${filePath}`);
  }

  return {
    path: parts.join("/"),
    file,
  };
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getNoFtpRootFromAdmBaseDir(serverId = getPrimaryServerId()) {
  const baseDir = getServerRuntimeContext(serverId).nitrado.baseDir || LEGACY_BASE_DIR;
  const marker = "/noftp/";
  const index = baseDir.indexOf(marker);

  if (index === -1) {
    return "";
  }

  return baseDir.slice(0, index + marker.length - 1);
}

function withDayzMissionFolderVariants(pathValue: string) {
  const normalized = normalizeNitradoFileServerPath(pathValue);
  const variants = [normalized];

  // Nitrado console guides commonly refer to the editable mission folder as
  // dayzps_mission/dayzxb_mission (singular). Some panels visually show
  // dayzps_missions, but the upload endpoint can reject that directory even
  // when file_server/list returns success with empty entries. Try both safely.
  if (normalized.startsWith("dayzps_missions/")) {
    variants.push(normalized.replace(/^dayzps_missions\//, "dayzps_mission/"));
  }

  if (normalized.startsWith("dayzps_mission/")) {
    variants.push(normalized.replace(/^dayzps_mission\//, "dayzps_missions/"));
  }

  return uniqueStrings(variants);
}

function buildUploadPathCandidates(pathValue: string) {
  const noFtpRoot = getNoFtpRootFromAdmBaseDir();
  const candidates: string[] = [];

  for (const variant of withDayzMissionFolderVariants(pathValue)) {
    candidates.push(ensureTrailingSlash(variant));
    candidates.push(variant);

    if (noFtpRoot) {
      candidates.push(ensureTrailingSlash(`${noFtpRoot}/${variant}`));
      candidates.push(`${noFtpRoot}/${variant}`);
    }
  }

  return uniqueStrings(candidates);
}

async function getUploadToken(
  filePath: string,
): Promise<{ url: string; token: string }> {
  const serviceId = getNitradoServiceId();
  const { path, file } = splitRemoteFilePath(filePath);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;
  const errors: string[] = [];
  const pathCandidates = buildUploadPathCandidates(path);

  console.log(`📤 Nitrado upload token request: file=${file}`);
  console.log(
    `📤 Nitrado upload path candidates: ${pathCandidates.join(" | ")}`,
  );

  // Public SDK/issues show this endpoint receives path/file parameters and then
  // returns a temporary file-server URL + token. Nitrado is strict about the
  // directory path format, so we try the same directory with and without the
  // trailing slash and with the absolute /games/.../noftp prefix.
  for (const pathCandidate of pathCandidates) {
    for (const strategy of ["query", "form"] as const) {
      const body = { path: pathCandidate, file };

      try {
        console.log(
          `📤 Nitrado upload token strategy=${strategy} path=${pathCandidate} file=${file}`,
        );

        const json =
          strategy === "form"
            ? await postForm(url, body)
            : await postWithQueryParams(url, body);

        const token = json?.data?.token;

        if (!token?.url || !token?.token) {
          throw new Error(
            `Nitrado did not return an upload token for ${filePath}`,
          );
        }

        console.log(
          `✅ Nitrado upload token received: strategy=${strategy} path=${pathCandidate}`,
        );

        return {
          url: token.url,
          token: token.token,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${strategy} ${pathCandidate}: ${message}`);
        console.warn(
          `⚠️ Nitrado upload token failed (${strategy}, ${pathCandidate}): ${message}`,
        );
      }
    }
  }

  throw new Error(
    `Nitrado upload token failed for ${filePath}. Attempts: ${errors.join(" | ")}`,
  );
}

export async function uploadShopSpawnerFile(
  filePath: string,
  payload: unknown,
) {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const { url, token } = await getUploadToken(filePath);
  const body = JSON.stringify(payload, null, 2);

  const res = await trackedNitradoFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/binary",
      token,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Nitrado upload HTTP ${res.status}: ${await res.text()}`);
  }

  console.log(`✅ Shop spawner uploaded: ${filePath} (${body.length} chars)`);
}
