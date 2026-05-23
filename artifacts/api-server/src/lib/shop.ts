import type { AppState, ShopOrder, ShopSavedLocation } from "./state";
import { getNitradoGameserverStatus } from "./nitradoDownloader";
import { downloadTextFile, uploadTextFile } from "./nitradoFtp";
import {
  injectShopEventSpawnsXml,
  injectShopEventsXml,
  removeShopBotBlock,
  SHOP_BOT_END,
  SHOP_BOT_START,
} from "./shopXml";
import { systems } from "./systems";

import {
  findShopItem,
  getShopCategories,
  getShopItems,
  getShopItemsByCategory,
  type ShopItem,
} from "./shopCatalog";

export type { ShopItem } from "./shopCatalog";
export {
  findShopItem,
  getShopCategories,
  getShopItems,
  getShopItemsByCategory,
} from "./shopCatalog";

export function getShopItemsSnapshot(): ShopItem[] {
  return getShopItems(true);
}

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


function hasShopBotBlock(xml: string) {
  const value = String(xml || "");
  return value.includes(SHOP_BOT_START) && value.includes(SHOP_BOT_END);
}

function missingShopBotError(fileLabel: string) {
  return `SHOP DEPLOY FAILED: ${fileLabel} does not contain SHOP_BOT block after injection/upload. Orders were not marked as included.`;
}

function validateOrdersReadyForXml(orders: ShopOrder[]) {
  if (!orders.length) {
    throw new Error("SHOP DEPLOY ABORTED: no pending orders to inject.");
  }

  for (const order of orders) {
    const itemClass = String(order.itemClass || "").trim();

    if (!itemClass) {
      throw new Error(
        `SHOP DEPLOY ABORTED: order ${order.id || "unknown"} has empty itemClass.`,
      );
    }

    if (![order.x, order.y, order.z].every(Number.isFinite)) {
      throw new Error(
        `SHOP DEPLOY ABORTED: order ${order.id || "unknown"} has invalid coordinates.`,
      );
    }
  }
}

function validateInjectedShopXml(options: {
  eventsXml: string;
  eventSpawnsXml: string;
  expectedOrders: ShopOrder[];
  eventNames?: string[];
  stage: "generated" | "uploaded";
}) {
  const { eventsXml, eventSpawnsXml, expectedOrders, eventNames, stage } = options;

  if (!hasShopBotBlock(eventsXml)) {
    throw new Error(missingShopBotError(`events.xml (${stage})`));
  }

  if (!hasShopBotBlock(eventSpawnsXml)) {
    throw new Error(missingShopBotError(`cfgeventspawns.xml (${stage})`));
  }

  for (const order of expectedOrders) {
    const itemClass = String(order.itemClass || "").trim();
    if (!eventsXml.includes(`type="${itemClass}"`)) {
      throw new Error(
        `SHOP DEPLOY FAILED: events.xml (${stage}) is missing item class ${itemClass} for order ${order.id}.`,
      );
    }
  }

  if (eventNames?.length && eventNames.length !== expectedOrders.length) {
    throw new Error(
      `SHOP DEPLOY FAILED: generated ${eventNames.length} event name(s) for ${expectedOrders.length} order(s).`,
    );
  }

  for (const eventName of eventNames || []) {
    if (!eventsXml.includes(`event name="${eventName}"`)) {
      throw new Error(
        `SHOP DEPLOY FAILED: events.xml (${stage}) is missing generated event ${eventName}.`,
      );
    }

    if (!eventSpawnsXml.includes(`event name="${eventName}"`)) {
      throw new Error(
        `SHOP DEPLOY FAILED: cfgeventspawns.xml (${stage}) is missing generated event ${eventName}.`,
      );
    }
  }
}

async function verifyUploadedShopBlocks(expectedOrders: ShopOrder[], eventNames: string[]) {
  const [uploadedEventsXml, uploadedEventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  validateInjectedShopXml({
    eventsXml: uploadedEventsXml,
    eventSpawnsXml: uploadedEventSpawnsXml,
    expectedOrders,
    eventNames,
    stage: "uploaded",
  });
}

async function verifyShopBlocksRemoved() {
  const [uploadedEventsXml, uploadedEventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  if (hasShopBotBlock(uploadedEventsXml) || hasShopBotBlock(uploadedEventSpawnsXml)) {
    throw new Error(
      "SHOP CLEAR FAILED: SHOP_BOT block is still present after upload.",
    );
  }
}

function isShopResetFallbackEnabled() {
  return boolEnv("SHOP_RESET_CONFIRM_FALLBACK_ENABLED", false);
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

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getShopResetFallbackMinutes() {
  // DayZ console/Nitrado may keep returning "started" during restarts.
  // This timeout is a safety valve so WAITING_RESET never becomes permanent.
  return Math.max(
    1,
    numberEnv("SHOP_RESET_CONFIRM_FALLBACK_MINUTES", 45),
  );
}

function getShopResetExpectedDelayMinutes() {
  const deployBefore = numberEnv("SHOP_DEPLOY_MINUTES_BEFORE_RESET", 15);
  const graceAfter = numberEnv("SHOP_DEPLOY_GRACE_MINUTES_AFTER_SCHEDULE", 15);
  return Math.max(1, deployBefore + graceAfter);
}

function getMonitorDeployDate(monitor: NonNullable<AppState["shopResetMonitor"]>, includedOrders: ShopOrder[]) {
  const raw = monitor.deployedAt || includedOrders[0]?.includedAt || includedOrders[0]?.createdAt;
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function ensureResetMonitorDeadlines(
  monitor: NonNullable<AppState["shopResetMonitor"]>,
  includedOrders: ShopOrder[],
) {
  const deployedAt = getMonitorDeployDate(monitor, includedOrders);

  if (!monitor.deployedAt) {
    monitor.deployedAt = deployedAt.toISOString();
  }

  if (!monitor.expectedRestartAt) {
    monitor.expectedRestartAt = addMinutes(
      deployedAt,
      getShopResetExpectedDelayMinutes(),
    ).toISOString();
  }

  if (!monitor.restartFallbackAt) {
    monitor.restartFallbackAt = addMinutes(
      deployedAt,
      getShopResetFallbackMinutes(),
    ).toISOString();
  }
}

function isPastIsoDate(value: string | null | undefined, now: Date) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && now.getTime() >= time;
}

export function getShopResetMonitorPersistenceKey(state: Pick<AppState, "shopResetMonitor">) {
  const monitor = state.shopResetMonitor || null;
  if (!monitor) return "null";

  // Do not include noisy heartbeat fields like lastCheckedAt/lastStatus.
  // Persist only fields that affect recovery or the order state machine.
  return JSON.stringify({
    batchId: monitor.batchId,
    deployedAt: monitor.deployedAt,
    sawOfflineAt: monitor.sawOfflineAt,
    sawOnlineAt: monitor.sawOnlineAt,
    clearedAt: monitor.clearedAt,
    expectedRestartAt: monitor.expectedRestartAt,
    restartFallbackAt: monitor.restartFallbackAt,
    autoConfirmedAt: monitor.autoConfirmedAt,
    confirmationReason: monitor.confirmationReason,
  });
}

export type ShopRuntimeStatus = {
  state: "READY" | "FROZEN" | "WAITING_RESET" | "WAITING_CLEAR";
  canAcceptPurchase: boolean;
  reason: string;
  nextRestartLabel?: string;
  minutesUntilRestart?: number;
};



export function ensureShopState(state: AppState) {
  state.shopOrders = state.shopOrders || [];
  state.shopSavedLocations = state.shopSavedLocations || [];
  state.shopPendingCheckouts = state.shopPendingCheckouts || [];
  state.shopResetMonitor = state.shopResetMonitor || null;
  return state;
}



export function getSavedShopLocations(state: AppState, discordUserId: string) {
  ensureShopState(state);
  return (state.shopSavedLocations || [])
    .filter((location) => location.discordUserId === discordUserId)
    .sort((a, b) => String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt)))
    .slice(0, 25);
}

export function findSavedShopLocation(
  state: AppState,
  discordUserId: string,
  locationId: string,
) {
  return getSavedShopLocations(state, discordUserId).find(
    (location) => location.id === locationId,
  ) || null;
}

export function saveShopLocation(options: {
  state: AppState;
  discordUserId: string;
  name: string;
  x: number;
  y: number;
  z: number;
}) {
  const state = ensureShopState(options.state);
  const now = new Date().toISOString();
  const cleanName = String(options.name || "").trim().slice(0, 40);

  if (!cleanName) return null;

  const existing = (state.shopSavedLocations || []).find(
    (location) =>
      location.discordUserId === options.discordUserId &&
      location.name.trim().toLowerCase() === cleanName.toLowerCase(),
  );

  const payload: ShopSavedLocation = {
    id:
      existing?.id ||
      `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    discordUserId: options.discordUserId,
    name: cleanName,
    x: Number(options.x.toFixed(2)),
    y: Number(options.y.toFixed(2)),
    z: Number(options.z.toFixed(2)),
    createdAt: existing?.createdAt || now,
    lastUsedAt: now,
  };

  if (existing) Object.assign(existing, payload);
  else state.shopSavedLocations!.push(payload);

  return payload;
}

export function markShopLocationUsed(location: ShopSavedLocation | null | undefined) {
  if (location) location.lastUsedAt = new Date().toISOString();
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


export function getShopRuntimeStatus(state: AppState): ShopRuntimeStatus {
  ensureShopState(state);

  const included = getIncludedShopOrders(state);
  if (included.length) {
    const monitor = state.shopResetMonitor;
    const waitingClear = Boolean(monitor?.sawOnlineAt);

    return {
      state: waitingClear ? "WAITING_CLEAR" : "WAITING_RESET",
      canAcceptPurchase: false,
      reason: waitingClear
        ? "Shop delivery is being finalized after the server restart. Try again in a few minutes."
        : "Shop delivery is prepared and waiting for the server restart. Try again after the restart.",
    };
  }

  const freezeWindow = getActiveAutoDeployWindow(new Date(), {
    requireAutoDeployEnabled: true,
    allowFreezeWindow: true,
  });

  if (freezeWindow) {
    const freezeMinutes = numberEnv("SHOP_DEPLOY_FREEZE_MINUTES", 2);
    if (freezeWindow.minutesUntilRestart <= freezeMinutes) {
      return {
        state: "FROZEN",
        canAcceptPurchase: false,
        reason:
          "Shop is temporarily closed while the server restart window is active. Try again after the delivery cycle finishes.",
        nextRestartLabel: freezeWindow.restartLabel,
        minutesUntilRestart: freezeWindow.minutesUntilRestart,
      };
    }
  }

  return {
    state: "READY",
    canAcceptPurchase: true,
    reason: "Shop is open.",
    nextRestartLabel: freezeWindow?.restartLabel,
    minutesUntilRestart: freezeWindow?.minutesUntilRestart,
  };
}

export function assertShopCanAcceptPurchase(state: AppState) {
  const status = getShopRuntimeStatus(state);
  if (!status.canAcceptPurchase) {
    throw new Error(status.reason);
  }

  return status;
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
  assertShopCanAcceptPurchase(state);
  const item = findShopItem(options.itemInput);

  if (!item) {
    throw new Error(
      `Item not found. Available items: ${getShopItems().map((i) => i.id).join(", ")}`,
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

async function backupShopXmlFiles(_eventsXml: string, _eventSpawnsXml: string) {
  // Backup generation was intentionally disabled for DayZ console/Nitrado.
  // The automatic shop cycle rewrites XML often, and keeping a backup on every
  // deploy/clear made the FTP directory too large.
  if (boolEnv("SHOP_XML_BACKUP_ENABLED", false)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");

    await uploadTextFile(`${SHOP_EVENTS_PATH}.shop-backup-${stamp}`, _eventsXml);
    await uploadTextFile(
      `${SHOP_EVENT_SPAWNS_PATH}.shop-backup-${stamp}`,
      _eventSpawnsXml,
    );
  }
}

export async function deployPendingShopOrders(state: AppState) {
  ensureShopState(state);

  if (!systems.shop) {
    console.log("⏸️ shop deploy ignorado: SYSTEM_SHOP=false");
    return null;
  }

  if (!systems.nitrado) {
    console.log("⏸️ shop deploy ignorado: SYSTEM_NITRADO=false");
    return null;
  }

  if (getIncludedShopOrders(state).length) {
    return {
      deployed: 0,
      path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
      reason: "A shop batch is already waiting for restart/clear.",
    };
  }

  const pendingOrders = getPendingShopOrders(state);

  if (!pendingOrders.length) {
    return {
      deployed: 0,
      path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
      reason: "No pending shop orders to deploy.",
    };
  }

  console.log(
    `🛒 SHOP DEPLOY START pending=${pendingOrders.length} events=${SHOP_EVENTS_PATH} spawns=${SHOP_EVENT_SPAWNS_PATH}`,
  );

  validateOrdersReadyForXml(pendingOrders);

  console.log("🛒 SHOP DEPLOY downloading XML files");
  const [eventsXml, eventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  await backupShopXmlFiles(eventsXml, eventSpawnsXml);

  console.log("🛒 SHOP DEPLOY injecting SHOP_BOT XML blocks");
  const injectedEvents = injectShopEventsXml(eventsXml, pendingOrders);
  const injectedEventSpawns = injectShopEventSpawnsXml(
    eventSpawnsXml,
    pendingOrders,
  );

  validateInjectedShopXml({
    eventsXml: injectedEvents.xml,
    eventSpawnsXml: injectedEventSpawns,
    expectedOrders: pendingOrders,
    eventNames: injectedEvents.eventNames,
    stage: "generated",
  });

  console.log(
    `🛒 SHOP DEPLOY uploading XML files events=${injectedEvents.eventNames.length}`,
  );
  await uploadTextFile(SHOP_EVENTS_PATH, injectedEvents.xml);
  await uploadTextFile(SHOP_EVENT_SPAWNS_PATH, injectedEventSpawns);

  console.log("🛒 SHOP DEPLOY verifying uploaded XML files");
  await verifyUploadedShopBlocks(pendingOrders, injectedEvents.eventNames);

  const now = new Date().toISOString();
  const batchId = `restart_${Date.now()}`;

  for (const order of pendingOrders) {
    order.status = "included_in_restart";
    order.restartTarget = batchId;
    order.includedAt = now;
  }

  const deployedAt = new Date(now);

  state.shopResetMonitor = {
    batchId,
    deployedAt: now,
    sawOfflineAt: undefined,
    sawOnlineAt: undefined,
    lastStatus: null,
    lastCheckedAt: now,
    clearedAt: undefined,
    expectedRestartAt: addMinutes(
      deployedAt,
      getShopResetExpectedDelayMinutes(),
    ).toISOString(),
    restartFallbackAt: addMinutes(
      deployedAt,
      getShopResetFallbackMinutes(),
    ).toISOString(),
    autoConfirmedAt: undefined,
    confirmationReason: undefined,
  };

  console.log(
    `✅ SHOP DEPLOY VERIFIED deployed=${pendingOrders.length} batch=${batchId}`,
  );

  return {
    deployed: pendingOrders.length,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
    batchId,
  };
}

async function removeShopXmlBlocks(options?: { requireExistingBlock?: boolean }) {
  const [eventsXml, eventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  const eventsHasBlock = hasShopBotBlock(eventsXml);
  const spawnsHasBlock = hasShopBotBlock(eventSpawnsXml);

  if (options?.requireExistingBlock && (!eventsHasBlock || !spawnsHasBlock)) {
    throw new Error(
      `SHOP CLEAR ABORTED: SHOP_BOT block missing before clear. events=${eventsHasBlock ? "yes" : "no"} spawns=${spawnsHasBlock ? "yes" : "no"}. Orders were not marked as spawned.`,
    );
  }

  await backupShopXmlFiles(eventsXml, eventSpawnsXml);

  await uploadTextFile(SHOP_EVENTS_PATH, removeShopBotBlock(eventsXml));
  await uploadTextFile(
    SHOP_EVENT_SPAWNS_PATH,
    removeShopBotBlock(eventSpawnsXml),
  );

  await verifyShopBlocksRemoved();
}

export async function clearShopSpawnerAndMarkSpawned(
  state: AppState,
  options?: { cancelPending?: boolean; includedOnly?: boolean },
) {

  ensureShopState(state);

  if (!systems.shop) {
    console.log("⏸️ shop clear ignorado: SYSTEM_SHOP=false");
    return {
      cleared: 0,
      cancelled: 0,
      path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
    };
  }

  if (!systems.nitrado) {
    console.log("⏸️ shop clear ignorado: SYSTEM_NITRADO=false");
    return {
      cleared: 0,
      cancelled: 0,
      path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
    };
  }
  const cancelPending = options?.cancelPending ?? true;
  const includedOrders = options?.includedOnly
    ? getIncludedBatchOrders(state)
    : getIncludedShopOrders(state);
  const pendingOrders = cancelPending ? getPendingShopOrders(state) : [];

  await removeShopXmlBlocks({ requireExistingBlock: includedOrders.length > 0 });

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

  if (!systems.shop) {
    return null;
  }

  if (!systems.nitrado) {
    return null;
  }

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
  ensureResetMonitorDeadlines(monitor, includedOrders);

  let status: string | null = null;

  try {
    const response = await getNitradoGameserverStatus();
    status = response.status;
  } catch (err) {
    console.error("❌ shop auto-clear status poll failed:", err);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const normalized = normalizeServerStatus(status);

  monitor.lastStatus = normalized;
  monitor.lastCheckedAt = nowIso;

  if (!monitor.sawOfflineAt && isOfflineLikeStatus(normalized)) {
    monitor.sawOfflineAt = nowIso;
    monitor.confirmationReason = `nitrado_status_offline:${normalized}`;
    console.log(`🛒 shop reset monitor: server went offline/restarting (${normalized})`);
    return null;
  }

  if (monitor.sawOfflineAt && !monitor.sawOnlineAt && isOnlineLikeStatus(normalized)) {
    monitor.sawOnlineAt = nowIso;
    monitor.confirmationReason = `nitrado_status_online:${normalized}`;
    console.log(`🛒 shop reset monitor: server came back online (${normalized})`);
    return null;
  }

  const fallbackExpired = isPastIsoDate(monitor.restartFallbackAt, now);

  if (!monitor.sawOnlineAt && fallbackExpired) {
    if (!isShopResetFallbackEnabled()) {
      console.warn(
        `⚠️ shop reset monitor: fallback expired, but SHOP_RESET_CONFIRM_FALLBACK_ENABLED is false. Not clearing XML automatically. status=${normalized} deployedAt=${monitor.deployedAt || "unknown"} fallbackAt=${monitor.restartFallbackAt || "unknown"}`,
      );
    } else {
      monitor.sawOnlineAt = nowIso;
      monitor.autoConfirmedAt = nowIso;
      monitor.confirmationReason = monitor.sawOfflineAt
        ? "fallback_timeout_after_offline"
        : "fallback_timeout_no_status_transition";

      console.warn(
        `⚠️ shop reset monitor: auto-confirming restart by timeout. status=${normalized} deployedAt=${monitor.deployedAt || "unknown"} fallbackAt=${monitor.restartFallbackAt || "unknown"}`,
      );
    }
  }

  if (!monitor.sawOfflineAt && !monitor.sawOnlineAt) {
    console.log(
      `🛒 shop auto-clear aguardando reset. status=${normalized} fallbackAt=${monitor.restartFallbackAt || "unknown"}`,
    );
    return null;
  }

  if (monitor.sawOfflineAt && !monitor.sawOnlineAt) {
    console.log(
      `🛒 shop auto-clear aguardando servidor voltar online. status=${normalized} fallbackAt=${monitor.restartFallbackAt || "unknown"}`,
    );
    return null;
  }

  const clearDelayMinutes = monitor.autoConfirmedAt
    ? 0
    : numberEnv("SHOP_CLEAR_MINUTES_AFTER_RESET", 5);
  const onlineAtMs = new Date(monitor.sawOnlineAt || nowIso).getTime();
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
    `✅ SHOP_BOT auto-clear completed: cleared=${result.cleared} cancelled=${result.cancelled} reason=${monitor.confirmationReason || "status_transition"}`,
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

function getActiveAutoDeployWindow(
  now = new Date(),
  options: { requireAutoDeployEnabled?: boolean; allowFreezeWindow?: boolean } = {},
): AutoDeployWindow | null {
  const requireAutoDeployEnabled = options.requireAutoDeployEnabled ?? true;
  const allowFreezeWindow = options.allowFreezeWindow ?? false;

  if (requireAutoDeployEnabled && !boolEnv("SHOP_AUTO_DEPLOY_ENABLED", false)) return null;

  const times = parseRestartTimes();
  if (!times.length) return null;

  const timeZone = process.env.SHOP_RESTART_TIMEZONE || "America/Sao_Paulo";
  const deployBefore = numberEnv("SHOP_DEPLOY_MINUTES_BEFORE_RESET", 15);
  const deployGraceAfter = numberEnv("SHOP_DEPLOY_GRACE_MINUTES_AFTER_SCHEDULE", 15);
  const freezeMinutes = numberEnv("SHOP_DEPLOY_FREEZE_MINUTES", 2);
  const local = getLocalDateParts(now, timeZone);

  for (const restart of times) {
    let diff = restart.minutes - local.minuteOfDay;

    // If the restart is just after midnight and now is late in the previous day,
    // treat it as the next occurrence.
    if (diff < -deployGraceAfter) diff += 24 * 60;

    const inDeployWindow = diff <= deployBefore && diff >= -deployGraceAfter;
    const inFreezeWindow = diff <= freezeMinutes && diff >= -deployGraceAfter;

    if (inDeployWindow && (allowFreezeWindow || !inFreezeWindow)) {
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

  if (!systems.shop) {
    return null;
  }

  if (!systems.nitrado) {
    return null;
  }

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

  if (!result) {
    return null;
  }

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
  const runtime = getShopRuntimeStatus(ensuredState);
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
    `Shop status: **${runtime.state}**`,
    runtime.nextRestartLabel
      ? `Next restart window: **${runtime.nextRestartLabel}** (${runtime.minutesUntilRestart} min)`
      : "Next restart window: unknown",
    runtime.canAcceptPurchase ? "Checkout: **open**" : `Checkout: **closed** — ${runtime.reason}`,
    "",
    `Pending: **${pending.length}**`,
    `Included in next restart: **${included.length}**`,
    `Spawned: **${spawned.length}**`,
    `Failed: **${failed.length}**`,
    ...monitorLines,
    ...autoDeployLines,
    "",
    "**Catalog**",
    ...getShopItems(true).map((item) => `• \`${item.id}\` → ${item.className}`),
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
