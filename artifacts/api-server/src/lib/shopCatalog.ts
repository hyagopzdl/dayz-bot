import {
  getCachedShopCatalog,
  isShopCatalogLoaded,
  initializeShopCatalogCache,
  refreshShopCatalogCache,
  deleteShopCatalogItemFromDatabase,
  deleteShopCatalogCategoryFromDatabase,
  toggleShopCatalogItemInDatabase,
  upsertShopCatalogCategory,
  upsertShopCatalogItemInDatabase,
  seedShopCatalogInDatabase,
  reorderShopCatalogCategories,
  reorderShopCatalogItems,
  cloneShopCatalogFromServer,
  getShopCatalogIsolationDiagnostics,
} from "./catalogService";

export type ShopDeliveryKind = "item" | "vehicle";

export type ShopItem = {
  id: string;
  name: string;
  className: string;
  price: number;
  category?: string;
  description?: string;
  imageUrl?: string;
  enabled?: boolean;
  maxPerRestart?: number;
  popularName?: string;
  spawnEventName?: string;
  deliveryKind?: ShopDeliveryKind;
  sortOrder?: number;
};

export type ShopCategory = {
  id: string;
  label: string;
  emoji?: string;
  description?: string;
  enabled?: boolean;
  sortOrder?: number;
};

export type ShopCatalog = {
  version: number;
  categories: ShopCategory[];
  items: ShopItem[];
};

export function normalizeShopCatalogId(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const KNOWN_VEHICLE_CATALOG_CLASSES = new Set([
  "CivilianSedan",
  "CivilianSedan_Black",
  "CivilianSedan_Wine",
  "OffroadHatchback",
  "OffroadHatchback_Blue",
  "OffroadHatchback_White",
  "Hatchback_02",
  "Hatchback_02_Black",
  "Hatchback_02_Blue",
  "Sedan_02",
  "Sedan_02_Grey",
  "Sedan_02_Red",
  "Truck_01_Cargo",
  "Truck_01_Cargo_Blue",
  "Truck_01_Cargo_Grey",
  "Truck_01_Cargo_Orange",
  "Truck_01_Chassis",
  "Truck_01_Chassis_Blue",
  "Truck_01_Chassis_Grey",
  "Truck_01_Chassis_Orange",
  "Truck_01_Covered",
  "Truck_01_Covered_Blue",
  "Truck_01_Covered_Grey",
  "Truck_01_Covered_Orange",
  "Truck_02",
  "M1025",
]);

export function getShopItemDeliveryKind(item: Pick<ShopItem, "className" | "spawnEventName" | "deliveryKind">): ShopDeliveryKind {
  if (item.deliveryKind === "vehicle") return "vehicle";
  if (String(item.spawnEventName || "").trim().startsWith("Vehicle")) return "vehicle";
  if (KNOWN_VEHICLE_CATALOG_CLASSES.has(String(item.className || "").trim())) return "vehicle";

  return "item";
}

export async function initializeShopCatalog() {
  return initializeShopCatalogCache();
}

export async function refreshShopCatalog() {
  return refreshShopCatalogCache();
}

export async function ensureShopCatalogLoaded() {
  if (!isShopCatalogLoaded()) {
    await initializeShopCatalogCache();
  }
}


export function getShopCatalog(): ShopCatalog {
  return getCachedShopCatalog();
}

export function getShopCategories(includeDisabled = false) {
  const catalog = getShopCatalog();
  const enabledItems = includeDisabled
    ? catalog.items
    : catalog.items.filter((item) => item.enabled !== false);
  const categoryIds = new Set(enabledItems.map((item) => item.category || "misc"));

  return catalog.categories
    .filter(
      (category) =>
        (includeDisabled || category.enabled !== false) && categoryIds.has(category.id),
    )
    .map((category) => ({
      id: category.id,
      label: category.label,
      emoji: category.emoji,
      description: category.description,
      enabled: category.enabled !== false,
    }));
}

export function getShopItems(includeDisabled = false) {
  const items = getShopCatalog().items;
  return includeDisabled ? items : items.filter((item) => item.enabled !== false);
}

export function getShopItemsByCategory(category: string, includeDisabled = false) {
  const normalized = normalizeShopCatalogId(category || "misc");
  return getShopItems(includeDisabled).filter(
    (item) => normalizeShopCatalogId(item.category || "misc") === normalized,
  );
}

export function findShopItem(input: string) {
  const normalized = normalizeShopCatalogId(input);

  return (
    getShopItems().find(
      (item) =>
        normalizeShopCatalogId(item.id) === normalized ||
        normalizeShopCatalogId(item.name) === normalized ||
        normalizeShopCatalogId(item.className) === normalized ||
        normalizeShopCatalogId(item.popularName || "") === normalized,
    ) || null
  );
}

export async function upsertShopCatalogCategoryItem(category: ShopCategory) {
  await upsertShopCatalogCategory(category);
  return refreshShopCatalogCache();
}

export async function deleteShopCatalogCategory(categoryId: string) {
  return deleteShopCatalogCategoryFromDatabase(categoryId);
}

export async function upsertShopCatalogItem(item: ShopItem) {
  return upsertShopCatalogItemInDatabase(item);
}

export async function deleteShopCatalogItem(itemId: string) {
  return deleteShopCatalogItemFromDatabase(itemId);
}

export async function toggleShopCatalogItem(itemId: string, enabled?: boolean) {
  return toggleShopCatalogItemInDatabase(itemId, enabled);
}

export async function seedShopCatalog(catalog: ShopCatalog, options?: { replace?: boolean }) {
  return seedShopCatalogInDatabase(catalog, options);
}

export async function reorderShopCategories(categoryIds: string[]) {
  return reorderShopCatalogCategories(categoryIds);
}

export async function reorderShopItems(categoryId: string, itemIds: string[]) {
  return reorderShopCatalogItems(categoryId, itemIds);
}

export async function cloneShopCatalog(sourceServerId: string, targetServerId?: string) {
  return cloneShopCatalogFromServer(sourceServerId, targetServerId);
}

export function getShopCatalogDiagnostics() {
  return getShopCatalogIsolationDiagnostics();
}

/**
 * The shop catalog is now database-backed. This function is kept only for
 * compatibility with old admin helpers and no longer creates local files.
 */
export function ensureShopCatalogFile() {
  return "Neon PostgreSQL: server_shop_catalog_items / server_shop_catalog_categories";
}

export function saveShopCatalog(_catalog: ShopCatalog): never {
  throw new Error(
    "Local shop catalog writes are disabled. Use Neon-backed catalog APIs instead.",
  );
}
