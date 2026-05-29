import { downloadTextFile, uploadTextFile } from "../nitradoFtp";
import { SHOP_EVENTS_PATH, SHOP_EVENT_SPAWNS_PATH } from "../shop";
import { getMapEventPresets } from "./mapEventPresets";
import {
  hasMapEventBlock,
  injectMapEventIntoEventSpawnsXml,
  injectMapEventIntoEventsXml,
  removeMapEventBlocks,
  resolveMapEventRequest,
} from "./mapEventXml";
import type { MapEventCleanupResult, MapEventDeployResult, MapEventInjectRequest } from "./mapEventTypes";

export function getMapEventPresetPayload() {
  return { presets: getMapEventPresets() };
}

export async function injectMapEventNow(input: MapEventInjectRequest): Promise<MapEventDeployResult> {
  const event = resolveMapEventRequest(input);

  const [eventsXml, eventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  const nextEventsXml = injectMapEventIntoEventsXml(eventsXml, event);
  const nextEventSpawnsXml = injectMapEventIntoEventSpawnsXml(eventSpawnsXml, event);

  if (!nextEventsXml.includes(`event name="${event.eventName}"`)) {
    throw new Error("Falha ao gerar events.xml do evento do mapa.");
  }

  if (!nextEventSpawnsXml.includes(`event name="${event.eventName}"`)) {
    throw new Error("Falha ao gerar cfgeventspawns.xml do evento do mapa.");
  }

  await Promise.all([
    uploadTextFile(SHOP_EVENTS_PATH, nextEventsXml),
    uploadTextFile(SHOP_EVENT_SPAWNS_PATH, nextEventSpawnsXml),
  ]);

  return {
    ok: true,
    id: event.id,
    eventName: event.eventName,
    presetId: event.preset.id,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
  };
}

export async function cleanupMapEventsNow(): Promise<MapEventCleanupResult> {
  const [eventsXml, eventSpawnsXml] = await Promise.all([
    downloadTextFile(SHOP_EVENTS_PATH),
    downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
  ]);

  const clearedEventsXml = hasMapEventBlock(eventsXml);
  const clearedEventSpawnsXml = hasMapEventBlock(eventSpawnsXml);

  await Promise.all([
    uploadTextFile(SHOP_EVENTS_PATH, removeMapEventBlocks(eventsXml)),
    uploadTextFile(SHOP_EVENT_SPAWNS_PATH, removeMapEventBlocks(eventSpawnsXml)),
  ]);

  return {
    ok: true,
    clearedEventsXml,
    clearedEventSpawnsXml,
    path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`,
  };
}
