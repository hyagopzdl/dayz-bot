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
import type { MapEventCleanupResult, MapEventDeployResult, MapEventInjectRequest, ResolvedMapEvent } from "./mapEventTypes";

const MAP_EVENT_SPAWNABLE_TYPES_PATH = SHOP_EVENT_SPAWNS_PATH.replace(/\/cfgeventspawns\.xml$/i, "/cfgspawnabletypes.xml");

let mapEventOperationLock: Promise<unknown> = Promise.resolve();

function runMapEventOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mapEventOperationLock.then(operation, operation);
  mapEventOperationLock = run.catch(() => undefined);
  return run;
}

export function getMapEventPresetPayload() {
  return { presets: getMapEventPresets() };
}

function companionEventNames(event: ResolvedMapEvent) {
  if (event.lootMode === "guaranteed_container" && event.rewardStorageClass) {
    return [`${event.eventName}_RewardStorage`];
  }

  if (event.lootMode === "guaranteed_items") {
    return event.guaranteedItems.flatMap((item) => Array.from({ length: item.quantity }, (_unused, index) => index))
      .slice(0, 100)
      .map((_unused, index) => `${event.eventName}_Loot_${index + 1}`);
  }

  return [];
}

function xmlHasEvent(xml: string, eventName: string) {
  return new RegExp(`<event\\s+name=["']${escapeRegExp(eventName)}["']`).test(xml);
}

function xmlHasType(xml: string, typeName: string) {
  return new RegExp(`<type\\s+name=["']${escapeRegExp(typeName)}["']`).test(xml);
}

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertMapEventXmlConsistency(params: {
  event: ResolvedMapEvent;
  eventsXml: string;
  eventSpawnsXml: string;
  spawnableTypesXml?: string;
}) {
  const { event, eventsXml, eventSpawnsXml, spawnableTypesXml = "" } = params;
  const expectedEventNames = [event.eventName, ...companionEventNames(event)];

  for (const eventName of expectedEventNames) {
    if (!xmlHasEvent(eventsXml, eventName)) {
      throw new Error(`Falha ao gerar events.xml: evento ausente ${eventName}.`);
    }

    if (!xmlHasEvent(eventSpawnsXml, eventName)) {
      throw new Error(`Falha ao gerar cfgeventspawns.xml: spawn ausente ${eventName}.`);
    }
  }

  if (event.lootMode === "guaranteed_container" && event.rewardStorageClass) {
    if (!xmlHasType(spawnableTypesXml, event.rewardStorageClass)) {
      throw new Error(`Falha ao gerar cfgspawnabletypes.xml: storage ausente ${event.rewardStorageClass}.`);
    }
  }
}

export async function injectMapEventNow(input: MapEventInjectRequest): Promise<MapEventDeployResult> {
  return runMapEventOperation(async () => {
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

    assertMapEventXmlConsistency({
      event,
      eventsXml: nextEventsXml,
      eventSpawnsXml: nextEventSpawnsXml,
      spawnableTypesXml: nextSpawnableTypesXml,
    });

    // Upload sequencial evita estado parcial/desalinhado quando a conexão FTP/Nitrado falha no meio.
    // Se algum upload falhar, tentamos restaurar os arquivos originais antes de retornar erro.
    try {
      await uploadTextFile(SHOP_EVENTS_PATH, nextEventsXml);
      await uploadTextFile(SHOP_EVENT_SPAWNS_PATH, nextEventSpawnsXml);

      if (shouldUseSpawnableTypes) {
        await uploadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH, nextSpawnableTypesXml);
      }
    } catch (err) {
      try {
        await uploadTextFile(SHOP_EVENTS_PATH, eventsXml);
        await uploadTextFile(SHOP_EVENT_SPAWNS_PATH, eventSpawnsXml);
        if (shouldUseSpawnableTypes) {
          await uploadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH, spawnableTypesXml);
        }
      } catch (rollbackErr) {
        console.error("[map-event] rollback failed after upload error", rollbackErr);
      }
      throw err;
    }

    // Revalidação pós-upload: garante que o painel não retorne sucesso se um arquivo remoto ficou antigo.
    const [uploadedEventsXml, uploadedEventSpawnsXml, uploadedSpawnableTypesXml] = await Promise.all([
      downloadTextFile(SHOP_EVENTS_PATH),
      downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
      shouldUseSpawnableTypes ? downloadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH) : Promise.resolve(""),
    ]);

    assertMapEventXmlConsistency({
      event,
      eventsXml: uploadedEventsXml,
      eventSpawnsXml: uploadedEventSpawnsXml,
      spawnableTypesXml: uploadedSpawnableTypesXml,
    });

    const path = shouldUseSpawnableTypes
      ? `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH} + ${MAP_EVENT_SPAWNABLE_TYPES_PATH}`
      : `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH}`;

    const companions = companionEventNames(event);

    return {
      ok: true,
      id: event.id,
      eventName: event.eventName,
      companionEventNames: companions,
      presetId: event.preset.id,
      lootMode: event.lootMode,
      path,
    };
  });
}

export async function cleanupMapEventsNow(): Promise<MapEventCleanupResult> {
  return runMapEventOperation(async () => {
    const [eventsXml, eventSpawnsXml, spawnableTypesXml] = await Promise.all([
      downloadTextFile(SHOP_EVENTS_PATH),
      downloadTextFile(SHOP_EVENT_SPAWNS_PATH),
      downloadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH),
    ]);

    const clearedEventsXml = hasMapEventBlock(eventsXml);
    const clearedEventSpawnsXml = hasMapEventBlock(eventSpawnsXml);
    const clearedSpawnableTypesXml = hasMapEventBlock(spawnableTypesXml);

    await uploadTextFile(SHOP_EVENTS_PATH, removeMapEventBlocks(eventsXml));
    await uploadTextFile(SHOP_EVENT_SPAWNS_PATH, removeMapEventBlocks(eventSpawnsXml));
    await uploadTextFile(MAP_EVENT_SPAWNABLE_TYPES_PATH, removeMapEventBlocks(spawnableTypesXml));

    return {
      ok: true,
      clearedEventsXml,
      clearedEventSpawnsXml,
      clearedSpawnableTypesXml,
      path: `${SHOP_EVENTS_PATH} + ${SHOP_EVENT_SPAWNS_PATH} + ${MAP_EVENT_SPAWNABLE_TYPES_PATH}`,
    };
  });
}
