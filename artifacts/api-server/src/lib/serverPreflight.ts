import {
  getManagedServerActivationConfigSignature,
  getManagedServerById,
  getServerFoundationDiagnostics,
  listManagedServers,
  setServerNamespacePersistenceStatus,
  type ManagedServerDescriptor,
  type ServerActivationPreflight,
  type ServerDiscordRuntimeConfig,
} from "./serverRegistry";
import { getServerStoragePlan, runInServerMaintenanceContext } from "./serverRuntime";
import {
  listDiscordGuildChannels,
  listDiscordGuildOptions,
  validateNitradoServiceSetup,
  type DiscordChannelOption,
  type DiscordGuildOption,
} from "./serverIntegrations";
import { inspectLivePersistenceFoundation } from "./persistenceFoundationCheck";
import {
  getStateAsync,
  inspectManagedServerNamespaceRows,
  markManagedServerActivationPreflightReady,
  markManagedServerNitradoValidated,
} from "./state";

export type ServerActivationPreflightCheckStatus = "pass" | "warning" | "fail" | "skipped";
export type ServerActivationPreflightCheck = { id: string; label: string; status: ServerActivationPreflightCheckStatus; message: string; details?: Record<string, unknown> };
export type ServerActivationPreflightResult = {
  serverId: string; passed: boolean; checkedAt: string; ready: boolean; warningCount: number; failureCount: number;
  checks: ServerActivationPreflightCheck[]; runtimeActivationBlocked: boolean; activationEndpointAvailable: boolean; server?: ManagedServerDescriptor;
};

function text(value: unknown) { return String(value || "").trim(); }
function pushCheck(checks: ServerActivationPreflightCheck[], id: string, label: string, status: ServerActivationPreflightCheckStatus, message: string, details?: Record<string, unknown>) {
  checks.push({ id, label, status, message, ...(details ? { details } : {}) });
}
function normalizeLocalPath(value: string) { return String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/"); }

const DISCORD_CHANNEL_EXPECTATIONS: Array<{ key: keyof ServerDiscordRuntimeConfig; label: string; type: "text" | "category" }> = [
  { key: "globalChannelId", label: "Global ranking", type: "text" }, { key: "dailyChannelId", label: "Daily ranking", type: "text" },
  { key: "weeklyChannelId", label: "Weekly ranking", type: "text" }, { key: "onlineListChannelId", label: "Online list", type: "text" },
  { key: "killfeedChannelId", label: "Killfeed", type: "text" }, { key: "killStreakChannelId", label: "Killstreak feed", type: "text" },
  { key: "longShotChannelId", label: "Longshot feed", type: "text" }, { key: "longShotRankingChannelId", label: "Longshot ranking", type: "text" },
  { key: "streakRankingChannelId", label: "Streak ranking", type: "text" }, { key: "onlineCategoryId", label: "Online category", type: "category" },
  { key: "matchCategoryId", label: "Match category", type: "category" }, { key: "memberFeedChannelId", label: "Member feed", type: "text" },
];

async function waitForDiscordReady(timeoutMs = 15000) {
  const discord = await import("./discordBot");
  const client = discord.getDiscordClient();
  const initialDiagnostics = discord.getDiscordGatewayDiagnostics();
  console.log("[preflight][discord] início da validação Gateway", initialDiagnostics);

  if (initialDiagnostics.ready) {
    console.log("[preflight][discord] Gateway já estava READY", initialDiagnostics);
    return true;
  }
  if (!process.env.DISCORD_TOKEN) {
    console.error("[preflight][discord] Gateway não iniciado: DISCORD_TOKEN ausente", initialDiagnostics);
    return false;
  }

  try {
    console.log("[preflight][discord] chamando startDiscordBot", initialDiagnostics);
    await discord.startDiscordBot();
    console.log("[preflight][discord] startDiscordBot resolveu", discord.getDiscordGatewayDiagnostics());
  } catch (error) {
    console.error("[preflight][discord] startDiscordBot falhou", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      diagnostics: discord.getDiscordGatewayDiagnostics(),
    });
    return false;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const diagnostics = discord.getDiscordGatewayDiagnostics();
    if (diagnostics.ready && client.isReady()) {
      console.log("[preflight][discord] Gateway READY confirmado", diagnostics);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const finalDiagnostics = discord.getDiscordGatewayDiagnostics();
  console.error("[preflight][discord] timeout aguardando READY", finalDiagnostics);
  return finalDiagnostics.ready && client.isReady();
}

async function validateOptionalDiscord(server: ManagedServerDescriptor, checks: ServerActivationPreflightCheck[]) {
  const guildId = text(server.integrations.discordGuildId);
  if (!guildId) { pushCheck(checks, "discord", "Discord", "skipped", "Discord nao esta configurado e continua opcional para o runtime core."); return; }

  console.log("[preflight][discord] validando guild configurada", { serverId: server.id, guildId });
  const ready = await waitForDiscordReady();
  const discord = await import("./discordBot");
  const diagnostics = discord.getDiscordGatewayDiagnostics();
  console.log("[preflight][discord] resultado da prontidão", { serverId: server.id, guildId, ready, diagnostics });

  let options: Awaited<ReturnType<typeof listDiscordGuildOptions>>;
  try {
    options = ready
      ? await listDiscordGuildOptions(server.id)
      : { ready: false, guilds: [] as DiscordGuildOption[], message: diagnostics.lastLoginError || (process.env.DISCORD_TOKEN ? "O bot Discord nao ficou pronto apos iniciar o Gateway." : "DISCORD_TOKEN nao esta configurado no processo.") };
    console.log("[preflight][discord] guild options retornadas", {
      serverId: server.id,
      guildId,
      ready: options.ready,
      guildCount: options.guilds.length,
      guilds: options.guilds.map((guild) => ({ id: guild.id, name: guild.name })),
      message: options.message || null,
    });
  } catch (error) {
    console.error("[preflight][discord] listDiscordGuildOptions falhou", {
      serverId: server.id,
      guildId,
      diagnostics,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    pushCheck(checks, "discord", "Discord", "fail", error instanceof Error ? error.message : String(error), { guildId, ...diagnostics });
    return;
  }

  if (!options.ready) {
    pushCheck(checks, "discord", "Discord", "fail", options.message || "Uma guild foi configurada, mas o bot Discord nao esta conectado.", {
      tokenConfigured: Boolean(process.env.DISCORD_TOKEN),
      clientReady: diagnostics.clientIsReady,
      gatewayReady: diagnostics.gatewayReadyFlag,
      ready: diagnostics.ready,
      loginInFlight: diagnostics.loginInFlight,
      lastLoginError: diagnostics.lastLoginError,
    });
    return;
  }
  const guild = options.guilds.find((candidate: DiscordGuildOption) => candidate.id === guildId);
  if (!guild) { pushCheck(checks, "discord", "Discord", "fail", "A guild configurada nao esta acessivel pelo bot atual.", { guildId, accessibleGuildCount: options.guilds.length }); return; }
  let channelsResult: Awaited<ReturnType<typeof listDiscordGuildChannels>>;
  try { channelsResult = await listDiscordGuildChannels(server.id, guildId); }
  catch (error) { pushCheck(checks, "discord", "Discord", "fail", error instanceof Error ? error.message : String(error)); return; }
  const channelsById = new Map<string, DiscordChannelOption>(channelsResult.channels.map((channel: DiscordChannelOption) => [channel.id, channel] as const));
  const invalidMappings: string[] = []; let configuredMappings = 0;
  for (const expectation of DISCORD_CHANNEL_EXPECTATIONS) {
    const channelId = text(server.runtime.discord?.[expectation.key]); if (!channelId) continue;
    configuredMappings += 1; const channel = channelsById.get(channelId); if (!channel || channel.type !== expectation.type) invalidMappings.push(expectation.label);
  }
  if (invalidMappings.length) { pushCheck(checks, "discord", "Discord", "fail", `A guild esta acessivel, mas existem mapeamentos invalidos: ${invalidMappings.join(", ")}.`, { guildId, invalidMappings }); return; }
  pushCheck(checks, "discord", "Discord", "pass", configuredMappings ? `Guild acessivel e ${configuredMappings} mapeamento(s) configurado(s) continuam validos.` : "Guild acessivel. Nenhum canal e obrigatorio para o runtime core.", { guildId, guildName: guild.name, configuredMappings });
}

export async function runManagedServerActivationPreflight(serverIdInput: string): Promise<ServerActivationPreflightResult> {
  const serverId = text(serverIdInput); const checkedAt = new Date().toISOString(); const checks: ServerActivationPreflightCheck[] = [];
  let server = getManagedServerById(serverId);
  if (!server) {
    pushCheck(checks, "registry", "Server registry", "fail", `Servidor ${serverId || "desconhecido"} nao encontrado.`);
    return { serverId, passed: false, checkedAt, ready: false, warningCount: 0, failureCount: 1, checks, runtimeActivationBlocked: false, activationEndpointAvailable: true };
  }

  let foundation = getServerFoundationDiagnostics(); const allServers = listManagedServers();
  const runtimeGateSafe = !server.runtimeEnabled && foundation.additionalServersEnabled === true && foundation.onboarding?.activationEndpointEnabled === true;
  pushCheck(checks, "runtime-gate", "Runtime gate", runtimeGateSafe ? "pass" : "fail", runtimeGateSafe ? "O servidor alvo continua parado; a Fase 12 permite ativacao somente depois deste gate." : "O servidor alvo ja esta executando ou o activation gate da Fase 12 nao esta disponivel.", { runtimeEnabled: server.runtimeEnabled, runtimeRows: Number(foundation.onboarding?.runtimeEnabledServers || 0), additionalServersEnabled: foundation.additionalServersEnabled });

  const targetServerId = server.id; const configuredDiscordGuildId = text(server.integrations.discordGuildId); let serviceId = text(server.integrations.nitradoServiceId); let baseDir = text(server.runtime.nitradoBaseDir);
  const duplicateService = serviceId ? allServers.find((candidate: ManagedServerDescriptor) => candidate.id !== targetServerId && text(candidate.integrations.nitradoServiceId) === serviceId) : undefined;
  const duplicateGuild = configuredDiscordGuildId ? allServers.find((candidate: ManagedServerDescriptor) => candidate.id !== targetServerId && text(candidate.integrations.discordGuildId) === configuredDiscordGuildId) : undefined;
  const uniqueRouting = !duplicateService && !duplicateGuild;

  let validation = server.runtime.nitradoValidation;
  let nitradoMetadataValid = Boolean(serviceId && baseDir && validation && validation.serviceId === serviceId && validation.baseDir === baseDir && validation.validatedAt);
  let prefetchedNitradoValidation: Awaited<ReturnType<typeof validateNitradoServiceSetup>> | undefined; let validationRecovered = false; let validationRecoveryError = "";
  if (!nitradoMetadataValid && serviceId && baseDir && uniqueRouting) {
    try {
      prefetchedNitradoValidation = await validateNitradoServiceSetup(server.id, serviceId, baseDir);
      server = await markManagedServerNitradoValidated(server.id, { serviceId: prefetchedNitradoValidation.serviceId, baseDir: prefetchedNitradoValidation.baseDir });
      serviceId = text(server.integrations.nitradoServiceId); baseDir = text(server.runtime.nitradoBaseDir); validation = server.runtime.nitradoValidation;
      nitradoMetadataValid = Boolean(serviceId && baseDir && validation && validation.serviceId === serviceId && validation.baseDir === baseDir && validation.validatedAt); validationRecovered = nitradoMetadataValid;
    } catch (error) { validationRecoveryError = error instanceof Error ? error.message : String(error); }
  }
  pushCheck(checks, "nitrado-metadata", "Nitrado configuration", nitradoMetadataValid ? "pass" : "fail", nitradoMetadataValid ? (validationRecovered ? `Service ${serviceId} foi revalidado e a marcacao persistida foi reconciliada para o base dir atual.` : `Service ${serviceId} possui validacao salva para o base dir atual.`) : (validationRecoveryError || "Valide Service ID + base dir na etapa Nitrado antes do preflight."));
  pushCheck(checks, "routing-uniqueness", "Integration ownership", uniqueRouting ? "pass" : "fail", uniqueRouting ? "Nitrado Service ID e Discord Guild ID nao colidem com outro servidor cadastrado." : `Existe uma integracao reutilizada por outro servidor${duplicateService ? ` (Nitrado: ${duplicateService.name})` : ""}${duplicateGuild ? ` (Discord: ${duplicateGuild.name})` : ""}.`);

  const targetStorage = getServerStoragePlan(server.id); const targetAdmLogDir = normalizeLocalPath(targetStorage.admLogDir); const targetManifest = normalizeLocalPath(targetStorage.admManifestFile); const targetState = normalizeLocalPath(targetStorage.stateFile);
  const admNamespaceMarker = `/adm_servers/${server.id}/`; const stateNamespaceMarker = `/state_servers/${server.id}/`;
  const storageIsolated = !targetStorage.isPrimary && targetAdmLogDir.includes(admNamespaceMarker) && targetManifest.includes(admNamespaceMarker) && targetState.includes(stateNamespaceMarker);
  pushCheck(checks, "storage-plan", "Local storage plan", storageIsolated ? "pass" : "fail", storageIsolated ? "ADM cache, manifest e state apontam para paths exclusivos do servidor cadastrado." : "Um dos paths planejados saiu do namespace esperado do servidor cadastrado.", { admLogDir: targetStorage.admLogDir, admManifestFile: targetStorage.admManifestFile, stateFile: targetStorage.stateFile });

  let namespaceRows = { botState: 0, playerStats: 0, positionHistory: 0 };
  let liveFoundation: Awaited<ReturnType<typeof inspectLivePersistenceFoundation>> | undefined;
  try {
    await runInServerMaintenanceContext(server.id, () => getStateAsync());
    namespaceRows = await inspectManagedServerNamespaceRows(server.id);
    foundation = getServerFoundationDiagnostics();
    try {
      liveFoundation = await inspectLivePersistenceFoundation(server.id);
      if (liveFoundation.botStateTableReady && liveFoundation.playerStatsTableReady) {
        setServerNamespacePersistenceStatus({ enabled: true, initialized: true, botStateTableReady: true, playerStatsTableReady: true, botStateCompositeKeyReady: liveFoundation.botStatePrimaryKeyReady, playerStatsCompositeKeyReady: liveFoundation.playerStatsPrimaryKeyReady, botStatePrimaryKeyReady: liveFoundation.botStatePrimaryKeyReady, playerStatsPrimaryKeyReady: liveFoundation.playerStatsPrimaryKeyReady, primaryKeyCutoverComplete: liveFoundation.botStatePrimaryKeyReady && liveFoundation.playerStatsPrimaryKeyReady, scopedReadsEnabled: liveFoundation.botStatePrimaryKeyReady, botStateUntaggedRows: liveFoundation.botStateUntaggedRows, playerStatsUntaggedRows: liveFoundation.playerStatsUntaggedRows, lastCheckedAt: new Date().toISOString(), lastError: undefined });
        foundation = getServerFoundationDiagnostics();
      }
      pushCheck(checks, "database-live", "Database live foundation", liveFoundation.safe ? "pass" : "fail", liveFoundation.safe ? "PostgreSQL confirma registry, tabelas, PKs compostas e ausencia de rows sem server_id." : "PostgreSQL ainda reporta uma garantia estrutural pendente.", { registryPersisted: liveFoundation.registryPersisted, botStateTableReady: liveFoundation.botStateTableReady, playerStatsTableReady: liveFoundation.playerStatsTableReady, botStatePrimaryKeyReady: liveFoundation.botStatePrimaryKeyReady, playerStatsPrimaryKeyReady: liveFoundation.playerStatsPrimaryKeyReady, botStateUntaggedRows: liveFoundation.botStateUntaggedRows, playerStatsUntaggedRows: liveFoundation.playerStatsUntaggedRows });
    } catch (error) { pushCheck(checks, "database-live", "Database live foundation", "fail", error instanceof Error ? error.message : String(error)); }
    const firstActivation = !server.runtime.activation?.everActivated;
    pushCheck(checks, "namespace-owned", "Database namespace", "pass", firstActivation ? `Namespace exclusivo do servidor confirmado antes da primeira ativacao (${namespaceRows.botState}/${namespaceRows.playerStats}/${namespaceRows.positionHistory}). Rows de onboarding podem ser reutilizadas com seguranca.` : "O servidor ja foi ativado anteriormente; as rows existentes permanecem no proprio namespace.", namespaceRows);
  } catch (error) { pushCheck(checks, "namespace-owned", "Database namespace", "fail", error instanceof Error ? error.message : String(error)); }

  const namespace = foundation.namespace;
  const databaseFoundationSafe = Boolean(liveFoundation?.safe && namespace?.scopedReadsEnabled && namespace?.botStatePrimaryKeyReady && (!namespace?.playerStatsTableReady || namespace.playerStatsPrimaryKeyReady) && namespace?.botStateUntaggedRows === 0 && (!namespace?.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0));
  pushCheck(checks, "database-foundation", "Isolation foundation", databaseFoundationSafe ? "pass" : "fail", databaseFoundationSafe ? "PKs, scoped persistence, server-tagged rows e caches persistidos estao preparados para isolamento por servidor." : "A fundacao persistida de isolamento por servidor ainda possui uma garantia estrutural pendente.", { liveFoundationSafe: liveFoundation?.safe, liveRegistryPersisted: liveFoundation?.registryPersisted, liveBotStatePrimaryKeyReady: liveFoundation?.botStatePrimaryKeyReady, livePlayerStatsPrimaryKeyReady: liveFoundation?.playerStatsPrimaryKeyReady, liveBotStateUntaggedRows: liveFoundation?.botStateUntaggedRows, playerStatsUntaggedRows: liveFoundation?.playerStatsUntaggedRows, scopedReadsEnabled: namespace?.scopedReadsEnabled, botStatePrimaryKeyReady: namespace?.botStatePrimaryKeyReady, playerStatsPrimaryKeyReady: namespace?.playerStatsPrimaryKeyReady, botStateUntaggedRows: namespace?.botStateUntaggedRows, playerStatsUntaggedRows: namespace?.playerStatsUntaggedRows });

  if (nitradoMetadataValid && uniqueRouting) {
    try {
      const remote = prefetchedNitradoValidation || await validateNitradoServiceSetup(server.id, serviceId, baseDir); const sameRouting = remote.serviceId === serviceId && remote.baseDir === baseDir;
      pushCheck(checks, "nitrado-live", "Nitrado live routing", sameRouting ? "pass" : "fail", sameRouting ? "Service ID e base dir conferem com a rota Nitrado validada agora." : "A rota Nitrado retornada nao confere com o servidor cadastrado.", { remoteServiceId: remote.serviceId, remoteBaseDir: remote.baseDir });
    } catch (error) { pushCheck(checks, "nitrado-live", "Nitrado live routing", "fail", error instanceof Error ? error.message : String(error)); }
  } else pushCheck(checks, "nitrado-live", "Nitrado live routing", "skipped", "A rota Nitrado live depende da validacao e unicidade anteriores.");

  await validateOptionalDiscord(server, checks);

  const failureCount = checks.filter((check) => check.status === "fail").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const passed = failureCount === 0;
  let readyServer: ManagedServerDescriptor | undefined;
  if (passed) {
    const preflight: ServerActivationPreflight = {
      version: "phase11-v1",
      source: "phase11-on-demand",
      checkedAt,
      passed: true,
      configurationSignature: getManagedServerActivationConfigSignature(server),
      serviceId,
      baseDir,
      discordGuildId: text(server.integrations.discordGuildId) || undefined,
      namespaceRows,
      warningCount,
    };
    readyServer = await markManagedServerActivationPreflightReady(server.id, preflight);
  }
  return { serverId, passed, checkedAt, ready: passed, warningCount, failureCount, checks, runtimeActivationBlocked: !passed, activationEndpointAvailable: true, server: readyServer || getManagedServerById(server.id) };
}
