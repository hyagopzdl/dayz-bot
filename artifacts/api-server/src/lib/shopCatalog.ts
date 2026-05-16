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
      popularName: "Barrel",
      price: 250,
      category: "containers",
      description: "Green storage barrel delivered on the next restart.",
      enabled: true,
    },
    {
      id: "barrel_red",
      name: "Red Barrel",
      className: "Barrel_Red",
      popularName: "Barrel",
      price: 250,
      category: "containers",
      description: "Red storage barrel delivered on the next restart.",
      enabled: true,
    },
  ],
};

function catalogPath() {
  return path.resolve(
    process.cwd(),
    process.env.SHOP_CATALOG_FILE || "data/shop-catalog.json",
  );
}

export function normalizeShopCatalogId(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function labelFromId(value: string) {
  return String(value || "Misc")
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Misc";
}

function safeCatalog(input: Partial<ShopCatalog> | null | undefined): ShopCatalog {
  const categories = Array.isArray(input?.categories)
    ? input!.categories
    : DEFAULT_CATALOG.categories;
  const items = Array.isArray(input?.items) ? input!.items : DEFAULT_CATALOG.items;

  const safeItems = items
    .filter((item) => item?.id && item?.className && item?.name)
    .map((item) => ({
      ...item,
      id: normalizeShopCatalogId(item.id),
      name: String(item.name || item.className).trim(),
      className: String(item.className || "").trim(),
      popularName: item.popularName ? String(item.popularName).trim() : undefined,
      category: normalizeShopCatalogId(item.category || "misc"),
      price: Number.isFinite(Number(item.price)) ? Number(item.price) : 0,
      enabled: item.enabled !== false,
      description: item.description ? String(item.description).trim() : undefined,
      imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
      maxPerRestart: Number.isFinite(Number(item.maxPerRestart))
        ? Number(item.maxPerRestart)
        : undefined,
    }));

  const categoryIds = new Set(safeItems.map((item) => item.category || "misc"));
  const safeCategories = categories
    .filter((category) => category?.id && category?.label)
    .map((category) => ({
      ...category,
      id: normalizeShopCatalogId(category.id),
      label: String(category.label || labelFromId(category.id)).trim(),
      enabled: category.enabled !== false,
    }));

  for (const categoryId of categoryIds) {
    if (!safeCategories.some((category) => category.id === categoryId)) {
      safeCategories.push({
        id: categoryId,
        label: labelFromId(categoryId),
        enabled: true,
      });
    }
  }

  return {
    version: Number(input?.version || DEFAULT_CATALOG.version),
    categories: safeCategories,
    items: safeItems,
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(safeCatalog(catalog), null, 2)}\n`, "utf8");
}

export function ensureShopCatalogFile() {
  const file = catalogPath();
  if (!fs.existsSync(file)) {
    saveShopCatalog(DEFAULT_CATALOG);
  }
  return file;
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

export function upsertShopCatalogItem(item: ShopItem) {
  const catalog = getShopCatalog();
  const normalizedItem: ShopItem = {
    ...item,
    id: normalizeShopCatalogId(item.id || item.name || item.className),
    name: String(item.name || item.className).trim(),
    className: String(item.className || "").trim(),
    popularName: item.popularName ? String(item.popularName).trim() : undefined,
    category: normalizeShopCatalogId(item.category || "misc"),
    price: Number(item.price || 0),
    enabled: item.enabled !== false,
    description: item.description ? String(item.description).trim() : undefined,
    imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
    maxPerRestart: Number.isFinite(Number(item.maxPerRestart))
      ? Number(item.maxPerRestart)
      : undefined,
  };

  if (!normalizedItem.id || !normalizedItem.className || !normalizedItem.name) {
    throw new Error("Catalog item requires id, className and name.");
  }

  const index = catalog.items.findIndex((existing) => existing.id === normalizedItem.id);
  if (index >= 0) catalog.items[index] = normalizedItem;
  else catalog.items.push(normalizedItem);

  if (!catalog.categories.some((category) => category.id === normalizedItem.category)) {
    catalog.categories.push({
      id: normalizedItem.category || "misc",
      label: labelFromId(normalizedItem.category || "misc"),
      enabled: true,
    });
  }

  saveShopCatalog(catalog);
  return normalizedItem;
}

export function deleteShopCatalogItem(itemId: string) {
  const catalog = getShopCatalog();
  const normalized = normalizeShopCatalogId(itemId);
  const before = catalog.items.length;
  catalog.items = catalog.items.filter((item) => item.id !== normalized);
  saveShopCatalog(catalog);
  return before !== catalog.items.length;
}

export function toggleShopCatalogItem(itemId: string, enabled?: boolean) {
  const catalog = getShopCatalog();
  const normalized = normalizeShopCatalogId(itemId);
  const item = catalog.items.find((entry) => entry.id === normalized);

  if (!item) return null;

  item.enabled = typeof enabled === "boolean" ? enabled : item.enabled === false;
  saveShopCatalog(catalog);
  return item;
}
