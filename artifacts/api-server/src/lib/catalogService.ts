import postgres from "postgres";
import type { ShopCatalog, ShopCategory, ShopDeliveryKind, ShopItem, ShopKit, ShopKitItem } from "./shopCatalog";
import { getActiveServerId } from "./serverRuntime";
import { getManagedServerById, getPrimaryServerId } from "./serverRegistry";
import { getDzPageItem } from "./dzpageService";

const CATALOG_VERSION = 1;
const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 })
  : null;

const cachedCatalogs = new Map<string, ShopCatalog>();
const initializingPromises = new Map<string, Promise<ShopCatalog>>();
let schemaPromise: Promise<void> | null = null;

function nowIso() { return new Date().toISOString(); }
function currentServerId() { return getActiveServerId(); }

function normalizeShopCatalogId(value: string) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function labelFromId(value: string) {
  return String(value || "Misc").split(/[_-]+/g).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Misc";
}

function getDeliveryKindFromSpawnEventName(spawnEventName: string | undefined): ShopDeliveryKind {
  return String(spawnEventName || "").trim().startsWith("Vehicle") ? "vehicle" : "item";
}

function requireSql() {
  if (!sql) throw new Error("Shop catalog database is unavailable: DATABASE_URL is not configured.");
  return sql;
}

export async function ensureShopCatalogSchema() {
  if (schemaPromise) return schemaPromise;
  const db = requireSql();
  schemaPromise = (async () => {
    await db`
      CREATE TABLE IF NOT EXISTS shop_catalog_categories (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, emoji TEXT, description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS shop_catalog_items (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, class_name TEXT NOT NULL, popular_name TEXT,
        category TEXT NOT NULL DEFAULT 'misc', price INTEGER NOT NULL DEFAULT 0,
        description TEXT, image_url TEXT, enabled BOOLEAN NOT NULL DEFAULT true,
        max_per_restart INTEGER, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS server_shop_catalog_categories (
        server_id TEXT NOT NULL,
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        emoji TEXT,
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (server_id, id)
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS server_shop_catalog_items (
        server_id TEXT NOT NULL,
        id TEXT NOT NULL,
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (server_id, id)
      )
    `;
    await db`CREATE INDEX IF NOT EXISTS server_shop_catalog_items_category_idx ON server_shop_catalog_items (server_id, category)`;
    await db`CREATE INDEX IF NOT EXISTS server_shop_catalog_items_enabled_idx ON server_shop_catalog_items (server_id, enabled)`;
    await db`
      CREATE TABLE IF NOT EXISTS server_shop_catalog_kits (
        server_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'kits',
        price INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        image_url TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (server_id, id)
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS server_shop_catalog_kit_items (
        server_id TEXT NOT NULL,
        kit_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, kit_id, item_id),
        FOREIGN KEY (server_id, kit_id) REFERENCES server_shop_catalog_kits(server_id, id) ON DELETE CASCADE,
        FOREIGN KEY (server_id, item_id) REFERENCES server_shop_catalog_items(server_id, id) ON DELETE RESTRICT
      )
    `;
    await db`CREATE INDEX IF NOT EXISTS server_shop_catalog_kits_category_idx ON server_shop_catalog_kits (server_id, category)`;
    await db`CREATE INDEX IF NOT EXISTS server_shop_catalog_kit_items_kit_idx ON server_shop_catalog_kit_items (server_id, kit_id)`;
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}


async function countServerCatalogItems(serverId: string) {
  const db = requireSql();
  const rows = await db`SELECT COUNT(*)::int AS count FROM server_shop_catalog_items WHERE server_id = ${serverId}`;
  return Number((rows as any[])[0]?.count || 0);
}

async function seedServerCatalogIfNeeded(serverId: string) {
  const db = requireSql();
  await ensureShopCatalogSchema();
  const primaryServerId = getPrimaryServerId();
  if (serverId !== primaryServerId) return;
  if (await countServerCatalogItems(serverId)) return;
  await db.begin(async (tx) => {
    await tx`INSERT INTO server_shop_catalog_categories (server_id, id, label, emoji, description, enabled, sort_order, created_at, updated_at)
      SELECT ${serverId}, id, label, emoji, description, enabled, sort_order, created_at, updated_at FROM shop_catalog_categories
      ON CONFLICT (server_id, id) DO NOTHING`;
    await tx`INSERT INTO server_shop_catalog_items (server_id, id, name, class_name, popular_name, category, price, description, image_url, enabled, max_per_restart, sort_order, created_at, updated_at)
      SELECT ${serverId}, id, name, class_name, popular_name, category, price, description, image_url, enabled, max_per_restart, sort_order, created_at, updated_at FROM shop_catalog_items
      ON CONFLICT (server_id, id) DO NOTHING`;
  });
}

function rowToCategory(row: any): ShopCategory {
  const id = normalizeShopCatalogId(row.id || "misc") || "misc";
  return { id, label: String(row.label || labelFromId(id)).trim(), emoji: row.emoji ? String(row.emoji).trim() : undefined,
    description: row.description ? String(row.description).trim() : undefined, enabled: row.enabled !== false,
    sortOrder: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0 };
}

function rowToItem(row: any): ShopItem {
  const id = normalizeShopCatalogId(row.id || row.name || row.class_name);
  const category = normalizeShopCatalogId(row.category || "misc") || "misc";
  const spawnEventName = row.spawn_event_name ? String(row.spawn_event_name).trim() : undefined;
  return { id, name: String(row.name || row.class_name || id).trim(), className: String(row.class_name || row.className || "").trim(),
    popularName: row.popular_name ? String(row.popular_name).trim() : undefined, category,
    price: Math.max(0, Math.floor(Number(row.price || 0))), description: row.description ? String(row.description).trim() : undefined,
    imageUrl: row.image_url ? String(row.image_url).trim() : undefined, enabled: row.enabled !== false,
    maxPerRestart: Number.isFinite(Number(row.max_per_restart)) ? Number(row.max_per_restart) : undefined,
    ...(spawnEventName ? { spawnEventName } : {}), deliveryKind: getDeliveryKindFromSpawnEventName(spawnEventName),
    sortOrder: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0 };
}

async function hydrateCatalogItemsFromDzPage(items: ShopItem[]) {
  const results = await Promise.all(items.map(async (item) => {
    try {
      const dzItem = await getDzPageItem(item.className);
      return {
        ...item,
        name: dzItem.name || item.name,
        popularName: item.popularName || dzItem.name || item.name,
        imageUrl: dzItem.iconUrl || item.imageUrl,
      } as ShopItem;
    } catch {
      return item;
    }
  }));
  return results;
}

function normalizeCatalog(catalog: ShopCatalog): ShopCatalog {
  const kits: ShopKit[] = (catalog.kits || []).filter((kit) => kit?.id && kit?.name).map((kit, index) => ({
    ...kit,
    id: normalizeShopCatalogId(kit.id),
    name: String(kit.name).trim(),
    category: normalizeShopCatalogId(kit.category || "kits") || "kits",
    price: Math.max(0, Math.floor(Number(kit.price || 0))),
    enabled: kit.enabled !== false,
    sortOrder: Number.isFinite(Number(kit.sortOrder)) ? Number(kit.sortOrder) : index,
    items: (kit.items || []).filter((item) => item?.className).map((item) => ({
      className: String(item.className).trim(),
      name: item.name ? String(item.name).trim() : undefined,
      quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
    })),
  }));

  const items: ShopItem[] = (catalog.items || []).filter((item) => item?.id && item?.className && item?.name).map((item, index) => ({
    ...item, id: normalizeShopCatalogId(item.id), name: String(item.name || item.className).trim(), className: String(item.className || "").trim(),
    popularName: item.popularName ? String(item.popularName).trim() : undefined, category: normalizeShopCatalogId(item.category || "misc") || "misc",
    price: Math.max(0, Math.floor(Number(item.price || 0))), enabled: item.enabled !== false,
    description: item.description ? String(item.description).trim() : undefined, imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
    spawnEventName: item.spawnEventName ? String(item.spawnEventName).trim() : undefined, deliveryKind: getDeliveryKindFromSpawnEventName(item.spawnEventName),
    maxPerRestart: Number.isFinite(Number(item.maxPerRestart)) ? Number(item.maxPerRestart) : undefined,
    sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
  }));
  const categories: ShopCategory[] = (catalog.categories || []).filter((category) => category?.id && category?.label).map((category, index) => ({
    ...category, id: normalizeShopCatalogId(category.id) || "misc", label: String(category.label || labelFromId(category.id)).trim(), enabled: category.enabled !== false,
    emoji: category.emoji ? String(category.emoji).trim() : undefined, description: category.description ? String(category.description).trim() : undefined,
    sortOrder: Number.isFinite(Number(category.sortOrder)) ? Number(category.sortOrder) : index,
  }));
  const categoryIds = new Set(categories.map((category) => category.id));
  for (const item of items) { const categoryId = item.category || "misc"; if (categoryIds.has(categoryId)) continue;
    categories.push({ id: categoryId, label: labelFromId(categoryId), enabled: true, sortOrder: categories.length }); categoryIds.add(categoryId); }
  return { version: Number(catalog.version || CATALOG_VERSION),
    categories: categories.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.label.localeCompare(b.label)),
    items: items.sort((a, b) => String(a.category || "misc").localeCompare(String(b.category || "misc")) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)),
    kits: kits.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)) };
}

export async function loadShopCatalogFromDatabase(): Promise<ShopCatalog> {
  const db = requireSql();
  const serverId = currentServerId();
  await seedServerCatalogIfNeeded(serverId);
  const [categoryRows, itemRows, kitRows] = await Promise.all([
    db`SELECT id, label, emoji, description, enabled, sort_order, created_at, updated_at FROM server_shop_catalog_categories WHERE server_id = ${serverId} ORDER BY sort_order ASC, label ASC`,
    db`SELECT item.id, item.name, item.class_name, item.popular_name, item.category, item.price, item.description, item.image_url, item.enabled,
              item.max_per_restart, item.sort_order, item.created_at, item.updated_at
       FROM server_shop_catalog_items AS item WHERE item.server_id = ${serverId}
       ORDER BY item.category ASC, item.sort_order ASC, item.name ASC`,
    db`SELECT id, name, category, price, description, image_url, enabled, sort_order
       FROM server_shop_catalog_kits WHERE server_id = ${serverId}
       ORDER BY sort_order ASC, name ASC`,
  ]);
  const baseItems = itemRows.map(rowToItem);
  const hydratedItems = await hydrateCatalogItemsFromDzPage(baseItems);
  const kits = await Promise.all(kitRows.map(async (row: any) => {
    const rows = await db`SELECT kit_item.item_id, kit_item.quantity, kit_item.sort_order,
             catalog_item.class_name, catalog_item.name
      FROM server_shop_catalog_kit_items AS kit_item
      INNER JOIN server_shop_catalog_items AS catalog_item
        ON catalog_item.server_id = kit_item.server_id AND catalog_item.id = kit_item.item_id
      WHERE kit_item.server_id = ${serverId} AND kit_item.kit_id = ${row.id}
      ORDER BY kit_item.sort_order ASC, catalog_item.class_name ASC`;
    return {
      id: normalizeShopCatalogId(row.id),
      name: String(row.name || row.id).trim(),
      category: normalizeShopCatalogId(row.category || "kits") || "kits",
      price: Math.max(0, Math.floor(Number(row.price || 0))),
      description: row.description ? String(row.description).trim() : undefined,
      imageUrl: row.image_url ? String(row.image_url).trim() : undefined,
      enabled: row.enabled !== false,
      sortOrder: Number(row.sort_order || 0),
      items: rows.map((item: any) => ({
        className: String(item.class_name || "").trim(),
        name: item.name ? String(item.name).trim() : undefined,
        quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
      })).filter((item: ShopKitItem) => item.className),
    } as ShopKit;
  }));
  return normalizeCatalog({ version: CATALOG_VERSION, categories: categoryRows.map(rowToCategory), items: hydratedItems, kits });
}

export async function refreshShopCatalogCache() {
  const serverId = currentServerId();
  const catalog = await loadShopCatalogFromDatabase();
  cachedCatalogs.set(serverId, catalog);
  return catalog;
}

export async function initializeShopCatalogCache() {
  const serverId = currentServerId();
  const pending = initializingPromises.get(serverId);
  if (pending) return pending;
  const next = refreshShopCatalogCache().finally(() => initializingPromises.delete(serverId));
  initializingPromises.set(serverId, next);
  return next;
}

export function getCachedShopCatalog() {
  const serverId = currentServerId();
  const catalog = cachedCatalogs.get(serverId);
  if (!catalog) throw new Error(`Shop catalog is not loaded for server ${serverId}.`);
  return catalog;
}

export function isShopCatalogLoaded() { return cachedCatalogs.has(currentServerId()); }

export async function upsertShopCatalogCategory(category: ShopCategory) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId);
  const id = normalizeShopCatalogId(category.id || category.label); if (!id) throw new Error("Category requires an id.");
  const sortOrder = Number.isFinite(Number(category.sortOrder)) ? Math.floor(Number(category.sortOrder)) : null;
  await db`INSERT INTO server_shop_catalog_categories (server_id, id, label, emoji, description, enabled, sort_order, updated_at)
    VALUES (${serverId}, ${id}, ${String(category.label || labelFromId(id)).trim()}, ${category.emoji || null}, ${category.description || null}, ${category.enabled !== false}, ${sortOrder ?? 0}, NOW())
    ON CONFLICT (server_id, id) DO UPDATE SET label = EXCLUDED.label, emoji = EXCLUDED.emoji, description = EXCLUDED.description, enabled = EXCLUDED.enabled,
      sort_order = COALESCE(${sortOrder}, server_shop_catalog_categories.sort_order), updated_at = NOW()`;
}

export async function deleteShopCatalogCategoryFromDatabase(categoryId: string) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId); const normalized = normalizeShopCatalogId(categoryId); if (!normalized) return false;
  const itemRows = await db`SELECT id FROM server_shop_catalog_items WHERE server_id = ${serverId} AND category = ${normalized} LIMIT 1`;
  if (itemRows.length) throw new Error("Category still has items. Move or delete the items before deleting the category.");
  const result = await db`DELETE FROM server_shop_catalog_categories WHERE server_id = ${serverId} AND id = ${normalized} RETURNING id`;
  await refreshShopCatalogCache(); return result.length > 0;
}

export async function upsertShopCatalogItemInDatabase(item: ShopItem) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId);
  const normalized: ShopItem = { ...item, id: normalizeShopCatalogId(item.id || item.name || item.className), name: String(item.name || item.className).trim(),
    className: String(item.className || "").trim(), popularName: item.popularName ? String(item.popularName).trim() : undefined,
    category: normalizeShopCatalogId(item.category || "misc") || "misc", price: Math.max(0, Math.floor(Number(item.price || 0))), enabled: item.enabled !== false,
    description: item.description ? String(item.description).trim() : undefined, imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
    spawnEventName: item.spawnEventName ? String(item.spawnEventName).trim() : undefined, deliveryKind: getDeliveryKindFromSpawnEventName(item.spawnEventName),
    maxPerRestart: Number.isFinite(Number(item.maxPerRestart)) ? Math.floor(Number(item.maxPerRestart)) : undefined,
    sortOrder: Number.isFinite(Number(item.sortOrder)) ? Math.floor(Number(item.sortOrder)) : undefined };
  if (!normalized.id || !normalized.className || !normalized.name) throw new Error("Catalog item requires id, className and name.");
  await upsertShopCatalogCategory({ id: normalized.category || "misc", label: labelFromId(normalized.category || "misc"), enabled: true });
  await db`INSERT INTO server_shop_catalog_items (server_id, id, name, class_name, popular_name, category, price, description, image_url, enabled, max_per_restart, sort_order, updated_at)
    VALUES (${serverId}, ${normalized.id}, ${normalized.name}, ${normalized.className}, ${normalized.popularName || null}, ${normalized.category || "misc"}, ${normalized.price}, ${normalized.description || null}, ${normalized.imageUrl || null}, ${normalized.enabled !== false}, ${normalized.maxPerRestart ?? null}, ${normalized.sortOrder ?? 0}, NOW())
    ON CONFLICT (server_id, id) DO UPDATE SET name = EXCLUDED.name, class_name = EXCLUDED.class_name, popular_name = EXCLUDED.popular_name, category = EXCLUDED.category,
      price = EXCLUDED.price, description = EXCLUDED.description, image_url = EXCLUDED.image_url, enabled = EXCLUDED.enabled, max_per_restart = EXCLUDED.max_per_restart,
      sort_order = COALESCE(${normalized.sortOrder ?? null}, server_shop_catalog_items.sort_order), updated_at = NOW()`;
  await refreshShopCatalogCache(); return normalized;
}

export async function deleteShopCatalogItemFromDatabase(itemId: string) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId); const normalized = normalizeShopCatalogId(itemId); if (!normalized) return false;
  const result = await db`DELETE FROM server_shop_catalog_items WHERE server_id = ${serverId} AND id = ${normalized} RETURNING id`; await refreshShopCatalogCache(); return result.length > 0;
}

export async function toggleShopCatalogItemInDatabase(itemId: string, enabled?: boolean) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId); const normalized = normalizeShopCatalogId(itemId); if (!normalized) return null;
  const currentRows = await db`SELECT enabled FROM server_shop_catalog_items WHERE server_id = ${serverId} AND id = ${normalized} LIMIT 1`; if (!currentRows.length) return null;
  const nextEnabled = typeof enabled === "boolean" ? enabled : currentRows[0].enabled === false;
  const rows = await db`UPDATE server_shop_catalog_items SET enabled = ${nextEnabled}, updated_at = NOW() WHERE server_id = ${serverId} AND id = ${normalized}
    RETURNING id, name, class_name, popular_name, category, price, description, image_url, enabled, max_per_restart, sort_order`;
  await refreshShopCatalogCache(); return rows[0] ? rowToItem(rows[0]) : null;
}


export async function upsertShopKitInDatabase(kit: ShopKit) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId);
  const id = normalizeShopCatalogId(kit.id || kit.name); if (!id) throw new Error("Kit requires an id.");
  const items = (kit.items || []).filter((item) => item?.className).map((item, index) => ({
    className: String(item.className).trim(),
    quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
    sortOrder: index,
  }));
  if (!items.length) throw new Error("Kit requires at least one item.");
  await db.begin(async (tx) => {
    await tx`INSERT INTO server_shop_catalog_kits (server_id, id, name, category, price, description, image_url, enabled, sort_order, updated_at)
      VALUES (${serverId}, ${id}, ${String(kit.name || id).trim()}, ${normalizeShopCatalogId(kit.category || "kits") || "kits"}, ${Math.max(0, Math.floor(Number(kit.price || 0)))}, ${kit.description || null}, ${kit.imageUrl || null}, ${kit.enabled !== false}, ${Number.isFinite(Number(kit.sortOrder)) ? Math.floor(Number(kit.sortOrder)) : 0}, NOW())
      ON CONFLICT (server_id, id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, price=EXCLUDED.price, description=EXCLUDED.description, image_url=EXCLUDED.image_url, enabled=EXCLUDED.enabled, sort_order=EXCLUDED.sort_order, updated_at=NOW()`;
    await tx`DELETE FROM server_shop_catalog_kit_items WHERE server_id=${serverId} AND kit_id=${id}`;
    for (const item of items) {
      const catalogRows = await tx`SELECT id FROM server_shop_catalog_items
        WHERE server_id=${serverId} AND class_name=${item.className} LIMIT 1`;
      if (!catalogRows.length) throw new Error(`Item "${item.className}" não está cadastrado no catálogo deste servidor.`);
      await tx`INSERT INTO server_shop_catalog_kit_items (server_id, kit_id, item_id, quantity, sort_order)
        VALUES (${serverId}, ${id}, ${catalogRows[0].id}, ${item.quantity}, ${item.sortOrder})`;
    }
  });
  await refreshShopCatalogCache();
  return (getCachedShopCatalog().kits || []).find((entry) => entry.id === id) || null;
}

export async function deleteShopKitFromDatabase(kitId: string) {
  const db = requireSql(); const serverId = currentServerId(); const id = normalizeShopCatalogId(kitId);
  if (!id) return false;
  const result = await db`DELETE FROM server_shop_catalog_kits WHERE server_id=${serverId} AND id=${id} RETURNING id`;
  await db`DELETE FROM server_shop_catalog_kit_items WHERE server_id=${serverId} AND kit_id=${id}`;
  await refreshShopCatalogCache();
  return result.length > 0;
}

export async function toggleShopKitInDatabase(kitId: string, enabled?: boolean) {
  const db = requireSql(); const serverId = currentServerId(); const id = normalizeShopCatalogId(kitId);
  const rows = await db`SELECT enabled FROM server_shop_catalog_kits WHERE server_id=${serverId} AND id=${id}`;
  if (!rows.length) return null;
  const next = typeof enabled === "boolean" ? enabled : rows[0].enabled === false;
  await db`UPDATE server_shop_catalog_kits SET enabled=${next}, updated_at=NOW() WHERE server_id=${serverId} AND id=${id}`;
  await refreshShopCatalogCache();
  return (getCachedShopCatalog().kits || []).find((entry) => entry.id === id) || null;
}

export async function reorderShopCatalogCategories(categoryIds: string[]) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId); const normalizedIds = categoryIds.map(normalizeShopCatalogId).filter(Boolean);
  await db.begin(async (tx) => { for (let index = 0; index < normalizedIds.length; index += 1) await tx`UPDATE server_shop_catalog_categories SET sort_order = ${index}, updated_at = NOW() WHERE server_id = ${serverId} AND id = ${normalizedIds[index]}`; });
  return refreshShopCatalogCache();
}

export async function reorderShopCatalogItems(categoryId: string, itemIds: string[]) {
  const db = requireSql(); const serverId = currentServerId(); await seedServerCatalogIfNeeded(serverId); const normalizedCategoryId = normalizeShopCatalogId(categoryId || "misc") || "misc";
  const normalizedIds = itemIds.map(normalizeShopCatalogId).filter(Boolean);
  await db.begin(async (tx) => { for (let index = 0; index < normalizedIds.length; index += 1) await tx`UPDATE server_shop_catalog_items SET sort_order = ${index}, updated_at = NOW() WHERE server_id = ${serverId} AND id = ${normalizedIds[index]} AND category = ${normalizedCategoryId}`; });
  return refreshShopCatalogCache();
}

export async function seedShopCatalogInDatabase(catalog: ShopCatalog, options?: { replace?: boolean }) {
  const db = requireSql(); const serverId = currentServerId(); await ensureShopCatalogSchema(); const normalized = normalizeCatalog(catalog);
  if (options?.replace) { await db`DELETE FROM server_shop_catalog_kit_items WHERE server_id = ${serverId}`; await db`DELETE FROM server_shop_catalog_kits WHERE server_id = ${serverId}`; await db`DELETE FROM server_shop_catalog_items WHERE server_id = ${serverId}`; await db`DELETE FROM server_shop_catalog_categories WHERE server_id = ${serverId}`; }
  for (const category of normalized.categories) await upsertShopCatalogCategory(category);
  for (const item of normalized.items) await upsertShopCatalogItemInDatabase(item);
  cachedCatalogs.set(serverId, normalized); return { categories: normalized.categories.length, items: normalized.items.length, seededAt: nowIso(), serverId };
}

export async function cloneShopCatalogFromServer(sourceServerId: string, targetServerId = currentServerId()) {
  const db = requireSql(); await ensureShopCatalogSchema(); const sourceServer = getManagedServerById(sourceServerId); const targetServer = getManagedServerById(targetServerId);
  if (!sourceServer || !targetServer) throw new Error("Servidor de origem ou destino do catalogo nao encontrado.");
  if (sourceServer.organizationId !== targetServer.organizationId) throw new Error("Catalogos nao podem ser clonados entre organizacoes diferentes.");
  await seedServerCatalogIfNeeded(sourceServerId); if (sourceServerId === targetServerId) return refreshShopCatalogCache();
  await db.begin(async (tx) => {
    await tx`DELETE FROM server_shop_catalog_kit_items WHERE server_id = ${targetServerId}`;
    await tx`DELETE FROM server_shop_catalog_kits WHERE server_id = ${targetServerId}`;
    await tx`DELETE FROM server_shop_catalog_items WHERE server_id = ${targetServerId}`;
    await tx`DELETE FROM server_shop_catalog_categories WHERE server_id = ${targetServerId}`;
    await tx`INSERT INTO server_shop_catalog_categories (server_id, id, label, emoji, description, enabled, sort_order, created_at, updated_at)
      SELECT ${targetServerId}, id, label, emoji, description, enabled, sort_order, NOW(), NOW() FROM server_shop_catalog_categories WHERE server_id = ${sourceServerId}`;
    await tx`INSERT INTO server_shop_catalog_items (server_id, id, name, class_name, popular_name, category, price, description, image_url, enabled, max_per_restart, sort_order, created_at, updated_at)
      SELECT ${targetServerId}, id, name, class_name, popular_name, category, price, description, image_url, enabled, max_per_restart, sort_order, NOW(), NOW() FROM server_shop_catalog_items WHERE server_id = ${sourceServerId}`;
    await tx`INSERT INTO server_shop_catalog_kits (server_id, id, name, category, price, description, image_url, enabled, sort_order, created_at, updated_at)
      SELECT ${targetServerId}, id, name, category, price, description, image_url, enabled, sort_order, NOW(), NOW() FROM server_shop_catalog_kits WHERE server_id = ${sourceServerId}`;
    await tx`INSERT INTO server_shop_catalog_kit_items (server_id, kit_id, class_name, name, quantity, sort_order)
      SELECT ${targetServerId}, kit_id, class_name, name, quantity, sort_order FROM server_shop_catalog_kit_items WHERE server_id = ${sourceServerId}`;
  });
  cachedCatalogs.delete(targetServerId); return { sourceServerId, targetServerId };
}

export function getShopCatalogIsolationDiagnostics() {
  return { phase: 17, cacheModel: "per-server" as const, tableModel: "server-scoped" as const, loadedServers: [...cachedCatalogs.keys()], legacyTablesReadOnlyMigrationSource: true };
}
