import fs from "fs";
import type { AppState, ShopOrder } from "./state";
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

export function ensureShopState(state: AppState) {
  state.shopOrders = state.shopOrders || [];
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

  return {
    deployed: pendingOrders.length,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
    batchId,
  };
}

async function clearShopXmlBlocksAndMarkOrders(
  state: AppState,
  options: { cancelPending: boolean; reason: string },
) {
  const includedOrders = getIncludedShopOrders(state);
  const pendingOrders = getPendingShopOrders(state);

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

  const now = new Date().toISOString();

  for (const order of includedOrders) {
    order.status = "spawned";
    order.spawnedAt = now;
  }

  let cancelled = 0;

  if (options.cancelPending) {
    for (const order of pendingOrders) {
      order.status = "failed";
      order.failedAt = now;
      order.failReason = options.reason;
      cancelled++;
    }
  }

  return {
    cleared: includedOrders.length,
    cancelled,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
  };
}

export async function clearShopSpawnerAndMarkSpawned(state: AppState) {
  return clearShopXmlBlocksAndMarkOrders(state, {
    cancelPending: true,
    reason: "Cleared before deploy",
  });
}

const SHOP_BOOT_PATTERNS = [
  /Mission\s+read/i,
  /Mission\s+file\s+read/i,
  /Game\s+started/i,
  /Host\s+identity\s+created/i,
  /World\s+initialized/i,
  /Server\s+started/i,
];

const SHOP_SHUTDOWN_PATTERNS = [
  /Shutdown/i,
  /Game\s+stopped/i,
  /Destroying\s+current\s+mission/i,
  /Mission\s+finished/i,
  /Server\s+shutdown/i,
  /Server\s+stopping/i,
];

function boolFromEnv(name: string, defaultValue: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function getClearMinutesAfterReset() {
  const value = Number(process.env.SHOP_CLEAR_MINUTES_AFTER_RESET || 5);
  return Number.isFinite(value) && value >= 0 ? value : 5;
}

function extractAdmStartedAt(filePath: string) {
  const match = String(filePath).match(
    /_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.ADM$/i,
  );

  if (!match) return null;

  const value = new Date(`${match[1]}T${match[2].replace(/-/g, ":")}.000Z`);
  const time = value.getTime();

  return Number.isFinite(time) ? value : null;
}

function containsAnyPattern(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function findShopResetEvidence(admFiles: string[], deployedAt: Date) {
  const deployedTime = deployedAt.getTime();
  let bootDetectedAt: Date | null = null;
  let bootFile: string | null = null;
  let shutdownDetected = false;
  let shutdownFile: string | null = null;

  for (const file of admFiles) {
    if (!fs.existsSync(file)) continue;

    const text = fs.readFileSync(file, "utf-8");
    const admStartedAt = extractAdmStartedAt(file);
    const admStartedTime = admStartedAt?.getTime() ?? 0;

    if (containsAnyPattern(text, SHOP_SHUTDOWN_PATTERNS)) {
      shutdownDetected = true;
      shutdownFile = file;
    }

    if (
      admStartedTime > deployedTime &&
      containsAnyPattern(text, SHOP_BOOT_PATTERNS) &&
      (!bootDetectedAt || admStartedTime > bootDetectedAt.getTime())
    ) {
      bootDetectedAt = admStartedAt;
      bootFile = file;
    }
  }

  return {
    bootDetectedAt,
    bootFile,
    shutdownDetected,
    shutdownFile,
  };
}

export async function tryAutoClearShopAfterAdmReset(
  state: AppState,
  admFiles: string[],
) {
  if (!boolFromEnv("SHOP_AUTO_CLEAR_ENABLED", true)) {
    return { cleared: false, reason: "disabled" };
  }

  const includedOrders = getIncludedShopOrders(state);
  if (!includedOrders.length) {
    return { cleared: false, reason: "no_included_orders" };
  }

  const deployTimes = includedOrders
    .map((order) => new Date(order.includedAt || order.createdAt).getTime())
    .filter(Number.isFinite);

  if (!deployTimes.length) {
    return { cleared: false, reason: "missing_deploy_time" };
  }

  const deployedAt = new Date(Math.min(...deployTimes));
  const evidence = findShopResetEvidence(admFiles, deployedAt);

  if (!evidence.bootDetectedAt) {
    console.log(
      `🛒 shop auto-clear aguardando boot ADM posterior ao deploy ${deployedAt.toISOString()}`,
    );
    return { cleared: false, reason: "no_boot_after_deploy" };
  }

  const requireShutdownAndBoot = boolFromEnv(
    "SHOP_RESET_REQUIRE_SHUTDOWN_AND_BOOT",
    false,
  );
  const allowBootOnlyFallback = boolFromEnv(
    "SHOP_RESET_ALLOW_BOOT_ONLY_FALLBACK",
    true,
  );

  if (requireShutdownAndBoot && !evidence.shutdownDetected) {
    console.log(
      `🛒 shop auto-clear viu boot, mas ainda aguarda shutdown também. bootFile=${evidence.bootFile}`,
    );
    return { cleared: false, reason: "missing_shutdown_confirmation" };
  }

  if (!evidence.shutdownDetected && !allowBootOnlyFallback) {
    console.log(
      `🛒 shop auto-clear viu boot, mas fallback boot-only está desativado. bootFile=${evidence.bootFile}`,
    );
    return { cleared: false, reason: "boot_only_fallback_disabled" };
  }

  const minutesAfterReset = getClearMinutesAfterReset();
  const readyAt = evidence.bootDetectedAt.getTime() + minutesAfterReset * 60_000;

  if (Date.now() < readyAt) {
    console.log(
      `🛒 shop auto-clear aguardando ${minutesAfterReset} min após boot. boot=${evidence.bootDetectedAt.toISOString()}`,
    );
    return { cleared: false, reason: "waiting_after_boot" };
  }

  const result = await clearShopXmlBlocksAndMarkOrders(state, {
    cancelPending: false,
    reason: "Auto-clear after confirmed ADM reset",
  });

  console.log(
    `✅ shop auto-clear concluído: cleared=${result.cleared}, bootFile=${evidence.bootFile}, shutdown=${evidence.shutdownDetected ? evidence.shutdownFile : "not_detected"}`,
  );

  return {
    cleared: true,
    result,
    evidence,
  };
}


// Backward-compatible export for older discordBot.ts versions.
// The safe auto-clear path now runs from the ADM parser via tryAutoClearShopAfterAdmReset(state, admFiles).
// Returning null here prevents the old timer-only Discord loop from clearing XMLs without reset evidence.
export async function autoClearShopBlocksIfNeeded(
  _state: AppState,
): Promise<{ cleared: number; cancelled: number } | null> {
  return null;
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

  const lines = [
    "🛒 **Shop Queue**",
    "",
    `Pending: **${pending.length}**`,
    `Included in next restart: **${included.length}**`,
    `Spawned: **${spawned.length}**`,
    `Failed: **${failed.length}**`,
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
