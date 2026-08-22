import { ChannelType } from "discord.js";
import { getDiscordClient } from "./discordBot";
import { recordNetworkTransfer } from "./networkMetrics";
import { getManagedServerById, getPrimaryServerId, listManagedServers } from "./serverRegistry";

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

function requireNitradoToken() {
  const token = String(process.env.NITRADO_TOKEN || "").trim();
  if (!token) {
    throw new Error("NITRADO_TOKEN nao esta configurado no ambiente. A Fase 10 reutiliza a conexao segura atual do PZ e nunca envia o token para o navegador.");
  }
  return token;
}

async function nitradoOnboardingJson(pathname: string) {
  const token = requireNitradoToken();
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

export function getIntegrationOnboardingStatus() {
  return {
    mode: "on-demand" as const,
    backgroundPolling: false,
    nitrado: {
      credentialSource: process.env.NITRADO_TOKEN ? "environment" as const : "missing" as const,
      tokenConfigured: Boolean(process.env.NITRADO_TOKEN),
      tokenExposedToBrowser: false,
    },
    discord: {
      botConfigured: Boolean(process.env.DISCORD_TOKEN),
      discoveryMode: "bot-cache/on-demand" as const,
    },
  };
}

export async function discoverNitradoServices(serverId: string) {
  assertOnboardingServer(serverId);
  const json = await nitradoOnboardingJson("/services");
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
      .map((server) => [String(server.integrations.nitradoServiceId), { id: server.id, name: server.name }] as const),
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
  return { services, connection: getIntegrationOnboardingStatus().nitrado };
}

export async function validateNitradoServiceSetup(serverId: string, serviceIdInput: unknown, baseDirInput: unknown) {
  assertOnboardingServer(serverId);
  const serviceId = String(serviceIdInput || "").trim();
  if (!/^\d+$/.test(serviceId)) throw new Error("Selecione um Nitrado Service ID valido.");

  const details = await nitradoOnboardingJson(`/services/${encodeURIComponent(serviceId)}/gameservers`);
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
  );
  const entries = Array.isArray(listJson?.data?.entries) ? listJson.data.entries : [];
  const admFilesFound = entries.filter((entry: any) => String(entry?.path || "").toUpperCase().endsWith(".ADM")).length;
  const gameText = collectObjectStrings(details).join(" ");
  return {
    serviceId,
    baseDir,
    detectedBaseDir,
    looksLikeDayz: /dayz/i.test(gameText),
    admFilesFound,
    validatedAt: new Date().toISOString(),
  };
}

export function listDiscordGuildOptions(serverId: string) {
  assertOnboardingServer(serverId);
  const client = getDiscordClient();
  if (!client.isReady()) {
    return { ready: false, guilds: [] as DiscordGuildOption[], message: "Discord bot ainda nao esta conectado." };
  }
  const guilds = client.guilds.cache
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      memberCount: Number(guild.memberCount || 0),
      iconUrl: guild.iconURL({ extension: "png", size: 64 }) || undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ready: true, guilds, message: guilds.length ? undefined : "O bot nao esta em nenhuma guild disponivel." };
}

export async function listDiscordGuildChannels(serverId: string, guildIdInput: unknown) {
  assertOnboardingServer(serverId);
  const guildId = String(guildIdInput || "").trim();
  if (!guildId) throw new Error("Selecione um servidor Discord.");
  const client = getDiscordClient();
  if (!client.isReady()) throw new Error("Discord bot ainda nao esta conectado.");

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
  if (!guild) throw new Error("Discord guild nao encontrada para este bot.");
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
