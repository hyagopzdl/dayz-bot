import { createHash } from "node:crypto";
import { findMapEventPreset } from "./mapEventPresets";
import type {
  MapEventGuaranteedItem,
  MapEventInjectRequest,
  MapEventLootMode,
  ResolvedMapEvent,
} from "./mapEventTypes";

export const MAP_EVENT_START_PREFIX = "<!-- MAP_EVENT_START";
export const MAP_EVENT_END = "<!-- MAP_EVENT_END -->";

const ALLOWED_LOOT_MODES = new Set<MapEventLootMode>(["rng", "guaranteed_container", "guaranteed_items"]);

function sanitizeEventPart(value: string) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "Event"
  );
}

function assertDayzClass(value: string, label = "classe DayZ") {
  const className = String(value || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(className)) {
    throw new Error(`Informe uma ${label} válida.`);
  }

  return className;
}

function numberOrDefault(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intOrDefault(value: unknown, fallback: number) {
  return Math.max(0, Math.floor(numberOrDefault(value, fallback)));
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(2)).toString();
}

function boolAttr(value: boolean) {
  return value ? "1" : "0";
}

function makeRunId(presetId: string, name: string) {
  const hash = createHash("sha1")
    .update(`${presetId}:${name}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 8);

  return `${sanitizeEventPart(presetId)}_${hash}`;
}

function makeEventName(prefix: string, id: string) {
  const safePrefix = sanitizeEventPart(prefix);
  const idParts = sanitizeEventPart(id).split("_").filter(Boolean);
  const hashSuffix = idParts[idParts.length - 1] || createHash("sha1").update(id).digest("hex").slice(0, 8);

  return `${safePrefix}_${hashSuffix}`.slice(0, 96);
}

function normalizeLootMode(value: unknown): MapEventLootMode {
  const mode = String(value || "rng") as MapEventLootMode;
  return ALLOWED_LOOT_MODES.has(mode) ? mode : "rng";
}

function parseGuaranteedItems(value: MapEventInjectRequest["guaranteedItems"]): MapEventGuaranteedItem[] {
  const rawItems = typeof value === "string" ? parseGuaranteedItemsText(value) : Array.isArray(value) ? value : [];
  const items: MapEventGuaranteedItem[] = [];

  for (const rawItem of rawItems) {
    const type = assertDayzClass(String(rawItem?.type || ""), "classe de item");
    const quantity = Math.max(1, Math.min(50, intOrDefault(rawItem?.quantity, 1)));
    const chance = Math.max(0, Math.min(1, numberOrDefault(rawItem?.chance, 1)));
    const item: MapEventGuaranteedItem = { type, quantity, chance };

    if (rawItem?.quantmin !== undefined) item.quantmin = numberOrDefault(rawItem.quantmin, -1);
    if (rawItem?.quantmax !== undefined) item.quantmax = numberOrDefault(rawItem.quantmax, -1);

    items.push(item);
  }

  return items.slice(0, 100);
}

function parseGuaranteedItemsText(value: string): MapEventGuaranteedItem[] {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const normalized = line.replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim();
      const parts = normalized.split(" ");
      const maybeQuantityFirst = parts[0]?.match(/^(\d+)x?$/i);
      const maybeQuantityLast = parts[parts.length - 1]?.match(/^x?(\d+)$/i);

      if (maybeQuantityFirst && parts[1]) {
        return { quantity: Number(maybeQuantityFirst[1]), type: parts.slice(1).join("") };
      }

      if (maybeQuantityLast && parts.length > 1) {
        return { quantity: Number(maybeQuantityLast[1]), type: parts.slice(0, -1).join("") };
      }

      return { quantity: 1, type: parts.join("") };
    });
}

export function resolveMapEventRequest(input: MapEventInjectRequest): ResolvedMapEvent {
  const preset = findMapEventPreset(input.presetId);
  if (!preset) {
    throw new Error(`Preset de evento do mapa inválido: ${input.presetId}`);
  }

  const x = numberOrDefault(input.x, Number.NaN);
  const z = numberOrDefault(input.z, Number.NaN);
  const a = numberOrDefault(input.angle, 0);

  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error("Coordenadas inválidas. Informe X e Z numéricos.");
  }

  const lootMode = normalizeLootMode(input.lootMode);
  const guaranteedItems = parseGuaranteedItems(input.guaranteedItems);
  const rewardStorageClass = lootMode === "guaranteed_container"
    ? assertDayzClass(input.rewardStorageClass || "SeaChest", "storage de recompensa")
    : undefined;

  if ((lootMode === "guaranteed_container" || lootMode === "guaranteed_items") && !guaranteedItems.length) {
    throw new Error("Adicione pelo menos um item para o loot garantido.");
  }

  const requestedQuantity = Math.max(1, Math.min(25, intOrDefault(input.quantity, preset.nominal)));
  const id = makeRunId(input.presetId, input.name || preset.name);
  const eventName = makeEventName(preset.eventPrefix || preset.defaultEventName, id);

  return {
    id,
    name: String(input.name || preset.name).trim() || preset.name,
    eventName,
    preset,
    position: { x, z, a },
    nominal: requestedQuantity,
    min: Math.min(requestedQuantity, Math.max(1, preset.min)),
    max: preset.max === 0 ? 0 : requestedQuantity,
    lifetime: Math.max(60, intOrDefault(input.lifetime, preset.lifetime)),
    saferadius: intOrDefault(input.safeRadius, preset.saferadius),
    distanceradius: intOrDefault(input.distanceRadius, preset.distanceradius),
    cleanupradius: intOrDefault(input.cleanupRadius, preset.cleanupradius),
    children: preset.children.map((child) => ({ ...child })),
    lootMode,
    rewardStorageClass,
    guaranteedItems,
  };
}

export function buildMapEventEventsBlock(event: ResolvedMapEvent) {
  const preset = event.preset;
  const blocks: string[] = [];
  const childXml = event.children.map((child) => {
    const lootmax = child.lootmax ?? 0;
    const lootmin = child.lootmin ?? 0;
    return `            <child lootmax="${lootmax}" lootmin="${lootmin}" max="${child.max}" min="${child.min}" type="${child.type}"/>`;
  });

  blocks.push([
    `<!-- MAP_EVENT_START id="${event.id}" name="${event.name}" kind="main" -->`,
    `    <event name="${event.eventName}">`,
    `        <nominal>${event.nominal}</nominal>`,
    `        <min>${event.min}</min>`,
    `        <max>${event.max}</max>`,
    `        <lifetime>${event.lifetime}</lifetime>`,
    `        <restock>${preset.restock}</restock>`,
    `        <saferadius>${event.saferadius}</saferadius>`,
    `        <distanceradius>${event.distanceradius}</distanceradius>`,
    `        <cleanupradius>${event.cleanupradius}</cleanupradius>`,
    `        <flags deletable="${boolAttr(preset.deletable)}" init_random="${boolAttr(preset.initRandom)}" remove_damaged="${boolAttr(preset.removeDamaged)}"/>`,
    `        <position>${preset.position}</position>`,
    `        <limit>${preset.limit}</limit>`,
    "        <active>1</active>",
    "        <children>",
    ...childXml,
    "        </children>",
    "    </event>",
    MAP_EVENT_END,
  ].join("\n"));

  if (event.lootMode === "guaranteed_container" && event.rewardStorageClass) {
    blocks.push(buildSimpleChildEventBlock(event, `${event.eventName}_RewardStorage`, event.rewardStorageClass, 1, {
      saferadius: 5,
      distanceradius: 5,
      cleanupradius: 100,
    }));
  }

  if (event.lootMode === "guaranteed_items") {
    const itemClasses = expandGuaranteedItems(event.guaranteedItems);
    itemClasses.forEach((itemClass, index) => {
      blocks.push(buildSimpleChildEventBlock(event, `${event.eventName}_Loot_${index + 1}`, itemClass, 1, {
        saferadius: 2,
        distanceradius: 2,
        cleanupradius: 50,
      }));
    });
  }

  return blocks.join("\n\n");
}

function buildSimpleChildEventBlock(
  event: ResolvedMapEvent,
  eventName: string,
  childType: string,
  quantity: number,
  options: { saferadius: number; distanceradius: number; cleanupradius: number },
) {
  return [
    `<!-- MAP_EVENT_START id="${event.id}" name="${event.name}" kind="companion" -->`,
    `    <event name="${eventName}">`,
    `        <nominal>${quantity}</nominal>`,
    `        <min>${quantity}</min>`,
    "        <max>0</max>",
    `        <lifetime>${event.lifetime}</lifetime>`,
    "        <restock>0</restock>",
    `        <saferadius>${options.saferadius}</saferadius>`,
    `        <distanceradius>${options.distanceradius}</distanceradius>`,
    `        <cleanupradius>${options.cleanupradius}</cleanupradius>`,
    "        <flags deletable=\"1\" init_random=\"0\" remove_damaged=\"1\"/>",
    "        <position>fixed</position>",
    "        <limit>child</limit>",
    "        <active>1</active>",
    "        <children>",
    `            <child lootmax="1" lootmin="1" max="1" min="1" type="${childType}"/>`,
    "        </children>",
    "    </event>",
    MAP_EVENT_END,
  ].join("\n");
}

export function buildMapEventSpawnsBlock(event: ResolvedMapEvent) {
  const blocks: string[] = [];

  blocks.push(buildSpawnBlock(event, event.eventName, event.position.x, event.position.z, event.position.a ?? 0, "main"));

  if (event.lootMode === "guaranteed_container" && event.rewardStorageClass) {
    blocks.push(buildSpawnBlock(event, `${event.eventName}_RewardStorage`, event.position.x + 1.5, event.position.z + 1.5, event.position.a ?? 0, "companion"));
  }

  if (event.lootMode === "guaranteed_items") {
    const itemClasses = expandGuaranteedItems(event.guaranteedItems);
    itemClasses.forEach((_itemClass, index) => {
      const offset = offsetForIndex(index);
      blocks.push(buildSpawnBlock(event, `${event.eventName}_Loot_${index + 1}`, event.position.x + offset.x, event.position.z + offset.z, event.position.a ?? 0, "companion"));
    });
  }

  return blocks.join("\n\n");
}

function buildSpawnBlock(event: ResolvedMapEvent, eventName: string, x: number, z: number, a: number, kind: string) {
  return [
    `<!-- MAP_EVENT_START id="${event.id}" name="${event.name}" kind="${kind}" -->`,
    `    <event name="${eventName}">`,
    `        <pos x="${formatNumber(x)}" z="${formatNumber(z)}" a="${formatNumber(a)}"/>`,
    "    </event>",
    MAP_EVENT_END,
  ].join("\n");
}

function expandGuaranteedItems(items: MapEventGuaranteedItem[]) {
  const classes: string[] = [];
  for (const item of items) {
    for (let i = 0; i < item.quantity; i += 1) {
      classes.push(item.type);
    }
  }
  return classes.slice(0, 100);
}

function offsetForIndex(index: number) {
  const radius = 1 + Math.floor(index / 8) * 0.8;
  const angle = (index % 8) * (Math.PI / 4);
  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius,
  };
}

export function buildMapEventSpawnableTypesBlock(event: ResolvedMapEvent) {
  if (event.lootMode !== "guaranteed_container" || !event.rewardStorageClass || !event.guaranteedItems.length) {
    return "";
  }

  const cargoLines: string[] = [];
  for (const item of event.guaranteedItems) {
    for (let i = 0; i < item.quantity; i += 1) {
      const attrs = [`name="${item.type}"`, `chance="${item.chance ?? 1}"`];
      if (item.quantmin !== undefined) attrs.push(`quantmin="${item.quantmin}"`);
      if (item.quantmax !== undefined) attrs.push(`quantmax="${item.quantmax}"`);
      cargoLines.push([`        <cargo chance="1.00">`, `            <item ${attrs.join(" ")}/>`, "        </cargo>"].join("\n"));
    }
  }

  return [
    `<!-- MAP_EVENT_START id="${event.id}" name="${event.name}" kind="spawnabletypes" -->`,
    `    <type name="${event.rewardStorageClass}">`,
    ...cargoLines,
    "    </type>",
    MAP_EVENT_END,
  ].join("\n");
}

export function removeMapEventBlocks(xml: string) {
  const pattern = /\s*<!--\s*MAP_EVENT_START\b[\s\S]*?<!--\s*MAP_EVENT_END\s*-->\s*/g;
  return String(xml || "")
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function injectBeforeClosingTag(xml: string, closingTag: string, block: string) {
  const cleanXml = removeMapEventBlocks(xml);
  const closingIndex = cleanXml.lastIndexOf(closingTag);

  if (closingIndex === -1) {
    throw new Error(`Could not find closing tag ${closingTag}`);
  }

  if (!block.trim()) return cleanXml;

  const before = cleanXml.slice(0, closingIndex).trimEnd();
  const after = cleanXml.slice(closingIndex);

  return `${before}\n\n${block}\n${after}`;
}

export function injectMapEventIntoEventsXml(xml: string, event: ResolvedMapEvent) {
  return injectBeforeClosingTag(xml, "</events>", buildMapEventEventsBlock(event));
}

export function injectMapEventIntoEventSpawnsXml(xml: string, event: ResolvedMapEvent) {
  return injectBeforeClosingTag(xml, "</eventposdef>", buildMapEventSpawnsBlock(event));
}

export function injectMapEventIntoSpawnableTypesXml(xml: string, event: ResolvedMapEvent) {
  return injectBeforeClosingTag(xml, "</spawnabletypes>", buildMapEventSpawnableTypesBlock(event));
}

export function hasMapEventBlock(xml: string) {
  return String(xml || "").includes(MAP_EVENT_START_PREFIX) && String(xml || "").includes(MAP_EVENT_END);
}
