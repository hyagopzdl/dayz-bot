import { getServerRuntimeContext } from "./serverRuntime";
import { getServerNitradoConfig } from "./serverNitrado";
import { getNitradoFileServerBookmarks } from "./nitradoDownloader";

const DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;
const resolvedDirectoryCache = new Map<string, { directory: string; expiresAt: number }>();

function normalize(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
}

function absolutePath(value: string) {
  const normalized = normalize(value).replace(/^\/+/, "");
  return normalized ? `/${normalized}` : "";
}

function getConfiguredRoot(serverId: string) {
  const baseDir = String(getServerRuntimeContext(serverId).nitrado.baseDir || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  if (!baseDir) return "";
  return absolutePath(baseDir);
}

function basename(value: string) {
  const normalized = normalize(value);
  return normalized.split("/").pop() || "";
}

function dirname(value: string) {
  const normalized = normalize(value).replace(/^\/+/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? `/${normalized.slice(0, index)}` : "/";
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
  const params = new URLSearchParams();
  params.set("dir", normalize(directory).replace(/^\/+/, ""));
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?${params.toString()}`;
  const response = await nitradoRequest(url, serverId);
  const json = await response.json() as any;
  return Array.isArray(json?.data?.entries) ? json.data.entries : [];
}

function entryPath(entry: any) {
  return typeof entry?.path === "string" ? absolutePath(entry.path) : "";
}

function isFileEntry(entry: any) {
  return !entry?.type || String(entry.type).toLowerCase() === "file";
}

/**
 * Nitrado's File Server exposes DayZ paths from the game-server logical root.
 * The web interface confirms the mission directory as:
 * /dayzps_missions/dayzOffline.chernarusplus
 *
 * runtime.nitradoBaseDir is the physical noftp/config path used elsewhere in
 * the service and must NOT be prepended to File Server paths.
 */
async function discoverMissionDirectory(relativeDirectory: string, serverId: string) {
  const normalizedRelative = normalize(relativeDirectory).replace(/^\/+/, "");
  const missionMarker = normalizedRelative.match(/^dayzps_missions\/(.+)$/i);
  if (!missionMarker) throw new Error(`Nitrado DayZ mission directory is invalid for \${serverId}: \${relativeDirectory}`);

  const cached = resolvedDirectoryCache.get(serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.directory;

  // Nitrado exposes canonical File Server roots through its bookmarks endpoint.
  // Resolve the physical mission root from that API instead of guessing between
  // noftp/config/game roots.
  const bookmarks = await getNitradoFileServerBookmarks(serverId);
  const missionRoot = bookmarks
    .map((bookmark) => absolutePath(String(bookmark || "")))
    .find((bookmark) => /\/dayzps_missions$/i.test(bookmark));

  if (!missionRoot) {
    throw new Error(
      `Nitrado File Server did not expose a dayzps_missions bookmark for \${serverId}. ` +
      `Bookmarks returned: \${bookmarks.map((bookmark) => String(bookmark)).join(", ") || "none"}`,
    );
  }

  const directory = absolutePath(`\${missionRoot}/\${missionMarker[1]}`);
  const entries = await listDirectory(directory, serverId);
  resolvedDirectoryCache.set(serverId, {
    directory,
    expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
  });

  console.log("✅ NITRADO DAYZ MISSION DIRECTORY RESOLVED FROM BOOKMARK", {
    serverId,
    missionRoot,
    directory,
    entries: entries.length,
    source: "nitrado-file-server-bookmark",
  });

  return directory;
}

export async function uploadDayzMissionTextFile(filePath: string, content: string, serverId: string) {
  const normalizedFilePath = normalize(filePath).replace(/^\/+/, "");
  const match = normalizedFilePath.match(/^(.*)\/([^/]+)$/);
  if (!match) throw new Error(`Invalid DayZ mission file path: ${filePath}`);
  const relativeDirectory = match[1];
  const file = match[2];
  if (!/^dayzps_missions\//i.test(relativeDirectory)) {
    throw new Error(`Not a DayZ mission path: ${filePath}`);
  }

  const directory = await discoverMissionDirectory(relativeDirectory, serverId);
  const uploadPath = absolutePath(directory);
  const serviceId = getServiceId(serverId);
  const tokenUrl = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;
  const form = new URLSearchParams({ path: uploadPath, file });

  console.log("📤 NITRADO DAYZ UPLOAD TOKEN", {
    serverId,
    serviceId,
    directory,
    uploadPath,
    file,
    transport: "application/x-www-form-urlencoded",
  });

  const tokenResponse = await nitradoRequest(tokenUrl, serverId, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = await tokenResponse.json() as any;
  const token = json?.data?.token;
  if (!token?.url || !token?.token) throw new Error(`Nitrado did not return an upload token for ${filePath}`);

  const uploadResponse = await globalThis.fetch(token.url, {
    method: "POST",
    headers: { "Content-Type": "application/binary", token: token.token },
    body: content,
  });
  if (!uploadResponse.ok) throw new Error(`Nitrado file upload HTTP ${uploadResponse.status}: ${await uploadResponse.text()}`);

  console.log("✅ NITRADO DAYZ FILE UPLOADED", { serverId, directory, uploadPath, file });
}
