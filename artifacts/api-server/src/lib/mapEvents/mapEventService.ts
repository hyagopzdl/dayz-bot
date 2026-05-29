import { downloadTextFile, uploadTextFile } from "../nitradoFtp";
import { SHOP_EVENTS_PATH, SHOP_EVENT_SPAWNS_PATH } from "../shop";
import { getMapEventPresets } from "./mapEventPresets";
import {
  hasMapEventBlock,
  injectMapEventIntoEventSpawnsXml,
  injectMapEventIntoEventsXml,
  injectMapEventIntoSpawnableTypesXml,
  removeMapEventBlocks,
  resolveMapEventRequest,
} from "./mapEventXml";
import type { MapEventCleanupResult, MapEventDeployResult, MapEventInjectRequest } from "./mapEventTypes";

const MAP_EVENT_SPAWNABLE_TYPES_PATH = SHOP_EVENT_SPAWNS_PATH.replace(/\/cfgeventspawns\.xml$/i, "/cfgspawnabletypes.xml");

export function getMapEventPresetPayload() {
  return { presets: getMapEventPresets() };
}

export async function injectMapEventNow(input: MapEventInjectRequest): Promise<MapEventDeployResult> {
  const event = resolveMapEventRequest(input);

  const shouldUseSpawnableTypes = event.lootMode === "guaranteed_container";

  const [eventsXml, eventSpawnsXml, spawnableTypesXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
    shouldUseSpawnableTypes ? downloadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH) : Promise.resolve(""),
  ]);

  const nextEventsXml = injectMapEventIntoEventsXml(eventsXml, event);
  const nextEventSpawnsXml = injectMapEventIntoEventSpawnsXml(eventSpawnsXml, event);
  const nextSpawnableTypesXml = shouldUseSpawnableTypes
    ? injectMapEventIntoSpawnableTypesXml(spawnableTypesXml, event)
    : "";

  if (!nextEventsXml.includes(`event name="${event.eventName}"`)) {
    throw new Error("Falha ao gerar events.xml do evento do mapa.");
  }

  if (!nextEventSpawnsXml.includes(`event name="${event.eventName}"`)) {
    throw new Error("Falha ao gerar cfgeventspawns.xml do evento do mapa.");
  }

  const uploads = [
    uploadTextFile(SHOP_EVENTS_PATH, nextEventsXml),
    uploadTextFile(SHOP_EVENT_SPAWNS_PATH, nextEventSpawnsXml),
  ];

  if (shouldUseSpawnableTypes) {
    if (!nextSpawnableTypesXml.includes(`type name="${event.rewardStorageClass}"`)) {
      throw new Error("Falha ao gerar cfgspawnabletypes.xml do loot garantido.");
    }

    uploads.push(uploadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH, nextSpawnableTypesXml));
  }

  await Promise.all(uploads);

  const path = shouldUseSpawnableTypes
    ? `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH} + ${MAP_EVENT_SPAWNABLE_TYPES_PATH}`
    : `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`;

  return {
    ok: true,
    id: event.id,
    eventName: event.eventName,
    presetId: event.preset.id,
    lootMode: event.lootMode,
    path,
  };
}

export async function cleanupMapEventsNow(): Promise<MapEventCleanupResult> {
  const [eventsXml, eventSpawnsXml, spawnableTypesXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
    downloadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH),
  ]);

  const clearedEventsXml = hasMapEventBlock(eventsXml);
  const clearedEventSpawnsXml = hasMapEventBlock(eventSpawnsXml);
  const clearedSpawnableTypesXml = hasMapEventBlock(spawnableTypesXml);

  await Promise.all([
    uploadTextFile(SHOP_EVENTS_PATH, removeMapEventBlocks(eventsXml)),
    uploadTextFile(SHOP_EVENT_SPAWNS_PATH, removeMapEventBlocks(eventSpawnsXml)),
    uploadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH, removeMapEventBlocks(spawnableTypesXml)),
  ]);

  return {
    ok: true,
    clearedEventsXml,
    clearedEventSpawnsXml,
    clearedSpawnableTypesXml,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH} + ${MAP_EVENT_SPAWNABLE_TYPES_PATH}`,
  };
}
