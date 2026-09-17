import { getServerRuntimeContext } from "./serverRuntime";
import { getServerNitradoConfig } from "./serverNitrado";

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

function getGameRoot(serverId: string) {
  const configuredRoot = getConfiguredRoot(serverId);
  if (!configuredRoot) return "";
  return configuredRoot.replace(/\/config$/i, "");
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

async function listDirectory(directory: string, serverId: string, search?: string): Promise<any[]> {
  const serviceId = getServiceId(serverId);
  const params = new URLSearchParams();
  params.set("dir", normalize(directory).replace(/^\/+/, ""));
  if (search) params.set("search", search);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?${params.toString()}`;
  const response = await nitradoRequest(url, serverId);
  const json = await response.json() as any;
  return Array.isArray(json?.data?.entries) ? json.data.entries : [];
}

async function getBookmarks(serverId: string): Promise<string[]> {
  const serviceId = getServiceId(serverId);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/bookmarks`;
  const response = await nitradoRequest(url, serverId);
  const json = await response.json() as any;
  const bookmarks = Array.isArray(json?.data?.bookmarks) ? json.data.bookmarks : [];
  return bookmarks
    .map((bookmark: any) => {
      if (typeof bookmark === "string") return absolutePath(bookmark);
      return absolutePath(bookmark?.path || bookmark?.dir || bookmark?.directory || "");
    })
    .filter(Boolean);
}

function entryPath(entry: any) {
  return typeof entry?.path === "string" ? absolutePath(entry.path) : "";
}

function isFileEntry(entry: any) {
  return !entry?.type || String(entry.type).toLowerCase() === "file";
}

async function findEventsFile(searchRoot: string, serverId: string) {
  const matches = await listDirectory(searchRoot, serverId, "events.xml");
  return matches.find((entry) =>
    isFileEntry(entry) && basename(entryPath(entry)).toLowerCase() === "events.xml",
  ) || null;
}

async function discoverMissionDirectory(relativeDirectory: string, serverId: string) {
  const normalizedRelative = normalize(relativeDirectory).replace(/^\/+/, "");
  const configuredRoot = getConfiguredRoot(serverId);
  const gameRoot = getGameRoot(serverId);
  if (!configuredRoot) throw new Error(`Nitrado baseDir nao pode ser resolvido para o servidor ${serverId}.`);

  const cached = resolvedDirectoryCache.get(serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.directory;

  // The File Server search is recursive only inside the supplied dir. The
  // previous implementation searched without a dir, which can legitimately
  // return no entries because it does not mean "search the entire server".
  // Start from Nitrado's own bookmarks, then the validated game root derived
  // from baseDir. This discovers the real path without inventing a mission
  // location under /config.
  const roots = [...new Set([...(await getBookmarks(serverId)), gameRoot, configuredRoot].filter(Boolean))];
  console.log("🔎 NITRADO DAYZ MISSION SEARCH ROOTS", {
    serverId,
    requestedDirectory: normalizedRelative,
    roots,
  });

  for (const root of roots) {
    try {
      const eventFile = await findEventsFile(root, serverId);
      if (!eventFile) continue;

      const discoveredFile = entryPath(eventFile);
      const discoveredDirectory = dirname(discoveredFile);
      console.log("✅ NITRADO DAYZ MISSION DIRECTORY DISCOVERED", {
        serverId,
        requestedDirectory: normalizedRelative,
        searchRoot: root,
        directory: discoveredDirectory,
        source: "file-server-bookmark-search",
        matchedFile: discoveredFile,
      });
      resolvedDirectoryCache.set(serverId, {
        directory: discoveredDirectory,
        expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
      });
      return discoveredDirectory;
    } catch (searchError) {
      console.warn("⚠️ NITRADO DAYZ MISSION SEARCH ROOT FAILED", {
        serverId,
        searchRoot: root,
        error: searchError instanceof Error ? searchError.message : String(searchError),
      });
    }
  }

  const configuredDirectory = `${configuredRoot}/${normalizedRelative}`;
  const entries = await listDirectory(configuredDirectory, serverId);
  if (entries.length > 0) {
    resolvedDirectoryCache.set(serverId, {
      directory: configuredDirectory,
      expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
    });
    console.log("✅ NITRADO DAYZ MISSION DIRECTORY CONFIRMED", {
      serverId,
      directory: configuredDirectory,
      entries: entries.length,
      source: "configured-baseDir",
    });
    return configuredDirectory;
  }

  throw new Error(
    `Nitrado DayZ mission directory could not be discovered for ${normalizedRelative}. ` +
    `Bookmarks/game-root search did not find events.xml and configured baseDir was empty: ${configuredDirectory}`,
  );
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
