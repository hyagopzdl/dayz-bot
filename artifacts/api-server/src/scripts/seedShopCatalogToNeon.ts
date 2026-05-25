import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { seedShopCatalog, type ShopCatalog, type ShopCategory, type ShopItem } from "../lib/shopCatalog";

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

function normalizeId(value: string) {
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

function normalizeCatalog(input: Partial<ShopCatalog> | ShopItem[]): ShopCatalog {
  const legacyItems: ShopItem[] | null = Array.isArray(input) ? input : null;
  const source: Partial<ShopCatalog> = Array.isArray(input) ? {} : input;
  const items: ShopItem[] = legacyItems ?? (Array.isArray(source.items) ? source.items : []);
  const categories: ShopCategory[] = Array.isArray(source.categories) ? source.categories : [];

  const safeItems = items
    .filter((item) => item?.id && item?.className && item?.name)
    .map((item, index) => ({
      ...item,
      id: normalizeId(item.id),
      name: String(item.name || item.className).trim(),
      className: String(item.className || "").trim(),
      popularName: item.popularName ? String(item.popularName).trim() : undefined,
      category: normalizeId(item.category || "misc") || "misc",
      price: Math.max(0, Math.floor(Number(item.price || 0))),
      enabled: item.enabled !== false,
      description: item.description ? String(item.description).trim() : undefined,
      imageUrl: item.imageUrl ? String(item.imageUrl).trim() : undefined,
      maxPerRestart: Number.isFinite(Number(item.maxPerRestart)) ? Number(item.maxPerRestart) : undefined,
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
    }));

  const safeCategories = categories
    .filter((category) => category?.id && category?.label)
    .map((category, index) => ({
      ...category,
      id: normalizeId(category.id) || "misc",
      label: String(category.label || labelFromId(category.id)).trim(),
      enabled: category.enabled !== false,
      emoji: category.emoji ? String(category.emoji).trim() : undefined,
      description: category.description ? String(category.description).trim() : undefined,
      sortOrder: Number.isFinite(Number(category.sortOrder)) ? Number(category.sortOrder) : index,
    }));

  const categoryIds = new Set(safeCategories.map((category) => category.id));
  for (const item of safeItems) {
    const categoryId = item.category || "misc";
    if (categoryIds.has(categoryId)) continue;
    safeCategories.push({
      id: categoryId,
      label: labelFromId(categoryId),
      enabled: true,
      emoji: undefined,
      description: undefined,
      sortOrder: safeCategories.length,
    });
    categoryIds.add(categoryId);
  }

  return {
    version: Number(source.version || 1),
    categories: safeCategories,
    items: safeItems,
  };
}

function readJsonFile(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function catalogFileCandidates() {
  const configured = process.env.SHOP_CATALOG_SEED_FILE || process.env.SHOP_CATALOG_FILE || "";
  return Array.from(
    new Set(
      [
        configured,
        path.resolve(process.cwd(), "shop-catalog.json"),
        path.resolve(process.cwd(), "data/shop-catalog.json"),
        path.resolve(process.cwd(), "artifacts/api-server/shop-catalog.json"),
        path.resolve(process.cwd(), "artifacts/api-server/data/shop-catalog.json"),
      ].filter(Boolean),
    ),
  );
}

function stateFileCandidates() {
  return Array.from(
    new Set([
      path.resolve(process.cwd(), "state.json"),
      path.resolve(process.cwd(), "artifacts/api-server/state.json"),
    ]),
  );
}

async function readCatalogFromBotState() {
  if (!process.env.DATABASE_URL) return null;

  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
  try {
    const rows = await sql`
      SELECT data->'shopCatalog' AS catalog
      FROM bot_state
      WHERE id = 'main'
      LIMIT 1
    `;

    const catalog = rows[0]?.catalog;
    if (catalog && typeof catalog === "object") return catalog as Partial<ShopCatalog>;
    return null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loadSeedCatalog() {
  for (const filePath of catalogFileCandidates()) {
    const parsed = readJsonFile(filePath);
    if (parsed) {
      console.log(`🛒 using catalog seed file: ${filePath}`);
      return normalizeCatalog(parsed);
    }
  }

  for (const filePath of stateFileCandidates()) {
    const parsed = readJsonFile(filePath);
    if (parsed?.shopCatalog) {
      console.log(`🛒 using shopCatalog from state file: ${filePath}`);
      return normalizeCatalog(parsed.shopCatalog);
    }
  }

  const stateCatalog = await readCatalogFromBotState();
  if (stateCatalog) {
    console.log("🛒 using shopCatalog from Neon bot_state.data");
    return normalizeCatalog(stateCatalog);
  }

  if (process.env.SHOP_CATALOG_ALLOW_DEFAULT_SEED === "true") {
    console.log("⚠️ no catalog seed found; using minimal default catalog");
    return DEFAULT_CATALOG;
  }

  throw new Error(
    "No shop catalog seed found. Set SHOP_CATALOG_SEED_FILE or run with SHOP_CATALOG_ALLOW_DEFAULT_SEED=true.",
  );
}

async function main() {
  const catalog = await loadSeedCatalog();
  const replace = process.env.SHOP_CATALOG_SEED_REPLACE === "true";
  const result = await seedShopCatalog(catalog, { replace });

  console.log("✅ shop catalog seeded to Neon", result);
}

main().catch((err) => {
  console.error("❌ failed to seed shop catalog:", err);
  process.exit(1);
});
