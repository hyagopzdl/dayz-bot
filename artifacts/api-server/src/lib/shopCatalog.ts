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
} from "./catalogService";

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
};

export type ShopCategory = {
  id: string;
  label: string;
  emoji?: string;
  description?: string;
  enabled?: boolean;
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

/**
 * The shop catalog is now database-backed. This function is kept only for
 * compatibility with old admin helpers and no longer creates local files.
 */
export function ensureShopCatalogFile() {
  return "Neon PostgreSQL: shop_catalog_items / shop_catalog_categories";
}

export function saveShopCatalog(_catalog: ShopCatalog): never {
  throw new Error(
    "Local shop catalog writes are disabled. Use Neon-backed catalog APIs instead.",
  );
}
