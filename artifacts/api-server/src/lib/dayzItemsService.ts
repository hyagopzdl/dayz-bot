import postgres from "postgres";
import type { DayzItemDefinition } from "./dayzItemDatabase";

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      ssl: "require",
      max: 1,
    })
  : null;

export type DayzItemRecord = DayzItemDefinition & {
  imageUrl?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type DayzItemSearchOptions = {
  query?: string;
  limit?: number;
  enabledOnly?: boolean;
};

function requireSql() {
  if (!sql) {
    throw new Error("DayZ item database is unavailable: DATABASE_URL is not configured.");
  }

  return sql;
}

function normalizeClassName(value: string) {
  return String(value || "").trim();
}

function normalizeSearch(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rowToDayzItem(row: any): DayzItemRecord {
  return {
    className: String(row.class_name || "").trim(),
    popularName: String(row.popular_name || row.class_name || "").trim(),
    ...(row.image_url ? { imageUrl: String(row.image_url).trim() } : {}),
    ...(row.spawn_event_name ? { spawnEventName: String(row.spawn_event_name).trim() } : {}),
    enabled: row.enabled !== false,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

export function normalizeDayzItems(input: unknown): DayzItemRecord[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const items: DayzItemRecord[] = [];

  for (const raw of input) {
    const value = raw as Record<string, unknown>;
    const className = normalizeClassName(String(value.className || value.class_name || ""));
    if (!className) continue;

    const key = className.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const popularName = String(value.popularName || value.popular_name || className).trim();
    const imageUrl = String(value.imageUrl || value.image_url || value.urlImg || "").trim();
    const spawnEventName = String(value.spawnEventName || value.spawn_event_name || "").trim();
    const enabled = typeof value.enabled === "boolean" ? value.enabled : true;

    items.push({
      className,
      popularName: popularName || className,
      ...(imageUrl ? { imageUrl } : {}),
      ...(spawnEventName ? { spawnEventName } : {}),
      enabled,
    });
  }

  return items;
}

export async function ensureDayzItemsSchema() {
  const db = requireSql();

  await db`
    CREATE TABLE IF NOT EXISTS dayz_items (
      class_name TEXT PRIMARY KEY,
      popular_name TEXT NOT NULL,
      image_url TEXT,
      spawn_event_name TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`
    CREATE INDEX IF NOT EXISTS dayz_items_enabled_idx
    ON dayz_items (enabled)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS dayz_items_popular_name_idx
    ON dayz_items (popular_name)
  `;
}

export async function getDayzItemByClassName(className: string) {
  const db = requireSql();
  await ensureDayzItemsSchema();

  const normalized = normalizeClassName(className);
  if (!normalized) return null;

  const rows = await db`
    SELECT class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
    FROM dayz_items
    WHERE LOWER(class_name) = LOWER(${normalized})
    LIMIT 1
  `;

  return rows[0] ? rowToDayzItem(rows[0]) : null;
}

export async function searchDayzItemsFromDatabase(options: DayzItemSearchOptions = {}) {
  const db = requireSql();
  await ensureDayzItemsSchema();

  const query = String(options.query || "").trim();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit || 25))));
  const enabledOnly = options.enabledOnly !== false;

  if (!query) {
    const rows = enabledOnly
      ? await db`
          SELECT class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
          FROM dayz_items
          WHERE enabled = true
          ORDER BY popular_name ASC, class_name ASC
          LIMIT ${limit}
        `
      : await db`
          SELECT class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
          FROM dayz_items
          ORDER BY popular_name ASC, class_name ASC
          LIMIT ${limit}
        `;

    return rows.map(rowToDayzItem);
  }

  const normalized = normalizeSearch(query);
  const like = `%${normalized.replace(/\s+/g, "%")}%`;
  const rawLike = `%${query}%`;

  const rows = enabledOnly
    ? await db`
        SELECT class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
        FROM dayz_items
        WHERE enabled = true
          AND (
            LOWER(class_name) LIKE LOWER(${rawLike})
            OR LOWER(popular_name) LIKE LOWER(${rawLike})
            OR LOWER(REGEXP_REPLACE(class_name || ' ' || popular_name, '[^a-zA-Z0-9]+', ' ', 'g')) LIKE ${like}
          )
        ORDER BY
          CASE WHEN LOWER(class_name) = LOWER(${query}) THEN 0 ELSE 1 END,
          CASE WHEN LOWER(popular_name) = LOWER(${query}) THEN 0 ELSE 1 END,
          CASE WHEN LOWER(class_name) LIKE LOWER(${`${query}%`}) THEN 0 ELSE 1 END,
          popular_name ASC,
          class_name ASC
        LIMIT ${limit}
      `
    : await db`
        SELECT class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
        FROM dayz_items
        WHERE LOWER(class_name) LIKE LOWER(${rawLike})
           OR LOWER(popular_name) LIKE LOWER(${rawLike})
           OR LOWER(REGEXP_REPLACE(class_name || ' ' || popular_name, '[^a-zA-Z0-9]+', ' ', 'g')) LIKE ${like}
        ORDER BY
          CASE WHEN LOWER(class_name) = LOWER(${query}) THEN 0 ELSE 1 END,
          CASE WHEN LOWER(popular_name) = LOWER(${query}) THEN 0 ELSE 1 END,
          CASE WHEN LOWER(class_name) LIKE LOWER(${`${query}%`}) THEN 0 ELSE 1 END,
          popular_name ASC,
          class_name ASC
        LIMIT ${limit}
      `;

  return rows.map(rowToDayzItem);
}

export async function getDayzItemsPage(options: {
  query?: string;
  cursor?: number;
  limit?: number;
  filter?: "all" | "enabled" | "disabled" | "missing_image";
}) {
  const db = requireSql();
  await ensureDayzItemsSchema();

  const query = String(options.query || "").trim();
  const cursor = Math.max(0, Math.floor(Number(options.cursor || 0)));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit || 30))));
  const filter = options.filter || "all";
  const rawLike = `%${query}%`;

  const whereParts: string[] = [];
  if (filter === "enabled") whereParts.push("enabled = true");
  if (filter === "disabled") whereParts.push("enabled = false");
  if (filter === "missing_image") whereParts.push("(image_url IS NULL OR image_url = '' OR image_url LIKE '%img-placeholder.png%')");

  const queryFilter = query
    ? db`(LOWER(class_name) LIKE LOWER(${rawLike}) OR LOWER(popular_name) LIKE LOWER(${rawLike}))`
    : db`true`;

  const enabledFilter = filter === "enabled"
    ? db`enabled = true`
    : filter === "disabled"
      ? db`enabled = false`
      : filter === "missing_image"
        ? db`(image_url IS NULL OR image_url = '' OR image_url LIKE '%img-placeholder.png%')`
        : db`true`;

  const [items, totalRows] = await Promise.all([
    db`
      SELECT class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
      FROM dayz_items
      WHERE ${queryFilter} AND ${enabledFilter}
      ORDER BY popular_name ASC, class_name ASC
      OFFSET ${cursor}
      LIMIT ${limit}
    `,
    db`
      SELECT COUNT(*)::int AS count
      FROM dayz_items
      WHERE ${queryFilter} AND ${enabledFilter}
    `,
  ]);

  const rows = items.map(rowToDayzItem);
  const total = Number(totalRows[0]?.count || 0);

  return {
    items: rows,
    total,
    nextCursor: cursor + rows.length,
    hasMore: cursor + rows.length < total,
  };
}

export async function updateDayzItemInDatabase(
  className: string,
  updates: Partial<Pick<DayzItemRecord, "popularName" | "imageUrl" | "spawnEventName" | "enabled">>,
) {
  const db = requireSql();
  await ensureDayzItemsSchema();

  const existing = await getDayzItemByClassName(className);
  if (!existing) return null;

  const popularName = String(updates.popularName ?? existing.popularName).trim() || existing.className;
  const imageUrl = updates.imageUrl === undefined ? existing.imageUrl || "" : String(updates.imageUrl || "").trim();
  const spawnEventName = updates.spawnEventName === undefined
    ? existing.spawnEventName || ""
    : String(updates.spawnEventName || "").trim();
  const enabled = typeof updates.enabled === "boolean" ? updates.enabled : existing.enabled !== false;

  const rows = await db`
    UPDATE dayz_items
    SET popular_name = ${popularName},
        image_url = ${imageUrl || null},
        spawn_event_name = ${spawnEventName || null},
        enabled = ${enabled},
        updated_at = NOW()
    WHERE LOWER(class_name) = LOWER(${className})
    RETURNING class_name, popular_name, image_url, spawn_event_name, enabled, created_at, updated_at
  `;

  return rows[0] ? rowToDayzItem(rows[0]) : null;
}

export async function toggleDayzItemInDatabase(className: string, enabled?: boolean) {
  const existing = await getDayzItemByClassName(className);
  if (!existing) return null;

  return updateDayzItemInDatabase(className, {
    enabled: typeof enabled === "boolean" ? enabled : !existing.enabled,
  });
}

export async function seedDayzItemsInDatabase(itemsInput: unknown, options?: { replace?: boolean }) {
  const db = requireSql();
  await ensureDayzItemsSchema();

  const items = normalizeDayzItems(itemsInput);
  if (!items.length) throw new Error("No DayZ items found to seed.");

  if (options?.replace) {
    await db`DELETE FROM dayz_items`;
  }

  for (const item of items) {
    await db`
      INSERT INTO dayz_items (class_name, popular_name, image_url, spawn_event_name, enabled, updated_at)
      VALUES (
        ${item.className},
        ${item.popularName},
        ${item.imageUrl || null},
        ${item.spawnEventName || null},
        ${item.enabled !== false},
        NOW()
      )
      ON CONFLICT (class_name)
      DO UPDATE SET
        popular_name = EXCLUDED.popular_name,
        image_url = EXCLUDED.image_url,
        spawn_event_name = EXCLUDED.spawn_event_name,
        enabled = dayz_items.enabled,
        updated_at = NOW()
    `;
  }

  const counts = await db`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE enabled = true)::int AS enabled,
      COUNT(*) FILTER (WHERE image_url IS NOT NULL AND image_url != '' AND image_url NOT LIKE '%img-placeholder.png%')::int AS with_images
    FROM dayz_items
  `;

  return {
    seeded: items.length,
    total: Number(counts[0]?.total || 0),
    enabled: Number(counts[0]?.enabled || 0),
    withImages: Number(counts[0]?.with_images || 0),
    seededAt: new Date().toISOString(),
  };
}
