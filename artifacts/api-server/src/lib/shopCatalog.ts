import fs from "fs";
import path from "path";

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

const DEFAULT_CATALOG: ShopCatalog = {
  version: 1,
  categories: [
    {
      id: "containers",
      label: "Containers",
      emoji: "📦",
      description: "Storage containers delivered after the next restart.",
      enabled: true,
    },
  ],
  items: [
    {
      id: "barrel_green",
      name: "Green Barrel",
      className: "Barrel_Green",
      price: 250,
      category: "containers",
      description: "Green storage barrel delivered on the next restart.",
      enabled: true,
    },
    {
      id: "barrel_red",
      name: "Red Barrel",
      className: "Barrel_Red",
      price: 250,
      category: "containers",
      description: "Red storage barrel delivered on the next restart.",
      enabled: true,
    },
  ],
};

function catalogPath() {
  return path.resolve(process.cwd(), process.env.SHOP_CATALOG_FILE || "shop-catalog.json");
}

function normalizeId(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeCatalog(input: Partial<ShopCatalog> | null | undefined): ShopCatalog {
  const categories = Array.isArray(input?.categories) ? input!.categories : DEFAULT_CATALOG.categories;
  const items = Array.isArray(input?.items) ? input!.items : DEFAULT_CATALOG.items;

  return {
    version: Number(input?.version || DEFAULT_CATALOG.version),
    categories: categories
      .filter((category) => category?.id && category?.label)
      .map((category) => ({
        ...category,
        id: normalizeId(category.id),
        enabled: category.enabled !== false,
      })),
    items: items
      .filter((item) => item?.id && item?.className && item?.name)
      .map((item) => ({
        ...item,
        id: normalizeId(item.id),
        category: normalizeId(item.category || "misc"),
        price: Number.isFinite(Number(item.price)) ? Number(item.price) : 0,
        enabled: item.enabled !== false,
      })),
  };
}

export function getShopCatalog(): ShopCatalog {
  const file = catalogPath();

  if (!fs.existsSync(file)) {
    return safeCatalog(DEFAULT_CATALOG);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return safeCatalog(parsed);
  } catch (err) {
    console.error("❌ failed to read shop catalog, falling back to defaults:", err);
    return safeCatalog(DEFAULT_CATALOG);
  }
}

export function saveShopCatalog(catalog: ShopCatalog) {
  const file = catalogPath();
  fs.writeFileSync(file, `${JSON.stringify(safeCatalog(catalog), null, 2)}\n`, "utf8");
}

export function ensureShopCatalogFile() {
  const file = catalogPath();
  if (!fs.existsSync(file)) {
    saveShopCatalog(DEFAULT_CATALOG);
  }
  return file;
}

export function getShopCategories() {
  const catalog = getShopCatalog();
  const categoryIds = new Set(catalog.items.map((item) => item.category || "misc"));

  return catalog.categories
    .filter((category) => category.enabled !== false && categoryIds.has(category.id))
    .map((category) => ({
      id: category.id,
      label: category.label,
      emoji: category.emoji,
      description: category.description,
    }));
}

export function getShopItems(includeDisabled = false) {
  const items = getShopCatalog().items;
  return includeDisabled ? items : items.filter((item) => item.enabled !== false);
}

export function getShopItemsByCategory(category: string, includeDisabled = false) {
  const normalized = normalizeId(category || "misc");
  return getShopItems(includeDisabled).filter((item) => normalizeId(item.category || "misc") === normalized);
}

export function findShopItem(input: string) {
  const normalized = normalizeId(input);

  return (
    getShopItems().find(
      (item) =>
        normalizeId(item.id) === normalized ||
        normalizeId(item.name) === normalized ||
        normalizeId(item.className) === normalized,
    ) || null
  );
}

export function upsertShopCatalogItem(item: ShopItem) {
  const catalog = getShopCatalog();
  const normalizedItem: ShopItem = {
    ...item,
    id: normalizeId(item.id || item.name || item.className),
    category: normalizeId(item.category || "misc"),
    price: Number(item.price || 0),
    enabled: item.enabled !== false,
  };

  const index = catalog.items.findIndex((existing) => existing.id === normalizedItem.id);
  if (index >= 0) catalog.items[index] = normalizedItem;
  else catalog.items.push(normalizedItem);

  if (!catalog.categories.some((category) => category.id === normalizedItem.category)) {
    catalog.categories.push({
      id: normalizedItem.category || "misc",
      label: String(normalizedItem.category || "Misc")
        .split(/[_-]+/g)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      enabled: true,
    });
  }

  saveShopCatalog(catalog);
  return normalizedItem;
}

export function deleteShopCatalogItem(itemId: string) {
  const catalog = getShopCatalog();
  const normalized = normalizeId(itemId);
  const before = catalog.items.length;
  catalog.items = catalog.items.filter((item) => item.id !== normalized);
  saveShopCatalog(catalog);
  return before !== catalog.items.length;
}
