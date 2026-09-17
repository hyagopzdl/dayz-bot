from pathlib import Path
import re

ROOT = Path('artifacts/api-server/src')

def edit(rel, fn):
    p = ROOT / rel
    s = p.read_text()
    n = fn(s)
    if n == s:
        raise SystemExit(f'NO CHANGE: {rel}')
    p.write_text(n)
    print('UPDATED', rel)

# serverRegistry: remove the throwing primary APIs entirely.
edit('lib/serverRegistry.ts', lambda s: re.sub(
    r'\n/\*\* @deprecated No runtime fallback; retained until all historical callers are migrated\. \*/\nexport function getPrimaryServerId\(\) \{ return ""; \}\n/\*\* @deprecated Never returns a synthetic server\. Historical callers must stop using this API\. \*/\nexport function getPrimaryServerDescriptor\(\): ManagedServerDescriptor \{ throw new Error\("Primary server fallback has been removed; resolve a managed server context first\."\); \}\n', '\n', s))


def state_transform(s):
    s = s.replace('  getPrimaryServerDescriptor,\n', '')
    s = re.sub(r'function mapManagedServerRow\(row: any, primary: ManagedServerDescriptor\): ManagedServerDescriptor \{.*?\n\}\n\nasync function reloadManagedServerRegistryFromDb\(primary = getPrimaryServerDescriptor\(\)\) \{.*?\n\}\n', '''function mapManagedServerRow(row: any): ManagedServerDescriptor {
  const id = String(row.id || "").trim();
  const runtimeConfig = parseManagedServerRuntimeConfig(row.runtime_config);
  const descriptor: ManagedServerDescriptor = {
    id,
    name: String(row.name || row.id || "Server"),
    organizationId: buildOrganizationId(row.organization_id) || getDefaultOrganizationId(),
    enabled: row.enabled !== false,
    primary: false,
    runtimeEnabled: Boolean(row.runtime_enabled),
    onboardingStatus: normalizeServerOnboardingStatus(row.onboarding_status),
    mode: "multi-server-native",
    integrations: {
      nitradoServiceId: String(row.nitrado_service_id || "").trim() || undefined,
      discordGuildId: String(row.discord_guild_id || "").trim() || undefined,
    },
    runtime: {
      nitradoBaseDir: String(runtimeConfig?.nitradoBaseDir || "").trim() || undefined,
      nitradoValidation: runtimeConfig?.nitradoValidation && typeof runtimeConfig.nitradoValidation === "object"
        ? {
            serviceId: String(runtimeConfig.nitradoValidation.serviceId || "").trim(),
            baseDir: String(runtimeConfig.nitradoValidation.baseDir || "").trim(),
            validatedAt: String(runtimeConfig.nitradoValidation.validatedAt || "").trim(),
            source: "phase10-on-demand",
          }
        : undefined,
      activationPreflight: runtimeConfig?.activationPreflight?.passed === true
        ? {
            version: "phase11-v1",
            source: "phase11-on-demand",
            checkedAt: String(runtimeConfig.activationPreflight.checkedAt || "").trim(),
            passed: true,
            configurationSignature: String(runtimeConfig.activationPreflight.configurationSignature || "").trim(),
            serviceId: String(runtimeConfig.activationPreflight.serviceId || "").trim(),
            baseDir: String(runtimeConfig.activationPreflight.baseDir || "").trim(),
            discordGuildId: String(runtimeConfig.activationPreflight.discordGuildId || "").trim() || undefined,
            namespaceRows: {
              botState: Number(runtimeConfig.activationPreflight.namespaceRows?.botState || 0),
              playerStats: Number(runtimeConfig.activationPreflight.namespaceRows?.playerStats || 0),
              positionHistory: Number(runtimeConfig.activationPreflight.namespaceRows?.positionHistory || 0),
            },
            warningCount: Number(runtimeConfig.activationPreflight.warningCount || 0),
          }
        : undefined,
      activation: runtimeConfig?.activation?.everActivated === true
        ? {
            source: "phase12-admin",
            everActivated: true,
            firstActivatedAt: String(runtimeConfig.activation.firstActivatedAt || "").trim(),
            lastEnabledAt: String(runtimeConfig.activation.lastEnabledAt || "").trim(),
            lastDisabledAt: String(runtimeConfig.activation.lastDisabledAt || "").trim() || undefined,
            activationCount: Math.max(1, Number(runtimeConfig.activation.activationCount || 1)),
          }
        : undefined,
      operations: runtimeConfig?.operations && typeof runtimeConfig.operations === "object"
        ? {
            paused: runtimeConfig.operations.paused === true,
            pausedAt: String(runtimeConfig.operations.pausedAt || "").trim() || undefined,
            resumedAt: String(runtimeConfig.operations.resumedAt || "").trim() || undefined,
            pauseReason: String(runtimeConfig.operations.pauseReason || "").trim().slice(0, 240) || undefined,
            source: runtimeConfig.operations.source === "phase14-admin" ? "phase14-admin" : undefined,
          }
        : undefined,
      settings: normalizeServerScopedSettingsDraft(runtimeConfig?.settings, {
        ...(String(runtimeConfig?.settings?.shopDeliveryConfiguredAt || "").trim()
          ? { shopDeliveryConfiguredAt: String(runtimeConfig.settings.shopDeliveryConfiguredAt).trim() }
          : {}),
      }),
      discord: { ...(runtimeConfig?.discord || {}) },
    },
  };
  const storedStatus = String(row.onboarding_status || "draft").trim().toLowerCase();
  descriptor.onboardingStatus = storedStatus === "ready"
    && hasMatchingManagedServerNitradoValidation(descriptor)
    && hasMatchingActivationPreflight(descriptor)
    ? "ready"
    : deriveServerOnboardingStatus(descriptor);
  return descriptor;
}

async function reloadManagedServerRegistryFromDb() {
  if (!sql) return [] as ManagedServerDescriptor[];
  const rows = await sql`
    SELECT id, name, organization_id, enabled, primary_server, runtime_enabled, onboarding_status,
           mode, nitrado_service_id, discord_guild_id, runtime_config
    FROM managed_servers
    ORDER BY created_at ASC, id ASC
  `;
  const descriptors = (rows as any[]).map((row) => mapManagedServerRow(row));
  setPersistedManagedServers(descriptors);
  setServerRegistryPersistenceStatus({
    rowsLoaded: descriptors.length,
    draftRows: descriptors.filter((server) => server.onboardingStatus === "draft").length,
    configuredRows: descriptors.filter((server) => server.onboardingStatus === "configured").length,
    readyRows: descriptors.filter((server) => server.onboardingStatus === "ready").length,
    runtimeEnabledRows: descriptors.filter((server) => server.runtimeEnabled).length,
    lastLoadedAt: new Date().toISOString(),
  });
  return descriptors;
}
''', s, flags=re.S)
    s = re.sub(r'async function ensurePrimaryServerRegistryMetadata\(\) \{.*?\n\}\n\n\nexport type PlayerPositionHistoryEventType', '''async function ensureManagedServerRegistryMetadata() {
  if (!sql) {
    setOrganizationRegistryPersistenceStatus({ enabled: false, initialized: true });
    setPersistedOrganizations([getDefaultOrganizationDescriptor()], []);
    setServerRegistryPersistenceStatus({ enabled: false, initialized: true, tableReady: false, primarySeeded: false, rowsLoaded: 0 });
    return;
  }
  if (serverRegistryReadyPromise) return serverRegistryReadyPromise;
  serverRegistryReadyPromise = (async () => {
    const defaultOrganization = getDefaultOrganizationDescriptor();
    try {
      await sql`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS organization_members (organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, discord_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','moderator','viewer')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (organization_id, discord_id))`;
      await sql`CREATE INDEX IF NOT EXISTS organization_members_discord_id_idx ON organization_members (discord_id)`;
      await sql`CREATE TABLE IF NOT EXISTS organization_integrations (organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('nitrado')), encrypted_secret TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL, key_version INTEGER NOT NULL DEFAULT 1, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (organization_id, provider))`;
      await sql`INSERT INTO organizations (id, name, active, created_at, updated_at) VALUES (${defaultOrganization.id}, ${defaultOrganization.name}, TRUE, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`;
      await reloadOrganizationRegistryFromDb();
      setOrganizationRegistryPersistenceStatus({ enabled: true, organizationsTableReady: true, membershipsTableReady: true, defaultOrganizationSeeded: true, initialized: true });

      await sql`CREATE TABLE IF NOT EXISTS managed_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, organization_id TEXT NOT NULL DEFAULT ${defaultOrganization.id}, enabled BOOLEAN NOT NULL DEFAULT TRUE, primary_server BOOLEAN NOT NULL DEFAULT FALSE, runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE, onboarding_status TEXT NOT NULL DEFAULT 'draft', mode TEXT NOT NULL DEFAULT 'multi-server-native', nitrado_service_id TEXT, discord_guild_id TEXT, runtime_config JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS runtime_config JSONB`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'draft'`;
      await sql`ALTER TABLE managed_servers ADD COLUMN IF NOT EXISTS organization_id TEXT`;
      await sql`UPDATE managed_servers SET organization_id = ${defaultOrganization.id}, updated_at = NOW() WHERE organization_id IS NULL OR BTRIM(organization_id) = ''`;
      await sql`CREATE INDEX IF NOT EXISTS managed_servers_organization_id_idx ON managed_servers (organization_id)`;
      await sql`ALTER TABLE managed_servers ALTER COLUMN organization_id SET NOT NULL`;
      const ownership = await sql`SELECT COUNT(*)::int AS missing FROM managed_servers WHERE organization_id IS NULL OR BTRIM(organization_id) = ''`;
      setOrganizationRegistryPersistenceStatus({ serverOwnershipColumnReady: Number((ownership as any[])[0]?.missing || 0) === 0, serversWithoutOrganization: Number((ownership as any[])[0]?.missing || 0) });
      setServerRegistryPersistenceStatus({ tableReady: true });

      const descriptors = await reloadManagedServerRegistryFromDb();
      setServerRegistryPersistenceStatus({ enabled: true, initialized: true, tableReady: true, primarySeeded: false, rowsLoaded: descriptors.length, draftRows: descriptors.filter((server) => server.onboardingStatus === 'draft').length, configuredRows: descriptors.filter((server) => server.onboardingStatus === 'configured').length, readyRows: descriptors.filter((server) => server.onboardingStatus === 'ready').length, runtimeEnabledRows: descriptors.filter((server) => server.runtimeEnabled).length, lastLoadedAt: new Date().toISOString(), lastError: undefined });

      const tableCheck = await sql`SELECT to_regclass('public.bot_state') IS NOT NULL AS exists`;
      if (Boolean((tableCheck as any[])[0]?.exists)) {
        await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS server_id TEXT`;
        const untagged = await sql`SELECT COUNT(*)::int AS count FROM bot_state WHERE server_id IS NULL`;
        if (Number((untagged as any[])[0]?.count || 0) > 0) throw new Error('Legacy bot_state rows without server_id remain; assign them explicitly before enabling multi-server runtime.');
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS bot_state_server_id_id_uidx ON bot_state (server_id, id)`;
        botStatePrimaryKeyReady = true;
        botStateScopedPersistenceReady = true;
        setServerNamespacePersistenceStatus({ enabled: true, initialized: true, botStateTableReady: true, botStateCompositeKeyReady: true, botStatePrimaryKeyReady: true, scopedReadsEnabled: true, scopedReadFallbacks: 0, botStateTaggedRows: 0, botStateUntaggedRows: 0, lastScopedReadSource: 'server-scoped', lastCheckedAt: new Date().toISOString(), lastError: undefined });
      } else {
        setServerNamespacePersistenceStatus({ enabled: true, initialized: true, botStateTableReady: false, botStateCompositeKeyReady: false, botStatePrimaryKeyReady: false, scopedReadsEnabled: false, lastCheckedAt: new Date().toISOString() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOrganizationRegistryPersistenceStatus({ initialized: true, lastError: message });
      setServerRegistryPersistenceStatus({ initialized: true, lastError: message });
      console.error('❌ erro inicializando metadata multi-server:', err);
    }
  })();
  return serverRegistryReadyPromise;
}


export type PlayerPositionHistoryEventType''', s, flags=re.S)
    s = s.replace('ensurePrimaryServerRegistryMetadata()', 'ensureManagedServerRegistryMetadata()')
    s = s.replace('if (!id || id === getPrimaryServerId()) return getPrimaryServerDescriptor();', 'if (!id) throw new Error("Server ID invalido.");')
    return s

edit('lib/state.ts', state_transform)

edit('lib/nitradoDownloader.ts', lambda s: s.replace('getManagedServerById, getPrimaryServerDescriptor, getPrimaryServerId', 'getManagedServerById').replace('serverId = getPrimaryServerId()', 'serverId = getActiveServerId()').replace('if (serverId === getPrimaryServerId())', 'if (serverId === getActiveServerId())'))
edit('lib/serverNitradoMigration.ts', lambda s: s.replace('  getPrimaryServerDescriptor,\n', ''))

def portal_context(s):
    s = s.replace('  getPrimaryServerDescriptor,\n  getPrimaryServerId,\n', '')
    s = s.replace('export function listPlayerPortalServers(organizationId = getPrimaryServerDescriptor().organizationId) {', 'export function listPlayerPortalServers(organizationId?: string) {')
    s = s.replace('.filter((server) => server.enabled && server.organizationId === organizationId)', '.filter((server) => server.enabled && (!organizationId || server.organizationId === organizationId))')
    s = re.sub(r'  const primaryId = getPrimaryServerId\(\);\n', '', s)
    s = re.sub(r'  const seed = requestedDescriptor\n    \|\| available\.find\(\(server\) => server\.id === primaryId\)\n    \|\| available\[0\];', '  const seed = requestedDescriptor || available[0];', s)
    s = s.replace('primaryOrganizationServers:', 'organizationServers:')
    s = s.replace('organizationId: getPrimaryServerDescriptor().organizationId,', 'organizationId: listManagedServers()[0]?.organizationId,')
    return s
edit('lib/playerPortalServerContext.ts', portal_context)

def admin_panel(s):
    s = s.replace('getManagedServerById, getPrimaryServerDescriptor, getPrimaryServerId, getServerFoundationDiagnostics, listManagedServers', 'getManagedServerById, getServerFoundationDiagnostics, listExecutableManagedServers, listManagedServers')
    s = s.replace('return requireOrganizationAccess(req, res, getPrimaryServerDescriptor().organizationId, resolvedCapability);', 'const server = getManagedServerById(getActiveServerId());\n  if (!server) { res.status(403).json({ error: "SERVER_CONTEXT_REQUIRED" }); return false; }\n  return requireOrganizationAccess(req, res, server.organizationId, resolvedCapability);')
    s = s.replace('return getManagedServerById(req.adminSession.serverId)?.organizationId || getPrimaryServerDescriptor().organizationId;\n  }\n  return getPrimaryServerDescriptor().organizationId;', 'return getManagedServerById(req.adminSession.serverId)?.organizationId || "";\n  }\n  return req.portalSession ? listUserOrganizationMemberships(req.portalSession.discordId)[0]?.organizationId || "" : "";')
    s = s.replace('  const primaryServerId = getPrimaryServerId();\n  const run = () => runInServerRuntimeContext(primaryServerId, () =>\n    runSpawnZoneAutomationNow().catch((err) => console.error("spawn zones automation failed", err)),\n  );', '  const run = () => Promise.all(listExecutableManagedServers().map((server) => runInServerRuntimeContext(server.id, () => runSpawnZoneAutomationNow().catch((err) => console.error(`spawn zones automation failed [${server.id}]`, err))));')
    s = s.replace('getActiveServerId() === getPrimaryServerId() ? "full" : "core"', '"full"')
    s = s.replace('const server = getManagedServerById(getActiveServerId()) || getPrimaryServerDescriptor();\n  res.json({ server, foundation: foundationForRequest(req) });', 'const server = getManagedServerById(getActiveServerId());\n  if (!server) return res.status(404).json({ error: "SERVER_CONTEXT_REQUIRED" });\n  res.json({ server, foundation: foundationForRequest(req) });')
    s = s.replace('const serverDescriptor = getManagedServerById(getActiveServerId()) || getPrimaryServerDescriptor();', 'const serverDescriptor = getManagedServerById(getActiveServerId());\n    if (!serverDescriptor) return res.status(404).json({ error: "SERVER_CONTEXT_REQUIRED" });')
    return s
edit('routes/adminPanel.ts', admin_panel)

def nitrado_diag(s):
    s = s.replace('  getPrimaryServerDescriptor,\n  getPrimaryServerId,\n', '')
    s = re.sub(r'  const descriptor = getManagedServerById\(serverId\)\n    \|\| \(serverId === getPrimaryServerId\(\) \? getPrimaryServerDescriptor\(\) : undefined\);', '  const descriptor = getManagedServerById(serverId);', s)
    s = s.replace('    primaryServerId: getPrimaryServerId(),\n    primaryServer: descriptorSnapshot(getPrimaryServerId()),\n', '    activeServerId: getActiveServerId(),\n    activeServer: descriptorSnapshot(getActiveServerId()),\n')
    if 'getActiveServerId' not in s.split('export const',1)[0]:
        s = s.replace('  getServerRuntimeIsolationStatus,', '  getServerRuntimeIsolationStatus,\n  getActiveServerId,')
    return s
edit('routes/nitradoDiagnostic.ts', nitrado_diag)

def player_portal(s):
    s = s.replace('getManagedServerById, getPrimaryServerDescriptor, getPrimaryServerId', 'getManagedServerById')
    s = re.sub(r'async function getPrimaryIdentityImportOptions\(state: AppState, session: PortalSession\) \{.*?\n\}\n', 'async function getPrimaryIdentityImportOptions(_state: AppState, _session: PortalSession) {\n  return null;\n}\n', s, flags=re.S)
    s = s.replace('    if (getActiveServerId() === getPrimaryServerId()) {\n      throw new Error("Primary identity import is only available on secondary servers.");\n    }\n', '')
    return s
edit('routes/playerPortal.ts', player_portal)

# The exact exception and executable descriptor references must be gone.
offenders = []
for p in ROOT.rglob('*.ts'):
    text = p.read_text()
    if 'getPrimaryServerDescriptor' in text or 'Primary server fallback has been removed' in text:
        offenders.append(str(p))
if offenders:
    raise SystemExit('Remaining primary descriptor references: ' + ', '.join(offenders))
print('PRIMARY DESCRIPTOR AUDIT: CLEAN')
