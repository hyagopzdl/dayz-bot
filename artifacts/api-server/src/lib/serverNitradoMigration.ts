import postgres from "postgres";
import { encryptOrganizationSecret, getOrganizationNitradoCredential } from "./organizationIntegrations";
import { getPrimaryServerDescriptor } from "./serverRegistry";

/**
 * One-time compatibility bridge for the original single-server deployment.
 * The legacy organization/environment credential is copied into the primary
 * managed_servers row in encrypted form. Runtime consumers then use only the
 * server-scoped credential; no tenant may inherit the primary credential.
 */
export async function migratePrimaryNitradoCredentialToServerScope() {
  if (!process.env.DATABASE_URL) return;

  const primary = getPrimaryServerDescriptor();
  const credential = getOrganizationNitradoCredential(primary.organizationId);
  if (!credential.token) return;

  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
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
