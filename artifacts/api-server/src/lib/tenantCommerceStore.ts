import crypto from "crypto";
import postgres from "postgres";
import { getActiveServerId } from "./serverRuntime";

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
let schemaReady: Promise<void> | null = null;
const knownPlayersByServer = new Map<string, Map<string, string>>();
const lastPlayerSnapshotHash = new Map<string, string>();
const lastCommerceSnapshotHash = new Map<string, string>();
const lastPlayerMirrorAt = new Map<string, number>();
const pendingSnapshots = new Map<string, { snapshot: any; mirrorPlayers: boolean; mirrorCommerce: boolean }>();
const flushPromises = new Map<string, Promise<void>>();

function normalize(value: string) { return String(value || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function hash(value: unknown) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function ensureSchema() {
  if (!sql) return;
  if (!schemaReady) schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS server_players (
      server_id TEXT NOT NULL,
      gamertag_normalized TEXT NOT NULL,
      gamertag TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_online_at TIMESTAMPTZ,
      PRIMARY KEY (server_id, gamertag_normalized)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_server_players_last_seen ON server_players(server_id, last_seen_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS server_player_links (
      server_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      gamertag_normalized TEXT NOT NULL,
      gamertag TEXT NOT NULL,
      locale TEXT,
      linked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, discord_id),
      UNIQUE (server_id, gamertag_normalized)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS server_wallets (
      server_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      gamertag TEXT NOT NULL,
      balance BIGINT NOT NULL DEFAULT 0,
      total_earned BIGINT NOT NULL DEFAULT 0,
      total_spent BIGINT NOT NULL DEFAULT 0,
      online_reward_minutes BIGINT NOT NULL DEFAULT 0,
      last_playtime_reward_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, discord_id)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS server_economy_transactions (
      server_id TEXT NOT NULL,
      id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      gamertag TEXT NOT NULL,
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_before BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (server_id, id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_server_economy_tx_player ON server_economy_transactions(server_id, discord_id, created_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS server_shop_orders (
      server_id TEXT NOT NULL,
      id TEXT NOT NULL,
      discord_id TEXT,
      status TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL,
      PRIMARY KEY (server_id, id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_server_shop_orders_status ON server_shop_orders(server_id, status, created_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS server_shop_saved_locations (
      server_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      name TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, discord_id, name)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS server_shop_checkouts (
      server_id TEXT NOT NULL,
      id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, id)
    );`;
  })().catch((err) => { schemaReady = null; throw err; });
  await schemaReady;
}

export async function hydrateKnownServerPlayers(serverId = getActiveServerId()) {
  if (!sql || knownPlayersByServer.has(serverId)) return;
  await ensureSchema();
  const rows = await sql`SELECT gamertag_normalized, gamertag FROM server_players WHERE server_id = ${serverId}` as any[];
  const map = new Map<string, string>();
  for (const row of rows) map.set(String(row.gamertag_normalized), String(row.gamertag));
  knownPlayersByServer.set(serverId, map);
}

export function getPersistedKnownGamertags(serverId = getActiveServerId()) {
  return [...(knownPlayersByServer.get(serverId)?.values() || [])];
}

async function mirrorPlayers(serverId: string, snap: any) {
  if (!sql) return;
  await ensureSchema();
  const known = knownPlayersByServer.get(serverId) || new Map<string, string>();
  const onlineSet = new Set(Object.keys(snap.onlinePlayers || {}).map(normalize));
  const observed = new Map<string, string>();
  for (const name of [...Object.keys(snap.players || {}), ...Object.keys(snap.onlinePlayers || {})]) {
    const key = normalize(name); if (key && !observed.has(key)) observed.set(key, name);
  }
  const observedRows = [...observed].map(([key, name]) => ({
    server_id: serverId, gamertag_normalized: key, gamertag: name, last_online_at: onlineSet.has(key) ? new Date() : null,
  }));
  for (let offset = 0; offset < observedRows.length; offset += 500) {
    const chunk = observedRows.slice(offset, offset + 500);
    if (!chunk.length) continue;
    await sql`INSERT INTO server_players ${sql(chunk, "server_id", "gamertag_normalized", "gamertag", "last_online_at")}
      ON CONFLICT (server_id, gamertag_normalized) DO UPDATE SET
        gamertag = EXCLUDED.gamertag,
        last_seen_at = CASE
          WHEN server_players.gamertag IS DISTINCT FROM EXCLUDED.gamertag
            OR server_players.last_seen_at <= NOW() - INTERVAL '15 minutes'
          THEN NOW()
          ELSE server_players.last_seen_at
        END,
        last_online_at = COALESCE(EXCLUDED.last_online_at, server_players.last_online_at)
      WHERE server_players.gamertag IS DISTINCT FROM EXCLUDED.gamertag
         OR server_players.last_seen_at <= NOW() - INTERVAL '15 minutes'
         OR (EXCLUDED.last_online_at IS NOT NULL AND server_players.last_online_at IS NULL)`;
  }
  for (const [key, name] of observed) known.set(key, name);
  knownPlayersByServer.set(serverId, known);
}

async function mirrorCommerce(serverId: string, snap: any) {
  if (!sql) return;
  await ensureSchema();

  const links = Object.values(snap.playerLinks || {}) as any[];
  if (links.length) {
    const ids = links.map((x) => String(x.discordId));
    await sql`DELETE FROM server_player_links WHERE server_id = ${serverId} AND NOT (discord_id = ANY(${ids}))`;
    const rows = links.map((link) => ({ server_id:serverId, discord_id:String(link.discordId), gamertag_normalized:String(link.gamertagNormalized || normalize(link.gamertag)), gamertag:String(link.gamertag), locale:link.locale || null, linked_at:link.linkedAt ? new Date(link.linkedAt) : null, updated_at:link.updatedAt ? new Date(link.updatedAt) : new Date() }));
    await sql`INSERT INTO server_player_links ${sql(rows, "server_id","discord_id","gamertag_normalized","gamertag","locale","linked_at","updated_at")}
      ON CONFLICT (server_id,discord_id) DO UPDATE SET gamertag_normalized=EXCLUDED.gamertag_normalized,gamertag=EXCLUDED.gamertag,locale=EXCLUDED.locale,linked_at=EXCLUDED.linked_at,updated_at=EXCLUDED.updated_at
      WHERE server_player_links.gamertag_normalized IS DISTINCT FROM EXCLUDED.gamertag_normalized
         OR server_player_links.gamertag IS DISTINCT FROM EXCLUDED.gamertag
         OR server_player_links.locale IS DISTINCT FROM EXCLUDED.locale
         OR server_player_links.linked_at IS DISTINCT FROM EXCLUDED.linked_at`;
  } else await sql`DELETE FROM server_player_links WHERE server_id = ${serverId}`;

  const wallets = Object.values(snap.wallets || {}) as any[];
  if (wallets.length) {
    const rows = wallets.map((wallet) => ({ server_id:serverId, discord_id:String(wallet.discordId), gamertag:String(wallet.gamertag), balance:Number(wallet.balance||0), total_earned:Number(wallet.totalEarned||0), total_spent:Number(wallet.totalSpent||0), online_reward_minutes:Number(wallet.onlineRewardMinutes||0), last_playtime_reward_at:wallet.lastPlaytimeRewardAt ? new Date(wallet.lastPlaytimeRewardAt) : null, created_at:wallet.createdAt ? new Date(wallet.createdAt) : null, updated_at:wallet.updatedAt ? new Date(wallet.updatedAt) : new Date() }));
    await sql`INSERT INTO server_wallets ${sql(rows,"server_id","discord_id","gamertag","balance","total_earned","total_spent","online_reward_minutes","last_playtime_reward_at","created_at","updated_at")}
      ON CONFLICT (server_id,discord_id) DO UPDATE SET gamertag=EXCLUDED.gamertag,balance=EXCLUDED.balance,total_earned=EXCLUDED.total_earned,total_spent=EXCLUDED.total_spent,online_reward_minutes=EXCLUDED.online_reward_minutes,last_playtime_reward_at=EXCLUDED.last_playtime_reward_at,updated_at=NOW()
      WHERE server_wallets.gamertag IS DISTINCT FROM EXCLUDED.gamertag
         OR server_wallets.balance IS DISTINCT FROM EXCLUDED.balance
         OR server_wallets.total_earned IS DISTINCT FROM EXCLUDED.total_earned
         OR server_wallets.total_spent IS DISTINCT FROM EXCLUDED.total_spent
         OR server_wallets.online_reward_minutes IS DISTINCT FROM EXCLUDED.online_reward_minutes
         OR server_wallets.last_playtime_reward_at IS DISTINCT FROM EXCLUDED.last_playtime_reward_at
         OR server_wallets.created_at IS DISTINCT FROM EXCLUDED.created_at`;
  }

  const transactions = snap.economyTransactions || [];
  for (let offset=0; offset<transactions.length; offset+=500) {
    const rows = transactions.slice(offset,offset+500).map((tx:any) => ({ server_id:serverId,id:String(tx.id),discord_id:String(tx.discordId),gamertag:String(tx.gamertag),type:String(tx.type),amount:Number(tx.amount||0),balance_before:Number(tx.balanceBefore||0),balance_after:Number(tx.balanceAfter||0),reason:tx.reason||null,created_by:tx.createdBy||null,created_at:tx.createdAt ? new Date(tx.createdAt) : new Date() }));
    if (rows.length) await sql`INSERT INTO server_economy_transactions ${sql(rows,"server_id","id","discord_id","gamertag","type","amount","balance_before","balance_after","reason","created_by","created_at")} ON CONFLICT (server_id,id) DO NOTHING`;
  }

  const orders = snap.shopOrders || [];
  if (orders.length) {
    const rows = orders.map((order:any) => ({ server_id:serverId,id:String(order.id),discord_id:order.discordUserId || order.discordId || null,status:order.status || null,created_at:order.createdAt ? new Date(order.createdAt) : null,updated_at:new Date(),payload:JSON.stringify(order) }));
    await sql`INSERT INTO server_shop_orders ${sql(rows,"server_id","id","discord_id","status","created_at","updated_at","payload")} ON CONFLICT (server_id,id) DO UPDATE SET discord_id=EXCLUDED.discord_id,status=EXCLUDED.status,updated_at=NOW(),payload=EXCLUDED.payload
      WHERE server_shop_orders.discord_id IS DISTINCT FROM EXCLUDED.discord_id
         OR server_shop_orders.status IS DISTINCT FROM EXCLUDED.status
         OR server_shop_orders.created_at IS DISTINCT FROM EXCLUDED.created_at
         OR server_shop_orders.payload IS DISTINCT FROM EXCLUDED.payload`;
  }

  const locations = snap.shopSavedLocations || [];
  if (locations.length) {
    const keys = locations.map((x:any) => `${x.discordUserId || x.discordId}:${String(x.name||"").toLowerCase()}`);
    await sql`DELETE FROM server_shop_saved_locations WHERE server_id=${serverId} AND NOT ((discord_id || ':' || lower(name)) = ANY(${keys}))`;
  } else await sql`DELETE FROM server_shop_saved_locations WHERE server_id=${serverId}`;
  if (locations.length) {
    const rows = locations.map((loc:any) => ({ server_id:serverId,discord_id:String(loc.discordUserId || loc.discordId),name:String(loc.name),payload:JSON.stringify(loc),updated_at:new Date() }));
    await sql`INSERT INTO server_shop_saved_locations ${sql(rows,"server_id","discord_id","name","payload","updated_at")} ON CONFLICT (server_id,discord_id,name) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()
      WHERE server_shop_saved_locations.payload IS DISTINCT FROM EXCLUDED.payload`;
  }

  const checkouts = snap.shopPendingCheckouts || [];
  if (checkouts.length) {
    const ids = checkouts.map((x:any) => String(x.id));
    await sql`DELETE FROM server_shop_checkouts WHERE server_id=${serverId} AND NOT (id = ANY(${ids}))`;
  } else await sql`DELETE FROM server_shop_checkouts WHERE server_id=${serverId}`;
  if (checkouts.length) {
    const rows = checkouts.map((c:any) => ({ server_id:serverId,id:String(c.id),discord_id:String(c.discordUserId || c.discordId),expires_at:c.expiresAt ? new Date(c.expiresAt) : null,payload:JSON.stringify(c),updated_at:new Date() }));
    await sql`INSERT INTO server_shop_checkouts ${sql(rows,"server_id","id","discord_id","expires_at","payload","updated_at")} ON CONFLICT (server_id,id) DO UPDATE SET discord_id=EXCLUDED.discord_id,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload,updated_at=NOW()
      WHERE server_shop_checkouts.discord_id IS DISTINCT FROM EXCLUDED.discord_id
         OR server_shop_checkouts.expires_at IS DISTINCT FROM EXCLUDED.expires_at
         OR server_shop_checkouts.payload IS DISTINCT FROM EXCLUDED.payload`;
  }
}

export function scheduleTenantCommerceMirror(state: any, serverId = getActiveServerId()) {
  if (!sql) return;
  const playerSnapshot = {
    players: state.players || {},
    onlinePlayers: state.onlinePlayers || {},
  };
  const commerceSnapshot = {
    playerLinks: state.playerLinks || {},
    wallets: state.wallets || {},
    economyTransactions: Array.isArray(state.economyTransactions) ? state.economyTransactions : [],
    shopOrders: Array.isArray(state.shopOrders) ? state.shopOrders : [],
    shopSavedLocations: Array.isArray(state.shopSavedLocations) ? state.shopSavedLocations : [],
    shopPendingCheckouts: Array.isArray(state.shopPendingCheckouts) ? state.shopPendingCheckouts : [],
  };

  const playerHash = hash(playerSnapshot);
  const commerceHash = hash(commerceSnapshot);
  const now = Date.now();
  const shouldMirrorPlayers = lastPlayerSnapshotHash.get(serverId) !== playerHash || now - (lastPlayerMirrorAt.get(serverId) || 0) >= 15 * 60 * 1000;
  const shouldMirrorCommerce = lastCommerceSnapshotHash.get(serverId) !== commerceHash;
  if (!shouldMirrorPlayers && !shouldMirrorCommerce) return;

  pendingSnapshots.set(serverId, {
    snapshot: { ...playerSnapshot, ...commerceSnapshot },
    mirrorPlayers: Boolean(pendingSnapshots.get(serverId)?.mirrorPlayers || shouldMirrorPlayers),
    mirrorCommerce: Boolean(pendingSnapshots.get(serverId)?.mirrorCommerce || shouldMirrorCommerce),
  });
  if (flushPromises.has(serverId)) return;

  const runner = (async () => {
    try {
      while (pendingSnapshots.has(serverId)) {
        const next = pendingSnapshots.get(serverId)!;
        pendingSnapshots.delete(serverId);
        if (next.mirrorPlayers) {
          await mirrorPlayers(serverId, next.snapshot);
          lastPlayerSnapshotHash.set(serverId, hash({ players: next.snapshot.players || {}, onlinePlayers: next.snapshot.onlinePlayers || {} }));
          lastPlayerMirrorAt.set(serverId, Date.now());
        }
        if (next.mirrorCommerce) {
          await mirrorCommerce(serverId, next.snapshot);
          lastCommerceSnapshotHash.set(serverId, hash({
            playerLinks: next.snapshot.playerLinks || {}, wallets: next.snapshot.wallets || {},
            economyTransactions: Array.isArray(next.snapshot.economyTransactions) ? next.snapshot.economyTransactions : [],
            shopOrders: Array.isArray(next.snapshot.shopOrders) ? next.snapshot.shopOrders : [],
            shopSavedLocations: Array.isArray(next.snapshot.shopSavedLocations) ? next.snapshot.shopSavedLocations : [],
            shopPendingCheckouts: Array.isArray(next.snapshot.shopPendingCheckouts) ? next.snapshot.shopPendingCheckouts : [],
          }));
        }
      }
    } catch (err) {
      console.error(`❌ tenant commerce mirror failed [${serverId}]`, err);
    } finally { flushPromises.delete(serverId); }
  })();
  flushPromises.set(serverId, runner);
}
