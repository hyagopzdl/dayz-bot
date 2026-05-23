import postgres from "postgres";
import type { ShopCatalog, ShopCategory, ShopItem } from "./shopCatalog";

const CATALOG_VERSION = 1;

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      ssl: "require",
      max: 1,
    })
  : null;

let cachedCatalog: ShopCatalog | null = null;
let initialized = false;
let initializingPromise: Promise<ShopCatalog> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function normalizeShopCatalogId(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function labelFromId(value: string) {
  return (
    String(value || "Misc")
      .split(/[_-]+/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Misc"
  );
}

function requireSql() {
  if (!sql) {
    throw new Error(
      "Shop catalog database is unavailable: DATABASE_URL is not configured.",
    );
  }

  return sql;
}

export async function ensureShopCatalogSchema() {
  const db = requireSql();

  await db`
    CREATE TABLE IF NOT EXISTS shop_catalog_categories (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      emoji TEXT,
      description TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS shop_catalog_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      popular_name TEXT,
      category TEXT NOT NULL DEFAULT 'misc',
      price INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      image_url TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      max_per_restart INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`
    CREATE INDEX IF NOT EXISTS shop_catalog_items_category_idx
    ON shop_catalog_items (category)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS shop_catalog_items_enabled_idx
    ON shop_catalog_items (enabled)
  `;
}

function rowToCategory(row: any): ShopCategory {
  const id = normalizeShopCatalogId(row.id || "misc") || "misc";

  return {
    id,
    label: String(row.label || labelFromId(id)).trim(),
    emoji: row.emoji ? String(row.emoji).trim() : undefined,
    description: row.description ? String(row.description).trim() : undefined,
    enabled: row.enabled !== false,
  };
}

function rowToItem(row: any): ShopItem {
  const id = normalizeShopCatalogId(row.id || row.name || row.class_name);
  const category = normalizeShopCatalogId(row.category || "misc") || "misc";

  return {
    id,
    name: String(row.name || row.class_name || id).trim(),
    className: String(row.class_name || row.className || "").trim(),
    popularName: row.popular_name ? String(row.popular_name).trim() : undefined,
    category,
    price: Math.max(0, Math.floor(Number(row.price || 0))),
    description: row.description ? String(row.description).trim() : undefined,
    imageUrl: row.image_url ? String(row.image_url).trim() : undefined,
    enabled: row.enabled !== false,
    maxPerRestart: Number.isFinite(Number(row.max_per_restart))
      ? Number(row.max_per_restart)
      : undefined,
  };
}

function normalizeCatalog(catalog: ShopCatalog): ShopCatalog {
  const items = (catalog.items || [])
    .filter((item) => item?.id && item?.className && item?.name)
    .map((item) => ({
      ...item,
      id: normalizeShopCatalogId(item.id),
      name: String(item.name || item.className).trim(),
      className: String(item.className || "").trim(),
      popularName: item.popularName ? String(item.popularName).trim() : undefined,
      category: normalizeShopCatalogId(item.category || "misc") || "misc",
      price: Math.max(0, Math.floor(Number(item.price || 0))),
      enabled: item.enabled !== false,
      description: item.description ? String(item.description).trim() : undefined,
      imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
      maxPerRestart: Number.isFinite(Number(item.maxPerRestart))
        ? Number(item.maxPerRestart)
        : undefined,
    }));

  const categories = (catalog.categories || [])
    .filter((category) => category?.id && category?.label)
    .map((category) => ({
      ...category,
      id: normalizeShopCatalogId(category.id) || "misc",
      label: String(category.label || labelFromId(category.id)).trim(),
      enabled: category.enabled !== false,
      emoji: category.emoji ? String(category.emoji).trim() : undefined,
      description: category.description ? String(category.description).trim() : undefined,
    }));

  const categoryIds = new Set(categories.map((category) => category.id));
  for (const item of items) {
    if (categoryIds.has(item.category || "misc")) continue;

    const categoryId = item.category || "misc";
    categories.push({
      id: categoryId,
      label: labelFromId(categoryId),
      enabled: true,
      emoji: undefined,
      description: undefined,
    });
    categoryIds.add(categoryId);
  }

  return {
    version: Number(catalog.version || CATALOG_VERSION),
    categories: categories.sort((a, b) => a.label.localeCompare(b.label)),
    items: items.sort(
      (a, b) =>
        String(a.category || "misc").localeCompare(String(b.category || "misc")) ||
        a.name.localeCompare(b.name),
    ),
  };
}

export async function loadShopCatalogFromDatabase(): Promise<ShopCatalog> {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const [categoryRows, itemRows] = await Promise.all([
    db`
      SELECT id, label, emoji, description, enabled, sort_order, created_at, updated_at
      FROM shop_catalog_categories
      ORDER BY sort_order ASC, label ASC
    `,
    db`
      SELECT id, name, class_name, popular_name, category, price, description, image_url,
             enabled, max_per_restart, sort_order, created_at, updated_at
      FROM shop_catalog_items
      ORDER BY sort_order ASC, category ASC, name ASC
    `,
  ]);

  if (!itemRows.length) {
    throw new Error(
      "Shop catalog is empty in Neon. Seed shop_catalog_items before enabling the shop.",
    );
  }

  return normalizeCatalog({
    version: CATALOG_VERSION,
    categories: categoryRows.map(rowToCategory),
    items: itemRows.map(rowToItem),
  });
}

export async function refreshShopCatalogCache() {
  const catalog = await loadShopCatalogFromDatabase();
  cachedCatalog = catalog;
  initialized = true;
  return catalog;
}

export async function initializeShopCatalogCache() {
  if (initializingPromise) return initializingPromise;

  initializingPromise = refreshShopCatalogCache().finally(() => {
    initializingPromise = null;
  });

  return initializingPromise;
}

export function getCachedShopCatalog() {
  if (!initialized || !cachedCatalog) {
    throw new Error(
      "Shop catalog is not loaded. Check DATABASE_URL and seed the Neon shop catalog.",
    );
  }

  return cachedCatalog;
}

export function isShopCatalogLoaded() {
  return Boolean(initialized && cachedCatalog);
}

export async function upsertShopCatalogCategory(category: ShopCategory) {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const id = normalizeShopCatalogId(category.id || category.label);
  if (!id) throw new Error("Category requires an id.");

  await db`
    INSERT INTO shop_catalog_categories (id, label, emoji, description, enabled, updated_at)
    VALUES (
      ${id},
      ${String(category.label || labelFromId(id)).trim()},
      ${category.emoji || null},
      ${category.description || null},
      ${category.enabled !== false},
      NOW()
    )
    ON CONFLICT (id)
    DO UPDATE SET
      label = EXCLUDED.label,
      emoji = EXCLUDED.emoji,
      description = EXCLUDED.description,
      enabled = EXCLUDED.enabled,
      updated_at = NOW()
  `;
}


export async function deleteShopCatalogCategoryFromDatabase(categoryId: string) {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const normalized = normalizeShopCatalogId(categoryId);
  if (!normalized) return false;

  const itemRows = await db`
    SELECT id
    FROM shop_catalog_items
    WHERE category = ${normalized}
    LIMIT 1
  `;

  if (itemRows.length) {
    throw new Error("Category still has items. Move or delete the items before deleting the category.");
  }

  const result = await db`
    DELETE FROM shop_catalog_categories
    WHERE id = ${normalized}
    RETURNING id
  `;

  await refreshShopCatalogCache();
  return result.length > 0;
}

export async function upsertShopCatalogItemInDatabase(item: ShopItem) {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const normalized: ShopItem = {
    ...item,
    id: normalizeShopCatalogId(item.id || item.name || item.className),
    name: String(item.name || item.className).trim(),
    className: String(item.className || "").trim(),
    popularName: item.popularName ? String(item.popularName).trim() : undefined,
    category: normalizeShopCatalogId(item.category || "misc") || "misc",
    price: Math.max(0, Math.floor(Number(item.price || 0))),
    enabled: item.enabled !== false,
    description: item.description ? String(item.description).trim() : undefined,
    imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
    maxPerRestart: Number.isFinite(Number(item.maxPerRestart))
      ? Number(item.maxPerRestart)
      : undefined,
  };

  if (!normalized.id || !normalized.className || !normalized.name) {
    throw new Error("Catalog item requires id, className and name.");
  }

  await upsertShopCatalogCategory({
    id: normalized.category || "misc",
    label: labelFromId(normalized.category || "misc"),
    enabled: true,
  });

  await db`
    INSERT INTO shop_catalog_items (
      id, name, class_name, popular_name, category, price, description, image_url,
      enabled, max_per_restart, updated_at
    )
    VALUES (
      ${normalized.id},
      ${normalized.name},
      ${normalized.className},
      ${normalized.popularName || null},
      ${normalized.category || "misc"},
      ${normalized.price},
      ${normalized.description || null},
      ${normalized.imageUrl || null},
      ${normalized.enabled !== false},
      ${normalized.maxPerRestart ?? null},
      NOW()
    )
    ON CONFLICT (id)
    DO UPDATE SET
      name = EXCLUDED.name,
      class_name = EXCLUDED.class_name,
      popular_name = EXCLUDED.popular_name,
      category = EXCLUDED.category,
      price = EXCLUDED.price,
      description = EXCLUDED.description,
      image_url = EXCLUDED.image_url,
      enabled = EXCLUDED.enabled,
      max_per_restart = EXCLUDED.max_per_restart,
      updated_at = NOW()
  `;

  await refreshShopCatalogCache();
  return normalized;
}

export async function deleteShopCatalogItemFromDatabase(itemId: string) {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const normalized = normalizeShopCatalogId(itemId);
  if (!normalized) return false;

  const result = await db`
    DELETE FROM shop_catalog_items
    WHERE id = ${normalized}
    RETURNING id
  `;

  await refreshShopCatalogCache();
  return result.length > 0;
}

export async function toggleShopCatalogItemInDatabase(itemId: string, enabled?: boolean) {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const normalized = normalizeShopCatalogId(itemId);
  if (!normalized) return null;

  const currentRows = await db`
    SELECT enabled
    FROM shop_catalog_items
    WHERE id = ${normalized}
    LIMIT 1
  `;

  if (!currentRows.length) return null;

  const nextEnabled = typeof enabled === "boolean" ? enabled : currentRows[0].enabled === false;

  const rows = await db`
    UPDATE shop_catalog_items
    SET enabled = ${nextEnabled}, updated_at = NOW()
    WHERE id = ${normalized}
    RETURNING id, name, class_name, popular_name, category, price, description, image_url,
              enabled, max_per_restart
  `;

  await refreshShopCatalogCache();
  return rows[0] ? rowToItem(rows[0]) : null;
}

export async function seedShopCatalogInDatabase(catalog: ShopCatalog, options?: { replace?: boolean }) {
  const db = requireSql();
  await ensureShopCatalogSchema();

  const normalized = normalizeCatalog(catalog);

  if (options?.replace) {
    await db`DELETE FROM shop_catalog_items`;
    await db`DELETE FROM shop_catalog_categories`;
  }

  for (const category of normalized.categories) {
    await upsertShopCatalogCategory(category);
  }

  for (const item of normalized.items) {
    await upsertShopCatalogItemInDatabase(item);
  }

  cachedCatalog = normalized;
  initialized = true;

  return {
    categories: normalized.categories.length,
    items: normalized.items.length,
    seededAt: nowIso(),
  };
}
