import postgres from "postgres";

export type LivePersistenceFoundationCheck = {
  registryPersisted: boolean;
  botStateTableReady: boolean;
  playerStatsTableReady: boolean;
  botStatePrimaryKeyReady: boolean;
  playerStatsPrimaryKeyReady: boolean;
  botStateUntaggedRows: number;
  playerStatsUntaggedRows: number;
  safe: boolean;
};

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1, idle_timeout: 10 })
  : null;

function parsePostgresTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export async function inspectLivePersistenceFoundation(serverId: string): Promise<LivePersistenceFoundationCheck> {
  if (!sql) throw new Error("DATABASE_URL nao esta configurada.");

  const rows = await sql`
    SELECT
      EXISTS (SELECT 1 FROM managed_servers WHERE id = ${serverId} AND organization_id IS NOT NULL) AS registry_persisted,
      to_regclass('public.bot_state') IS NOT NULL AS bot_state_table_ready,
      to_regclass('public.player_stats_state') IS NOT NULL AS player_stats_table_ready,
      (
        SELECT COALESCE(array_agg(a.attname ORDER BY keycols.ordinality), ARRAY[]::text[])
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN unnest(i.indkey) WITH ORDINALITY AS keycols(attnum, ordinality) ON TRUE
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keycols.attnum
        WHERE t.relname = 'bot_state' AND i.indisprimary
        GROUP BY i.indexrelid
        LIMIT 1
      ) AS bot_state_pk,
      (
        SELECT COALESCE(array_agg(a.attname ORDER BY keycols.ordinality), ARRAY[]::text[])
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN unnest(i.indkey) WITH ORDINALITY AS keycols(attnum, ordinality) ON TRUE
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keycols.attnum
        WHERE t.relname = 'player_stats_state' AND i.indisprimary
        GROUP BY i.indexrelid
        LIMIT 1
      ) AS player_stats_pk,
      CASE WHEN to_regclass('public.bot_state') IS NOT NULL
        THEN (SELECT COUNT(*)::int FROM bot_state WHERE server_id IS NULL) ELSE 0 END AS bot_state_untagged,
      CASE WHEN to_regclass('public.player_stats_state') IS NOT NULL
        THEN (SELECT COUNT(*)::int FROM player_stats_state WHERE server_id IS NULL) ELSE 0 END AS player_stats_untagged
  `;

  const row = (rows as any[])[0] || {};
  const botStatePk = parsePostgresTextArray(row.bot_state_pk).join(",");
  const playerStatsPk = parsePostgresTextArray(row.player_stats_pk).join(",");
  const result: LivePersistenceFoundationCheck = {
    registryPersisted: Boolean(row.registry_persisted),
    botStateTableReady: Boolean(row.bot_state_table_ready),
    playerStatsTableReady: Boolean(row.player_stats_table_ready),
    botStatePrimaryKeyReady: botStatePk === "server_id,id",
    playerStatsPrimaryKeyReady: playerStatsPk === "server_id,player_key",
    botStateUntaggedRows: Number(row.bot_state_untagged || 0),
    playerStatsUntaggedRows: Number(row.player_stats_untagged || 0),
    safe: false,
  };
  result.safe = Boolean(
    result.registryPersisted &&
    result.botStateTableReady &&
    result.playerStatsTableReady &&
    result.botStatePrimaryKeyReady &&
    result.playerStatsPrimaryKeyReady &&
    result.botStateUntaggedRows === 0 &&
    result.playerStatsUntaggedRows === 0,
  );
  return result;
}
