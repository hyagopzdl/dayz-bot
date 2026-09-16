import postgres from "postgres";

const confirmation = process.env.RESET_TEST_DATA_CONFIRM;
if (confirmation !== "RESET_DAYZ_TEST_DATA") {
  throw new Error(
    "Refusing to reset the database. Set RESET_TEST_DATA_CONFIRM=RESET_DAYZ_TEST_DATA to confirm this destructive test-data reset.",
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");

const sql = postgres(databaseUrl, { ssl: "require", max: 1 });

try {
  const tables = await sql<{ schema_name: string; table_name: string }[]>`
    SELECT table_schema AS schema_name, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_name NOT IN ('__drizzle_migrations', 'drizzle_migrations')
    ORDER BY table_schema, table_name
  `;

  if (!tables.length) {
    console.log("[reset-test-data] No application tables found.");
  } else {
    const qualified = tables.map(({ schema_name, table_name }) =>
      `"${schema_name.replaceAll('"', '""')}"."${table_name.replaceAll('"', '""')}"`,
    );
    await sql.unsafe(`TRUNCATE TABLE ${qualified.join(", ")} RESTART IDENTITY CASCADE`);
    console.log(`[reset-test-data] Cleared ${tables.length} application tables.`);
    console.log("[reset-test-data] Database schema and migration history were preserved.");
  }
} finally {
  await sql.end({ timeout: 5 });
}
