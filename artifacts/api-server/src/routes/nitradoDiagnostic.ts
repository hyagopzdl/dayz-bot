import { Router, type Request } from "express";
import { debugNitradoListRaw, getNitradoGameserverStatus } from "../lib/nitradoDownloader";
import { getActiveServerId } from "../lib/serverRuntime";
import { getManagedServerById, getServerRuntimeIsolationStatus, getServerRegistryPersistenceStatus, getServerNamespacePersistenceStatus, listManagedServers } from "../lib/serverRegistry";

const router = Router();

function getAdminToken(req: Request) {
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  const headerToken = typeof req.headers["x-admin-token"] === "string" ? req.headers["x-admin-token"] : "";
  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const cookieToken = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("shop_admin_token="))?.slice("shop_admin_token=".length) || "";
  return queryToken || headerToken || decodeURIComponent(cookieToken);
}

function requireDiagnosticAdmin(req: Request, res: any) {
  const configuredToken = String(process.env.SHOP_ADMIN_TOKEN || process.env.ADMIN_PANEL_TOKEN || "").trim();
  if (!configuredToken) { res.status(503).json({ error: "ADMIN_TOKEN_NOT_CONFIGURED" }); return false; }
  if (getAdminToken(req) !== configuredToken) { res.status(401).json({ error: "UNAUTHORIZED" }); return false; }
  return true;
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]").replace(/token=[^&\s]+/gi, "token=[REDACTED]");
}

async function safeCall<T>(fn: () => Promise<T>) {
  try { return { ok: true as const, data: await fn() }; }
  catch (error) { return { ok: false as const, error: sanitizeError(error) }; }
}

function descriptorSnapshot(serverId: string | null) {
  if (!serverId) return null;
  const descriptor = getManagedServerById(serverId);
  if (!descriptor) return null;
  // Do not call tenant-scoped organization helpers here. This is a global,
  // read-only infrastructure diagnostic and must work without tenant context.
  return {
    id: descriptor.id,
    name: descriptor.name,
    primary: descriptor.primary,
    enabled: descriptor.enabled,
    runtimeEnabled: descriptor.runtimeEnabled,
    onboardingStatus: descriptor.onboardingStatus,
    organizationId: descriptor.organizationId,
    nitradoServiceId: descriptor.integrations.nitradoServiceId || null,
    baseDir: descriptor.runtime.nitradoBaseDir || null,
    dayzMissionDir: descriptor.runtime.settings?.dayzMissionDir || "dayzps_missions/dayzOffline.chernarusplus",
    credentialConfigured: Boolean(descriptor.runtime.nitradoApiTokenEncrypted),
    ftpConfigured: Boolean(descriptor.runtime.nitradoFtp?.passwordEncrypted),
  };
}

function normalize(value: string) { return String(value || "").replace(/\\/g, "/").replace(/\/+$/g, ""); }
function absolute(value: string) { const normalized = normalize(value).replace(/^\/+/, ""); return normalized ? `/${normalized}` : "/"; }
function gameRootFromBaseDir(baseDir: string) { return normalize(baseDir).replace(/\/config$/i, "") || "/"; }
function missionDirectory(missionDir: string) { return absolute(missionDir); }

async function inspectDirectory(serverId: string, directory: string) {
  const raw = await safeCall(() => debugNitradoListRaw(directory, serverId));
  const parsed = raw.ok ? (() => {
    try {
      const json = JSON.parse(raw.data.text) as any;
      return {
        dataKeys: json?.data && typeof json.data === "object" ? Object.keys(json.data) : [],
        entries: Array.isArray(json?.data?.entries) ? json.data.entries.map((entry: any) => ({
          name: typeof entry?.name === "string" ? entry.name : null,
          type: typeof entry?.type === "string" ? entry.type : null,
          path: typeof entry?.path === "string" ? entry.path : null,
          size: typeof entry?.size === "number" ? entry.size : null,
          modified: typeof entry?.modified === "string" ? entry.modified : null,
        })) : [],
      };
    } catch { return null; }
  })() : null;
  return {
    requestedDirectory: directory || "/",
    raw: raw.ok ? { status: raw.data.status, statusText: raw.data.statusText, entriesCount: raw.data.entriesCount, text: raw.data.text } : { error: raw.error },
    parsed,
  };
}

async function diagnoseServer(serverId: string) {
  const descriptor = descriptorSnapshot(serverId);
  if (!descriptor) return { serverId, descriptor: null, error: "SERVER_NOT_REGISTERED" };
  const configuredBaseDir = absolute(String(descriptor.baseDir || ""));
  const configuredMissionDir = missionDirectory(String(descriptor.dayzMissionDir || "dayzps_missions/dayzOffline.chernarusplus"));
  // The Nitrado web interface supplied by the user establishes the logical
  // DayZ File Server root. Physical /games paths are comparison-only.
  const roots = Array.from(new Set([
    "/", configuredMissionDir, `${configuredMissionDir}/db`, "/dayzps_missions",
    configuredBaseDir, gameRootFromBaseDir(configuredBaseDir),
  ].filter(Boolean)));
  console.log("🔬 NITRADO FILE SERVER ROOT DIAGNOSTIC", { serverId, roots });
  const directories: Record<string, unknown> = {};
  for (const root of roots) directories[root] = await inspectDirectory(serverId, root);
  const status = await safeCall(() => getNitradoGameserverStatus(serverId));
  return {
    serverId, descriptor,
    status: status.ok ? { ok: true, value: status.data.status } : { ok: false, error: status.error },
    roots, directories,
    uploadProbe: { performed: false, reason: "Read-only diagnostic. No upload token or file upload is attempted." },
  };
}

function safeActiveServerId() { try { return getActiveServerId() || null; } catch { return null; } }

router.get("/nitrado-diagnostic", async (req, res) => {
  if (!requireDiagnosticAdmin(req, res)) return;
  try {
    const startedAt = Date.now();
    const managedServers = listManagedServers();
    const servers = [];
    for (const server of managedServers) servers.push(await diagnoseServer(server.id));
    const activeServerId = safeActiveServerId();
    return res.json({
      diagnostic: "nitrado-file-server-root-inspection-v5",
      generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
      activeServerId, activeServer: descriptorSnapshot(activeServerId),
      managedServerCount: managedServers.length, servers,
      registry: getServerRegistryPersistenceStatus(), namespace: getServerNamespacePersistenceStatus(), isolation: getServerRuntimeIsolationStatus(),
      interpretation: {
        purpose: "Expose the actual read-only file_server/list payload for every currently managed server before changing production upload behavior.",
        important: "The Nitrado web interface path /dayzps_missions/dayzOffline.chernarusplus is included directly in this comparison.",
        noUpload: "This endpoint never requests an upload token and never writes a file.",
        tenantContext: "This infrastructure diagnostic does not require request tenant context; it reads only the persisted managed-server registry and Nitrado File Server API.",
      },
    });
  } catch (error) {
    console.error("❌ NITRADO DIAGNOSTIC FAILED", error);
    return res.status(500).json({ error: "NITRADO_DIAGNOSTIC_FAILED", message: sanitizeError(error) });
  }
});

export default router;
