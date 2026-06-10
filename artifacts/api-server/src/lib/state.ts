import fs from "fs";
import path from "path";
import crypto from "crypto";
import postgres from "postgres";
import type { ShopCatalog } from "./shopCatalog";
import type { DayzItemDefinition } from "./dayzItemDatabase";
import type { Locale } from "./i18n";

const FILE = path.resolve(process.cwd(), "state.json");
const STATE_ID = "main";

const STATE_SAVE_DEBOUNCE_MS = Number(process.env.STATE_SAVE_DEBOUNCE_MS || 15000);
const STATE_FORCE_SAVE_AFTER_MS = Number(process.env.STATE_FORCE_SAVE_AFTER_MS || 60000);
const STATE_DEBUG = process.env.STATE_DEBUG === "true";

let cachedState: AppState | null = null;
let lastPersistedHash = "";
let lastPersistedJson = "";
let pendingPersistJson = "";
let pendingPersistHash = "";
let pendingPersistStartedAt = 0;
let saveTimer: NodeJS.Timeout | null = null;
let flushPromise: Promise<void> | null = null;

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      ssl: "require",
      max: 1,
    })
  : null;

export type PlayerStats = {
  kills: number;
  deaths: number;
};

export type OnlineSession = {
  connectedAt?: string;
  lastSeenAt?: string;
  kills?: number;
  deaths?: number;
  streak?: number;
};

type OnlinePlayer = {
  online: true;
  connectedAt?: string;
  lastSeenAt: string;
  sessionKills?: number;
  sessionDeaths?: number;
  sessionStreak?: number;
};

export type FileCursor = {
  lastLine: number;
  lastProcessedAt: string;
};

export type KillFeedEvent = {
  killer: string;
  victim: string;
  weapon?: string;
  at: string;
};

export type LongShotEvent = {
  killer: string;
  victim: string;
  weapon: string;
  distance: number;
  timestamp: number;
};

export type KillStreakEvent =
  | {
      type: "streak";
      player: string;
      streak: number;
      timestamp: number;
    }
  | {
      type: "ended";
      player: string;
      streak: number;
      killer: string;
      timestamp: number;
    };

export type ShopOrderStatus =
  | "pending_spawn"
  | "included_in_restart"
  | "spawned"
  | "failed";


export type ShopResetMonitor = {
  batchId?: string;
  deployedAt?: string;
  sawOfflineAt?: string;
  sawOnlineAt?: string;
  lastStatus?: string | null;
  lastCheckedAt?: string;
  clearedAt?: string;
  /**
   * Restart detection on DayZ console/Nitrado is not always exposed as a
   * visible status transition. These fields keep the monitor recoverable and
   * prevent WAITING_RESET from blocking checkout forever.
   */
  expectedRestartAt?: string;
  restartFallbackAt?: string;
  autoConfirmedAt?: string;
  confirmationReason?: string;
};

export type ShopAutoDeployState = {
  lastWindowId?: string;
  lastCheckedAt?: string;
  lastDeployAt?: string;
};

export type ShopSavedLocation = {
  id: string;
  discordUserId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  createdAt: string;
  lastUsedAt?: string;
};

export type ShopPendingCheckout = {
  id: string;
  discordUserId: string;
  itemId: string;
  itemClass: string;
  itemName?: string;
  price?: number;
  spawnEventName?: string;
  deliveryKind?: "item" | "vehicle";
  x: number;
  y: number;
  z: number;
  saveLocationName?: string;
  createdAt: string;
  expiresAt: string;
};

export type ShopOrder = {
  id: string;
  discordUserId: string;
  itemClass: string;
  itemName?: string;
  spawnEventName?: string;
  deliveryKind?: "item" | "vehicle";
  x: number;
  y: number;
  z: number;
  status: ShopOrderStatus;
  restartTarget?: string;
  createdAt: string;
  includedAt?: string;
  spawnedAt?: string;
  failedAt?: string;
  failReason?: string;
};

export type PlayerLink = {
  discordId: string;
  gamertag: string;
  gamertagNormalized: string;
  locale: Locale;
  linkedAt: string;
  updatedAt: string;
};

export type Wallet = {
  discordId: string;
  gamertag: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  /**
   * Accumulated online minutes that have not been converted into coins yet.
   * This persists across bot/server restarts so a player at 58/60 minutes
   * keeps that progress and receives the reward after the remaining time.
   */
  onlineRewardMinutes?: number;
  lastPlaytimeRewardAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EconomyTransactionType =
  | "ADMIN_ADD"
  | "ADMIN_REMOVE"
  | "ADMIN_SET"
  | "SHOP_PURCHASE"
  | "PLAYTIME_REWARD"
  | "EVENT_REWARD"
  | "DONATION_REWARD";

export type EconomyTransaction = {
  id: string;
  discordId: string;
  gamertag: string;
  type: EconomyTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason?: string;
  createdAt: string;
  createdBy?: string;
};

export type ActiveMatch = {
  id: string;
  name: string;
  channelId: string;
  messageId?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "finished";
  players: Record<string, PlayerStats>;
};


export type OnlineActivitySample = {
  bucket: string;
  online: number;
};

export type OnlineConnectionEvent = {
  player: string;
  at: string;
};

export type AppState = {
  players: Record<string, PlayerStats>;
  dailyPlayers: Record<string, PlayerStats>;
  weeklyPlayers: Record<string, PlayerStats>;
  onlinePlayers: Record<string, OnlinePlayer>;
  onlineSessions: Record<string, OnlineSession>;
  onlineActivitySamples?: OnlineActivitySample[];
  onlineConnectionEvents?: OnlineConnectionEvent[];

  playerLinks: Record<string, PlayerLink>;
  playerLinksByGamertag: Record<string, string>;

  wallets: Record<string, Wallet>;
  economyTransactions: EconomyTransaction[];

  shopOrders: ShopOrder[];
  shopSavedLocations?: ShopSavedLocation[];
  shopPendingCheckouts?: ShopPendingCheckout[];
  shopCatalog?: ShopCatalog;
  dayzItems?: DayzItemDefinition[];
  shopResetMonitor?: ShopResetMonitor | null;
  shopAutoDeploy?: ShopAutoDeployState | null;

  files: Record<string, FileCursor>;
  recentEventIds: string[];

  killFeedEvents: KillFeedEvent[];
  longShotEvents: LongShotEvent[];

  currentKillStreaks: Record<string, number>;
  killStreakEvents: KillStreakEvent[];

  discordMessageIds: Record<string, string>;

  activeMatch?: ActiveMatch | null;

  lastDailyReset: string;
  lastWeeklyReset: string;

  globalStartedAt?: string;
  dailyStartedAt?: string;
  weeklyStartedAt?: string;

  lastLine?: number;
  lastFileName?: string;
};

function defaultState(): AppState {
  return {
    players: {},
    dailyPlayers: {},
    weeklyPlayers: {},
    onlinePlayers: {},
    onlineSessions: {},
    onlineActivitySamples: [],
    onlineConnectionEvents: [],
    playerLinks: {},
    playerLinksByGamertag: {},
    wallets: {},
    economyTransactions: [],
    shopOrders: [],
    shopSavedLocations: [],
    shopPendingCheckouts: [],
    shopCatalog: undefined,
    dayzItems: undefined,
    shopResetMonitor: null,
    shopAutoDeploy: null,
    files: {},
    recentEventIds: [],
    killFeedEvents: [],
    longShotEvents: [],
    currentKillStreaks: {},
    killStreakEvents: [],
    discordMessageIds: {},
    activeMatch: null,
    lastDailyReset: "",
    lastWeeklyReset: "",
  };
}

function normalizeKillStreakEvent(event: any): KillStreakEvent | null {
  if (!event || typeof event !== "object") return null;

  const timestamp =
    typeof event.timestamp === "number"
      ? event.timestamp
      : event.at
        ? Math.floor(new Date(event.at).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

  if (event.type === "streak" || event.type === "milestone") {
    return {
      type: "streak",
      player: event.player || "Unknown",
      streak: Number(event.streak || 0),
      timestamp,
    };
  }

  if (event.type === "ended") {
    return {
      type: "ended",
      player: event.player || "Unknown",
      streak: Number(event.streak || 0),
      killer: event.killer || event.endedBy || "Unknown",
      timestamp,
    };
  }

  return null;
}

function migrateLegacyState(data: any): AppState {
  const state = defaultState();

  state.players = data.players || {};
  state.dailyPlayers = data.dailyPlayers || {};
  state.weeklyPlayers = data.weeklyPlayers || {};
  state.recentEventIds = data.recentEventIds || [];
  state.killFeedEvents = data.killFeedEvents || [];
  state.longShotEvents = (data.longShotEvents || []).slice(-150);

  state.currentKillStreaks = data.currentKillStreaks || data.killStreaks || {};

  state.killStreakEvents = (data.killStreakEvents || [])
    .map(normalizeKillStreakEvent)
    .filter(Boolean)
    .slice(-150) as KillStreakEvent[];

  state.discordMessageIds = data.discordMessageIds || {};
  state.files = data.files || {};
  state.lastDailyReset = data.lastDailyReset || "";
  state.lastWeeklyReset = data.lastWeeklyReset || "";

  state.globalStartedAt = data.globalStartedAt;
  state.dailyStartedAt = data.dailyStartedAt;
  state.weeklyStartedAt = data.weeklyStartedAt;

  state.activeMatch = data.activeMatch || null;

  state.lastLine = data.lastLine;
  state.lastFileName = data.lastFileName;

  state.onlineSessions = data.onlineSessions || {};
  state.onlineActivitySamples = Array.isArray(data.onlineActivitySamples) ? data.onlineActivitySamples : [];
  state.onlineConnectionEvents = Array.isArray((data as any).onlineConnectionEvents) ? (data as any).onlineConnectionEvents : [];
  state.playerLinks = data.playerLinks || {};
  state.playerLinksByGamertag = {};

  for (const [discordId, link] of Object.entries(state.playerLinks)) {
    const existing = link as any;
    const gamertag = String(existing.gamertag || "").trim();
    if (!gamertag) {
      delete state.playerLinks[discordId];
      continue;
    }

    const normalized = String(existing.gamertagNormalized || gamertag.toLowerCase()).trim().toLowerCase();
    state.playerLinks[discordId] = {
      discordId: String(existing.discordId || discordId),
      gamertag,
      gamertagNormalized: normalized,
      locale: existing.locale === "pt" ? "pt" : "en",
      linkedAt: existing.linkedAt || existing.createdAt || new Date().toISOString(),
      updatedAt: existing.updatedAt || existing.linkedAt || new Date().toISOString(),
    };
    state.playerLinksByGamertag[normalized] = discordId;
  }

  state.wallets = {};
  for (const [discordId, wallet] of Object.entries(data.wallets || {})) {
    const existing = wallet as any;
    const balance = Math.max(0, Math.floor(Number(existing.balance || 0)));
    const totalEarned = Math.max(0, Math.floor(Number(existing.totalEarned || 0)));
    const totalSpent = Math.max(0, Math.floor(Number(existing.totalSpent || 0)));
    const linkedGamertag = state.playerLinks[discordId]?.gamertag;
    const gamertag = String(existing.gamertag || linkedGamertag || "Unknown").trim();
    const now = new Date().toISOString();

    state.wallets[discordId] = {
      discordId: String(existing.discordId || discordId),
      gamertag,
      balance,
      totalEarned,
      totalSpent,
      onlineRewardMinutes: Math.max(0, Math.floor(Number(existing.onlineRewardMinutes || 0))),
      lastPlaytimeRewardAt: existing.lastPlaytimeRewardAt,
      createdAt: existing.createdAt || existing.linkedAt || now,
      updatedAt: existing.updatedAt || now,
    };
  }

  state.economyTransactions = Array.isArray(data.economyTransactions)
    ? data.economyTransactions.slice(-1000)
    : [];

  state.shopOrders = Array.isArray(data.shopOrders) ? data.shopOrders : [];
  state.shopSavedLocations = Array.isArray(data.shopSavedLocations) ? data.shopSavedLocations : [];
  state.shopPendingCheckouts = Array.isArray(data.shopPendingCheckouts) ? data.shopPendingCheckouts : [];
  state.shopCatalog = data.shopCatalog;
  state.dayzItems = Array.isArray(data.dayzItems) ? data.dayzItems : undefined;
  state.shopResetMonitor = data.shopResetMonitor || null;
  state.shopAutoDeploy = data.shopAutoDeploy || null;

  const rawOnlinePlayers = data.onlinePlayers || {};
  const now = new Date().toISOString();

  for (const [name, value] of Object.entries(rawOnlinePlayers)) {
    if (value === true) {
      state.onlinePlayers[name] = {
        online: true,
        connectedAt: now,
        lastSeenAt: now,
      };

      state.onlineSessions[name] = {
        connectedAt: now,
        lastSeenAt: now,
        kills: 0,
        deaths: 0,
        streak: 0,
      };
    } else if (typeof value === "object" && value) {
      const existing = value as any;

      if (existing.online === false) continue;

      const connectedAt = existing.connectedAt || existing.lastSeenAt || now;
      const lastSeenAt = existing.lastSeenAt || now;

      state.onlinePlayers[name] = {
        online: true,
        connectedAt,
        lastSeenAt,
      };

      state.onlineSessions[name] = {
        connectedAt,
        lastSeenAt,
        kills: Number(existing.sessionKills || existing.kills || 0),
        deaths: Number(existing.sessionDeaths || existing.deaths || 0),
        streak: Number(existing.sessionStreak || existing.streak || 0),
      };
    }
  }

  return state;
}


function serializeState(data: AppState): string {
  return JSON.stringify(data);
}

function hashState(serialized: string): string {
  return crypto.createHash("sha1").update(serialized).digest("hex");
}

function logStateDebug(message: string, meta?: Record<string, unknown>) {
  if (!STATE_DEBUG) return;
  if (meta) {
    console.log(message, meta);
  } else {
    console.log(message);
  }
}

async function persistStateToNeon(serialized: string, hash: string) {
  if (!sql) return;

  if (hash === lastPersistedHash) {
    logStateDebug("⏭️ STATE NEON ignorado: sem alterações");
    return;
  }

  const parsed = JSON.parse(serialized) as AppState;

  await sql`
    INSERT INTO bot_state (id, data, updated_at)
    VALUES (${STATE_ID}, ${sql.json(parsed)}, NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      data = EXCLUDED.data,
      updated_at = NOW()
  `;

  lastPersistedHash = hash;
  lastPersistedJson = serialized;
  logStateDebug("💾 STATE SALVO NO NEON", { bytes: Buffer.byteLength(serialized, "utf8") });
}

async function flushPendingState() {
  if (!pendingPersistJson || !pendingPersistHash) return;
  if (flushPromise) return flushPromise;

  const serialized = pendingPersistJson;
  const hash = pendingPersistHash;
  pendingPersistJson = "";
  pendingPersistHash = "";
  pendingPersistStartedAt = 0;

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  flushPromise = persistStateToNeon(serialized, hash)
    .catch((err) => {
      console.error("❌ erro salvando state no Neon:", err);
      pendingPersistJson = serialized;
      pendingPersistHash = hash;
      pendingPersistStartedAt = pendingPersistStartedAt || Date.now();
      scheduleNeonPersist();
    })
    .finally(() => {
      flushPromise = null;
    });

  return flushPromise;
}

function scheduleNeonPersist() {
  if (!sql || !pendingPersistJson) return;
  if (saveTimer) return;

  const elapsed = pendingPersistStartedAt ? Date.now() - pendingPersistStartedAt : 0;
  const delay = elapsed >= STATE_FORCE_SAVE_AFTER_MS ? 0 : STATE_SAVE_DEBOUNCE_MS;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushPendingState().catch((err) => {
      console.error("❌ erro no flush agendado do state:", err);
    });
  }, delay);
}

export async function flushStateAsync() {
  await flushPendingState();
}

function readLocalState(): AppState {
  if (!fs.existsSync(FILE)) {
    return defaultState();
  }

  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return migrateLegacyState(data);
  } catch (err) {
    console.error("❌ erro lendo state.json local:", err);
    return defaultState();
  }
}

function writeLocalState(data: AppState) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export async function getStateAsync(): Promise<AppState> {
  if (cachedState) {
    return cachedState;
  }

  if (!sql) {
    cachedState = readLocalState();
    lastPersistedJson = serializeState(cachedState);
    lastPersistedHash = hashState(lastPersistedJson);
    return cachedState;
  }

  try {
    const rows = await sql`
      SELECT data
      FROM bot_state
      WHERE id = ${STATE_ID}
      LIMIT 1
    `;

    if (!rows.length) {
      const state = defaultState();
      const serialized = serializeState(state);
      const hash = hashState(serialized);

      await sql`
        INSERT INTO bot_state (id, data, updated_at)
        VALUES (${STATE_ID}, ${sql.json(state)}, NOW())
        ON CONFLICT (id) DO NOTHING
      `;

      cachedState = state;
      lastPersistedJson = serialized;
      lastPersistedHash = hash;
      return cachedState;
    }

    cachedState = migrateLegacyState(rows[0].data || {});
    lastPersistedJson = serializeState(cachedState);
    lastPersistedHash = hashState(lastPersistedJson);
    return cachedState;
  } catch (err) {
    console.error("❌ erro lendo state no Neon, usando state.json local:", err);
    cachedState = readLocalState();
    lastPersistedJson = serializeState(cachedState);
    lastPersistedHash = hashState(lastPersistedJson);
    return cachedState;
  }
}

export async function saveStateAsync(data: AppState) {
  const safeData: AppState = {
    players: data.players || {},
    dailyPlayers: data.dailyPlayers || {},
    weeklyPlayers: data.weeklyPlayers || {},
    onlinePlayers: data.onlinePlayers || {},
    onlineSessions: data.onlineSessions || {},
    onlineActivitySamples: Array.isArray(data.onlineActivitySamples) ? data.onlineActivitySamples : [],
    onlineConnectionEvents: Array.isArray(data.onlineConnectionEvents) ? data.onlineConnectionEvents.slice(-5000) : [],
    playerLinks: data.playerLinks || {},
    playerLinksByGamertag: data.playerLinksByGamertag || {},
    wallets: data.wallets || {},
    economyTransactions: Array.isArray(data.economyTransactions) ? data.economyTransactions.slice(-1000) : [],
    shopOrders: Array.isArray(data.shopOrders) ? data.shopOrders : [],
    shopSavedLocations: Array.isArray(data.shopSavedLocations) ? data.shopSavedLocations : [],
    shopPendingCheckouts: Array.isArray(data.shopPendingCheckouts) ? data.shopPendingCheckouts : [],
    shopCatalog: data.shopCatalog,
    dayzItems: Array.isArray(data.dayzItems) ? data.dayzItems : undefined,
    shopResetMonitor: data.shopResetMonitor || null,
    shopAutoDeploy: data.shopAutoDeploy || null,
    files: data.files || {},
    recentEventIds: (data.recentEventIds || []).slice(-3000),
    killFeedEvents: (data.killFeedEvents || []).slice(-60),
    longShotEvents: (data.longShotEvents || []).slice(-100),

    currentKillStreaks: data.currentKillStreaks || {},
    killStreakEvents: (data.killStreakEvents || []).slice(-100),

    discordMessageIds: data.discordMessageIds || {},
    activeMatch: data.activeMatch || null,

    lastDailyReset: data.lastDailyReset || "",
    lastWeeklyReset: data.lastWeeklyReset || "",

    globalStartedAt: data.globalStartedAt,
    dailyStartedAt: data.dailyStartedAt,
    weeklyStartedAt: data.weeklyStartedAt,

    lastLine: data.lastLine,
    lastFileName: data.lastFileName,
  };

  cachedState = safeData;

  const serialized = serializeState(safeData);
  const hash = hashState(serialized);

  if (hash === lastPersistedHash || serialized === lastPersistedJson) {
    logStateDebug("⏭️ STATE ignorado: sem alterações");
    return;
  }

  writeLocalState(safeData);

  if (!sql) {
    lastPersistedJson = serialized;
    lastPersistedHash = hash;
    logStateDebug("💾 STATE SALVO EM", { file: FILE });
    return;
  }

  pendingPersistJson = serialized;
  pendingPersistHash = hash;
  pendingPersistStartedAt = pendingPersistStartedAt || Date.now();
  scheduleNeonPersist();
}

export function getState(): AppState {
  if (cachedState) return cachedState;
  cachedState = readLocalState();
  lastPersistedJson = serializeState(cachedState);
  lastPersistedHash = hashState(lastPersistedJson);
  return cachedState;
}

export function saveState(data: AppState) {
  cachedState = data;
  const serialized = serializeState(data);
  lastPersistedJson = serialized;
  lastPersistedHash = hashState(serialized);
  writeLocalState(data);
  logStateDebug("💾 STATE SALVO LOCALMENTE", { file: FILE });
}
