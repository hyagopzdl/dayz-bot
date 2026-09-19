import type { AppState, ShopOrder, ShopSavedLocation } from "./state";
import { ensureManagedServerShopDeliveryConfiguration, ensureManagedServerShopDeliveryRoutingConfiguration } from "./state";
import { getNitradoGameserverStatus } from "./nitradoDownloader";
import { downloadServerTextFile, uploadServerTextFile } from "./serverFileTransport";
import {
  injectShopEventSpawnsXml,
  injectShopEventsXml,
  removeShopBotBlock,
  SHOP_BOT_END,
  SHOP_BOT_START,
  expandShopOrdersForDelivery,
} from "./shopXml";
import { systems } from "./systems";
import { getServerRuntimeContext } from "./serverRuntime";
import {
  getManagedServerById,
  hasManagedServerRuntimeActivation,
  hasMatchingActivationPreflight,
  hasMatchingManagedServerNitradoValidation,
  isManagedServerRuntimePaused,
} from "./serverRegistry";
import { getOrganizationIntegrationStatus } from "./organizationIntegrations";
import { discoverNitradoMissionDir, discoverNitradoShopDeliveryRouting } from "./serverIntegrations";
import { getServerScopedSettings } from "./serverRegistry";
import { getNextServerReset as getNextConfiguredRestart } from "./serverResetScheduler";
import { hasShopEffectAreas, injectShopEffectAreas, removeShopEffectAreas } from "./shopEffectArea";
export { getNextServerReset as getNextConfiguredRestart } from "./serverResetScheduler";

import {
  findShopItem,
  getShopCategories,
  getShopItemDeliveryKind,
  getShopItems,
  getShopItemsByCategory,
  getShopCatalog,
  type ShopItem,
} from "./shopCatalog";

export type { ShopItem } from "./shopCatalog";
export {
  findShopItem,
  getShopCategories,
  getShopItemDeliveryKind,
  getShopItems,
  getShopItemsByCategory,
} from "./shopCatalog";

export function getShopItemsSnapshot(): ShopItem[] {
  return getShopItems(true);
}

function normalizeRelativePath(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

export type ShopDeliveryReadiness = {
  ready: boolean;
  serverId: string;
  transport: "legacy-ftp" | "nitrado-file-server";
  missionDir?: string;
  reason?: string;
};

function getExplicitMissionDir(serverId: string) {
  const server = getManagedServerById(serverId);
  return normalizeRelativePath(String(server?.runtime.settings?.dayzMissionDir || ""));
}

export function getShopDeliveryReadiness(serverId = getServerRuntimeContext().serverId): ShopDeliveryReadiness {
  const runtime = getServerRuntimeContext(serverId);
  const missionDir = getExplicitMissionDir(runtime.serverId);
  const server = getManagedServerById(runtime.serverId);
  if (!server) return { ready: false, serverId: runtime.serverId, transport: "nitrado-file-server", reason: "Shop delivery is blocked because this managed server is unavailable." };
  if (!server.runtimeEnabled || !hasManagedServerRuntimeActivation(server)) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked until this server runtime is activated." };
  }
  if (isManagedServerRuntimePaused(server)) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked while this server runtime is paused." };
  }
  if (!hasMatchingManagedServerNitradoValidation(server) || !hasMatchingActivationPreflight(server)) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked until Nitrado routing passes validation and activation preflight." };
  }
  if (!String(server.integrations.nitradoServiceId || "").trim() || !String(server.runtime.nitradoBaseDir || "").trim()) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked because this server has no explicit Nitrado Service ID/base dir." };
  }
  if (!missionDir) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked until a mission path is explicitly saved for this server." };
  }
  const deliveryConfiguredAt = String(server.runtime.settings?.shopDeliveryConfiguredAt || "").trim();
  if (!deliveryConfiguredAt) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked until the mission/filesystem routing is explicitly saved for this server." };
  }
  if (!getOrganizationIntegrationStatus(server.organizationId).configured) {
    return { ready: false, serverId: server.id, transport: "nitrado-file-server", reason: "Shop delivery is blocked because this organization has no usable Nitrado credential." };
  }

  return { ready: true, serverId: server.id, transport: "nitrado-file-server", missionDir };
}

const shopDeliveryDiscoveryCooldown = new Map<string, number>();

export async function ensureShopDeliveryConfiguration(serverId = getServerRuntimeContext().serverId): Promise<ShopDeliveryReadiness> {
  let readiness = getShopDeliveryReadiness(serverId);
  if (readiness.ready) return readiness;

  const server = getManagedServerById(serverId);
  if (!server) return readiness;

  // Recover filesystem routing before applying the strict readiness checks.
  // Older onboarding versions could activate a valid secondary runtime while
  // leaving runtime.nitradoBaseDir/dayzMissionDir empty. Requiring those fields
  // before discovery made the self-heal path unreachable.
  const canDiscover = Boolean(
    server.runtimeEnabled
    && hasManagedServerRuntimeActivation(server)
    && !isManagedServerRuntimePaused(server)
    && String(server.integrations.nitradoServiceId || "").trim()
    && getOrganizationIntegrationStatus(server.organizationId).configured
  );
  if (!canDiscover) return readiness;

  const hasRouting = Boolean(
    String(server.runtime.nitradoBaseDir || "").trim()
    && String(server.runtime.settings?.dayzMissionDir || "").trim()
    && String(server.runtime.settings?.shopDeliveryConfiguredAt || "").trim()
  );

  if (!hasRouting) {
    const now = Date.now();
    const retryAt = shopDeliveryDiscoveryCooldown.get(serverId) || 0;
    if (now >= retryAt) {
      shopDeliveryDiscoveryCooldown.set(serverId, now + 60_000);
      try {
        const discovered = await discoverNitradoShopDeliveryRouting(serverId);
        if (discovered.baseDir && discovered.missionDir) {
          await ensureManagedServerShopDeliveryRoutingConfiguration(serverId, {
            serviceId: discovered.serviceId,
            baseDir: discovered.baseDir,
            missionDir: discovered.missionDir,
          });
          shopDeliveryDiscoveryCooldown.delete(serverId);
          readiness = getShopDeliveryReadiness(serverId);
          if (readiness.ready) return readiness;
        }
      } catch (error) {
        console.error(`[shop-delivery][${serverId}] automatic routing bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Existing correctly-routed tenants may only be missing the fill-only Shop
  // settings marker. Keep the old lightweight bootstrap for that case.
  const refreshed = getManagedServerById(serverId);
  if (!refreshed) return getShopDeliveryReadiness(serverId);
  const canBootstrapSettings = Boolean(
    refreshed.runtimeEnabled
    && hasManagedServerRuntimeActivation(refreshed)
    && !isManagedServerRuntimePaused(refreshed)
    && hasMatchingManagedServerNitradoValidation(refreshed)
    && hasMatchingActivationPreflight(refreshed)
    && String(refreshed.integrations.nitradoServiceId || "").trim()
    && String(refreshed.runtime.nitradoBaseDir || "").trim()
    && getOrganizationIntegrationStatus(refreshed.organizationId).configured
  );
  if (!canBootstrapSettings) return getShopDeliveryReadiness(serverId);

  const existingMissionDir = normalizeRelativePath(String(refreshed.runtime.settings?.dayzMissionDir || ""));
  const missionDir = existingMissionDir || await discoverNitradoMissionDir(serverId);
  if (!missionDir) return getShopDeliveryReadiness(serverId);

  await ensureManagedServerShopDeliveryConfiguration(serverId, { missionDir });
  return getShopDeliveryReadiness(serverId);
}

async function repairShopDeliveryRouting(serverId = getServerRuntimeContext().serverId) {
  const discovered = await discoverNitradoShopDeliveryRouting(serverId);
  if (!discovered.baseDir || !discovered.missionDir) {
    throw new Error(`SHOP DELIVERY ROUTING REPAIR FAILED: no valid mission/filesystem route found for ${serverId}.`);
  }
  await ensureManagedServerShopDeliveryRoutingConfiguration(serverId, {
    serviceId: discovered.serviceId,
    baseDir: discovered.baseDir,
    missionDir: discovered.missionDir,
  });
  return getShopDeliveryReadiness(serverId);
}

export function getShopFilePaths(serverId = getServerRuntimeContext().serverId) {
  const readiness = getShopDeliveryReadiness(serverId);
  if (!readiness.ready || !readiness.missionDir) {
    throw new Error(readiness.reason || "Shop delivery routing is not ready for this server.");
  }
  const missionDir = readiness.missionDir;
  return {
    missionDir,
    eventsPath: `${missionDir}/db/events.xml`,
    eventSpawnsPath: `${missionDir}/cfgeventspawns.xml`,
    effectAreaPath: `${missionDir}/cfgEffectArea.json`,
  };
}

export function getShopEventsPath(serverId = getServerRuntimeContext().serverId) {
  return getShopFilePaths(serverId).eventsPath;
}

export function getShopEventSpawnsPath(serverId = getServerRuntimeContext().serverId) {
  return getShopFilePaths(serverId).eventSpawnsPath;
}

function getLegacyShopEventSpawnsPath(serverId = getServerRuntimeContext().serverId) {
  const missionDir = getShopFilePaths(serverId).missionDir;
  return missionDir + "/db/cfgeventspawns.xml";
}

function buildExpectedShopEventNamesForOrders(orders: ShopOrder[]) {
  return expandShopOrdersForDelivery(orders).map((order, index) => {
    const item = String(order.itemClass || order.itemName || "Item")
      .replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "Item";
    const id = String(order.id || index)
      .replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(-16) || String(index);
    const vehicle = order.deliveryKind === "vehicle" || String(order.spawnEventName || "").startsWith("Vehicle");
    return (vehicle ? "VehicleShop_" : "Static_") + item + "_" + id;
  });
}

async function repairLegacyShopEventSpawnsIfNeeded(state: AppState) {
  const includedOrders = getIncludedShopOrders(state);
  if (!includedOrders.length) return false;

  const paths = getShopFilePaths();
  const legacyPath = getLegacyShopEventSpawnsPath();
  let rootXml: string;
  let legacyXml: string | null = null;

  try {
    rootXml = await downloadServerTextFile(paths.eventSpawnsPath);
  } catch (error) {
    console.error("❌ SHOP recovery could not read root cfgeventspawns.xml:", error);
    return false;
  }

  try {
    legacyXml = await downloadServerTextFile(legacyPath);
  } catch {
    // The legacy path may not exist. That is fine.
  }

  const expectedNames = buildExpectedShopEventNamesForOrders(includedOrders);
  const rootHasShopBlock = hasShopBotBlock(rootXml);
  const rootHasAllExpectedEvents = expectedNames.every((name) => rootXml.includes('event name="' + name + '"'));
  const legacyHasShopBlock = Boolean(legacyXml && hasShopBotBlock(legacyXml));

  if (rootHasShopBlock && rootHasAllExpectedEvents) {
    if (legacyHasShopBlock) {
      console.warn("⚠️ SHOP recovery removing stale SHOP_BOT block from legacy path: " + legacyPath);
      await uploadServerTextFile(legacyPath, removeShopBotBlock(legacyXml!));
    }
    return false;
  }

  if (legacyHasShopBlock) {
    console.warn("🚑 SHOP recovery migrating SHOP_BOT cfgeventspawns.xml from legacy db/ path to mission root: " + legacyPath + " -> " + paths.eventSpawnsPath);
  } else {
    console.warn("🚑 SHOP recovery restoring missing SHOP_BOT block in mission-root cfgeventspawns.xml for " + includedOrders.length + " included order(s).");
  }

  const repairedRoot = injectShopEventSpawnsXml(rootXml, includedOrders);
  const eventsXml = await downloadServerTextFile(paths.eventsPath);
  const eventNames = expectedNames;
  validateInjectedShopXml({
    eventsXml: eventsXml,
    eventSpawnsXml: repairedRoot,
    expectedOrders: includedOrders,
    eventNames,
    stage: "generated",
  });

  await uploadServerTextFile(paths.eventSpawnsPath, repairedRoot);
  const verifiedRoot = await downloadServerTextFile(paths.eventSpawnsPath);
  if (!hasShopBotBlock(verifiedRoot) || !expectedNames.every((name) => verifiedRoot.includes('event name="' + name + '"'))) {
    throw new Error("SHOP recovery failed verification of mission-root cfgeventspawns.xml.");
  }

  if (legacyHasShopBlock) {
    await uploadServerTextFile(legacyPath, removeShopBotBlock(legacyXml!));
  }

  console.log("✅ SHOP recovery verified mission-root cfgeventspawns.xml for " + includedOrders.length + " included order(s).");
  return true;
}



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

  const activeServerId = getServerRuntimeContext().serverId;
  for (const order of orders) {
    if (order.serverId && order.serverId !== activeServerId) {
      throw new Error(`SHOP DEPLOY ABORTED: order ${order.id || "unknown"} belongs to ${order.serverId}, not ${activeServerId}.`);
    }
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

  const deliveryOrders = expandShopOrdersForDelivery(expectedOrders);
  for (const order of deliveryOrders) {
    const itemClass = String(order.itemClass || "").trim();
    if (!eventsXml.includes(`type="${itemClass}"`)) {
      throw new Error(`SHOP DEPLOY FAILED: events.xml (${stage}) is missing item class ${itemClass} for order ${order.id}.`);
    }
  }

  if (eventNames?.length && eventNames.length !== deliveryOrders.length) {
    throw new Error(`SHOP DEPLOY FAILED: generated ${eventNames.length} event name(s) for ${deliveryOrders.length} delivery event(s).`);
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

async function restoreAndVerifyShopXmlFiles(
  eventsXml: string,
  eventSpawnsXml: string,
  operation: string,
) {
  await uploadServerTextFile(getShopFilePaths().eventsPath, eventsXml);
  await uploadServerTextFile(getShopFilePaths().eventSpawnsPath, eventSpawnsXml);

  const [restoredEventsXml, restoredEventSpawnsXml] = await Promise.all([
    downloadServerTextFile(getShopFilePaths().eventsPath),
    downloadServerTextFile(getShopFilePaths().eventSpawnsPath),
  ]);

  if (restoredEventsXml !== eventsXml || restoredEventSpawnsXml !== eventSpawnsXml) {
    throw new Error(
      "SHOP " + operation + " ROLLBACK FAILED: restored XML payloads do not match the original files.",
    );
  }
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

function getShopClearMinutesAfterReset() {
  return Math.max(0, numberEnv("SHOP_CLEAR_MINUTES_AFTER_RESET", 5));
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

function getMonitorDeployDate(monitor: NonNullable<AppState["shopResetMonitor"]>, includedOrders: ShopOrder[]) {
  const raw = monitor.deployedAt || includedOrders[0]?.includedAt || includedOrders[0]?.createdAt;
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function ensureResetMonitorState(
  monitor: NonNullable<AppState["shopResetMonitor"]>,
  includedOrders: ShopOrder[],
) {
  const deployedAt = getMonitorDeployDate(monitor, includedOrders);
  if (!monitor.deployedAt) monitor.deployedAt = deployedAt.toISOString();
}
export function getShopResetMonitorPersistenceKey(state: Pick<AppState, "shopResetMonitor">) {
  const monitor = state.shopResetMonitor || null;
  if (!monitor) return "null";

  // Do not include noisy heartbeat fields like lastCheckedAt/lastStatus.
  // Persist only fields that affect recovery or the order state machine.
  return JSON.stringify({
    batchId: monitor.batchId,
    deployedAt: monitor.deployedAt,
    admFileAtDeploy: monitor.admFileAtDeploy,
    sawOfflineAt: monitor.sawOfflineAt,
    sawOnlineAt: monitor.sawOnlineAt,
    clearedAt: monitor.clearedAt,
    expectedRestartAt: monitor.expectedRestartAt,
    restartFallbackAt: monitor.restartFallbackAt,
    autoConfirmedAt: monitor.autoConfirmedAt,
    confirmationReason: monitor.confirmationReason,
    autoRestartManaged: monitor.autoRestartManaged,
    targetRestartAt: monitor.targetRestartAt,
    restartPhase: monitor.restartPhase,
    restartRequestedAt: monitor.restartRequestedAt,
    restartCompletedAt: monitor.restartCompletedAt,
    restartError: monitor.restartError,
  });
}

export type ShopRuntimeStatus = {
  state: "READY" | "BLOCKED" | "WAITING_RESET" | "WAITING_CLEAR";
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

  const delivery = getShopDeliveryReadiness();
  if (!delivery.ready) {
    return { state: "BLOCKED", canAcceptPurchase: false, reason: delivery.reason || "Shop delivery routing is not ready for this server." };
  }

  const nextRestart = getNextConfiguredRestart(new Date(), getServerRuntimeContext().serverId);
  const minutesUntilRestart = nextRestart
    ? Math.max(0, Math.ceil((nextRestart.at.getTime() - Date.now()) / 60_000))
    : undefined;

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
      nextRestartLabel: nextRestart?.label,
      minutesUntilRestart,
    };
  }

  return {
    state: "READY",
    canAcceptPurchase: true,
    reason: "Shop is open.",
    nextRestartLabel: nextRestart?.label,
    minutesUntilRestart,
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
  price?: number;
  locationName?: string;
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
    serverId: getServerRuntimeContext().serverId,
    discordUserId: options.discordUserId,
    itemClass: item.className,
    itemName: item.name,
    ...(item.spawnEventName ? { spawnEventName: item.spawnEventName } : {}),
    deliveryKind: getShopItemDeliveryKind(item),
    x: Number(options.x.toFixed(2)),
    y: Number(options.y.toFixed(2)),
    z: Number(options.z.toFixed(2)),
    status: "pending_spawn",
    createdAt: now,
    ...(Number.isFinite(options.price) ? { price: Number(options.price) } : {}),
    ...(String(options.locationName || "").trim() ? { locationName: String(options.locationName).trim().slice(0, 40) } : {}),
  };

  state.shopOrders.push(order);
  return order;
}

export function createShopKitOrder(options: {
  state: AppState;
  discordUserId: string;
  kitId: string;
  x: number;
  y: number;
  z: number;
  price?: number;
  locationName?: string;
}) {
  const state = ensureShopState(options.state);
  assertShopCanAcceptPurchase(state);
  const catalog = getShopCatalog();
  const kit = (catalog.kits || []).find((candidate) => String(candidate.id) === String(options.kitId));

  if (!kit || kit.enabled === false) {
    throw new Error("Kit not found or disabled.");
  }

  const components = Array.isArray(kit.items)
    ? kit.items
        .map((item) => ({
          className: String(item.className || "").trim(),
          ...(String(item.name || "").trim() ? { name: String(item.name).trim() } : {}),
          quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
        }))
        .filter((item) => item.className)
    : [];

  if (!components.length) {
    throw new Error("Kit has no valid items.");
  }

  if (![options.x, options.y, options.z].every(Number.isFinite)) {
    throw new Error("Invalid coordinates.");
  }

  const now = new Date().toISOString();
  const first = components[0];
  const order: ShopOrder = {
    id: `shop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    serverId: getServerRuntimeContext().serverId,
    discordUserId: options.discordUserId,
    itemClass: first.className,
    itemKind: "kit",
    kitId: String(kit.id),
    kitItems: components,
    itemName: kit.name,
    deliveryKind: "item",
    x: Number(options.x.toFixed(2)),
    y: Number(options.y.toFixed(2)),
    z: Number(options.z.toFixed(2)),
    status: "pending_spawn",
    createdAt: now,
    ...(Number.isFinite(options.price) ? { price: Number(options.price) } : {}),
    ...(String(options.locationName || "").trim() ? { locationName: String(options.locationName).trim().slice(0, 40) } : {}),
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

async function backupShopXmlFiles(_eventsXml: string, _eventSpawnsXml: string, _effectAreaJson?: string) {
  // Backup generation was intentionally disabled for DayZ console/Nitrado.
  // The automatic shop cycle rewrites XML often, and keeping a backup on every
  // deploy/clear made the FTP directory too large.
  if (boolEnv("SHOP_XML_BACKUP_ENABLED", false)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");

    await uploadServerTextFile(`${getShopFilePaths().eventsPath}.shop-backup-${stamp}`, _eventsXml);
    await uploadServerTextFile(
      `${getShopFilePaths().eventSpawnsPath}.shop-backup-${stamp}`,
      _eventSpawnsXml,
    );
    if (_effectAreaJson !== undefined) {
      await uploadServerTextFile(
        `${getShopFilePaths().effectAreaPath}.shop-backup-${stamp}`,
        _effectAreaJson,
      );
    }
  }
}

export async function deployPendingShopOrders(state: AppState) {
  ensureShopState(state);

  const delivery = await ensureShopDeliveryConfiguration();
  if (!delivery.ready) {
    throw new Error(delivery.reason || "SHOP DEPLOY BLOCKED: server-scoped delivery routing is not ready.");
  }

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
      path: `${getShopFilePaths().eventsPath} + ${getShopFilePaths().eventSpawnsPath} + ${getShopFilePaths().effectAreaPath}`,
      reason: "A shop batch is already waiting for restart/clear.",    };
  }

  const pendingOrders = getPendingShopOrders(state);

  if (!pendingOrders.length) {
    return {
      deployed: 0,
      path: `${getShopFilePaths().eventsPath} + ${getShopFilePaths().eventSpawnsPath} + ${getShopFilePaths().effectAreaPath}`,
      reason: "No pending shop orders to deploy.",
    };
  }

  console.log(
    `🛒 SHOP DEPLOY START pending=${pendingOrders.length} events=${getShopFilePaths().eventsPath} spawns=${getShopFilePaths().eventSpawnsPath} effects=${getShopFilePaths().effectAreaPath}`,
  );

  validateOrdersReadyForXml(pendingOrders);

  console.log("🛒 SHOP DEPLOY downloading XML files");
  let eventsXml: string;
  let eventSpawnsXml: string;
  let effectAreaJson: string;
  try {
    [eventsXml, eventSpawnsXml, effectAreaJson] = await Promise.all([
      downloadServerTextFile(getShopFilePaths().eventsPath),
      downloadServerTextFile(getShopFilePaths().eventSpawnsPath),
      downloadServerTextFile(getShopFilePaths().effectAreaPath),
    ]);
  } catch (firstError) {
    const serverId = getServerRuntimeContext().serverId;
    console.warn(`[shop-delivery][${serverId}] configured XML route failed; rediscovering before one retry: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
    const repaired = await repairShopDeliveryRouting(serverId);
    if (!repaired.ready) throw firstError;
    [eventsXml, eventSpawnsXml, effectAreaJson] = await Promise.all([
      downloadServerTextFile(getShopFilePaths().eventsPath),
      downloadServerTextFile(getShopFilePaths().eventSpawnsPath),
      downloadServerTextFile(getShopFilePaths().effectAreaPath),
    ]);
  }

  await backupShopXmlFiles(eventsXml, eventSpawnsXml, effectAreaJson);

  console.log("🛒 SHOP DEPLOY injecting SHOP_BOT XML blocks");
  const injectedEvents = injectShopEventsXml(eventsXml, pendingOrders);
  const injectedEventSpawns = injectShopEventSpawnsXml(
    eventSpawnsXml,
    pendingOrders,
  );
  const injectedEffectAreaJson = injectShopEffectAreas(effectAreaJson, pendingOrders);

  validateInjectedShopXml({
    eventsXml: injectedEvents.xml,
    eventSpawnsXml: injectedEventSpawns,
    expectedOrders: pendingOrders,
    eventNames: injectedEvents.eventNames,
    stage: "generated",
  });
  if (!hasShopEffectAreas(injectedEffectAreaJson, pendingOrders)) {
    throw new Error("SHOP DEPLOY FAILED: cfgEffectArea.json is missing one or more generated Shop fire markers.");
  }

  console.log(
    `🛒 SHOP DEPLOY uploading XML files events=${injectedEvents.eventNames.length}`,
  );
  try {
    await uploadServerTextFile(getShopFilePaths().eventsPath, injectedEvents.xml);
    await uploadServerTextFile(getShopFilePaths().eventSpawnsPath, injectedEventSpawns);
    await uploadServerTextFile(getShopFilePaths().effectAreaPath, injectedEffectAreaJson);

  } catch (deployError) {
    console.error("❌ SHOP DEPLOY partial failure; attempting XML rollback", deployError);
    try {
      await restoreAndVerifyShopXmlFiles(eventsXml, eventSpawnsXml, "DEPLOY");
      await uploadServerTextFile(getShopFilePaths().effectAreaPath, effectAreaJson);
      const restoredEffectAreaJson = await downloadServerTextFile(getShopFilePaths().effectAreaPath);
      if (restoredEffectAreaJson !== effectAreaJson) {
        throw new Error("SHOP DEPLOY ROLLBACK FAILED: cfgEffectArea.json could not be restored.");
      }
      console.log("✅ SHOP DEPLOY rollback verified by restoring and re-downloading both original XML payloads");
    } catch (rollbackError) {
      console.error("❌ SHOP DEPLOY rollback failed or could not be verified", rollbackError);
      throw new Error(
        "SHOP DEPLOY FAILED AND ROLLBACK COULD NOT BE VERIFIED: " +
          (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
        { cause: deployError },
      );
    }
    throw deployError;
  }

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
    admFileAtDeploy: state.lastFileName,
    sawOfflineAt: undefined,
    sawOnlineAt: undefined,
    lastStatus: null,
    lastCheckedAt: now,
    confirmationReason: undefined,
  };

  console.log(
    `✅ SHOP DEPLOY VERIFIED deployed=${pendingOrders.length} batch=${batchId}`,
  );

  return {
    deployed: pendingOrders.length,
    path: `${getShopFilePaths().eventsPath} + ${getShopFilePaths().eventSpawnsPath} + ${getShopFilePaths().effectAreaPath}`,
    batchId,
  };
}

async function removeShopXmlBlocks(expectedOrders: ShopOrder[] = []) {
  const [eventsXml, eventSpawnsXml, effectAreaJson] = await Promise.all([
    downloadServerTextFile(getShopFilePaths().eventsPath),
    downloadServerTextFile(getShopFilePaths().eventSpawnsPath),
    downloadServerTextFile(getShopFilePaths().effectAreaPath),
  ]);

  const eventsHasBlock = hasShopBotBlock(eventsXml);
  const spawnsHasBlock = hasShopBotBlock(eventSpawnsXml);
  const effectAreaHasShopMarkers = hasShopEffectAreas(effectAreaJson);
  const effectAreaHasExpectedMarkers = expectedOrders.length
    ? hasShopEffectAreas(effectAreaJson, expectedOrders)
    : effectAreaHasShopMarkers;

  // A restart may already have consumed/removed the Shop block before the bot
  // gets a chance to run its clear step. Clearing must be idempotent: absence
  // of the block is a recoverable state, not a fatal error that can permanently
  // lock the checkout behind included_in_restart orders.
  if (!eventsHasBlock && !spawnsHasBlock && !effectAreaHasShopMarkers) {
    console.warn("⚠️ SHOP CLEAR: SHOP_BOT block already absent from both XML files; no XML changes required.");
    return {
      eventsHasBlock,
      spawnsHasBlock,
      effectAreaHasShopMarkers,
      effectAreaHasExpectedMarkers,
      blockWasPresent: false,
    };
  }

  await backupShopXmlFiles(eventsXml, eventSpawnsXml, effectAreaJson);

  try {
    await uploadServerTextFile(getShopFilePaths().eventsPath, removeShopBotBlock(eventsXml));
    await uploadServerTextFile(
      getShopFilePaths().eventSpawnsPath,
      removeShopBotBlock(eventSpawnsXml),
    );
    const clearedEffectArea = removeShopEffectAreas(effectAreaJson);
    await uploadServerTextFile(getShopFilePaths().effectAreaPath, clearedEffectArea.json);

  } catch (clearError) {
    console.error("❌ SHOP CLEAR partial failure; attempting XML rollback", clearError);
    try {
      await restoreAndVerifyShopXmlFiles(eventsXml, eventSpawnsXml, "CLEAR");
      await uploadServerTextFile(getShopFilePaths().effectAreaPath, effectAreaJson);
      const restoredEffectAreaJson = await downloadServerTextFile(getShopFilePaths().effectAreaPath);
      if (restoredEffectAreaJson !== effectAreaJson) {
        throw new Error("SHOP CLEAR ROLLBACK FAILED: cfgEffectArea.json could not be restored.");
      }
      console.log("✅ SHOP CLEAR rollback verified by restoring and re-downloading both original XML payloads");
    } catch (rollbackError) {
      console.error("❌ SHOP CLEAR rollback failed or could not be verified", rollbackError);
      throw new Error(
        "SHOP CLEAR FAILED AND ROLLBACK COULD NOT BE VERIFIED: " +
          (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
        { cause: clearError },
      );
    }
    throw clearError;
  }

  return {
    eventsHasBlock,
    spawnsHasBlock,
    effectAreaHasShopMarkers,
    effectAreaHasExpectedMarkers,
    blockWasPresent: true,
  };
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
      path: `${getShopFilePaths().eventsPath} + ${getShopFilePaths().eventSpawnsPath} + ${getShopFilePaths().effectAreaPath}`,
    };
  }

  if (!systems.nitrado) {
    console.log("⏸️ shop clear ignorado: SYSTEM_NITRADO=false");
    return {
      cleared: 0,
      cancelled: 0,
      path: `${getShopFilePaths().eventsPath} + ${getShopFilePaths().eventSpawnsPath} + ${getShopFilePaths().effectAreaPath}`,
    };
  }
  const cancelPending = options?.cancelPending ?? true;
  const includedOrders = options?.includedOnly
    ? getIncludedBatchOrders(state)
    : getIncludedShopOrders(state);
  const pendingOrders = cancelPending ? getPendingShopOrders(state) : [];

  const clearState = await removeShopXmlBlocks(includedOrders);

  const now = new Date().toISOString();

  if (clearState.eventsHasBlock && clearState.spawnsHasBlock && (clearState.effectAreaHasExpectedMarkers || !clearState.effectAreaHasShopMarkers)) {
    // Both files contained the expected Shop block, so the batch can be
    // considered successfully finalized.
    for (const order of includedOrders) {
      order.status = "spawned";
      order.spawnedAt = now;
      order.failReason = undefined;
    }
  } else {
    // The XML was already partially/fully absent. We must never claim that the
    // items spawned just because the queue was unlocked. Preserve the history
    // as a failed/unverified batch while allowing new purchases immediately.
    const reason = clearState.blockWasPresent
      ? "Shop XML block was partially missing before clear; delivery could not be verified."
      : "Shop XML block was already absent before clear; delivery could not be verified.";

    for (const order of includedOrders) {
      order.status = "failed";
      order.failedAt = now;
      order.failReason = reason;
    }

    if (includedOrders.length) {
      console.warn(
        `⚠️ SHOP CLEAR finalized stale/unverified batch as failed: orders=${includedOrders.length} reason=${reason}`,
      );
    }
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
    path: `${getShopFilePaths().eventsPath} + ${getShopFilePaths().eventSpawnsPath} + ${getShopFilePaths().effectAreaPath}`,
  };
}

function getShopDeployMinutesBeforeReset() {
  return Math.max(1, numberEnv("SHOP_DEPLOY_MINUTES_BEFORE_RESET", 5));
}

function isWithinScheduledDeployWindow(now: Date, restartAt: Date) {
  const deployAt = restartAt.getTime() - getShopDeployMinutesBeforeReset() * 60_000;
  // Never deploy after the scheduled reset has already happened. Doing so
  // would require an unnecessary second restart just to apply the XML.
  return now.getTime() >= deployAt && now.getTime() < restartAt.getTime();
}

export async function autoDeployPendingShopOrdersIfNeeded(
  state: AppState,
  observedServerStatus?: string | null,
) {
  ensureShopState(state);
  if (!systems.shop || !systems.nitrado || !boolEnv("SHOP_AUTO_DEPLOY_ENABLED", true)) return null;

  const pending = getPendingShopOrders(state);
  if (!pending.length || getIncludedShopOrders(state).length) return null;

  const restart = getNextConfiguredRestart(new Date(), getServerRuntimeContext().serverId);
  if (!restart) return null;

  const now = new Date();
  if (!isWithinScheduledDeployWindow(now, restart.at)) return null;

  const result = await deployPendingShopOrders(state);
  if (!result?.deployed) return result;

  const monitor = state.shopResetMonitor;
  if (monitor) {
    monitor.autoRestartManaged = true;
    monitor.targetRestartAt = restart.at.toISOString();
    monitor.restartPhase = "scheduled";
    monitor.restartError = undefined;
    monitor.confirmationReason = `scheduled_restart:${restart.label}`;
  }

  state.shopAutoDeploy = {
    lastServerStatus: normalizeServerStatus(observedServerStatus),
    lastCheckedAt: now.toISOString(),
    lastDeployAt: now.toISOString(),
    lastAction: `shop_deploy_before_${restart.label}`,
  };

  console.log(`🛒 SHOP AUTO-DEPLOY scheduled for ${restart.at.toISOString()} (${restart.label})`);
  return { ...result, scheduledRestartAt: restart.at.toISOString(), stateChanged: true };
}

export async function syncShopWithNitradoServer(
  state: AppState,
  observedServerStatus?: string | null,
): Promise<{ deployResult: unknown; clearResult: unknown; stateChanged: boolean } | null> {
  ensureShopState(state);

  try {
    await repairLegacyShopEventSpawnsIfNeeded(state);  } catch (recoveryError) {
    console.error("❌ SHOP recovery failed:", recoveryError);
  }

  const pending = getPendingShopOrders(state);
  const included = getIncludedShopOrders(state);
  const now = new Date();
  const nextRestart = getNextConfiguredRestart(now, getServerRuntimeContext().serverId);
  const monitor = state.shopResetMonitor;

  // Pending orders are scheduled purely from the configured reset time. There is
  // no reason to query Nitrado while waiting for the deploy window.
  if (pending.length && !included.length) {
    const deployResult = await autoDeployPendingShopOrdersIfNeeded(state, observedServerStatus);
    return deployResult
      ? { deployResult, clearResult: null, stateChanged: true }
      : null;
  }

  // A bot-managed batch does not need status polling before its target. At the
  // target we own the whole STOP -> stopped -> START -> started lifecycle.
  if (
    monitor?.autoRestartManaged &&
    monitor.targetRestartAt &&
    monitor.restartPhase === "scheduled" &&
    Date.now() < Date.parse(monitor.targetRestartAt)
  ) {
    return null;
  }

  if (
    monitor?.autoRestartManaged &&
    monitor.restartPhase === "completed"
  ) {
    const beforeKey = getShopResetMonitorPersistenceKey(state);
    const clearResult = await pollShopResetStatusAndAutoClear(state, monitor.lastStatus || "started");
    const afterKey = getShopResetMonitorPersistenceKey(state);
    return {
      deployResult: null,
      clearResult,
      stateChanged: beforeKey !== afterKey,
    };
  }

  // Manually deployed batches are still supported. We only watch Nitrado around
  // the next configured reset instead of polling the server all day.
  if (!monitor?.autoRestartManaged && nextRestart) {
    const watchStartsAt = nextRestart.at.getTime() - 2 * 60_000;
    const watchEndsAt = nextRestart.at.getTime() + 10 * 60_000;
    if (now.getTime() < watchStartsAt || now.getTime() > watchEndsAt) return null;
  }

  let status = observedServerStatus;
  if (status === undefined) {
    const response = await getNitradoGameserverStatus(getServerRuntimeContext().serverId);
    status = response.status;
  }

  const beforeKey = getShopResetMonitorPersistenceKey(state);

  const clearResult = await pollShopResetStatusAndAutoClear(state, status);
  const afterKey = getShopResetMonitorPersistenceKey(state);
  return {
    deployResult: null,
    clearResult,
    stateChanged: beforeKey !== afterKey,
  };
}


export async function pollShopResetStatusAndAutoClear(
  state: AppState,
  observedServerStatus?: string | null,
) {
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

  let monitor = state.shopResetMonitor || null;

  // The Shop monitor is operational state, not the source of truth for orders.
  // A process restart/deploy can legitimately lose the in-memory monitor while
  // server_shop_orders still contains included orders. Reconstruct the monitor
  // from the persisted order timestamp and the canonical server reset state so a
  // successful reset cannot leave a batch stuck in included_in_restart forever.
  if (!monitor) {
    const serverReset = state.serverReset;
    const recentReset = serverReset?.lastCompletedAt && serverReset?.lastCompletedAtRuntime
      ? {
          targetAt: Date.parse(serverReset.lastCompletedAt),
          completedAt: Date.parse(serverReset.lastCompletedAtRuntime),
        }
      : null;
    const oldestIncludedAt = includedOrders
      .map((order) => Date.parse(String(order.includedAt || order.createdAt || "")))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];

    if (recentReset && Number.isFinite(oldestIncludedAt) && recentReset.targetAt >= oldestIncludedAt) {
      const completedIso = new Date(recentReset.completedAt).toISOString();
      const targetIso = new Date(recentReset.targetAt).toISOString();
      monitor = {
        batchId: includedOrders[0]?.restartTarget,
        deployedAt: includedOrders[0]?.includedAt,
        lastStatus: "started",
        lastCheckedAt: completedIso,
        sawOfflineAt: serverReset?.lastAttemptedAtRuntime,
        sawOnlineAt: completedIso,
        autoRestartManaged: true,
        targetRestartAt: targetIso,
        restartPhase: "completed",
        restartCompletedAt: completedIso,
        confirmationReason: "reconstructed_from_persisted_server_reset",
      } as NonNullable<AppState["shopResetMonitor"]>;
      console.log(
        `♻️ SHOP reset monitor reconstructed from persisted server reset: batch=\${monitor.batchId || "unknown"} target=\${targetIso} completed=\${completedIso}`,
      );
    }
  }

  if (!monitor) {
    monitor = {
      batchId: includedOrders[0]?.restartTarget,
      deployedAt: includedOrders[0]?.includedAt,
      lastStatus: null,
      lastCheckedAt: new Date().toISOString(),
    } as NonNullable<AppState["shopResetMonitor"]>;
  }

  state.shopResetMonitor = monitor;
  ensureResetMonitorState(monitor, includedOrders);

  let status: string | null = observedServerStatus ?? null;

  if (observedServerStatus === undefined) {
    try {
      const response = await getNitradoGameserverStatus(getServerRuntimeContext().serverId);
      status = response.status;
    } catch (err) {
      console.error("❌ shop auto-clear status poll failed:", err);
    }
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

  if (!monitor.sawOfflineAt && !monitor.sawOnlineAt) {
    console.log(
      `🛒 shop auto-clear aguardando reset. status=${normalized}` ,
    );
    return null;
  }

  if (monitor.sawOfflineAt && !monitor.sawOnlineAt) {
    console.log(
      `🛒 shop auto-clear aguardando servidor voltar online. status=${normalized}` ,
    );
    return null;
  }

  const clearDelayMinutes = getShopClearMinutesAfterReset();
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
  ensureShopState(state);
  const included = getIncludedShopOrders(state);
  const monitor = state.shopResetMonitor;
  const currentAdmFile = String(state.lastFileName || "").trim();
  const deployedAdmFile = String(monitor?.admFileAtDeploy || "").trim();

  // Nitrado status polling can miss a fast restart entirely between 5-minute
  // coordinator ticks. A new ADM file after deployment is server-scoped,
  // parser-observed evidence that a fresh DayZ process has started.
  if (included.length && monitor && deployedAdmFile && currentAdmFile && currentAdmFile !== deployedAdmFile && !monitor.sawOnlineAt) {
    monitor.sawOnlineAt = new Date().toISOString();
    monitor.confirmationReason = `adm_file_rotated:${deployedAdmFile}->${currentAdmFile}`;
    console.log(`🛒 shop reset monitor: restart confirmed by ADM rotation ${deployedAdmFile} -> ${currentAdmFile}`);
  }

  return pollShopResetStatusAndAutoClear(state);
}

export function formatShopQueue(state: AppState) {
  const shopOrders = ensureShopState(state).shopOrders;

  const pending = shopOrders.filter((order) => order.status === "pending_spawn");
  const included = shopOrders.filter((order) => order.status === "included_in_restart");
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
        `Last server status: \`${autoDeploy.lastServerStatus || "unknown"}\``,
        `Last deploy: \`${autoDeploy.lastDeployAt || "no"}\``,
        `Last action: \`${autoDeploy.lastAction || "none"}\``,
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
