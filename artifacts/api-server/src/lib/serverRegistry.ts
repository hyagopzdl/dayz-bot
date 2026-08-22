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

const FALLBACK_SERVER_ID = "pz-deathmatch";
const FALLBACK_SERVER_NAME = "PZ Deathmatch";

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
  // Phase 1 is intentionally read-only. The current production server is
  // represented as the primary tenant, while every existing persistence key,
  // parser cursor and Discord/Nitrado integration keeps its current behavior.
  return [getPrimaryServerDescriptor()];
}

export function resolveServerIdFromDiscordGuildId(guildId: unknown) {
  const descriptor = getPrimaryServerDescriptor();
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId || !descriptor.integrations.discordGuildId) return undefined;
  return normalizedGuildId === descriptor.integrations.discordGuildId ? descriptor.id : undefined;
}

export function getServerFoundationDiagnostics() {
  const server = getPrimaryServerDescriptor();
  return {
    phase: 1,
    mode: server.mode,
    currentServerId: server.id,
    currentServerName: server.name,
    managedServers: 1,
    additionalServersEnabled: false,
    persistenceNamespaced: false,
    parserNamespaced: false,
    discordRoutingNamespaced: false,
    nitradoRoutingNamespaced: false,
    currentDataPathChanged: false,
    safety: {
      legacyStateIdsPreserved: true,
      legacyAdmCursorsPreserved: true,
      legacyDiscordGuildPreserved: true,
      legacyNitradoServicePreserved: true,
      databaseWritesAdded: false,
    },
    integrations: server.integrations,
  };
}

export function buildFutureServerScopedKey(serverId: string, key: string) {
  return `${normalizeServerId(serverId)}:${String(key || "").trim()}`;
}
