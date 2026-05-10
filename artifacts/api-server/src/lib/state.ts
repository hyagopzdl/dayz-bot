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

export type OnlinePlayer = {
  online: true;
  lastSeenAt: string;
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

export type AppState = {
  players: Record<string, PlayerStats>;
  dailyPlayers: Record<string, PlayerStats>;
  weeklyPlayers: Record<string, PlayerStats>;
  onlinePlayers: Record<string, OnlinePlayer>;

  files: Record<string, FileCursor>;
  recentEventIds: string[];

  killFeedEvents: KillFeedEvent[];

  currentKillStreaks: Record<string, number>;
  killStreakEvents: KillStreakEvent[];

  discordMessageIds: Record<string, string>;

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
    files: {},
    recentEventIds: [],
    killFeedEvents: [],
    currentKillStreaks: {},
    killStreakEvents: [],
    discordMessageIds: {},
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

  state.lastLine = data.lastLine;
  state.lastFileName = data.lastFileName;

  const rawOnlinePlayers = data.onlinePlayers || {};

  for (const [name, value] of Object.entries(rawOnlinePlayers)) {
    if (value === true) {
      state.onlinePlayers[name] = {
        online: true,
        lastSeenAt: new Date().toISOString(),
      };
    } else if (typeof value === "object" && value) {
      state.onlinePlayers[name] = value as OnlinePlayer;
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
    files: data.files || {},
    recentEventIds: (data.recentEventIds || []).slice(-10000),
    killFeedEvents: (data.killFeedEvents || []).slice(-100),

    currentKillStreaks: data.currentKillStreaks || {},
    killStreakEvents: (data.killStreakEvents || []).slice(-150),

    discordMessageIds: data.discordMessageIds || {},

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
