import fs from "fs";
import path from "path";
import postgres from "postgres";

const FILE = path.resolve(process.cwd(), "state.json");
const STATE_ID = "main";

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
};

export type ShopOrder = {
  id: string;
  discordUserId: string;
  itemClass: string;
  itemName?: string;
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

export type AppState = {
  players: Record<string, PlayerStats>;
  dailyPlayers: Record<string, PlayerStats>;
  weeklyPlayers: Record<string, PlayerStats>;
  onlinePlayers: Record<string, OnlinePlayer>;
  onlineSessions: Record<string, OnlineSession>;

  shopOrders: ShopOrder[];
  shopResetMonitor?: ShopResetMonitor | null;

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
    shopOrders: [],
    shopResetMonitor: null,
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
  state.shopOrders = Array.isArray(data.shopOrders) ? data.shopOrders : [];
  state.shopResetMonitor = data.shopResetMonitor || null;

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
  if (!sql) {
    return readLocalState();
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

      await sql`
        INSERT INTO bot_state (id, data, updated_at)
        VALUES (${STATE_ID}, ${sql.json(state)}, NOW())
        ON CONFLICT (id) DO NOTHING
      `;

      return state;
    }

    return migrateLegacyState(rows[0].data || {});
  } catch (err) {
    console.error("❌ erro lendo state no Neon, usando state.json local:", err);
    return readLocalState();
  }
}

export async function saveStateAsync(data: AppState) {
  const safeData: AppState = {
    players: data.players || {},
    dailyPlayers: data.dailyPlayers || {},
    weeklyPlayers: data.weeklyPlayers || {},
    onlinePlayers: data.onlinePlayers || {},
    onlineSessions: data.onlineSessions || {},
    shopOrders: Array.isArray(data.shopOrders) ? data.shopOrders : [],
    shopResetMonitor: data.shopResetMonitor || null,
    files: data.files || {},
    recentEventIds: (data.recentEventIds || []).slice(-10000),
    killFeedEvents: (data.killFeedEvents || []).slice(-99),
    longShotEvents: (data.longShotEvents || []).slice(-150),

    currentKillStreaks: data.currentKillStreaks || {},
    killStreakEvents: (data.killStreakEvents || []).slice(-150),

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

  writeLocalState(safeData);

  if (!sql) {
    console.log("💾 STATE SALVO EM:", FILE);
    return;
  }

  try {
    await sql`
      INSERT INTO bot_state (id, data, updated_at)
      VALUES (${STATE_ID}, ${sql.json(safeData)}, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = NOW()
    `;

    console.log("💾 STATE SALVO NO NEON");
  } catch (err) {
    console.error("❌ erro salvando state no Neon:", err);
  }
}

export function getState(): AppState {
  return readLocalState();
}

export function saveState(data: AppState) {
  writeLocalState(data);
  console.log("💾 STATE SALVO LOCALMENTE:", FILE);
}
