import type { AppState, ShopOrder } from "./state";
import { listNitradoDirectory, uploadShopSpawnerFile } from "./nitradoDownloader";

export type ShopItem = {
  name: string;
  className: string;
  price: number;
};

export const SHOP_ITEMS: ShopItem[] = [
  { name: "M4A1", className: "M4A1", price: 1000 },
  { name: "AKM", className: "AKM", price: 900 },
  { name: "NVG", className: "NVGoggles", price: 500 },
];

const DEFAULT_DAYZ_MISSION_DIR =
  process.env.DAYZ_MISSION_DIR || "dayzps_missions/dayzOffline.chernarusplus";

function normalizeRelativePath(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

function resolveShopSpawnerPath() {
  const configuredPath =
    process.env.SHOP_SPAWNER_PATH || "custom/shop_pending.json";
  const cleanPath = normalizeRelativePath(configuredPath.trim());

  if (cleanPath.startsWith("dayzps_missions/")) {
    return cleanPath;
  }

  return `${normalizeRelativePath(DEFAULT_DAYZ_MISSION_DIR)}/${cleanPath}`;
}

export const SHOP_SPAWNER_PATH = resolveShopSpawnerPath();

export async function debugShopSpawnerPaths() {
  const dirsToCheck = [
    "",
    "dayzps_missions",
    "dayzps_missions/dayzOffline.chernarusplus",
    "dayzps_missions/dayzOffline.chernarusplus/custom",
    "dayzps/config",
  ];

  const lines = [
    "🧪 **Nitrado Shop Path Debug**",
    "",
    `Configured upload file: \`${SHOP_SPAWNER_PATH}\``,
    "",
  ];

  for (const dir of dirsToCheck) {
    try {
      const entries = await listNitradoDirectory(dir);
      const preview = entries
        .slice(0, 6)
        .map((entry) => entry.path.split("/").filter(Boolean).pop() || entry.path)
        .join(", ");

      lines.push(
        `✅ \`${dir || "/"}\` exists (${entries.length} entries)${preview ? `: ${preview}` : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`❌ \`${dir || "/"}\` failed: ${message.slice(0, 160)}`);
    }
  }

  return lines.join("\n");
}

function normalizeItemName(value: string) {
  return String(value || "").trim().toLowerCase();
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
        normalizeItemName(item.name) === normalized ||
        normalizeItemName(item.className) === normalized,
    ) || null
  );
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
    throw new Error(`Item not found in shop catalog: ${options.itemInput}`);
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
    x: options.x,
    y: options.y,
    z: options.z,
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

export function buildShopSpawnerJson(orders: ShopOrder[]) {
  return {
    Objects: orders.map((order) => ({
      name: order.itemClass,
      pos: [order.x, order.y, order.z],
      ypr: [0, 0, 0],
      scale: 1,
      enableCEPersistency: false,
    })),
  };
}

export function buildEmptyShopSpawnerJson() {
  return { Objects: [] };
}

export async function deployPendingShopOrders(state: AppState) {
  const pendingOrders = getPendingShopOrders(state);

  if (!pendingOrders.length) {
    return { deployed: 0, path: SHOP_SPAWNER_PATH };
  }

  const payload = buildShopSpawnerJson(pendingOrders);
  await uploadShopSpawnerFile(SHOP_SPAWNER_PATH, payload);

  const now = new Date().toISOString();
  const batchId = `restart_${Date.now()}`;

  for (const order of pendingOrders) {
    order.status = "included_in_restart";
    order.restartTarget = batchId;
    order.includedAt = now;
  }

  return { deployed: pendingOrders.length, path: SHOP_SPAWNER_PATH, batchId };
}

export async function clearShopSpawnerAndMarkSpawned(state: AppState) {
  const includedOrders = getIncludedShopOrders(state);

  await uploadShopSpawnerFile(SHOP_SPAWNER_PATH, buildEmptyShopSpawnerJson());

  const now = new Date().toISOString();

  for (const order of includedOrders) {
    order.status = "spawned";
    order.spawnedAt = now;
  }

  return { cleared: includedOrders.length, path: SHOP_SPAWNER_PATH };
}

export function formatShopQueue(state: AppState) {
  const shopOrders = ensureShopState(state).shopOrders;
  const pending = shopOrders.filter((order) => order.status === "pending_spawn");
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
