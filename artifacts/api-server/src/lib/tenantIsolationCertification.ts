import postgres from "postgres";
import { getActiveServerId } from "./serverRuntime";
import type { AppState } from "./state";

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;

function norm(v: unknown) { return String(v ?? "").trim(); }
function countLegacy(state: AppState & Record<string, any>) {
  return {
    links: Object.keys(state.playerLinks || {}).length,
    wallets: Object.keys(state.wallets || {}).length,
    transactions: Array.isArray(state.economyTransactions) ? state.economyTransactions.length : 0,
    orders: Array.isArray(state.shopOrders) ? state.shopOrders.length : 0,
    locations: Array.isArray(state.shopSavedLocations) ? state.shopSavedLocations.length : 0,
    checkouts: Array.isArray(state.shopPendingCheckouts) ? state.shopPendingCheckouts.length : 0,
  };
}

export async function certifyTenantIsolation(state: AppState & Record<string, any>, serverId = getActiveServerId()) {
  if (!sql) return { serverId, isolationPassed: false, commerceCutoverReady: false, criticalIssues: ["DATABASE_URL_NOT_CONFIGURED"], domains: {} };

  const legacy = countLegacy(state);
  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM server_player_links WHERE server_id=${serverId}) links,
      (SELECT COUNT(*)::int FROM server_wallets WHERE server_id=${serverId}) wallets,
      (SELECT COUNT(*)::int FROM server_economy_transactions WHERE server_id=${serverId}) transactions,
      (SELECT COUNT(*)::int FROM server_shop_orders WHERE server_id=${serverId}) orders,
      (SELECT COUNT(*)::int FROM server_shop_saved_locations WHERE server_id=${serverId}) locations,
      (SELECT COUNT(*)::int FROM server_shop_checkouts WHERE server_id=${serverId}) checkouts,
      (SELECT COUNT(*)::int FROM bot_state WHERE server_id IS NULL) unscoped_bot_state,
      (SELECT COUNT(*)::int FROM player_stats_state WHERE server_id IS NULL) unscoped_player_stats,
      (SELECT COUNT(*)::int FROM player_position_history WHERE server_id IS NULL) unscoped_positions
  ` as any[];

  const [server] = await sql`SELECT nitrado_service_id, discord_guild_id FROM managed_servers WHERE id=${serverId} LIMIT 1` as any[];
  const collisions: string[] = [];
  if (norm(server?.nitrado_service_id)) {
    const [{ count }] = await sql`SELECT COUNT(*)::int count FROM managed_servers WHERE id<>${serverId} AND nitrado_service_id=${norm(server.nitrado_service_id)}` as any[];
    if (Number(count) > 0) collisions.push("NITRADO_SERVICE_ID_COLLISION");
  }
  if (norm(server?.discord_guild_id)) {
    const [{ count }] = await sql`SELECT COUNT(*)::int count FROM managed_servers WHERE id<>${serverId} AND discord_guild_id=${norm(server.discord_guild_id)}` as any[];
    if (Number(count) > 0) collisions.push("DISCORD_GUILD_ID_COLLISION");
  }

  const normalized = {
    links: Number(counts?.links || 0), wallets: Number(counts?.wallets || 0), transactions: Number(counts?.transactions || 0),
    orders: Number(counts?.orders || 0), locations: Number(counts?.locations || 0), checkouts: Number(counts?.checkouts || 0),
  };
  const domains = Object.fromEntries(Object.keys(legacy).map((key) => {
    const k = key as keyof typeof legacy;
    return [key, { legacy: legacy[k], normalized: normalized[k], exact: legacy[k] === normalized[k] }];
  }));
  const criticalIssues = [...collisions];
  if (Number(counts?.unscoped_bot_state || 0) > 0) criticalIssues.push("UNSCOPED_BOT_STATE_ROWS");
  if (Number(counts?.unscoped_player_stats || 0) > 0) criticalIssues.push("UNSCOPED_PLAYER_STATS_ROWS");
  if (Number(counts?.unscoped_positions || 0) > 0) criticalIssues.push("UNSCOPED_POSITION_ROWS");
  const commerceCutoverReady = Object.values(domains).every((d: any) => d.exact === true);
  return {
    serverId,
    isolationPassed: criticalIssues.length === 0,
    commerceCutoverReady,
    criticalIssues,
    domains,
    unscoped: {
      botState: Number(counts?.unscoped_bot_state || 0),
      playerStats: Number(counts?.unscoped_player_stats || 0),
      positions: Number(counts?.unscoped_positions || 0),
    },
  };
}
