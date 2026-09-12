import postgres from "postgres";
import { encryptOrganizationSecret, getOrganizationNitradoCredential } from "./organizationIntegrations";
import {
  getPrimaryServerDescriptor,
  listManagedServers,
  setPersistedManagedServers,
} from "./serverRegistry";

function createSql() {
  if (!process.env.DATABASE_URL) return null;
  return postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
}

/**
 * One-time compatibility bridge for the original single-server deployment.
 * The legacy organization/environment credential is copied into the primary
 * managed_servers row in encrypted form. Runtime consumers then use only the
 * server-scoped credential; no tenant may inherit the primary credential.
 */
export async function migratePrimaryNitradoCredentialToServerScope() {
  const sql = createSql();
  if (!sql) return;

  const primary = getPrimaryServerDescriptor();
  const credential = getOrganizationNitradoCredential(primary.organizationId);
  if (!credential.token) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    return;
  }

  try {
    const rows = await sql`
      SELECT runtime_config
      FROM managed_servers
      WHERE id = ${primary.id}
      LIMIT 1
    `;
    if (!(rows as any[]).length) return;

    const runtimeConfig = (rows as any[])[0]?.runtime_config;
    if (runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      && (runtimeConfig as Record<string, unknown>).nitradoApiTokenEncrypted) {
      return;
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
      WHERE id = ${primary.id}
    `;

    console.log(`🔐 Nitrado credential migrated to server scope [${primary.id}]`);
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
