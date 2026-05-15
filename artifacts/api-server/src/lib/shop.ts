import type { AppState, ShopOrder } from "./state";
import { getNitradoGameserverStatus } from "./nitradoDownloader";
import { downloadTextFile, uploadTextFile } from "./nitradoFtp";
import {
  injectShopEventSpawnsXml,
  injectShopEventsXml,
  removeShopBotBlock,
} from "./shopXml";

export type ShopItem = {
  id: string;
  name: string;
  className: string;
  price: number;
};

export const SHOP_ITEMS: ShopItem[] = [
  {
    id: "barrel_green",
    name: "Green Barrel",
    className: "Barrel_Green",
    price: 250,
  },
  {
    id: "barrel_red",
    name: "Red Barrel",
    className: "Barrel_Red",
    price: 250,
  },
];

const DEFAULT_DAYZ_MISSION_DIR =
  process.env.DAYZ_MISSION_DIR || "dayzps_missions/dayzOffline.chernarusplus";

function normalizeRelativePath(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

const DAYZ_MISSION_DIR = normalizeRelativePath(DEFAULT_DAYZ_MISSION_DIR);

export const SHOP_EVENTS_PATH = `${DAYZ_MISSION_DIR}/db/events.xml`;
export const SHOP_EVENT_SPAWNS_PATH = `${DAYZ_MISSION_DIR}/cfgeventspawns.xml`;

function normalizeItemName(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function boolEnv(name: string, defaultValue: boolean) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name: string, defaultValue: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function normalizeServerStatus(status: string | null | undefined) {
  return String(status || "unknown").trim().toLowerCase();
}

function isOfflineLikeStatus(status: string | null | undefined) {
  const normalized = normalizeServerStatus(status);
  return (
    normalized.includes("stop") ||
    normalized.includes("restart") ||
    normalized.includes("offline") ||
    normalized.includes("shutdown") ||
    normalized.includes("suspend")
  );
}

function isOnlineLikeStatus(status: string | null | undefined) {
  const normalized = normalizeServerStatus(status);
  return (
    normalized === "started" ||
    normalized === "online" ||
    normalized === "running" ||
    normalized === "active" ||
    normalized.includes("started") ||
    normalized.includes("online") ||
    normalized.includes("running")
  );
}

export function ensureShopState(state: AppState) {
  state.shopOrders = state.shopOrders || [];
  state.shopResetMonitor = state.shopResetMonitor || null;
  return state;
}

export function findShopItem(input: string) {
  const normalized = normalizeItemName(input);

  return (
    SHOP_ITEMS.find(
      (item) =>
        normalizeItemName(item.id) === normalized ||
        normalizeItemName(item.name) === normalized ||
        normalizeItemName(item.className) === normalized,
    ) || null
  );
}

export function parseShopCoordinates(input: string, fallbackY = 0) {
  const raw = String(input || "").trim();

  if (!raw) {
    throw new Error("Coordinate input is empty.");
  }

  const normalized = raw
    .replace(/,/g, ".")
    .replace(/[;|]/g, " / ")
    .replace(/\s+\/\s+/g, " / ");

  const matches = normalized.match(/-?\d+(?:\.\d+)?/g) || [];
  const values = matches.map((value) => Number.parseFloat(value));

  if (values.length < 2) {
    throw new Error("Invalid coordinates. Use: `4587.29 / 8373.59`");
  }

  const [x, second, third] = values;
  const hasExplicitY = values.length >= 3;
  const y = hasExplicitY ? second : fallbackY;
  const z = hasExplicitY ? third : second;

  if (![x, y, z].every(Number.isFinite)) {
    throw new Error("Invalid coordinates.");
  }

  return { x, y, z };
}

export function createShopOrder(options: {
  state: AppState;
  discordUserId: string;
  itemInput: string;
  x: number;
  y: number;
  z: number;
}) {
  const state = ensureShopState(options.state);
  const item = findShopItem(options.itemInput);

  if (!item) {
    throw new Error(
      `Item not found. Available items: ${SHOP_ITEMS.map((i) => i.id).join(", ")}`,
    );
  }

  if (![options.x, options.y, options.z].every(Number.isFinite)) {
    throw new Error("Invalid coordinates.");
  }

  const now = new Date().toISOString();

  const order: ShopOrder = {
    id: `shop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    discordUserId: options.discordUserId,
    itemClass: item.className,
    itemName: item.name,
    x: Number(options.x.toFixed(2)),
    y: Number(options.y.toFixed(2)),
    z: Number(options.z.toFixed(2)),
    status: "pending_spawn",
    createdAt: now,
  };

  state.shopOrders.push(order);
  return order;
}

export function getPendingShopOrders(state: AppState) {
  return ensureShopState(state).shopOrders.filter(
    (order) => order.status === "pending_spawn",
  );
}

export function getIncludedShopOrders(state: AppState) {
  return ensureShopState(state).shopOrders.filter(
    (order) => order.status === "included_in_restart",
  );
}

function getIncludedBatchOrders(state: AppState) {
  const included = getIncludedShopOrders(state);
  if (!included.length) return [];

  const batchId = state.shopResetMonitor?.batchId || included[0]?.restartTarget;
  if (!batchId) return included;

  return included.filter((order) => order.restartTarget === batchId);
}

async function backupShopXmlFiles(eventsXml: string, eventSpawnsXml: string) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  await uploadTextFile(`${SHOP_EVENTS_PATH}.shop-backup-${stamp}`, eventsXml);
  await uploadTextFile(
    `${SHOP_EVENT_SPAWNS_PATH}.shop-backup-${stamp}`,
    eventSpawnsXml,
  );
}

export async function deployPendingShopOrders(state: AppState) {
  const pendingOrders = getPendingShopOrders(state);

  if (!pendingOrders.length) {
    return {
      deployed: 0,
      path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
    };
  }

  const [eventsXml, eventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  await backupShopXmlFiles(eventsXml, eventSpawnsXml);

  const injectedEvents = injectShopEventsXml(eventsXml, pendingOrders);
  const injectedEventSpawns = injectShopEventSpawnsXml(
    eventSpawnsXml,
    pendingOrders,
  );

  await uploadTextFile(SHOP_EVENTS_PATH, injectedEvents.xml);
  await uploadTextFile(SHOP_EVENT_SPAWNS_PATH, injectedEventSpawns);

  const now = new Date().toISOString();
  const batchId = `restart_${Date.now()}`;

  for (const order of pendingOrders) {
    order.status = "included_in_restart";
    order.restartTarget = batchId;
    order.includedAt = now;
  }

  state.shopResetMonitor = {
    batchId,
    deployedAt: now,
    sawOfflineAt: undefined,
    sawOnlineAt: undefined,
    lastStatus: null,
    lastCheckedAt: now,
    clearedAt: undefined,
  };

  return {
    deployed: pendingOrders.length,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
    batchId,
  };
}

async function removeShopXmlBlocks() {
  const [eventsXml, eventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  await backupShopXmlFiles(eventsXml, eventSpawnsXml);

  await uploadTextFile(SHOP_EVENTS_PATH, removeShopBotBlock(eventsXml));
  await uploadTextFile(
    SHOP_EVENT_SPAWNS_PATH,
    removeShopBotBlock(eventSpawnsXml),
  );
}

export async function clearShopSpawnerAndMarkSpawned(
  state: AppState,
  options?: { cancelPending?: boolean; includedOnly?: boolean },
) {
  const cancelPending = options?.cancelPending ?? true;
  const includedOrders = options?.includedOnly
    ? getIncludedBatchOrders(state)
    : getIncludedShopOrders(state);
  const pendingOrders = cancelPending ? getPendingShopOrders(state) : [];

  await removeShopXmlBlocks();

  const now = new Date().toISOString();

  for (const order of includedOrders) {
    order.status = "spawned";
    order.spawnedAt = now;
  }

  for (const order of pendingOrders) {
    order.status = "failed";
    order.failedAt = now;
    order.failReason = "Cleared before deploy";
  }

  if (!getIncludedShopOrders(state).length) {
    state.shopResetMonitor = null;
  } else if (state.shopResetMonitor) {
    state.shopResetMonitor.clearedAt = now;
  }

  return {
    cleared: includedOrders.length,
    cancelled: pendingOrders.length,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
  };
}

export async function pollShopResetStatusAndAutoClear(state: AppState) {
  ensureShopState(state);

  if (!boolEnv("SHOP_AUTO_CLEAR_ENABLED", true)) {
    return null;
  }

  const includedOrders = getIncludedShopOrders(state);
  if (!includedOrders.length) return null;

  const monitor =
    state.shopResetMonitor ||
    ({
      batchId: includedOrders[0]?.restartTarget,
      deployedAt: includedOrders[0]?.includedAt,
      lastStatus: null,
      lastCheckedAt: new Date().toISOString(),
    } as NonNullable<AppState["shopResetMonitor"]>);

  state.shopResetMonitor = monitor;

  let status: string | null = null;

  try {
    const response = await getNitradoGameserverStatus();
    status = response.status;
  } catch (err) {
    console.error("❌ shop auto-clear status poll failed:", err);
    return null;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const normalized = normalizeServerStatus(status);

  monitor.lastStatus = normalized;
  monitor.lastCheckedAt = nowIso;

  if (!monitor.sawOfflineAt && isOfflineLikeStatus(normalized)) {
    monitor.sawOfflineAt = nowIso;
    console.log(`🛒 shop reset monitor: server went offline/restarting (${normalized})`);
    return null;
  }

  if (monitor.sawOfflineAt && !monitor.sawOnlineAt && isOnlineLikeStatus(normalized)) {
    monitor.sawOnlineAt = nowIso;
    console.log(`🛒 shop reset monitor: server came back online (${normalized})`);
    return null;
  }

  if (!monitor.sawOfflineAt) {
    console.log(`🛒 shop auto-clear aguardando servidor desligar/reiniciar. status=${normalized}`);
    return null;
  }

  if (!monitor.sawOnlineAt) {
    console.log(`🛒 shop auto-clear aguardando servidor voltar online. status=${normalized}`);
    return null;
  }

  const clearDelayMinutes = numberEnv("SHOP_CLEAR_MINUTES_AFTER_RESET", 5);
  const onlineAtMs = new Date(monitor.sawOnlineAt).getTime();
  const elapsedMs = Date.now() - onlineAtMs;
  const requiredMs = clearDelayMinutes * 60 * 1000;

  if (elapsedMs < requiredMs) {
    const remainingSeconds = Math.ceil((requiredMs - elapsedMs) / 1000);
    console.log(
      `🛒 shop auto-clear aguardando janela segura pós-online (${remainingSeconds}s restantes).`,
    );
    return null;
  }

  const result = await clearShopSpawnerAndMarkSpawned(state, {
    cancelPending: false,
    includedOnly: true,
  });

  console.log(
    `✅ SHOP_BOT auto-clear completed after Nitrado status reset: cleared=${result.cleared} cancelled=${result.cancelled}`,
  );

  return result;
}

// Backwards-compatible name used by earlier patches/discordBot imports.
export const autoClearShopBlocksIfNeeded = pollShopResetStatusAndAutoClear;

// Backwards-compatible name still imported by parser.ts from the previous ADM-based patch.
// The current implementation no longer trusts ADM content as the primary reset signal;
// it polls Nitrado server status instead. The second argument is intentionally ignored.
export async function tryAutoClearShopAfterAdmReset(
  state: AppState,
  _admFiles?: unknown,
) {
  return pollShopResetStatusAndAutoClear(state);
}

function parseRestartTimes() {
  const raw = process.env.SHOP_RESTART_TIMES || "00:00,04:00,08:00,12:00,16:00,20:00";

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const [hourRaw, minuteRaw = "0"] = value.split(":");
      const hour = Number(hourRaw);
      const minute = Number(minuteRaw);

      if (
        !Number.isInteger(hour) ||
        !Number.isInteger(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        throw new Error(`Invalid SHOP_RESTART_TIMES entry: ${value}`);
      }

      return { label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, minutes: hour * 60 + minute };
    })
    .sort((a, b) => a.minutes - b.minutes);
}

function getLocalDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  const year = values.year;
  const month = values.month;
  const day = values.day;
  let hour = Number(values.hour || 0);
  const minute = Number(values.minute || 0);

  // Some runtimes format midnight as 24:00. Treat it as 00:00 for window math.
  if (hour === 24) hour = 0;

  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

type AutoDeployWindow = {
  windowId: string;
  restartLabel: string;
  minutesUntilRestart: number;
};

function getActiveAutoDeployWindow(now = new Date()): AutoDeployWindow | null {
  if (!boolEnv("SHOP_AUTO_DEPLOY_ENABLED", false)) return null;

  const times = parseRestartTimes();
  if (!times.length) return null;

  const timeZone = process.env.SHOP_RESTART_TIMEZONE || "America/Sao_Paulo";
  const deployBefore = numberEnv("SHOP_DEPLOY_MINUTES_BEFORE_RESET", 15);
  const deployGraceAfter = numberEnv("SHOP_DEPLOY_GRACE_MINUTES_AFTER_SCHEDULE", 5);
  const local = getLocalDateParts(now, timeZone);

  for (const restart of times) {
    let diff = restart.minutes - local.minuteOfDay;

    // If the restart is just after midnight and now is late in the previous day,
    // treat it as the next occurrence.
    if (diff < -deployGraceAfter) diff += 24 * 60;

    if (diff <= deployBefore && diff >= -deployGraceAfter) {
      const windowDateKey = diff < 0 ? `${local.dateKey}` : local.dateKey;
      return {
        windowId: `${windowDateKey}_${restart.label}`,
        restartLabel: restart.label,
        minutesUntilRestart: diff,
      };
    }
  }

  return null;
}

export async function autoDeployPendingShopOrdersIfNeeded(state: AppState) {
  ensureShopState(state);

  const pendingOrders = getPendingShopOrders(state);
  if (!pendingOrders.length) return null;

  // Never inject a new batch while a previous one is waiting for restart/clear.
  if (getIncludedShopOrders(state).length) {
    return null;
  }

  const window = getActiveAutoDeployWindow();
  if (!window) return null;

  const autoDeployState = state.shopAutoDeploy || {};
  state.shopAutoDeploy = autoDeployState;
  autoDeployState.lastCheckedAt = new Date().toISOString();

  if (autoDeployState.lastWindowId === window.windowId) {
    console.log(
      `🛒 shop auto-deploy já executado para janela ${window.windowId}.`,
    );
    return null;
  }

  console.log(
    `🛒 shop auto-deploy iniciado para restart ${window.restartLabel} (${window.minutesUntilRestart} min). pending=${pendingOrders.length}`,
  );

  const result = await deployPendingShopOrders(state);

  autoDeployState.lastWindowId = window.windowId;
  autoDeployState.lastDeployAt = new Date().toISOString();

  console.log(
    `✅ SHOP_BOT auto-deploy completed: deployed=${result.deployed} batch=${result.batchId || "none"}`,
  );

  return {
    ...result,
    windowId: window.windowId,
    restartLabel: window.restartLabel,
  };
}

export function formatShopQueue(state: AppState) {
  const shopOrders = ensureShopState(state).shopOrders;

  const pending = shopOrders.filter(
    (order) => order.status === "pending_spawn",
  );
  const included = shopOrders.filter(
    (order) => order.status === "included_in_restart",
  );
  const spawned = shopOrders.filter((order) => order.status === "spawned");
  const failed = shopOrders.filter((order) => order.status === "failed");

  const latest = [...shopOrders]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 10);

  const ensuredState = ensureShopState(state);
  const monitor = ensuredState.shopResetMonitor;
  const autoDeploy = ensuredState.shopAutoDeploy;
  const monitorLines = monitor
    ? [
        "",
        "**Reset monitor**",
        `Batch: \`${monitor.batchId || "unknown"}\``,
        `Last status: \`${monitor.lastStatus || "unknown"}\``,
        `Saw offline: \`${monitor.sawOfflineAt || "no"}\``,
        `Saw online: \`${monitor.sawOnlineAt || "no"}\``,
      ]
    : [];

  const autoDeployLines = autoDeploy
    ? [
        "",
        "**Auto deploy**",
        `Last window: \`${autoDeploy.lastWindowId || "none"}\``,
        `Last deploy: \`${autoDeploy.lastDeployAt || "no"}\``,
      ]
    : [];

  const lines = [
    "🛒 **Shop Queue**",
    "",
    `Pending: **${pending.length}**`,
    `Included in next restart: **${included.length}**`,
    `Spawned: **${spawned.length}**`,
    `Failed: **${failed.length}**`,
    ...monitorLines,
    ...autoDeployLines,
    "",
    "**Catalog**",
    ...SHOP_ITEMS.map((item) => `• \`${item.id}\` → ${item.className}`),
    "",
    "**Latest orders**",
  ];

  if (!latest.length) {
    lines.push("No shop orders yet.");
  } else {
    for (const order of latest) {
      lines.push(
        `• \`${order.status}\` ${order.itemClass} @ \`${order.x}, ${order.y}, ${order.z}\``,
      );
    }
  }

  return lines.join("\n");
}
