import { getServerRuntimeContext } from "./serverRuntime";
import { getServerNitradoConfig } from "./serverNitrado";

const DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;
const resolvedDirectoryCache = new Map<string, { directory: string; expiresAt: number }>();

function normalize(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

function getNoFtpRoot(serverId: string) {
  const baseDir = String(getServerRuntimeContext(serverId).nitrado.baseDir || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  const marker = "/noftp/";
  const index = baseDir.indexOf(marker);
  if (index === -1) return "";
  return baseDir.slice(0, index + marker.length - 1);
}

function basename(value: string) {
  const normalized = normalize(value);
  return normalized.split("/").pop() || "";
}

function getServiceId(serverId: string) {
  return getServerNitradoConfig(serverId).serviceId;
}

function getToken(serverId: string) {
  return getServerNitradoConfig(serverId).apiToken;
}

async function nitradoRequest(url: string, serverId: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${getToken(serverId)}`);
  const response = await globalThis.fetch(url, { ...init, headers });
  if (!response.ok) {
    throw new Error(`Nitrado HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function listDirectory(directory: string, serverId: string): Promise<any[]> {
  const serviceId = getServiceId(serverId);
  const normalized = normalize(directory);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(normalized)}`;
  const response = await nitradoRequest(url, serverId);
  const json = await response.json() as any;
  return Array.isArray(json?.data?.entries) ? json.data.entries : [];
}

function entryPath(entry: any) {
  return typeof entry?.path === "string" ? normalize(entry.path) : "";
}

function findChild(entries: any[], name: string) {
  const target = normalize(name).toLowerCase();
  return entries.find((entry) => basename(entryPath(entry)).toLowerCase() === target);
}

async function discoverMissionDirectory(relativeDirectory: string, serverId: string) {
  const normalizedRelative = normalize(relativeDirectory);
  const noFtpRoot = getNoFtpRoot(serverId);
  if (!noFtpRoot) throw new Error(`Nitrado noftp root nao pode ser derivado para o servidor ${serverId}.`);

  const cached = resolvedDirectoryCache.get(serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.directory;

  const absoluteDirectory = `${noFtpRoot}/${normalizedRelative}`;
  try {
    await listDirectory(absoluteDirectory, serverId);
    resolvedDirectoryCache.set(serverId, { directory: absoluteDirectory, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS });
    console.log("✅ NITRADO DAYZ MISSION DIRECTORY CONFIRMED", { serverId, directory: absoluteDirectory, source: "direct-list" });
    return absoluteDirectory;
  } catch (directError) {
    console.warn("⚠️ NITRADO DAYZ DIRECT DIRECTORY CHECK FAILED", {
      serverId,
      directory: absoluteDirectory,
      error: directError instanceof Error ? directError.message : String(directError),
    });
  }

  const parts = normalizedRelative.split("/").filter(Boolean);
  let current = noFtpRoot;
  for (const part of parts) {
    const entries = await listDirectory(current, serverId);
    const child = findChild(entries, part);
    if (!child) {
      throw new Error(`Nitrado directory not found while resolving ${normalizedRelative}: parent=${current} child=${part}`);
    }
    const discovered = entryPath(child);
    current = discovered.startsWith("games/") || discovered.startsWith("/games/") ? `/${discovered.replace(/^\/+/, "")}` : `${current}/${part}`;
    console.log("🧭 NITRADO DAYZ DIRECTORY DISCOVERY", { serverId, parent: current, child: part, discoveredPath: discovered || null });
  }

  resolvedDirectoryCache.set(serverId, { directory: current, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS });
  console.log("✅ NITRADO DAYZ MISSION DIRECTORY RESOLVED", { serverId, directory: current, requestedDirectory: normalizedRelative });
  return current;
}

export async function uploadDayzMissionTextFile(filePath: string, content: string, serverId: string) {
  const normalizedFilePath = normalize(filePath);
  const match = normalizedFilePath.match(/^(.*)\/([^/]+)$/);
  if (!match) throw new Error(`Invalid DayZ mission file path: ${filePath}`);
  const relativeDirectory = match[1];
  const file = match[2];
  if (!/^dayzps_missions\//i.test(relativeDirectory)) {
    throw new Error(`Not a DayZ mission path: ${filePath}`);
  }

  const directory = await discoverMissionDirectory(relativeDirectory, serverId);
  const serviceId = getServiceId(serverId);
  const tokenUrl = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload?${new URLSearchParams({ path: directory, file }).toString()}`;

  console.log("📤 NITRADO DAYZ UPLOAD TOKEN", { serverId, serviceId, directory, file });
  const tokenResponse = await nitradoRequest(tokenUrl, serverId, { method: "POST" });
  const json = await tokenResponse.json() as any;
  const token = json?.data?.token;
  if (!token?.url || !token?.token) throw new Error(`Nitrado did not return an upload token for ${filePath}`);

  const uploadResponse = await globalThis.fetch(token.url, {
    method: "POST",
    headers: { "Content-Type": "application/binary", token: token.token },
    body: content,
  });
  if (!uploadResponse.ok) throw new Error(`Nitrado file upload HTTP ${uploadResponse.status}: ${await uploadResponse.text()}`);

  console.log("✅ NITRADO DAYZ FILE UPLOADED", { serverId, directory, file });
}
