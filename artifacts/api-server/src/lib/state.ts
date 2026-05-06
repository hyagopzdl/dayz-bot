import fs from "fs";
import path from "path";

const FILE = path.resolve(process.cwd(), "state.json");

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
  at: string;
};

export type AppState = {
  players: Record<string, PlayerStats>;
  dailyPlayers: Record<string, PlayerStats>;
  weeklyPlayers: Record<string, PlayerStats>;
  onlinePlayers: Record<string, OnlinePlayer>;

  files: Record<string, FileCursor>;
  recentEventIds: string[];

  killFeedEvents: KillFeedEvent[];

  lastDailyReset: string;
  lastWeeklyReset: string;

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
    lastDailyReset: "",
    lastWeeklyReset: "",
  };
}

function migrateLegacyState(data: any): AppState {
  const state = defaultState();

  state.players = data.players || {};
  state.dailyPlayers = data.dailyPlayers || {};
  state.weeklyPlayers = data.weeklyPlayers || {};
  state.recentEventIds = data.recentEventIds || [];
  state.killFeedEvents = data.killFeedEvents || [];
  state.files = data.files || {};
  state.lastDailyReset = data.lastDailyReset || "";
  state.lastWeeklyReset = data.lastWeeklyReset || "";
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

export function getState(): AppState {
  if (!fs.existsSync(FILE)) {
    return defaultState();
  }

  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return migrateLegacyState(data);
  } catch (err) {
    console.error("❌ erro lendo state.json, usando estado vazio:", err);
    return defaultState();
  }
}

export function saveState(data: AppState) {
  const safeData: AppState = {
    players: data.players || {},
    dailyPlayers: data.dailyPlayers || {},
    weeklyPlayers: data.weeklyPlayers || {},
    onlinePlayers: data.onlinePlayers || {},
    files: data.files || {},
    recentEventIds: (data.recentEventIds || []).slice(-10000),
    killFeedEvents: (data.killFeedEvents || []).slice(-50),
    lastDailyReset: data.lastDailyReset || "",
    lastWeeklyReset: data.lastWeeklyReset || "",
    lastLine: data.lastLine,
    lastFileName: data.lastFileName,
  };

  fs.writeFileSync(FILE, JSON.stringify(safeData, null, 2));
  console.log("💾 STATE SALVO EM:", FILE);
}
