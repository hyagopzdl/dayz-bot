export type ServerFoundationMode = "single-server-compat";

export type ManagedServerDescriptor = {
  id: string;
  name: string;
  enabled: boolean;
  primary: boolean;
  mode: ServerFoundationMode;
  integrations: {
    nitradoServiceId?: string;
    discordGuildId?: string;
  };
};

export type ServerRegistryPersistenceStatus = {
  enabled: boolean;
  initialized: boolean;
  tableReady: boolean;
  primarySeeded: boolean;
  rowsLoaded: number;
  lastLoadedAt?: string;
  lastError?: string;
  configDrift?: {
    name?: boolean;
    nitradoServiceId?: boolean;
    discordGuildId?: boolean;
  };
};

const FALLBACK_SERVER_ID = "pz-deathmatch";
const FALLBACK_SERVER_NAME = "PZ Deathmatch";

let persistedServers: ManagedServerDescriptor[] = [];
let registryPersistenceStatus: ServerRegistryPersistenceStatus = {
  enabled: Boolean(process.env.DATABASE_URL),
  initialized: false,
  tableReady: false,
  primarySeeded: false,
  rowsLoaded: 0,
};

function normalizeServerId(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || FALLBACK_SERVER_ID;
}

function normalizeServerName(value: unknown) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized || FALLBACK_SERVER_NAME;
}

export function getPrimaryServerId() {
  return normalizeServerId(process.env.DEFAULT_SERVER_ID || process.env.SERVER_ID || FALLBACK_SERVER_ID);
}

export function getPrimaryServerDescriptor(): ManagedServerDescriptor {
  return {
    id: getPrimaryServerId(),
    name: normalizeServerName(process.env.SERVER_DISPLAY_NAME || process.env.SERVER_NAME || FALLBACK_SERVER_NAME),
    enabled: true,
    primary: true,
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(process.env.NITRADO_SERVICE_ID || "").trim() || undefined,
      discordGuildId: String(process.env.DISCORD_SERVER_ID || process.env.DISCORD_GUILD_ID || "").trim() || undefined,
    },
  };
}

export function listManagedServers(): ManagedServerDescriptor[] {
  // Phase 2 persists the registry metadata only. Operational state, ADM cursors,
  // Discord routing and Nitrado routing still use the exact single-server path
  // from production, so the existing server cannot be split or remapped yet.
  if (persistedServers.length) return persistedServers.map((server) => ({ ...server, integrations: { ...server.integrations } }));
  return [getPrimaryServerDescriptor()];
}

export function setPersistedManagedServers(servers: ManagedServerDescriptor[]) {
  persistedServers = servers.map((server) => ({
    id: normalizeServerId(server.id),
    name: normalizeServerName(server.name),
    enabled: server.enabled !== false,
    primary: Boolean(server.primary),
    mode: "single-server-compat",
    integrations: {
      nitradoServiceId: String(server.integrations?.nitradoServiceId || "").trim() || undefined,
      discordGuildId: String(server.integrations?.discordGuildId || "").trim() || undefined,
    },
  }));
}

export function setServerRegistryPersistenceStatus(status: Partial<ServerRegistryPersistenceStatus>) {
  registryPersistenceStatus = {
    ...registryPersistenceStatus,
    ...status,
    configDrift: status.configDrift
      ? { ...(registryPersistenceStatus.configDrift || {}), ...status.configDrift }
      : registryPersistenceStatus.configDrift,
  };
}

export function getServerRegistryPersistenceStatus(): ServerRegistryPersistenceStatus {
  return {
    ...registryPersistenceStatus,
    configDrift: registryPersistenceStatus.configDrift ? { ...registryPersistenceStatus.configDrift } : undefined,
  };
}

export function resolveServerIdFromDiscordGuildId(guildId: unknown) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return undefined;
  const server = listManagedServers().find((candidate) => candidate.integrations.discordGuildId === normalizedGuildId);
  return server?.id;
}

export function getServerFoundationDiagnostics() {
  const server = getPrimaryServerDescriptor();
  const registry = getServerRegistryPersistenceStatus();
  return {
    phase: 2,
    mode: server.mode,
    currentServerId: server.id,
    currentServerName: server.name,
    managedServers: listManagedServers().length,
    additionalServersEnabled: false,
    registryPersisted: registry.initialized && registry.tableReady && registry.primarySeeded,
    persistenceNamespaced: false,
    parserNamespaced: false,
    discordRoutingNamespaced: false,
    nitradoRoutingNamespaced: false,
    currentDataPathChanged: false,
    registry,
    safety: {
      legacyStateIdsPreserved: true,
      legacyAdmCursorsPreserved: true,
      legacyDiscordGuildPreserved: true,
      legacyNitradoServicePreserved: true,
      operationalDatabaseWritesAdded: false,
      registryMetadataOnly: true,
    },
    integrations: server.integrations,
  };
}

export function buildFutureServerScopedKey(serverId: string, key: string) {
  return `${normalizeServerId(serverId)}:${String(key || "").trim()}`;
}
