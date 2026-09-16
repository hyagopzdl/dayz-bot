import postgres from "postgres";

// One-time compatibility cleanup for server records that belonged to the retired
// pre-SaaS installation. This is intentionally isolated from the active registry
// so the old identities can never become valid tenant contexts again.
const RETIRED_SERVER_IDS = ["pz-deathmatch", "pz-survival"] as const;

export async function cleanupRetiredServerRecords() {
  if (!process.env.DATABASE_URL) return { removed: 0 };

  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
  try {
    const result = await sql`
      DELETE FROM managed_servers
      WHERE lower(id) = ANY(${sql.array([...RETIRED_SERVER_IDS])})
         OR lower(trim(name)) IN ('pz deathmatch', 'pz survival')
      RETURNING id
    `;
    const removed = (result as any[]).length;
    if (removed) console.log(`🧹 registros legados removidos do registry: ${removed}`);
    return { removed };
  } catch (error) {
    // The registry bootstrap owns schema creation. If this cleanup races that
    // bootstrap, simply retry on the next process lifecycle instead of blocking
    // HTTP health or tenant onboarding.
    console.warn("ℹ️ cleanup de registros legados aguardando registry", error instanceof Error ? error.message : String(error));
    return { removed: 0 };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}
