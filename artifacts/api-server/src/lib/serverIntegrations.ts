import { ChannelType, PermissionFlagsBits } from "discord.js";
import { getDiscordClient } from "./discordBot";
import { recordNetworkTransfer } from "./networkMetrics";
import { getManagedServerById, getPrimaryServerDescriptor, getPrimaryServerId, listManagedServers } from "./serverRegistry";
import { getOrganizationIntegrationStatus, getOrganizationNitradoCredential } from "./organizationIntegrations";

const NITRADO_API_BASE = "https://api.nitrado.net";

export type NitradoServiceOption = {
  id: string;
  name: string;
  status?: string;
  type?: string;
  game?: string;
  username?: string;
  detectedBaseDir?: string;
  assignedServerId?: string;
  assignedServerName?: string;
};

export type DiscordGuildOption = {
  id: string;
  name: string;
  memberCount: number;
  iconUrl?: string;
};

export type DiscordChannelOption = {
  id: string;
  name: string;
  type: "text" | "category";
  parentId?: string;
};

function assertOnboardingServer(serverId: string) {
  const server = getManagedServerById(serverId);
  if (!server) throw new Error(`Servidor ${serverId} nao encontrado.`);
  if (server.id === getPrimaryServerId() || server.primary) {
    throw new Error("O servidor primario nao usa o fluxo de integracao da Fase 10.");
  }
  return server;
}

function requireNitradoToken(serverId: string) {
  const server = getManagedServerById(serverId) || (serverId === getPrimaryServerId() ? getPrimaryServerDescriptor() : undefined);
  if (!server) throw new Error(`Servidor ${serverId} nao encontrado.`);
  const credential = getOrganizationNitradoCredential(server.organizationId);
  if (!credential.token) {
    throw new Error("Conecte a conta Nitrado desta organizacao antes de descobrir ou validar servidores.");
  }
  return credential.token;
}

async function nitradoOnboardingJson(pathname: string, serverId: string) {
  const token = requireNitradoToken(serverId);
  const url = `${NITRADO_API_BASE}${pathname}`;
  let response: globalThis.Response;
  try {
    response = await globalThis.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    recordNetworkTransfer({
      service: "nitrado-onboarding",
      operation: `GET ${pathname.split("?")[0]}`,
      direction: "outbound",
      bytes: 0,
      ok: false,
    });
    throw error;
  }

  const text = await response.text();
  recordNetworkTransfer({
    service: "nitrado-onboarding",
    operation: `GET ${pathname.split("?")[0]}`,
    direction: "outbound",
    bytes: 0,
    ok: response.ok,
  });
  recordNetworkTransfer({
    service: "nitrado-onboarding",
    operation: `GET ${pathname.split("?")[0]}`,
    direction: "inbound",
    bytes: Buffer.byteLength(text, "utf8"),
    ok: response.ok,
  });

  if (!response.ok) {
    throw new Error(`Nitrado HTTP ${response.status}. Verifique se o token possui acesso ao servico selecionado.`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("A Nitrado retornou uma resposta invalida durante a validacao.");
  }
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function collectObjectStrings(value: unknown, depth = 0, output: string[] = []) {
  if (depth > 5 || value == null) return output;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) collectObjectStrings(item, depth + 1, output);
    return output;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>).slice(0, 120)) {
      collectObjectStrings(child, depth + 1, output);
    }
  }
  return output;
}

function findRecursiveField(value: unknown, fieldNames: Set<string>, depth = 0): string | undefined {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 80)) {
      const found = findRecursiveField(child, fieldNames, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (fieldNames.has(key.toLowerCase())) {
      const found = firstText(child);
      if (found) return found;
    }
    const nested = findRecursiveField(child, fieldNames, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeRemotePath(value: string) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function detectNitradoBaseDir(raw: unknown) {
  const strings = collectObjectStrings(raw);
  for (const value of strings) {
    const normalized = normalizeRemotePath(value);
    const marker = normalized.match(/\/games\/[^\s]+\/noftp\/(?:dayzps|dayzxb)\/config(?:\/|$)/i);
    if (marker) return marker[0].replace(/\/$/, "");
    if (/\/noftp\/(?:dayzps|dayzxb)\/config(?:\/|$)/i.test(normalized)) return normalized.replace(/\/$/, "");
  }

  const username = findRecursiveField(raw, new Set(["username", "service_username", "gameserver_username"]));
  if (!username || !/^ni[a-z0-9_-]+$/i.test(username)) return undefined;
  const all = strings.join(" ").toLowerCase();
  const folder = all.includes("dayzxb") || all.includes("xbox") ? "dayzxb" : "dayzps";
  return `/games/${username}/noftp/${folder}/config`;
}

function mapNitradoService(raw: any): NitradoServiceOption | null {
  const id = firstText(raw?.id, raw?.service_id, raw?.serviceId);
  if (!id) return null;
  const details = raw?.details && typeof raw.details === "object" ? raw.details : {};
  const name = firstText(
    raw?.name,
    raw?.comment,
    details?.name,
    details?.game_human,
    details?.product,
    raw?.username,
  ) || `Nitrado service ${id}`;
  return {
    id,
    name,
    status: firstText(raw?.status, raw?.status_text, details?.status),
    type: firstText(raw?.type, raw?.service_type, details?.type),
    game: firstText(raw?.game, raw?.game_human, details?.game, details?.game_human, details?.product),
    username: firstText(raw?.username, details?.username),
    detectedBaseDir: detectNitradoBaseDir(raw),
  };
}


export async function testOrganizationNitradoCredential(tokenInput: unknown) {
  const token = String(tokenInput || "").trim();
  if (!token) throw new Error("Informe o token Nitrado.");
  const response = await globalThis.fetch(`${NITRADO_API_BASE}/services`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  recordNetworkTransfer({
    service: "nitrado-onboarding",
    operation: "GET /services credential-test",
    direction: "outbound",
    bytes: 0,
    ok: response.ok,
  });
  recordNetworkTransfer({
    service: "nitrado-onboarding",
    operation: "GET /services credential-test",
    direction: "inbound",
    bytes: Buffer.byteLength(text, "utf8"),
    ok: response.ok,
  });
  if (!response.ok) throw new Error(`Nitrado HTTP ${response.status}. O token nao foi aceito.`);
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error("A Nitrado retornou uma resposta invalida."); }
  const rawServices: unknown[] = Array.isArray(json?.data?.services)
    ? json.data.services
    : Array.isArray(json?.services)
      ? json.services
      : Array.isArray(json?.data)
        ? json.data
        : [];
  const services = rawServices.map(mapNitradoService).filter((service): service is NitradoServiceOption => Boolean(service));
  return {
    validatedAt: new Date().toISOString(),
    serviceCount: services.length,
    dayzServiceCount: services.filter((service) => /dayz/i.test(`${service.name} ${service.game || ""}`)).length,
  };
}


export async function discoverOrganizationNitradoServices(organizationIdInput: unknown) {
  const organizationId = String(organizationIdInput || "").trim();
  if (!organizationId) throw new Error("Organization invalida.");
  const credential = getOrganizationNitradoCredential(organizationId);
  if (!credential.token) throw new Error("Conecte sua conta Nitrado antes de buscar os servidores.");
  const response = await globalThis.fetch(`${NITRADO_API_BASE}/services`, { headers: { Authorization: `Bearer ${credential.token}` } });
  const text = await response.text();
  recordNetworkTransfer({ service: "nitrado-onboarding", operation: "GET /services admin-discovery", direction: "outbound", bytes: 0, ok: response.ok });
  recordNetworkTransfer({ service: "nitrado-onboarding", operation: "GET /services admin-discovery", direction: "inbound", bytes: Buffer.byteLength(text, "utf8"), ok: response.ok });
  if (!response.ok) throw new Error(`Nitrado HTTP ${response.status}. O token nao foi aceito.`);
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error("A Nitrado retornou uma resposta invalida."); }
  const rawServices: unknown[] = Array.isArray(json?.data?.services) ? json.data.services : Array.isArray(json?.services) ? json.services : Array.isArray(json?.data) ? json.data : [];
  const assigned = new Map(listManagedServers().filter((server) => server.integrations.nitradoServiceId).map((server) => [String(server.integrations.nitradoServiceId), server] as const));
  const services = rawServices.map(mapNitradoService).filter((service): service is NitradoServiceOption => Boolean(service)).filter((service) => /dayz/i.test(`${service.name} ${service.game || ""}`)).map((service) => {
    const owner = assigned.get(service.id);
    return owner ? { ...service, assignedServerId: owner.id, assignedServerName: owner.name } : service;
  }).sort((a,b) => a.name.localeCompare(b.name)).slice(0,100);
  return { services };
}

export function getIntegrationOnboardingStatus(serverId = getPrimaryServerId()) {
  const server = getManagedServerById(serverId) || getPrimaryServerDescriptor();
  const nitradoStatus = getOrganizationIntegrationStatus(server.organizationId);
  return {
    mode: "on-demand" as const,
    backgroundPolling: false,
    organizationId: server.organizationId,
    nitrado: {
      credentialSource: nitradoStatus.credentialSource,
      tokenConfigured: nitradoStatus.configured,
      encryptedAtRest: nitradoStatus.encryptedAtRest,
      tokenExposedToBrowser: false,
    },
    discord: {
      botConfigured: Boolean(process.env.DISCORD_TOKEN),
      credentialModel: "platform-bot" as const,
      discoveryMode: "bot-cache/on-demand" as const,
    },
  };
}

export async function discoverNitradoServices(serverId: string) {
  const onboardingServer = assertOnboardingServer(serverId);
  const json = await nitradoOnboardingJson("/services", serverId);
  const rawServices: unknown[] = Array.isArray(json?.data?.services)
    ? json.data.services
    : Array.isArray(json?.services)
      ? json.services
      : Array.isArray(json?.data)
        ? json.data
        : [];
  const assignedByServiceId = new Map(
    listManagedServers()
      .filter((server) => server.id !== serverId && server.integrations.nitradoServiceId)
      .map((server) => [String(server.integrations.nitradoServiceId), {
        id: server.organizationId === onboardingServer.organizationId ? server.id : "assigned",
        name: server.organizationId === onboardingServer.organizationId ? server.name : "Outro workspace",
      }] as const),
  );
  const services = rawServices
    .map(mapNitradoService)
    .filter((service: NitradoServiceOption | null): service is NitradoServiceOption => Boolean(service))
    .map((service) => {
      const assigned = assignedByServiceId.get(service.id);
      return assigned
        ? { ...service, assignedServerId: assigned.id, assignedServerName: assigned.name }
        : service;
    })
    .sort((a, b) => {
      const aDayz = /dayz/i.test(`${a.name} ${a.game || ""}`) ? 1 : 0;
      const bDayz = /dayz/i.test(`${b.name} ${b.game || ""}`) ? 1 : 0;
      return bDayz - aDayz || a.name.localeCompare(b.name);
    })
    .slice(0, 100);
  return { services, connection: getIntegrationOnboardingStatus(serverId).nitrado };
}


function normalizeMissionRelativePath(value: unknown) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function nitradoEntryPath(entry: any) {
  return firstText(entry?.path, entry?.name, entry?.file, entry?.filename) || "";
}

async function listNitradoMissionDirectory(serverId: string, serviceId: string, dir: string) {
  try {
    const json = await nitradoOnboardingJson(
      `/services/${encodeURIComponent(serviceId)}/gameservers/file_server/list?dir=${encodeURIComponent(dir)}`,
      serverId,
    );
    return Array.isArray(json?.data?.entries) ? json.data.entries : [];
  } catch {
    return [];
  }
}

/**
 * Discovers the editable DayZ mission directory from this server's own Nitrado
 * file server. This never falls back to the primary server mission path.
 */
async function discoverNitradoMissionDirFor(
  serverId: string,
  serviceIdInput: unknown,
  baseDirInput: unknown,
): Promise<string | undefined> {
  const serviceId = String(serviceIdInput || "").trim();
  const baseDir = String(baseDirInput || "").trim().replace(/\\/g, "/");
  if (!serviceId || !baseDir) return undefined;

  const platform = /\/dayzxb\//i.test(baseDir) ? "dayzxb" : "dayzps";
  const roots = [`${platform}_missions`, `${platform}_mission`];
  const noftpIndex = baseDir.toLowerCase().indexOf("/noftp/");
  const noftpRoot = noftpIndex >= 0 ? baseDir.slice(0, noftpIndex + "/noftp".length) : "";
  const missionNames = new Set(["dayzOffline.chernarusplus", "dayzOffline.enoch", "dayzOffline.sakhal"]);

  for (const root of roots) {
    const rootCandidates = [root, noftpRoot ? `${noftpRoot}/${root}` : ""].filter(Boolean);
    for (const rootDir of rootCandidates) {
      const entries = await listNitradoMissionDirectory(serverId, serviceId, rootDir);
      for (const entry of entries) {
        const raw = normalizeMissionRelativePath(nitradoEntryPath(entry));
        if (!raw) continue;
        const parts = raw.split("/").filter(Boolean);
        const name = parts[parts.length - 1];
        if (!name || !name.includes(".")) continue;
        missionNames.add(name);
      }
    }

    for (const missionName of missionNames) {
      const relative = `${root}/${missionName}`;
      const candidateDirs = [relative, noftpRoot ? `${noftpRoot}/${relative}` : ""].filter(Boolean);
      for (const candidateDir of candidateDirs) {
        const entries = await listNitradoMissionDirectory(serverId, serviceId, candidateDir);
        const names = entries.map((entry: any) => normalizeMissionRelativePath(nitradoEntryPath(entry)).split("/").pop()?.toLowerCase() || "");
        if (names.includes("cfgeventspawns.xml") && (names.includes("db") || names.includes("cfgplayerspawnpoints.xml") || names.includes("cfgspawnabletypes.xml"))) {
          return relative;
        }
      }
    }
  }

  return undefined;
}

/**
 * Discovers the editable DayZ mission directory from this server's own Nitrado
 * file server. This never falls back to the primary server mission path.
 */
export async function discoverNitradoMissionDir(serverId: string): Promise<string | undefined> {
  const server = assertOnboardingServer(serverId);
  return discoverNitradoMissionDirFor(
    serverId,
    server.integrations.nitradoServiceId || server.runtime.nitradoValidation?.serviceId,
    server.runtime.nitradoBaseDir || server.runtime.nitradoValidation?.baseDir,
  );
}

export async function validateNitradoServiceSetup(serverId: string, serviceIdInput: unknown, baseDirInput: unknown) {
  assertOnboardingServer(serverId);
  const serviceId = String(serviceIdInput || "").trim();
  if (!/^\d+$/.test(serviceId)) throw new Error("Selecione um Nitrado Service ID valido.");

  const details = await nitradoOnboardingJson(`/services/${encodeURIComponent(serviceId)}/gameservers`, serverId);
  const detectedBaseDir = detectNitradoBaseDir(details);
  const baseDir = String(baseDirInput || detectedBaseDir || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!baseDir) {
    throw new Error("Nao foi possivel detectar o base dir automaticamente. Informe o caminho do config e tente validar novamente.");
  }
  if (!/\/noftp\/(?:dayzps|dayzxb)\/config$/i.test(baseDir)) {
    throw new Error("O base dir precisa apontar para o diretorio config de um servidor DayZ (dayzps ou dayzxb).");
  }

  const listJson = await nitradoOnboardingJson(
    `/services/${encodeURIComponent(serviceId)}/gameservers/file_server/list?dir=${encodeURIComponent(baseDir)}`,
    serverId,
  );
  const entries = Array.isArray(listJson?.data?.entries) ? listJson.data.entries : [];
  const admFilesFound = entries.filter((entry: any) => String(entry?.path || "").toUpperCase().endsWith(".ADM")).length;
  const gameText = collectObjectStrings(details).join(" ");
  const missionDir = await discoverNitradoMissionDirFor(serverId, serviceId, baseDir);
  return {
    serviceId,
    baseDir,
    missionDir,
    detectedBaseDir,
    looksLikeDayz: /dayz/i.test(gameText),
    admFilesFound,
    validatedAt: new Date().toISOString(),
  };
}

export async function listDiscordGuildOptions(serverId: string, requesterDiscordId?: string) {
  const server = assertOnboardingServer(serverId);
  const client = getDiscordClient();
  if (!client.isReady()) {
    return { ready: false, guilds: [] as DiscordGuildOption[], message: "Discord bot ainda nao esta conectado." };
  }
  const assigned = new Map(
    listManagedServers()
      .filter((candidate) => candidate.integrations.discordGuildId)
      .map((candidate) => [String(candidate.integrations.discordGuildId), candidate] as const),
  );
  const guilds: DiscordGuildOption[] = [];
  for (const guild of client.guilds.cache.values()) {
    const owner = assigned.get(guild.id);
    if (owner && owner.organizationId !== server.organizationId) continue;
    if (!owner && requesterDiscordId) {
      try {
        const member = guild.members.cache.get(requesterDiscordId) || await guild.members.fetch(requesterDiscordId);
        const canManage = member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);
        if (!canManage) continue;
      } catch {
        continue;
      }
    }
    guilds.push({
      id: guild.id,
      name: guild.name,
      memberCount: Number(guild.memberCount || 0),
      iconUrl: guild.iconURL({ extension: "png", size: 64 }) || undefined,
    });
  }
  guilds.sort((a, b) => a.name.localeCompare(b.name));
  return { ready: true, guilds, message: guilds.length ? undefined : "Nenhum servidor Discord elegivel foi encontrado para esta organizacao." };
}

export async function listDiscordGuildChannels(serverId: string, guildIdInput: unknown, requesterDiscordId?: string) {
  const server = assertOnboardingServer(serverId);
  const guildId = String(guildIdInput || "").trim();
  if (!guildId) throw new Error("Selecione um servidor Discord.");
  const client = getDiscordClient();
  if (!client.isReady()) throw new Error("Discord bot ainda nao esta conectado.");

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
  if (!guild) throw new Error("Discord guild nao encontrada para este bot.");
  const assigned = listManagedServers().find((candidate) => candidate.integrations.discordGuildId === guildId);
  if (assigned && assigned.organizationId !== server.organizationId) {
    throw new Error("Este servidor Discord pertence a outra organizacao.");
  }
  if (!assigned && requesterDiscordId) {
    let member;
    try { member = guild.members.cache.get(requesterDiscordId) || await guild.members.fetch(requesterDiscordId); } catch { member = null; }
    const canManage = Boolean(member && (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)));
    if (!canManage) throw new Error("Sua conta precisa ter Manage Server ou Administrator neste Discord para conecta-lo.");
  }
  const fetched = await guild.channels.fetch();
  const channels: DiscordChannelOption[] = [];
  fetched.forEach((channel) => {
    if (!channel) return;
    if (channel.type === ChannelType.GuildCategory) {
      channels.push({ id: channel.id, name: channel.name, type: "category" });
      return;
    }
    if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
      channels.push({ id: channel.id, name: channel.name, type: "text", parentId: channel.parentId || undefined });
    }
  });
  channels.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { guild: { id: guild.id, name: guild.name }, channels };
}
