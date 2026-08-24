import { Router, type Request } from "express";
import {
  getNitradoGameserverStatus,
  listNitradoDirectory,
  probeNitradoUploadTokenForDirectory,
} from "../lib/nitradoDownloader";
import {
  getManagedServerById,
  getOrganizationIntegrationStatus,
  getPrimaryServerDescriptor,
  getPrimaryServerId,
  getServerRuntimeIsolationStatus,
  getServerRegistryPersistenceStatus,
  getServerNamespacePersistenceStatus,
  listManagedServers,
} from "../lib/serverRegistry";

const router = Router();

const TARGET_SERVERS = [
  { id: "19149785", label: "deathmatch" },
  { id: "19791331", label: "survival" },
] as const;

function getAdminToken(req: Request) {
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  const headerToken = typeof req.headers["x-admin-token"] === "string" ? req.headers["x-admin-token"] : "";
  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const cookieToken = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("shop_admin_token="))
    ?.slice("shop_admin_token=".length) || "";

  return queryToken || headerToken || decodeURIComponent(cookieToken);
}

function requireDiagnosticAdmin(req: Request, res: any) {
  const configuredToken = String(process.env.SHOP_ADMIN_TOKEN || process.env.ADMIN_PANEL_TOKEN || "").trim();
  if (!configuredToken) {
    res.status(503).json({ error: "ADMIN_TOKEN_NOT_CONFIGURED" });
    return false;
  }

  if (getAdminToken(req) !== configuredToken) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return false;
  }

  return true;
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
    .replace(/token=[^&\s]+/gi, "token=[REDACTED]");
}

async function safeCall<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, data: await fn() };
  } catch (error) {
    return { ok: false as const, error: sanitizeError(error) };
  }
}

function descriptorSnapshot(serverId: string) {
  const descriptor = getManagedServerById(serverId)
    || (serverId === getPrimaryServerId() ? getPrimaryServerDescriptor() : undefined);

  if (!descriptor) return null;

  const integration = getOrganizationIntegrationStatus(descriptor.organizationId);
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
    credentialSource: integration.credentialSource,
    credentialConfigured: integration.configured,
    encryptedAtRest: integration.encryptedAtRest,
    validation: descriptor.runtime.nitradoValidation
      ? {
          serviceId: descriptor.runtime.nitradoValidation.serviceId,
          baseDir: descriptor.runtime.nitradoValidation.baseDir,
          validatedAt: descriptor.runtime.nitradoValidation.validatedAt,
        }
      : null,
  };
}

async function diagnoseServer(serverId: string, label: string) {
  const descriptor = descriptorSnapshot(serverId);
  if (!descriptor) {
    return {
      serverId,
      label,
      descriptor: null,
      error: "SERVER_NOT_REGISTERED",
    };
  }

  const missionDir = String(descriptor.dayzMissionDir || "dayzps_missions/dayzOffline.chernarusplus")
    .replace(/^\/+|\/+$/g, "");
  const directories = [
    "",
    "dayzps_missions",
    missionDir,
    `${missionDir}/db`,
  ];

  const listing = {} as Record<string, unknown>;
  for (const dir of directories) {
    listing[dir || "/"] = await safeCall(() => listNitradoDirectory(dir, serverId));
  }

  const uploadProbe = {} as Record<string, unknown>;
  for (const dir of [missionDir, `${missionDir}/db`]) {
    uploadProbe[dir] = await safeCall(() =>
      probeNitradoUploadTokenForDirectory(dir, "events.xml", serverId),
    );
  }

  const status = await safeCall(() => getNitradoGameserverStatus(serverId));

  return {
    serverId,
    label,
    descriptor,
    status: status.ok
      ? { ok: true, value: status.data.status }
      : { ok: false, error: status.error },
    listing,
    uploadProbe,
  };
}

router.get("/nitrado-diagnostic", async (req, res) => {
  if (!requireDiagnosticAdmin(req, res)) return;

  const startedAt = Date.now();
  const servers = [];

  for (const target of TARGET_SERVERS) {
    servers.push(await diagnoseServer(target.id, target.label));
  }

  res.json({
    diagnostic: "nitrado-file-server-v1",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    targetServers: TARGET_SERVERS,
    primaryServerId: getPrimaryServerId(),
    primaryServer: descriptorSnapshot(getPrimaryServerId()),
    managedServers: listManagedServers().map((server) => descriptorSnapshot(server.id)),
    registry: getServerRegistryPersistenceStatus(),
    namespace: getServerNamespacePersistenceStatus(),
    isolation: getServerRuntimeIsolationStatus(),
    servers,
    interpretation: {
      listSuccessMeans: "Nitrado accepted the service credential and resolved the requested directory for the File Server list endpoint.",
      uploadProbeSuccessMeans: "Nitrado accepted the same credential and returned an upload token for that logical directory; no file is uploaded by this diagnostic.",
      usefulComparison: "Compare Deathmatch 19149785 with Survival 19791331 directory listings and upload probes before changing any Render secret or Shop path.",
    },
  });
});

export default router;
