import fs from "fs";
import path from "path";
import crypto from "crypto";
import postgres from "postgres";
import type { ShopCatalog } from "./shopCatalog";
import type { DayzItemDefinition } from "./dayzItemDatabase";
import type { Locale } from "./i18n";
import { normalizeDiscordCommandSettings, type DiscordCommandSettings } from "./discord/commandSettings";
import { normalizeServiceSettings, type ServiceSettings } from "./serviceSettings";
import { recordNetworkTransfer } from "./networkMetrics";

const FILE = path.resolve(process.cwd(), "state.json");
const STATE_ID = "main";
const DISCORD_RUNTIME_STATE_ID = "discord_runtime";

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
let pendingPersistReasons = new Set<string>();

let lastCoreHash = "";
let lastDiscordRuntimeHash = "";
let pendingDiscordRuntimeJson = "";
let pendingDiscordRuntimeHash = "";
let discordRuntimeSaveTimer: NodeJS.Timeout | null = null;
let discordRuntimeFlushPromise: Promise<void> | null = null;

const discordRuntimeMetrics = {
  startedAt: new Date().toISOString(),
  saveRequests: 0,
  explicitRuntimeRequests: 0,
  fallbackToCore: 0,
  writes: 0,
  skippedWrites: 0,
  failedWrites: 0,
  totalPayloadBytesWritten: 0,
  totalWriteDurationMs: 0,
  lastPayloadBytes: 0,
  lastWriteDurationMs: 0,
  lastWriteAt: undefined as string | undefined,
  lastWriteError: undefined as string | undefined,
};

type PersistenceReasonMetric = {
  saveRequests: number;
  skippedRequests: number;
  contributedWrites: number;
  estimatedBytesWritten: number;
  lastRequestedAt?: string;
  lastWriteAt?: string;
};

type PersistenceSectionMetric = {
  currentBytes: number;
  currentEntries: number;
  changedWrites: number;
  cumulativeBytesWritten: number;
  lastChangedAt?: string;
  lastDeltaBytes?: number;
};

type PayloadFieldMetric = {
  field: string;
  bytes: number;
  presentIn: number;
};

type PayloadSectionAnalysis = {
  key: string;
  bytes: number;
  entries: number;
  averageEntryBytes: number;
  maxEntryBytes: number;
  topFields: PayloadFieldMetric[];
};

type PersistenceWriteSample = {
  at: string;
  bytes: number;
  durationMs: number;
  reasons: string[];
  changedSections: string[];
  changedBytes: number;
};

const persistenceMetrics = {
  startedAt: new Date().toISOString(),
  reads: 0,
  writes: 0,
  failedWrites: 0,
  saveRequests: 0,
  skippedWrites: 0,
  consolidatedWrites: 0,
  totalPayloadBytesWritten: 0,
  totalChangedBytes: 0,
  totalWriteDurationMs: 0,
  maxWriteDurationMs: 0,
  lastWriteDurationMs: 0,
  lastReadAt: undefined as string | undefined,
  lastWriteAt: undefined as string | undefined,
  lastWriteError: undefined as string | undefined,
  lastPayloadBytes: 0,
  lastChangedBytes: 0,
  lastChangedSections: [] as string[],
  lastWriteReasons: [] as string[],
  reasons: {} as Record<string, PersistenceReasonMetric>,
  sections: {} as Record<string, PersistenceSectionMetric>,
  lastPayloadSections: [] as Array<{ key: string; bytes: number; entries: number }>,
  detailedSections: [] as PayloadSectionAnalysis[],
  recentWrites: [] as PersistenceWriteSample[],
};

let lastSectionHashes: Record<string, string> = {};
let lastSectionBytes: Record<string, number> = {};

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      ssl: "require",
      max: 1,
    })
  : null;


export type PlayerPositionHistoryEventType = "position" | "connect" | "disconnect";

export type PlayerPositionHistoryObservation = {
  sourceKey: string;
  playerName: string;
  playerNormalized: string;
  eventType: PlayerPositionHistoryEventType;
  x?: number;
  z?: number;
  y?: number;
  observedAt: string;
  sourceFile?: string;
};

const PLAYER_POSITION_RETENTION_HOURS = 24;
const PLAYER_POSITION_FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const PLAYER_POSITION_MAX_PENDING = 250;
const PLAYER_POSITION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PLAYER_POSITION_MIN_MOVEMENT_METERS = 25;
const PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS = 2 * 60 * 1000;

let playerPositionTableReadyPromise: Promise<void> | null = null;
let pendingPlayerPositionObservations = new Map<string, PlayerPositionHistoryObservation>();
let lastPlayerPositionFlushAt = 0;
let lastPlayerPositionCleanupAt = 0;

type RetainedPlayerPosition = { x: number; z: number; observedAtMs: number };
const lastRetainedPlayerPositions = new Map<string, RetainedPlayerPosition>();

const playerPositionHistoryMetrics = {
  startedAt: new Date().toISOString(),
  observationsReceived: 0,
  positionEvents: 0,
  queuedPositionEvents: 0,
  suppressedPositionEvents: 0,
  connectEvents: 0,
  disconnectEvents: 0,
  invalidPositions: 0,
  batchesWritten: 0,
  rowsWritten: 0,
  failedBatches: 0,
  totalPayloadBytesWritten: 0,
  totalWriteDurationMs: 0,
  lastWriteDurationMs: 0,
  lastWriteAt: undefined as string | undefined,
  lastError: undefined as string | undefined,
  recentSamples: [] as PlayerPositionHistoryObservation[],
  observedPlayers: new Set<string>(),
};

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
  distance?: number | null;
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
  price?: number;
  locationName?: string;
  balanceBefore?: number;
  balanceAfter?: number;
};


export type ClanRole = "owner" | "officer" | "member";

export type ClanMember = {
  discordId: string;
  gamertag: string;
  role: ClanRole;
  joinedAt: string;
};

export type ClanActivityEvent = {
  id: string;
  type: "created" | "updated" | "invited" | "joined" | "left" | "removed" | "promoted" | "demoted" | "ownership_transferred";
  actorDiscordId: string;
  actorGamertag: string;
  subject?: string;
  createdAt: string;
};

export type Clan = {
  id: string;
  name: string;
  tag: string;
  description?: string;
  ownerDiscordId: string;
  createdAt: string;
  updatedAt: string;
  members: ClanMember[];
  activity?: ClanActivityEvent[];
};

export type ClanInvite = {
  id: string;
  clanId: string;
  invitedDiscordId: string;
  invitedGamertag: string;
  invitedByDiscordId: string;
  invitedByGamertag: string;
  createdAt: string;
  expiresAt: string;
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

export type AppState = {
  players: Record<string, PlayerStats>;
  dailyPlayers: Record<string, PlayerStats>;
  weeklyPlayers: Record<string, PlayerStats>;
  onlinePlayers: Record<string, OnlinePlayer>;
  onlineSessions: Record<string, OnlineSession>;
  onlineActivitySamples?: OnlineActivitySample[];

  playerLinks: Record<string, PlayerLink>;
  playerLinksByGamertag: Record<string, string>;
  playerAlts?: Record<string, string[]>;

  clans?: Record<string, Clan>;
  clanMemberships?: Record<string, string>;
  clanInvites?: ClanInvite[];

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
  // Recent kills for the Player Portal. Unlike killFeedEvents, Discord never consumes this ring buffer.
  portalKillFeedEvents: KillFeedEvent[];
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

  mapRotation?: any;
  mapVoteUserLocales?: Record<string, { locale: Locale; updatedAt: string }>;
  discordCommandSettings?: DiscordCommandSettings;
  serviceSettings?: ServiceSettings;
};

export type DiscordRuntimeState = {
  killFeedEvents: KillFeedEvent[];
  killStreakEvents: KillStreakEvent[];
  discordMessageIds: Record<string, string>;
  mapRotation?: any;
};

function defaultDiscordRuntimeState(): DiscordRuntimeState {
  return {
    killFeedEvents: [],
    killStreakEvents: [],
    discordMessageIds: {},
    mapRotation: undefined,
  };
}

function normalizeDiscordRuntimeState(data: Partial<AppState> | Partial<DiscordRuntimeState> | null | undefined): DiscordRuntimeState {
  const source = data || {};
  return {
    killFeedEvents: Array.isArray(source.killFeedEvents) ? source.killFeedEvents.slice(-60) : [],
    killStreakEvents: Array.isArray(source.killStreakEvents)
      ? source.killStreakEvents.map(normalizeKillStreakEvent).filter(Boolean).slice(-100) as KillStreakEvent[]
      : [],
    discordMessageIds: source.discordMessageIds && typeof source.discordMessageIds === "object" ? source.discordMessageIds : {},
    mapRotation: source.mapRotation,
  };
}

function applyDiscordRuntimeState(state: AppState, runtime: DiscordRuntimeState): AppState {
  state.killFeedEvents = runtime.killFeedEvents;
  state.killStreakEvents = runtime.killStreakEvents;
  state.discordMessageIds = runtime.discordMessageIds;
  state.mapRotation = runtime.mapRotation;
  return state;
}

function defaultState(): AppState {
  return {
    players: {},
    dailyPlayers: {},
    weeklyPlayers: {},
    onlinePlayers: {},
    onlineSessions: {},
    onlineActivitySamples: [],
    playerLinks: {},
    playerLinksByGamertag: {},
    playerAlts: {},
    clans: {},
    clanMemberships: {},
    clanInvites: [],
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
    portalKillFeedEvents: [],
    longShotEvents: [],
    currentKillStreaks: {},
    killStreakEvents: [],
    discordMessageIds: {},
    activeMatch: null,
    mapRotation: undefined,
    mapVoteUserLocales: {},
    discordCommandSettings: {},
    serviceSettings: normalizeServiceSettings(undefined),
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
  state.portalKillFeedEvents = (data.portalKillFeedEvents || data.killFeedEvents || []).slice(-99);
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
  state.playerLinks = data.playerLinks || {};
  state.playerLinksByGamertag = {};
  const playerAlts: Record<string, string[]> = data.playerAlts && typeof data.playerAlts === "object"
    ? (data.playerAlts as Record<string, string[]>)
    : {};
  state.playerAlts = playerAlts;
  state.clans = data.clans && typeof data.clans === "object" ? data.clans : {};
  state.clanMemberships = data.clanMemberships && typeof data.clanMemberships === "object" ? data.clanMemberships : {};
  state.clanInvites = Array.isArray(data.clanInvites) ? data.clanInvites : [];

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
      locale: existing.locale === "pt" ? "pt" : existing.locale === "es" ? "es" : "en",
      linkedAt: existing.linkedAt || existing.createdAt || new Date().toISOString(),
      updatedAt: existing.updatedAt || existing.linkedAt || new Date().toISOString(),
    };
    state.playerLinksByGamertag[normalized] = discordId;
  }

  for (const [discordId, rawAlts] of Object.entries(playerAlts)) {
    const mainLink = state.playerLinks[discordId];
    if (!mainLink) {
      delete playerAlts[discordId];
      continue;
    }
    const mainNormalized = mainLink.gamertagNormalized || "";
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const raw of Array.isArray(rawAlts) ? rawAlts : []) {
      const gamertag = String(raw || "").trim();
      const normalized = gamertag.toLowerCase();
      if (!gamertag || !normalized || normalized === mainNormalized || seen.has(normalized)) continue;
      const owner = state.playerLinksByGamertag[normalized];
      if (owner && owner !== discordId) continue;
      seen.add(normalized);
      clean.push(gamertag);
      state.playerLinksByGamertag[normalized] = discordId;
    }
    playerAlts[discordId] = clean.slice(0, 5);
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
  state.mapRotation = data.mapRotation;
  state.mapVoteUserLocales = data.mapVoteUserLocales && typeof data.mapVoteUserLocales === "object" ? data.mapVoteUserLocales : {};
  state.discordCommandSettings = normalizeDiscordCommandSettings(data.discordCommandSettings);
  state.serviceSettings = normalizeServiceSettings(data.serviceSettings);

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




function hasPersistedSpawnZones(value: any) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.zones) && value.zones.length > 0);
}

function parseLastPersistedState(): Partial<AppState> | null {
  if (!lastPersistedJson) return null;
  try {
    return JSON.parse(lastPersistedJson) as Partial<AppState>;
  } catch {
    return null;
  }
}

function serializeState(data: AppState): string {
  return JSON.stringify(data);
}

function hashState(serialized: string): string {
  return crypto.createHash("sha1").update(serialized).digest("hex");
}

function serializeCoreState(data: AppState): string {
  const { killFeedEvents: _killFeedEvents, killStreakEvents: _killStreakEvents, discordMessageIds: _discordMessageIds, mapRotation: _mapRotation, ...core } = data;
  return JSON.stringify(core);
}

function hashCoreState(data: AppState): string {
  return hashState(serializeCoreState(data));
}

export function getCoreStateFingerprint(data: AppState): string {
  return hashCoreState(data);
}

function serializeDiscordRuntime(data: Partial<AppState> | Partial<DiscordRuntimeState>): string {
  return JSON.stringify(normalizeDiscordRuntimeState(data));
}

function logStateDebug(message: string, meta?: Record<string, unknown>) {
  if (!STATE_DEBUG) return;
  if (meta) {
    console.log(message, meta);
  } else {
    console.log(message);
  }
}

function normalizePersistenceReason(value?: string): string {
  const explicit = String(value || "").trim();
  if (explicit) return explicit.slice(0, 120);

  const stack = new Error().stack || "";
  const line = stack
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes("/src/") && !entry.includes("/src/lib/state."));

  if (!line) return "unknown";
  const match = line.match(/\/src\/(.+?)(?::\d+:\d+|\)?$)/);
  const source = (match?.[1] || line).replace(/\\/g, "/");
  if (source.startsWith("lib/parser")) return "parser";
  if (source.startsWith("lib/discord/")) return `discord:${source.split("/").slice(2, 4).join(":").replace(/\.(ts|js)$/, "")}`;
  if (source.startsWith("routes/adminPanel")) return "admin-panel";
  if (source.startsWith("routes/playerPortal")) return "player-portal";
  if (source.startsWith("routes/admin")) return "admin-api";
  return source.replace(/\.(ts|js)$/, "").slice(0, 120);
}

function getReasonMetric(reason: string): PersistenceReasonMetric {
  return persistenceMetrics.reasons[reason] ||= {
    saveRequests: 0,
    skippedRequests: 0,
    contributedWrites: 0,
    estimatedBytesWritten: 0,
  };
}

function recordSaveRequest(reason: string) {
  const now = new Date().toISOString();
  persistenceMetrics.saveRequests += 1;
  const metric = getReasonMetric(reason);
  metric.saveRequests += 1;
  metric.lastRequestedAt = now;
}

function countSectionEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return value == null ? 0 : 1;
}

function analyzeSectionFields(value: unknown): { topFields: PayloadFieldMetric[]; averageEntryBytes: number; maxEntryBytes: number } {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : [];
  if (!entries.length) return { topFields: [], averageEntryBytes: 0, maxEntryBytes: 0 };

  const fieldTotals: Record<string, { bytes: number; presentIn: number }> = {};
  let totalEntryBytes = 0;
  let maxEntryBytes = 0;
  for (const entry of entries.slice(0, 10000)) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry ?? null), "utf8");
    totalEntryBytes += entryBytes;
    maxEntryBytes = Math.max(maxEntryBytes, entryBytes);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const [field, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
      const current = fieldTotals[field] ||= { bytes: 0, presentIn: 0 };
      current.bytes += Buffer.byteLength(JSON.stringify(fieldValue ?? null), "utf8");
      current.presentIn += 1;
    }
  }

  return {
    averageEntryBytes: Math.round(totalEntryBytes / entries.length),
    maxEntryBytes,
    topFields: Object.entries(fieldTotals)
      .map(([field, metric]) => ({ field, ...metric }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12),
  };
}

function analyzePayload(parsed: AppState, now: string) {
  const allSections = Object.entries(parsed).map(([key, value]) => {
    const serialized = JSON.stringify(value ?? null);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const hash = crypto.createHash("sha1").update(serialized).digest("hex");
    const changed = lastSectionHashes[key] !== hash;
    const previousBytes = lastSectionBytes[key] || 0;
    const entries = countSectionEntries(value);
    const metric = persistenceMetrics.sections[key] ||= {
      currentBytes: 0,
      currentEntries: 0,
      changedWrites: 0,
      cumulativeBytesWritten: 0,
    };
    metric.currentBytes = bytes;
    metric.currentEntries = entries;
    if (changed) {
      metric.changedWrites += 1;
      metric.cumulativeBytesWritten += bytes;
      metric.lastChangedAt = now;
      metric.lastDeltaBytes = bytes - previousBytes;
    }
    lastSectionHashes[key] = hash;
    lastSectionBytes[key] = bytes;
    return { key, bytes, entries, changed, value };
  });

  const changed = allSections.filter((section) => section.changed);
  const detailedKeys = new Set([
    "players",
    "currentKillStreaks",
    "recentEventIds",
    "dayzItems",
    "files",
    "economyTransactions",
    "shopOrders",
    "longShotEvents",
    "killStreakEvents",
  ]);

  return {
    sections: allSections
      .map(({ key, bytes, entries }) => ({ key, bytes, entries }))
      .sort((a, b) => b.bytes - a.bytes),
    changedSections: changed.map((section) => section.key),
    changedBytes: changed.reduce((sum, section) => sum + section.bytes, 0),
    detailedSections: allSections
      .filter((section) => detailedKeys.has(section.key))
      .map((section) => {
        const fieldAnalysis = analyzeSectionFields(section.value);
        return {
          key: section.key,
          bytes: section.bytes,
          entries: section.entries,
          averageEntryBytes: fieldAnalysis.averageEntryBytes,
          maxEntryBytes: fieldAnalysis.maxEntryBytes,
          topFields: fieldAnalysis.topFields,
        };
      })
      .sort((a, b) => b.bytes - a.bytes),
  };
}

async function persistDiscordRuntimeToNeon(serialized: string, hash: string) {
  if (!sql) return;
  if (hash === lastDiscordRuntimeHash) {
    discordRuntimeMetrics.skippedWrites += 1;
    return;
  }

  const runtime = JSON.parse(serialized) as DiscordRuntimeState;
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  const startedAt = Date.now();
  discordRuntimeMetrics.writes += 1;
  discordRuntimeMetrics.lastPayloadBytes = payloadBytes;
  discordRuntimeMetrics.totalPayloadBytesWritten += payloadBytes;
  discordRuntimeMetrics.lastWriteAt = new Date().toISOString();

  try {
    await sql`
      INSERT INTO bot_state (id, data, updated_at)
      VALUES (${DISCORD_RUNTIME_STATE_ID}, ${sql.json(runtime)}, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `;
    recordNetworkTransfer({
      service: "neon-runtime",
      operation: "discord_runtime_write",
      direction: "outbound",
      bytes: payloadBytes,
      ok: true,
    });
    lastDiscordRuntimeHash = hash;
  } catch (err) {
    discordRuntimeMetrics.failedWrites += 1;
    discordRuntimeMetrics.lastWriteError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;
    discordRuntimeMetrics.lastWriteDurationMs = durationMs;
    discordRuntimeMetrics.totalWriteDurationMs += durationMs;
  }
}

async function flushPendingDiscordRuntime() {
  if (!pendingDiscordRuntimeJson || !pendingDiscordRuntimeHash) return;
  if (discordRuntimeFlushPromise) return discordRuntimeFlushPromise;

  const serialized = pendingDiscordRuntimeJson;
  const hash = pendingDiscordRuntimeHash;
  pendingDiscordRuntimeJson = "";
  pendingDiscordRuntimeHash = "";
  if (discordRuntimeSaveTimer) {
    clearTimeout(discordRuntimeSaveTimer);
    discordRuntimeSaveTimer = null;
  }

  discordRuntimeFlushPromise = persistDiscordRuntimeToNeon(serialized, hash)
    .catch((err) => {
      console.error("❌ erro salvando discord_runtime no Neon:", err);
      pendingDiscordRuntimeJson = serialized;
      pendingDiscordRuntimeHash = hash;
      scheduleDiscordRuntimePersist();
    })
    .finally(() => {
      discordRuntimeFlushPromise = null;
      if (pendingDiscordRuntimeJson) scheduleDiscordRuntimePersist();
    });

  return discordRuntimeFlushPromise;
}

function scheduleDiscordRuntimePersist() {
  if (!sql || !pendingDiscordRuntimeJson || discordRuntimeSaveTimer) return;
  discordRuntimeSaveTimer = setTimeout(() => {
    discordRuntimeSaveTimer = null;
    flushPendingDiscordRuntime().catch((err) => console.error("❌ erro no flush do discord_runtime:", err));
  }, STATE_SAVE_DEBOUNCE_MS);
}

async function persistStateToNeon(serialized: string, hash: string, reasons: string[]) {
  if (!sql) return;

  if (hash === lastPersistedHash) {
    persistenceMetrics.skippedWrites += 1;
    logStateDebug("⏭️ STATE NEON ignorado: sem alterações");
    return;
  }

  const parsed = JSON.parse(serialized) as AppState;
  const now = new Date().toISOString();
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  const uniqueReasons = [...new Set(reasons.length ? reasons : ["unknown"])];

  const analysis = analyzePayload(parsed, now);
  persistenceMetrics.writes += 1;
  persistenceMetrics.lastWriteAt = now;
  persistenceMetrics.lastPayloadBytes = payloadBytes;
  persistenceMetrics.lastChangedBytes = analysis.changedBytes;
  persistenceMetrics.lastChangedSections = analysis.changedSections;
  persistenceMetrics.lastWriteReasons = uniqueReasons;
  persistenceMetrics.lastPayloadSections = analysis.sections.slice(0, 24);
  persistenceMetrics.detailedSections = analysis.detailedSections;
  persistenceMetrics.totalPayloadBytesWritten += payloadBytes;
  persistenceMetrics.totalChangedBytes += analysis.changedBytes;
  if (uniqueReasons.length > 1) persistenceMetrics.consolidatedWrites += 1;

  const byteShare = Math.round(payloadBytes / uniqueReasons.length);
  for (const reason of uniqueReasons) {
    const metric = getReasonMetric(reason);
    metric.contributedWrites += 1;
    metric.estimatedBytesWritten += byteShare;
    metric.lastWriteAt = now;
  }

  const writeStarted = Date.now();
  try {
    await sql`
      INSERT INTO bot_state (id, data, updated_at)
      VALUES (${STATE_ID}, ${sql.json(parsed)}, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = NOW()
    `;
    // The serialized JSON dominates the outbound payload to Neon. This counter
    // intentionally measures application bytes, not PostgreSQL/TLS overhead.
    recordNetworkTransfer({
      service: "neon",
      operation: "bot_state_write",
      direction: "outbound",
      bytes: payloadBytes,
      ok: true,
    });
  } catch (err) {
    persistenceMetrics.failedWrites += 1;
    persistenceMetrics.lastWriteError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - writeStarted;
    persistenceMetrics.lastWriteDurationMs = durationMs;
    persistenceMetrics.totalWriteDurationMs += durationMs;
    persistenceMetrics.maxWriteDurationMs = Math.max(persistenceMetrics.maxWriteDurationMs, durationMs);
  }

  persistenceMetrics.recentWrites.push({
    at: now,
    bytes: payloadBytes,
    durationMs: persistenceMetrics.lastWriteDurationMs,
    reasons: uniqueReasons,
    changedSections: analysis.changedSections,
    changedBytes: analysis.changedBytes,
  });
  if (persistenceMetrics.recentWrites.length > 100) {
    persistenceMetrics.recentWrites.splice(0, persistenceMetrics.recentWrites.length - 100);
  }

  lastPersistedHash = hash;
  lastPersistedJson = serialized;
  logStateDebug("💾 STATE SALVO NO NEON", { bytes: payloadBytes, changedBytes: analysis.changedBytes, changedSections: analysis.changedSections });
}

async function flushPendingState() {
  if (!pendingPersistJson || !pendingPersistHash) return;
  if (flushPromise) return flushPromise;

  const serialized = pendingPersistJson;
  const hash = pendingPersistHash;
  const reasons = [...pendingPersistReasons];
  pendingPersistJson = "";
  pendingPersistHash = "";
  pendingPersistReasons = new Set<string>();
  pendingPersistStartedAt = 0;

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  flushPromise = persistStateToNeon(serialized, hash, reasons)
    .catch((err) => {
      console.error("❌ erro salvando state no Neon:", err);
      pendingPersistJson = serialized;
      pendingPersistHash = hash;
      pendingPersistReasons = new Set([...pendingPersistReasons, ...reasons]);
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
  await Promise.all([flushPendingState(), flushPendingDiscordRuntime(), flushPlayerPositionHistoryBatch()]);
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
    lastCoreHash = hashCoreState(cachedState);
    lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(cachedState));
    return cachedState;
  }

  try {
    persistenceMetrics.reads += 1;
    persistenceMetrics.lastReadAt = new Date().toISOString();
    const rows = await sql`
      SELECT id, data, updated_at
      FROM bot_state
      WHERE id IN (${STATE_ID}, ${DISCORD_RUNTIME_STATE_ID})
    `;
    const mainRow = rows.find((row: any) => row.id === STATE_ID);
    const runtimeRow = rows.find((row: any) => row.id === DISCORD_RUNTIME_STATE_ID);

    if (!mainRow) {
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
      lastCoreHash = hashCoreState(state);
      lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(state));
      return cachedState;
    }

    cachedState = migrateLegacyState(mainRow.data || {});
    const mainUpdatedAt = mainRow.updated_at ? new Date(mainRow.updated_at).getTime() : 0;
    const runtimeUpdatedAt = runtimeRow?.updated_at ? new Date(runtimeRow.updated_at).getTime() : 0;
    if (runtimeRow && runtimeUpdatedAt >= mainUpdatedAt) {
      applyDiscordRuntimeState(cachedState, normalizeDiscordRuntimeState(runtimeRow.data || defaultDiscordRuntimeState()));
    }
    const loadedStateJson = serializeState(cachedState);
    recordNetworkTransfer({
      service: "neon",
      operation: "bot_state_read",
      direction: "inbound",
      bytes: Buffer.byteLength(loadedStateJson, "utf8"),
      ok: true,
    });
    lastPersistedJson = loadedStateJson;
    lastPersistedHash = hashState(lastPersistedJson);
    lastCoreHash = hashCoreState(cachedState);
    lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(cachedState));
    return cachedState;
  } catch (err) {
    console.error("❌ erro lendo state no Neon, usando state.json local:", err);
    cachedState = readLocalState();
    lastPersistedJson = serializeState(cachedState);
    lastPersistedHash = hashState(lastPersistedJson);
    lastCoreHash = hashCoreState(cachedState);
    lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(cachedState));
    return cachedState;
  }
}


export function getStatePersistenceMetrics() {
  const writes = Math.max(1, persistenceMetrics.writes);
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(persistenceMetrics.startedAt).getTime()) / 3_600_000);
  const bytesPerHour = persistenceMetrics.totalPayloadBytesWritten / uptimeHours;
  return {
    ...persistenceMetrics,
    averagePayloadBytes: Math.round(persistenceMetrics.totalPayloadBytesWritten / writes),
    averageChangedBytes: Math.round(persistenceMetrics.totalChangedBytes / writes),
    averageWriteDurationMs: Math.round(persistenceMetrics.totalWriteDurationMs / writes),
    projected30DayPayloadBytes: Math.round(bytesPerHour * 24 * 30),
    writeRatePerHour: Number((persistenceMetrics.writes / uptimeHours).toFixed(2)),
    reasons: { ...persistenceMetrics.reasons },
    sections: { ...persistenceMetrics.sections },
    lastPayloadSections: [...persistenceMetrics.lastPayloadSections],
    detailedSections: [...persistenceMetrics.detailedSections],
    recentWrites: [...persistenceMetrics.recentWrites],
  };
}

export function getDiscordRuntimePersistenceMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(discordRuntimeMetrics.startedAt).getTime()) / 3_600_000);
  const writes = Math.max(1, discordRuntimeMetrics.writes);
  return {
    ...discordRuntimeMetrics,
    averagePayloadBytes: Math.round(discordRuntimeMetrics.totalPayloadBytesWritten / writes),
    averageWriteDurationMs: Math.round(discordRuntimeMetrics.totalWriteDurationMs / writes),
    writeRatePerHour: Number((discordRuntimeMetrics.writes / uptimeHours).toFixed(2)),
    projected30DayPayloadBytes: Math.round((discordRuntimeMetrics.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
  };
}


async function ensurePlayerPositionHistoryTable() {
  if (!sql) return;
  if (playerPositionTableReadyPromise) return playerPositionTableReadyPromise;

  playerPositionTableReadyPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS player_position_history (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        player_name TEXT NOT NULL,
        player_normalized TEXT NOT NULL,
        event_type TEXT NOT NULL,
        x DOUBLE PRECISION,
        z DOUBLE PRECISION,
        y DOUBLE PRECISION,
        observed_at TIMESTAMPTZ NOT NULL,
        source_file TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS player_position_history_observed_at_idx ON player_position_history (observed_at)`;
    await sql`CREATE INDEX IF NOT EXISTS player_position_history_player_time_idx ON player_position_history (player_normalized, observed_at)`;
  })().catch((err) => {
    playerPositionTableReadyPromise = null;
    throw err;
  });

  return playerPositionTableReadyPromise;
}

async function flushPlayerPositionHistoryBatch() {
  if (!sql || !pendingPlayerPositionObservations.size) return;

  const rows = [...pendingPlayerPositionObservations.values()];
  pendingPlayerPositionObservations = new Map<string, PlayerPositionHistoryObservation>();
  const startedAt = Date.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");

  try {
    await ensurePlayerPositionHistoryTable();
    const values = rows.map((row) => ({
      source_key: row.sourceKey,
      player_name: row.playerName,
      player_normalized: row.playerNormalized,
      event_type: row.eventType,
      x: row.x ?? null,
      z: row.z ?? null,
      y: row.y ?? null,
      observed_at: row.observedAt,
      source_file: row.sourceFile || null,
    }));
    const result = await sql`
      INSERT INTO player_position_history ${sql(values)}
      ON CONFLICT (source_key) DO NOTHING
    `;

    const inserted = Number((result as any).count ?? rows.length);
    const now = Date.now();
    playerPositionHistoryMetrics.batchesWritten += 1;
    playerPositionHistoryMetrics.rowsWritten += inserted;
    playerPositionHistoryMetrics.totalPayloadBytesWritten += payloadBytes;
    playerPositionHistoryMetrics.lastWriteAt = new Date(now).toISOString();
    lastPlayerPositionFlushAt = now;
    recordNetworkTransfer({
      service: "neon-position-history",
      operation: "player_position_history_batch",
      direction: "outbound",
      bytes: payloadBytes,
      ok: true,
    });

    if (now - lastPlayerPositionCleanupAt >= PLAYER_POSITION_CLEANUP_INTERVAL_MS) {
      await sql`DELETE FROM player_position_history WHERE observed_at < NOW() - INTERVAL '24 hours'`;
      lastPlayerPositionCleanupAt = now;
    }
  } catch (err) {
    playerPositionHistoryMetrics.failedBatches += 1;
    playerPositionHistoryMetrics.lastError = err instanceof Error ? err.message : String(err);
    for (const row of rows) pendingPlayerPositionObservations.set(row.sourceKey, row);
    recordNetworkTransfer({
      service: "neon-position-history",
      operation: "player_position_history_batch",
      direction: "outbound",
      bytes: payloadBytes,
      ok: false,
    });
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;
    playerPositionHistoryMetrics.lastWriteDurationMs = durationMs;
    playerPositionHistoryMetrics.totalWriteDurationMs += durationMs;
  }
}

export async function queuePlayerPositionHistoryObservations(observations: PlayerPositionHistoryObservation[]) {
  if (!observations.length) return;

  for (const observation of observations) {
    playerPositionHistoryMetrics.observationsReceived += 1;
    playerPositionHistoryMetrics.observedPlayers.add(observation.playerNormalized);

    if (observation.eventType === "connect") {
      playerPositionHistoryMetrics.connectEvents += 1;
      // A reconnect starts a new forensic session. If the ADM exposes coordinates
      // on the connect line, use them as the baseline for movement sampling.
      lastRetainedPlayerPositions.delete(observation.playerNormalized);
      if (observation.x != null && observation.z != null) {
        const observedAtMs = Date.parse(observation.observedAt);
        lastRetainedPlayerPositions.set(observation.playerNormalized, {
          x: observation.x,
          z: observation.z,
          observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : Date.now(),
        });
      }
      pendingPlayerPositionObservations.set(observation.sourceKey, observation);
      playerPositionHistoryMetrics.recentSamples.push(observation);
      continue;
    }

    if (observation.eventType === "disconnect") {
      playerPositionHistoryMetrics.disconnectEvents += 1;
      pendingPlayerPositionObservations.set(observation.sourceKey, observation);
      playerPositionHistoryMetrics.recentSamples.push(observation);
      // Never carry a location baseline across sessions.
      lastRetainedPlayerPositions.delete(observation.playerNormalized);
      continue;
    }

    playerPositionHistoryMetrics.positionEvents += 1;
    if (observation.x == null || observation.z == null) continue;

    const observedAtMsRaw = Date.parse(observation.observedAt);
    const observedAtMs = Number.isFinite(observedAtMsRaw) ? observedAtMsRaw : Date.now();
    const previous = lastRetainedPlayerPositions.get(observation.playerNormalized);
    let shouldRetain = !previous;

    if (previous) {
      const dx = observation.x - previous.x;
      const dz = observation.z - previous.z;
      const movedMeters = Math.hypot(dx, dz);
      const elapsedMs = Math.max(0, observedAtMs - previous.observedAtMs);
      shouldRetain =
        movedMeters >= PLAYER_POSITION_MIN_MOVEMENT_METERS ||
        elapsedMs >= PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS;
    }

    if (!shouldRetain) {
      playerPositionHistoryMetrics.suppressedPositionEvents += 1;
      continue;
    }

    playerPositionHistoryMetrics.queuedPositionEvents += 1;
    lastRetainedPlayerPositions.set(observation.playerNormalized, {
      x: observation.x,
      z: observation.z,
      observedAtMs,
    });
    pendingPlayerPositionObservations.set(observation.sourceKey, observation);
    playerPositionHistoryMetrics.recentSamples.push(observation);
  }

  if (playerPositionHistoryMetrics.recentSamples.length > 80) {
    playerPositionHistoryMetrics.recentSamples.splice(0, playerPositionHistoryMetrics.recentSamples.length - 80);
  }

  if (!sql) return;
  const now = Date.now();
  const shouldFlush =
    lastPlayerPositionFlushAt === 0 ||
    now - lastPlayerPositionFlushAt >= PLAYER_POSITION_FLUSH_INTERVAL_MS ||
    pendingPlayerPositionObservations.size >= PLAYER_POSITION_MAX_PENDING;

  if (shouldFlush) await flushPlayerPositionHistoryBatch();
}

export function recordInvalidPlayerPositionObservation() {
  playerPositionHistoryMetrics.invalidPositions += 1;
}

export type PlayerPositionSnapshot = {
  playerName: string;
  playerNormalized: string;
  x: number;
  z: number;
  observedAt: string;
  source: "memory" | "database";
};

export async function getLatestPlayerPositionSnapshot(playerNames: string[]): Promise<PlayerPositionSnapshot[]> {
  const requested = new Map<string, string>();
  for (const rawName of playerNames) {
    const playerName = String(rawName || "").trim();
    if (!playerName) continue;
    requested.set(playerName.toLowerCase(), playerName);
  }
  if (!requested.size) return [];

  const byPlayer = new Map<string, PlayerPositionSnapshot>();

  // Prefer the most recent retained in-memory point. This lets the admin map
  // reflect the latest parser cycle without forcing the pending forensic batch
  // to be written to Neon first.
  for (const [playerNormalized, playerName] of requested.entries()) {
    const retained = lastRetainedPlayerPositions.get(playerNormalized);
    if (!retained) continue;
    byPlayer.set(playerNormalized, {
      playerName,
      playerNormalized,
      x: retained.x,
      z: retained.z,
      observedAt: new Date(retained.observedAtMs).toISOString(),
      source: "memory",
    });
  }

  if (sql) {
    try {
      await ensurePlayerPositionHistoryTable();
      const normalizedNames = [...requested.keys()];
      const rows = await sql`
        SELECT DISTINCT ON (player_normalized)
          player_name, player_normalized, x, z, observed_at
        FROM player_position_history
        WHERE event_type = 'position'
          AND x IS NOT NULL
          AND z IS NOT NULL
          AND observed_at >= NOW() - INTERVAL '24 hours'
          AND player_normalized IN ${sql(normalizedNames)}
        ORDER BY player_normalized, observed_at DESC
      `;

      for (const row of rows as any[]) {
        const playerNormalized = String(row.player_normalized || "").toLowerCase();
        if (!requested.has(playerNormalized)) continue;
        const observedAt = row.observed_at instanceof Date
          ? row.observed_at.toISOString()
          : new Date(row.observed_at).toISOString();
        const candidate: PlayerPositionSnapshot = {
          playerName: String(row.player_name || requested.get(playerNormalized) || playerNormalized),
          playerNormalized,
          x: Number(row.x),
          z: Number(row.z),
          observedAt,
          source: "database",
        };
        const current = byPlayer.get(playerNormalized);
        if (!current || Date.parse(candidate.observedAt) > Date.parse(current.observedAt)) {
          byPlayer.set(playerNormalized, candidate);
        }
      }
    } catch (err) {
      // The admin map is observational only. A read failure must never affect
      // parser, rankings, killfeed or the position-history writer.
      console.warn("Failed to read latest player position snapshot", err);
    }
  }

  return [...byPlayer.values()];
}

export function getPlayerPositionHistoryMetrics() {
  const uptimeHours = Math.max(1 / 60, (Date.now() - new Date(playerPositionHistoryMetrics.startedAt).getTime()) / 3_600_000);
  const batches = Math.max(1, playerPositionHistoryMetrics.batchesWritten);
  return {
    startedAt: playerPositionHistoryMetrics.startedAt,
    retentionHours: PLAYER_POSITION_RETENTION_HOURS,
    flushIntervalMinutes: PLAYER_POSITION_FLUSH_INTERVAL_MS / 60_000,
    minMovementMeters: PLAYER_POSITION_MIN_MOVEMENT_METERS,
    maxSampleIntervalMinutes: PLAYER_POSITION_MAX_SAMPLE_INTERVAL_MS / 60_000,
    observationsReceived: playerPositionHistoryMetrics.observationsReceived,
    positionEvents: playerPositionHistoryMetrics.positionEvents,
    queuedPositionEvents: playerPositionHistoryMetrics.queuedPositionEvents,
    suppressedPositionEvents: playerPositionHistoryMetrics.suppressedPositionEvents,
    positionReductionPercent: playerPositionHistoryMetrics.positionEvents > 0
      ? Number(((playerPositionHistoryMetrics.suppressedPositionEvents / playerPositionHistoryMetrics.positionEvents) * 100).toFixed(2))
      : 0,
    connectEvents: playerPositionHistoryMetrics.connectEvents,
    disconnectEvents: playerPositionHistoryMetrics.disconnectEvents,
    invalidPositions: playerPositionHistoryMetrics.invalidPositions,
    uniquePlayersObserved: playerPositionHistoryMetrics.observedPlayers.size,
    pendingObservations: pendingPlayerPositionObservations.size,
    batchesWritten: playerPositionHistoryMetrics.batchesWritten,
    rowsWritten: playerPositionHistoryMetrics.rowsWritten,
    failedBatches: playerPositionHistoryMetrics.failedBatches,
    totalPayloadBytesWritten: playerPositionHistoryMetrics.totalPayloadBytesWritten,
    averageBatchPayloadBytes: Math.round(playerPositionHistoryMetrics.totalPayloadBytesWritten / batches),
    averageWriteDurationMs: Math.round(playerPositionHistoryMetrics.totalWriteDurationMs / batches),
    projected30DayPayloadBytes: Math.round((playerPositionHistoryMetrics.totalPayloadBytesWritten / uptimeHours) * 24 * 30),
    lastWriteAt: playerPositionHistoryMetrics.lastWriteAt,
    lastWriteDurationMs: playerPositionHistoryMetrics.lastWriteDurationMs,
    lastError: playerPositionHistoryMetrics.lastError,
    recentSamples: [...playerPositionHistoryMetrics.recentSamples],
  };
}

export async function saveDiscordRuntimeStateOnlyAsync(data: AppState, reason?: string) {
  const runtimeReason = normalizePersistenceReason(reason);
  discordRuntimeMetrics.saveRequests += 1;
  discordRuntimeMetrics.explicitRuntimeRequests += 1;
  await persistDiscordRuntimeOnly(data, runtimeReason);
}

async function persistDiscordRuntimeOnly(data: AppState, runtimeReason: string) {
  const runtime = normalizeDiscordRuntimeState(data);
  if (cachedState) applyDiscordRuntimeState(cachedState, runtime);
  else cachedState = data;
  writeLocalState(cachedState);

  if (!sql) {
    // Local-only environments keep the established single-file behavior.
    await saveStateAsync(cachedState, runtimeReason);
    return;
  }

  const serialized = JSON.stringify(runtime);
  const hash = hashState(serialized);
  if (hash === lastDiscordRuntimeHash || hash === pendingDiscordRuntimeHash) {
    discordRuntimeMetrics.skippedWrites += 1;
    return;
  }

  pendingDiscordRuntimeJson = serialized;
  pendingDiscordRuntimeHash = hash;
  scheduleDiscordRuntimePersist();
}

export async function saveDiscordStateAsync(data: AppState, reason?: string) {
  const runtimeReason = normalizePersistenceReason(reason);
  discordRuntimeMetrics.saveRequests += 1;

  // Generic Discord mutations remain conservative: if core state changed, persist it fully.
  // The periodic feed loop uses saveDiscordRuntimeStateOnlyAsync only after verifying that
  // the loop itself did not change core state.
  if (!lastCoreHash || hashCoreState(data) !== lastCoreHash) {
    discordRuntimeMetrics.fallbackToCore += 1;
    await saveStateAsync(data, runtimeReason);
    return;
  }

  await persistDiscordRuntimeOnly(data, runtimeReason);
}

export async function saveStateAsync(data: AppState, reason?: string) {
  const persistenceReason = normalizePersistenceReason(reason);
  recordSaveRequest(persistenceReason);
  const persistedState = parseLastPersistedState();
  const shouldProtectMapRotation = !data.mapRotation && hasPersistedSpawnZones(persistedState?.mapRotation);

  const safeData: AppState = {
    players: data.players || {},
    dailyPlayers: data.dailyPlayers || {},
    weeklyPlayers: data.weeklyPlayers || {},
    onlinePlayers: data.onlinePlayers || {},
    onlineSessions: data.onlineSessions || {},
    onlineActivitySamples: Array.isArray(data.onlineActivitySamples) ? data.onlineActivitySamples : [],
    playerLinks: data.playerLinks || {},
    playerLinksByGamertag: data.playerLinksByGamertag || {},
    playerAlts: data.playerAlts && typeof data.playerAlts === "object" ? data.playerAlts : {},
    clans: data.clans && typeof data.clans === "object" ? data.clans : {},
    clanMemberships: data.clanMemberships && typeof data.clanMemberships === "object" ? data.clanMemberships : {},
    clanInvites: Array.isArray(data.clanInvites) ? data.clanInvites : [],
    wallets: data.wallets || {},
    economyTransactions: Array.isArray(data.economyTransactions) ? data.economyTransactions.slice(-1000) : [],
    shopOrders: Array.isArray(data.shopOrders) ? data.shopOrders : [],
    shopSavedLocations: Array.isArray(data.shopSavedLocations) ? data.shopSavedLocations : [],
    shopPendingCheckouts: Array.isArray(data.shopPendingCheckouts) ? data.shopPendingCheckouts : [],
    shopCatalog: data.shopCatalog,
    dayzItems: Array.isArray(data.dayzItems) ? data.dayzItems : undefined,
    shopResetMonitor: data.shopResetMonitor || null,
    shopAutoDeploy: data.shopAutoDeploy || null,
    mapRotation: shouldProtectMapRotation ? persistedState?.mapRotation : data.mapRotation || undefined,
    mapVoteUserLocales: data.mapVoteUserLocales && typeof data.mapVoteUserLocales === "object" ? data.mapVoteUserLocales : {},
    discordCommandSettings: normalizeDiscordCommandSettings(data.discordCommandSettings),
    serviceSettings: normalizeServiceSettings(data.serviceSettings),
    files: data.files || {},
    recentEventIds: (data.recentEventIds || []).slice(-3000),
    killFeedEvents: (data.killFeedEvents || []).slice(-60),
    portalKillFeedEvents: (data.portalKillFeedEvents || []).slice(-99),
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
  lastCoreHash = hashCoreState(safeData);

  // If a runtime-only write was waiting while a full/core save became necessary,
  // refresh that pending payload so an older runtime snapshot can never become
  // newer than the full row after a race.
  if (pendingDiscordRuntimeJson) {
    pendingDiscordRuntimeJson = serializeDiscordRuntime(safeData);
    pendingDiscordRuntimeHash = hashState(pendingDiscordRuntimeJson);
  }

  const serialized = serializeState(safeData);
  const hash = hashState(serialized);

  if (hash === lastPersistedHash || serialized === lastPersistedJson) {
    persistenceMetrics.skippedWrites += 1;
    getReasonMetric(persistenceReason).skippedRequests += 1;
    logStateDebug("⏭️ STATE ignorado: sem alterações", { reason: persistenceReason });
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
  pendingPersistReasons.add(persistenceReason);
  pendingPersistStartedAt = pendingPersistStartedAt || Date.now();
  scheduleNeonPersist();
}

export function getState(): AppState {
  if (cachedState) return cachedState;
  cachedState = readLocalState();
  lastPersistedJson = serializeState(cachedState);
  lastPersistedHash = hashState(lastPersistedJson);
  lastCoreHash = hashCoreState(cachedState);
  lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(cachedState));
  return cachedState;
}

export function saveState(data: AppState) {
  cachedState = data;
  const serialized = serializeState(data);
  lastPersistedJson = serialized;
  lastPersistedHash = hashState(serialized);
  lastCoreHash = hashCoreState(data);
  lastDiscordRuntimeHash = hashState(serializeDiscordRuntime(data));
  writeLocalState(data);
  logStateDebug("💾 STATE SALVO LOCALMENTE", { file: FILE });
}
