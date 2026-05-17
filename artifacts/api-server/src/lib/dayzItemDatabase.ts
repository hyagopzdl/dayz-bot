import fs from "fs";
import path from "path";

export type DayzItemDefinition = {
  className: string;
  popularName: string;
  imageUrl?: string;
  spawnEventName?: string;
};

const DEFAULT_DAYZ_ITEMS: DayzItemDefinition[] = [
  { className: "Barrel_Green", popularName: "Barrel" },
  { className: "Barrel_Red", popularName: "Barrel" },
];


const COLOR_VARIANT_LABELS: Record<string, string> = {
  beige: "Beige",
  black: "Black",
  blackskull: "Black Skull",
  blue: "Blue",
  brown: "Brown",
  camo: "Camo",
  crimson: "Crimson",
  dark: "Dark",
  digital: "Digital",
  dubok: "Dubok",
  flecktarn: "Flecktarn",
  green: "Green",
  grey: "Grey",
  gray: "Grey",
  khaki: "Khaki",
  mossy: "Mossy",
  multicolor: "Multicolor",
  multicam: "Multicam",
  navy: "Navy",
  olive: "Olive",
  orange: "Orange",
  pattern: "Pattern",
  pink: "Pink",
  red: "Red",
  skull: "Skull",
  tan: "Tan",
  ttsko: "TTSKO",
  white: "White",
  woodland: "Woodland",
  yellow: "Yellow",
};

function getClassNameVariantLabel(className: string) {
  const parts = String(className || "").split("_").filter(Boolean);
  if (parts.length < 2) return "";

  const suffix = parts[parts.length - 1].toLowerCase();
  return COLOR_VARIANT_LABELS[suffix] || "";
}

function enrichPopularNameWithVariant(className: string, popularName: string) {
  const cleanPopularName = String(popularName || className).trim();
  const variant = getClassNameVariantLabel(className);
  if (!variant) return cleanPopularName;

  const normalizedPopularName = cleanPopularName.toLowerCase();
  const normalizedVariant = variant.toLowerCase();
  if (normalizedPopularName.includes(normalizedVariant)) return cleanPopularName;

  return `${cleanPopularName} ${variant}`;
}

function dayzItemsPath() {
  return path.resolve(
    process.cwd(),
    process.env.DAYZ_ITEMS_FILE || "data/dayz-items.json",
  );
}

function statePathCandidates() {
  return Array.from(
    new Set([
      path.resolve(process.cwd(), "state.json"),
      path.resolve(process.cwd(), "artifacts/api-server/state.json"),
    ]),
  );
}

function readDayzItemsFromStateFile() {
  for (const file of statePathCandidates()) {
    if (!fs.existsSync(file)) continue;

    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(state?.dayzItems)) return safeDayzItems(state.dayzItems);
    } catch {
      // Ignore invalid local state and continue with normal database fallback.
    }
  }

  return null;
}

function mergeStateImages(items: DayzItemDefinition[]) {
  const stateItems = readDayzItemsFromStateFile();
  if (!stateItems?.length) return items;

  const imagesByClass = new Map(
    stateItems
      .filter((item) => item.imageUrl)
      .map((item) => [item.className.trim().toLowerCase(), item.imageUrl] as const),
  );

  return items.map((item) => {
    const imageUrl = imagesByClass.get(item.className.trim().toLowerCase());
    return imageUrl && !item.imageUrl ? { ...item, imageUrl } : item;
  });
}

function dayzItemsPathCandidates() {
  const configured = dayzItemsPath();
  return Array.from(
    new Set([
      configured,
      path.resolve(process.cwd(), "data/dayz-items.json"),
      path.resolve(process.cwd(), "dayz-items.json"),
      path.resolve(process.cwd(), "artifacts/api-server/data/dayz-items.json"),
      path.resolve(process.cwd(), "artifacts/api-server/dayz-items.json"),
    ]),
  );
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

function saveDayzItems(items: DayzItemDefinition[]) {
  const file = dayzItemsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(safeDayzItems(items), null, 2)}\n`, "utf8");
}


function inferVehicleSpawnEventName(className: string) {
  const normalized = String(className || "").trim();

  const vehicleEventByClassName: Record<string, string> = {
    CivilianSedan: "VehicleCivilianSedan",
    CivilianSedan_Black: "VehicleCivilianSedan",
    CivilianSedan_Wine: "VehicleCivilianSedan",

    OffroadHatchback: "VehicleOffroadHatchback",
    OffroadHatchback_Blue: "VehicleOffroadHatchback",
    OffroadHatchback_White: "VehicleOffroadHatchback",

    Hatchback_02: "VehicleHatchback02",
    Hatchback_02_Black: "VehicleHatchback02",
    Hatchback_02_Blue: "VehicleHatchback02",

    Sedan_02: "VehicleSedan02",
    Sedan_02_Grey: "VehicleSedan02",
    Sedan_02_Red: "VehicleSedan02",

    Truck_01_Cargo: "VehicleTruck01",
    Truck_01_Cargo_Blue: "VehicleTruck01",
    Truck_01_Cargo_Grey: "VehicleTruck01",
    Truck_01_Cargo_Orange: "VehicleTruck01",
    Truck_01_Chassis: "VehicleTruck01",
    Truck_01_Chassis_Blue: "VehicleTruck01",
    Truck_01_Chassis_Grey: "VehicleTruck01",
    Truck_01_Chassis_Orange: "VehicleTruck01",

    Truck_02: "VehicleTruck02",
  };

  return vehicleEventByClassName[normalized] || "";
}

function safeDayzItems(input: unknown): DayzItemDefinition[] {
  if (!Array.isArray(input)) return DEFAULT_DAYZ_ITEMS;

  const seen = new Set<string>();
  const items: DayzItemDefinition[] = [];

  for (const item of input) {
    const className = String((item as any)?.className || "").trim();
    const popularName = enrichPopularNameWithVariant(
      className,
      String((item as any)?.popularName || className).trim(),
    );
    const imageUrl = (item as any)?.imageUrl ? String((item as any).imageUrl).trim() : undefined;
    const rawSpawnEventName = (item as any)?.spawnEventName
      ? String((item as any).spawnEventName).trim()
      : "";
    const spawnEventName = rawSpawnEventName || inferVehicleSpawnEventName(className);

    if (!className || seen.has(className)) continue;
    seen.add(className);
    items.push({
      className,
      popularName,
      ...(imageUrl ? { imageUrl } : {}),
      ...(spawnEventName ? { spawnEventName } : {}),
    });
  }

  return items.length ? items : DEFAULT_DAYZ_ITEMS;
}

export function getDayzItems(): DayzItemDefinition[] {
  let lastError: unknown = null;

  for (const file of dayzItemsPathCandidates()) {
    if (!fs.existsSync(file)) continue;

    try {
      return mergeStateImages(safeDayzItems(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch (err) {
      lastError = err;
    }
  }

  const stateItems = readDayzItemsFromStateFile();
  if (stateItems?.length) return stateItems;

  if (lastError) console.error("❌ failed to read DayZ item database:", lastError);
  return DEFAULT_DAYZ_ITEMS;
}

export function findDayzItem(className: string) {
  const normalized = String(className || "").trim().toLowerCase();
  if (!normalized) return null;

  return (
    getDayzItems().find(
      (item) => item.className.trim().toLowerCase() === normalized,
    ) || null
  );
}

export function searchDayzItems(query: string, limit = 50) {
  const normalizedQuery = normalizeSearch(query);
  const items = getDayzItems();

  if (!normalizedQuery) return items.slice(0, limit);

  const tokens = normalizedQuery.split(/\s+/g).filter(Boolean);

  return items
    .map((item) => {
      const classSearch = normalizeSearch(item.className);
      const popularSearch = normalizeSearch(item.popularName);
      const combined = `${classSearch} ${popularSearch}`;

      let score = 0;
      for (const token of tokens) {
        if (classSearch === token) score += 100;
        if (popularSearch === token) score += 80;
        if (classSearch.startsWith(token)) score += 50;
        if (popularSearch.startsWith(token)) score += 40;
        if (classSearch.includes(token)) score += 25;
        if (popularSearch.includes(token)) score += 20;
        if (combined.includes(token)) score += 10;
      }

      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.className.localeCompare(b.item.className))
    .slice(0, limit)
    .map((entry) => entry.item);
}


export function upsertDayzItemImage(className: string, imageUrl?: string) {
  const normalized = String(className || "").trim().toLowerCase();
  if (!normalized) return null;

  const items = getDayzItems();
  const item = items.find((entry) => entry.className.trim().toLowerCase() === normalized);
  if (!item) return null;

  const cleanImageUrl = String(imageUrl || "").trim();
  if (cleanImageUrl) item.imageUrl = cleanImageUrl;
  else delete item.imageUrl;

  saveDayzItems(items);
  return item;
}
