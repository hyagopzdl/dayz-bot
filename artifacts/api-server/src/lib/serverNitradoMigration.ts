import postgres from "postgres";
import { encryptOrganizationSecret, getOrganizationNitradoCredential } from "./organizationIntegrations";
import {
  getPrimaryServerDescriptor,
  getManagedServerById,
  listManagedServers,
  setPersistedManagedServers,
} from "./serverRegistry";

function createSql() {
  if (!process.env.DATABASE_URL) return null;
  return postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
}

/**
 * Protect the registry bootstrap from malformed JSONB values left by older
 * migrations. Scalar values are wrapped instead of discarded, so the original
 * value remains available for forensic recovery while the runtime_config row
 * becomes a normal JSON object that supports scoped settings.
 */
export async function normalizeManagedServerRuntimeConfig() {
  const sql = createSql();
  if (!sql) return;

  try {
    await sql`
      UPDATE managed_servers
      SET runtime_config = jsonb_build_object('legacyRuntimeConfig', runtime_config),
          updated_at = NOW()
      WHERE runtime_config IS NOT NULL
        AND jsonb_typeof(runtime_config) <> 'object'
    `;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Compatibility bridge for the original organization-level Nitrado credential.
 * Every managed server receives its own encrypted credential snapshot. The
 * organization credential is used only as the source for this migration; the
 * runtime resolver remains server-scoped and never borrows another server's
 * credential.
 */
export async function migratePrimaryNitradoCredentialToServerScope() {
  const sql = createSql();
  if (!sql) return;

  try {
    const rows = await sql`
      SELECT id, organization_id, runtime_config
      FROM managed_servers
      ORDER BY created_at ASC NULLS FIRST, id ASC
    `;

    for (const row of rows as any[]) {
      const serverId = String(row.id || "").trim();
      const organizationId = String(row.organization_id || "").trim();
      if (!serverId || !organizationId) continue;

      const credential = getOrganizationNitradoCredential(organizationId);
      if (!credential.token) continue;

      const runtimeConfig = row.runtime_config;
      if (
        runtimeConfig
        && typeof runtimeConfig === "object"
        && !Array.isArray(runtimeConfig)
        && (runtimeConfig as Record<string, unknown>).nitradoApiTokenEncrypted
      ) {
        continue;
      }

      const encrypted = encryptOrganizationSecret(credential.token);
      const currentJson = runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
        ? runtimeConfig
        : {};

      await sql`
        UPDATE managed_servers
        SET runtime_config = ${JSON.stringify({
          ...currentJson,
          nitradoApiTokenEncrypted: encrypted,
        })}::jsonb,
        updated_at = NOW()
        WHERE id = ${serverId}
      `;

      console.log(`🔐 Nitrado credential migrated to server scope [${serverId}]`);
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Ensures a newly onboarded server can execute immediately, without waiting for
 * a process restart. The organization credential is copied only to this exact
 * server row and is encrypted before persistence. Existing server-scoped
 * credentials are never replaced.
 */
export async function ensureServerScopedNitradoCredential(serverIdInput: string) {
  const serverId = String(serverIdInput || "").trim();
  const server = getManagedServerById(serverId);
  if (!server) throw new Error(`Servidor ${serverId} nao encontrado.`);

  const credential = getOrganizationNitradoCredential(server.organizationId);
  if (!credential.token) {
    throw new Error(`Conecte a conta Nitrado da organizacao antes de ativar ${server.id}.`);
  }

  if (server.runtime.nitradoApiTokenEncrypted?.encryptedSecret) return false;

  const sql = createSql();
  if (!sql) throw new Error("DATABASE_URL obrigatoria para persistir a credencial Nitrado server-scoped.");

  try {
    const rows = await sql`
      SELECT runtime_config
      FROM managed_servers
      WHERE id = ${server.id}
      LIMIT 1
    `;
    if (!(rows as any[]).length) throw new Error(`Servidor ${server.id} nao encontrado no registry persistido.`);

    const runtimeConfig = (rows as any[])[0]?.runtime_config;
    if (
      runtimeConfig
      && typeof runtimeConfig === "object"
      && !Array.isArray(runtimeConfig)
      && (runtimeConfig as Record<string, unknown>).nitradoApiTokenEncrypted
    ) {
      return false;
    }

    const encrypted = encryptOrganizationSecret(credential.token);
    const currentJson = runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      ? runtimeConfig
      : {};

    await sql`
      UPDATE managed_servers
      SET runtime_config = ${JSON.stringify({
        ...currentJson,
        nitradoApiTokenEncrypted: encrypted,
      })}::jsonb,
      updated_at = NOW()
      WHERE id = ${server.id}
    `;

    console.log(`🔐 Nitrado credential bootstrapped to server scope [${server.id}]`);
    return true;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * serverRegistry deliberately strips secrets from its row mapper. Hydrate only
 * the encrypted containers needed by the server-scoped Nitrado resolver after
 * the registry has loaded. Plaintext credentials never enter the descriptor.
 */
export async function hydrateServerNitradoSecretsFromDb() {
  const sql = createSql();
  if (!sql) return;

  try {
    const rows = await sql`
      SELECT id, runtime_config
      FROM managed_servers
      WHERE runtime_config IS NOT NULL
    `;
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows as any[]) {
      const runtime = row.runtime_config;
      if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
        byId.set(String(row.id || "").trim(), runtime as Record<string, unknown>);
      }
    }

    const hydrated = listManagedServers().map((server) => {
      const runtimeConfig = byId.get(server.id);
      if (!runtimeConfig) return server;
      const token = runtimeConfig.nitradoApiTokenEncrypted;
      const ftp = runtimeConfig.nitradoFtp;
      return {
        ...server,
        runtime: {
          ...server.runtime,
          nitradoApiTokenEncrypted: token && typeof token === "object"
            ? token as any
            : server.runtime.nitradoApiTokenEncrypted,
          nitradoFtp: ftp && typeof ftp === "object"
            ? ftp as any
            : server.runtime.nitradoFtp,
        },
      };
    });

    setPersistedManagedServers(hydrated);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
