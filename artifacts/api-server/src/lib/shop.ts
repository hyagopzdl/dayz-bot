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

export async function clearShopSpawnerAndMarkSpawned(state: AppState) {
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

  for (const order of pendingOrders) {
    order.status = "failed";
    order.failedAt = now;
    order.failReason = "Cleared before deploy";
  }

  return {
    cleared: includedOrders.length,
    cancelled: pendingOrders.length,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
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
