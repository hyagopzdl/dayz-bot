import postgres from "postgres";

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 })
  : null;

const CACHE_TTL_MS = 5 * 60 * 1000;
let schemaPromise: Promise<void> | null = null;
let cache: { expiresAt: number; values: Map<string, string> } | null = null;
let loadingPromise: Promise<Map<string, string>> | null = null;

function requireSql() {
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  return sql;
}

function normalizeClassName(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function isSystemOwner(adminUserId: unknown) {
  const configured = String(process.env.SYSTEM_OWNER_ADMIN_USER_ID || "").trim();
  return Boolean(configured && String(adminUserId || "").trim() === configured);
}

export async function ensureDayzItemOverridesSchema() {
  if (schemaPromise) return schemaPromise;
  const db = requireSql();
  schemaPromise = db`
    CREATE TABLE IF NOT EXISTS dayz_item_overrides (
      class_name TEXT PRIMARY KEY,
      image_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.then(() => undefined).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function loadOverrides(force = false) {
  await ensureDayzItemOverridesSchema();
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) return cache.values;
  if (loadingPromise) return loadingPromise;

  const db = requireSql();
  loadingPromise = (async () => {
    const rows = await db`
      SELECT class_name, image_url
      FROM dayz_item_overrides
      WHERE image_url IS NOT NULL AND BTRIM(image_url) <> ''
    `;
    const values = new Map<string, string>();
    for (const row of rows) {
      const key = normalizeClassName(row.class_name);
      const imageUrl = String(row.image_url || "").trim();
      if (key && imageUrl) values.set(key, imageUrl);
    }
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, values };
    return values;
  })().finally(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

export async function getDayzItemImageOverrides() {
  return loadOverrides();
}

export async function setDayzItemImageOverride(className: string, imageUrl: string | null) {
  await ensureDayzItemOverridesSchema();
  const db = requireSql();
  const normalizedClassName = String(className || "").trim();
  if (!normalizedClassName) throw new Error("className is required.");

  const normalizedImageUrl = String(imageUrl || "").trim();
  if (!normalizedImageUrl) {
    await db`
      DELETE FROM dayz_item_overrides
      WHERE LOWER(class_name) = LOWER(${normalizedClassName})
    `;
  } else {
    await db`
      INSERT INTO dayz_item_overrides (class_name, image_url, updated_at)
      VALUES (${normalizedClassName}, ${normalizedImageUrl}, NOW())
      ON CONFLICT (class_name) DO UPDATE SET
        image_url = EXCLUDED.image_url,
        updated_at = NOW()
    `;
  }

  cache = null;
  return normalizedImageUrl || null;
}

export async function listDayzItemImageOverrides() {
  const values = await loadOverrides();
  return [...values.entries()]
    .map(([className, imageUrl]) => ({ className, imageUrl }))
    .sort((a, b) => a.className.localeCompare(b.className));
}

export function clearDayzItemImageOverridesCache() {
  cache = null;
}
