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

async function listDirectory(directory: string | undefined, serverId: string, search?: string): Promise<any[]> {
  const serviceId = getServiceId(serverId);
  const params = new URLSearchParams();
  if (directory) params.set("dir", normalize(directory).replace(/^\/+/, ""));
  if (search) params.set("search", search);
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

async function discoverMissionDirectory(relativeDirectory: string, serverId: string) {
  const normalizedRelative = normalize(relativeDirectory).replace(/^\/+/, "");
  const configuredRoot = getConfiguredRoot(serverId);
  if (!configuredRoot) throw new Error(`Nitrado baseDir nao pode ser resolvido para o servidor ${serverId}.`);

  const cached = resolvedDirectoryCache.get(serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.directory;

  // Nitrado's File Server API supports recursive search. Use the actual file
  // that we are about to replace as the source of truth instead of guessing
  // whether the DayZ mission lives below /config, /noftp or another root.
  try {
    const matches = await listDirectory(undefined, serverId, "events.xml");
    const eventFile = matches.find((entry) =>
      isFileEntry(entry) && basename(entryPath(entry)).toLowerCase() === "events.xml",
    );
    if (eventFile) {
      const discoveredFile = entryPath(eventFile);
      const discoveredDirectory = dirname(discoveredFile);
      console.log("✅ NITRADO DAYZ MISSION DIRECTORY DISCOVERED", {
        serverId,
        requestedDirectory: normalizedRelative,
        directory: discoveredDirectory,
        source: "file-server-search",
        matchedFile: discoveredFile,
      });
      resolvedDirectoryCache.set(serverId, {
        directory: discoveredDirectory,
        expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
      });
      return discoveredDirectory;
    }

    console.warn("⚠️ NITRADO DAYZ MISSION SEARCH DID NOT FIND events.xml", {
      serverId,
      requestedDirectory: normalizedRelative,
      configuredRoot,
      matches: matches.length,
    });
  } catch (searchError) {
    console.warn("⚠️ NITRADO DAYZ MISSION SEARCH FAILED", {
      serverId,
      requestedDirectory: normalizedRelative,
      error: searchError instanceof Error ? searchError.message : String(searchError),
    });
  }

  // Keep the validated baseDir as a conservative fallback, but only accept it
  // when the target directory actually contains files. Do not walk children
  // from an empty directory and manufacture a path from assumptions.
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
    `File Server search did not find events.xml and configured baseDir was empty: ${configuredDirectory}`,
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
  // Preserve the absolute filesystem path returned by Nitrado. The official
  // NitrAPI client passes the path directly to uploadToken(), including the
  // leading slash when the file-server entry contains one.
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
