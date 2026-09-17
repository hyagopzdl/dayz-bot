import {
  getManagedServerActivationConfigSignature,
  getManagedServerById,
  getServerFoundationDiagnostics,
  listManagedServers,
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

async function validateOptionalDiscord(server: ManagedServerDescriptor, checks: ServerActivationPreflightCheck[]) {
  const guildId = text(server.integrations.discordGuildId);
  if (!guildId) { pushCheck(checks, "discord", "Discord", "skipped", "Discord nao esta configurado e continua opcional para o runtime core."); return; }
  const options = await listDiscordGuildOptions(server.id);
  if (!options.ready) { pushCheck(checks, "discord", "Discord", "fail", "Uma guild foi configurada, mas o bot Discord nao esta conectado."); return; }
  const guild = options.guilds.find((candidate: DiscordGuildOption) => candidate.id === guildId);
  if (!guild) { pushCheck(checks, "discord", "Discord", "fail", "A guild configurada nao esta acessivel pelo bot atual.", { guildId }); return; }
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
  try {
    // The preflight must initialize every persistence component whose readiness is
    // part of the runtime gate. Merely inspecting rows is insufficient because the
    // player_stats PK/cutover flags are initialized by the granular persistence boot.
    await runInServerMaintenanceContext(server.id, () => getStateAsync());
    namespaceRows = await inspectManagedServerNamespaceRows(server.id);
    // Namespace inspection initializes/refreshes the live isolation diagnostics. Re-read
    // the foundation after that I/O so the gate never evaluates a stale startup snapshot.
    foundation = getServerFoundationDiagnostics();
    const firstActivation = !server.runtime.activation?.everActivated;
    pushCheck(checks, "namespace-owned", "Database namespace", "pass", firstActivation ? `Namespace exclusivo do servidor confirmado antes da primeira ativacao (${namespaceRows.botState}/${namespaceRows.playerStats}/${namespaceRows.positionHistory}). Rows de onboarding podem ser reutilizadas com seguranca.` : "O servidor ja foi ativado anteriormente; as rows existentes permanecem no proprio namespace.", namespaceRows);
  } catch (error) { pushCheck(checks, "namespace-owned", "Database namespace", "fail", error instanceof Error ? error.message : String(error)); }

  const namespace = foundation.namespace;
  const databaseFoundationSafe = Boolean(foundation.registryPersisted && foundation.persistenceNamespaced && foundation.persistenceTaggedWithServerId && foundation.safety?.compositePrimaryKeysActive && (!namespace?.playerStatsTableReady || namespace.playerStatsPrimaryKeyReady) && namespace?.botStatePrimaryKeyReady && namespace?.scopedReadsEnabled && namespace?.botStateUntaggedRows === 0 && (!namespace?.playerStatsTableReady || namespace.playerStatsUntaggedRows === 0));
  pushCheck(checks, "database-foundation", "Isolation foundation", databaseFoundationSafe ? "pass" : "fail", databaseFoundationSafe ? "PKs, scoped persistence, server-tagged rows e caches persistidos estao preparados para isolamento por servidor." : "A fundacao persistida de isolamento por servidor ainda possui uma garantia estrutural pendente.", { registryPersisted: foundation.registryPersisted, persistenceNamespaced: foundation.persistenceNamespaced, persistenceTaggedWithServerId: foundation.persistenceTaggedWithServerId, compositePrimaryKeysActive: foundation.safety?.compositePrimaryKeysActive, scopedReadsEnabled: namespace?.scopedReadsEnabled, botStateUntaggedRows: namespace?.botStateUntaggedRows, playerStatsUntaggedRows: namespace?.playerStatsUntaggedRows });

  if (nitradoMetadataValid && uniqueRouting) {
    try {
      const remote = prefetchedNitradoValidation || await validateNitradoServiceSetup(server.id, serviceId, baseDir); const sameRouting = remote.serviceId === serviceId && remote.baseDir === baseDir;
      pushCheck(checks, "nitrado-live", "Nitrado live check", sameRouting ? "pass" : "fail", sameRouting ? `Service acessivel e file_server respondeu para o base dir salvo${remote.admFilesFound ? ` (${remote.admFilesFound} ADM encontrado(s))` : ""}.` : "A validacao ao vivo retornou routing diferente do cadastro.", { looksLikeDayz: remote.looksLikeDayz, admFilesFound: remote.admFilesFound });
      if (sameRouting && !remote.admFilesFound) pushCheck(checks, "adm-presence", "ADM availability", "warning", "Nenhum arquivo .ADM apareceu no diretório agora. Isso pode ser normal em um servidor novo, mas deve ser confirmado antes da primeira ativacao real.");
    } catch (error) { pushCheck(checks, "nitrado-live", "Nitrado live check", "fail", error instanceof Error ? error.message : String(error)); }
  } else pushCheck(checks, "nitrado-live", "Nitrado live check", "skipped", "A checagem ao vivo nao foi executada porque a configuracao Nitrado ainda possui bloqueios.");

  await validateOptionalDiscord(server, checks);
  const failureCount = checks.filter((check) => check.status === "fail").length; const warningCount = checks.filter((check) => check.status === "warning").length; const passed = failureCount === 0;
  let readyServer: ManagedServerDescriptor | undefined;
  if (passed) {
    const preflight: ServerActivationPreflight = { version: "phase11-v1", source: "phase11-on-demand", checkedAt, passed: true, configurationSignature: getManagedServerActivationConfigSignature(server), serviceId, baseDir, discordGuildId: text(server.integrations.discordGuildId) || undefined, namespaceRows, warningCount };
    readyServer = await markManagedServerActivationPreflightReady(server.id, preflight);
    pushCheck(checks, "ready-gate", "Activation gate", "pass", "Preflight aprovado. O servidor esta Ready e pode ser ativado manualmente na Fase 12; runtime_enabled continua false ate essa acao explicita.");
  } else pushCheck(checks, "ready-gate", "Activation gate", "fail", "Preflight reprovado. O servidor permanece Draft/Configured e nenhum runtime foi iniciado.");
  return { serverId: server.id, passed, checkedAt, ready: Boolean(readyServer?.onboardingStatus === "ready"), warningCount, failureCount, checks, runtimeActivationBlocked: false, activationEndpointAvailable: true, ...(readyServer ? { server: readyServer } : {}) };
}
