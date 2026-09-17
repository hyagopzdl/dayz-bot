import postgres from "postgres";

const DATABASE_IDLE_TIMEOUT_SECONDS = Math.max(
  15,
  Number(process.env.NEON_IDLE_TIMEOUT_SECONDS || 30),
);
const DATABASE_MAX_LIFETIME_SECONDS = Math.max(
  300,
  Number(process.env.NEON_MAX_LIFETIME_SECONDS || 30 * 60),
);

/**
 * Single PostgreSQL client for the API process.
 *
 * Neon should be allowed to scale to zero while the API is idle. The previous
 * architecture created one postgres.js client per service module and left the
 * default idle_timeout at 0, which keeps each connection alive indefinitely
 * after the first query. A shared client also prevents every feature module
 * from independently waking/holding the Neon compute.
 */
export const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      ssl: "require",
      max: 1,
      idle_timeout: DATABASE_IDLE_TIMEOUT_SECONDS,
      max_lifetime: DATABASE_MAX_LIFETIME_SECONDS,
      connect_timeout: 10,
    })
  : null;

export async function closeDatabase() {
  if (!sql) return;
  await sql.end({ timeout: 5 });
}

export function getDatabaseConnectionPolicy() {
  return {
    configured: Boolean(sql),
    maxConnections: 1,
    idleTimeoutSeconds: DATABASE_IDLE_TIMEOUT_SECONDS,
    maxLifetimeSeconds: DATABASE_MAX_LIFETIME_SECONDS,
  };
}
