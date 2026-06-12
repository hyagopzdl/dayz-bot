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

const MAP_EVENT_MISSION_DIR = SHOP_EVENTS_PATH.replace(/\/db\/events\.xml$/i, "");
const MAP_EVENT_ECONOMY_CORE_PATH = `${MAP_EVENT_MISSION_DIR}/cfgeconomycore.xml`;
const MAP_EVENT_MAPGROUPPROTO_PATH = `${MAP_EVENT_MISSION_DIR}/mapgroupproto.xml`;
const MAP_EVENT_CUSTOM_TYPES_PATH = `${MAP_EVENT_MISSION_DIR}/custom/locked-container-types.xml`;

const LOCKED_CONTAINER_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<types>
    <type name="Land_ContainerLocked_Blue_DE">
        <nominal>0</nominal>
        <lifetime>2400</lifetime>
        <restock>0</restock>
        <min>0</min>
        <quantmin>-1</quantmin>
        <quantmax>-1</quantmax>
        <cost>100</cost>
        <flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/>
        <category name="containers"/>
        <usage name="Military"/>
    </type>

    <type name="ShippingContainerKeys_Blue">
        <nominal>5</nominal>
        <lifetime>14400</lifetime>
        <restock>0</restock>
        <min>1</min>
        <quantmin>-1</quantmin>
        <quantmax>-1</quantmax>
        <cost>100</cost>
        <flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/>
        <category name="tools"/>
        <usage name="Military"/>
        <value name="Tier4"/>
    </type>

    <type name="M4A1"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="AKM"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="FAL"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="VSS"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Mag_STANAG_30Rnd"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Mag_AKM_30Rnd"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Mag_FAL_20Rnd"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Mag_VSS_10Rnd"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Ammo_556x45"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>20</quantmin><quantmax>40</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Ammo_762x39"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>20</quantmin><quantmax>40</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Ammo_308Win"><nominal>12</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>10</quantmin><quantmax>30</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Ammo_9x39"><nominal>12</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>10</quantmin><quantmax>30</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="NVGoggles"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="PlateCarrierVest"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="clothes"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="PlateCarrierPouches"><nominal>8</nominal><lifetime>14400</lifetime><restock>1800</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="clothes"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="PlateCarrierHolster"><nominal>8</nominal><lifetime>14400</lifetime><restock>1800</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="clothes"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Battery9V"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>20</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="BandageDressing"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>20</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Military"/><value name="Tier4"/></type>
</types>
`;

const LOCKED_CONTAINER_MAPGROUP_BLOCK = `<!-- LOCKED_CONTAINER_BLUE_MILITARY_START -->
<group name="Land_ContainerLocked_Blue_DE" lootmax="9">
    <usage name="Military" />
    <container name="lootFloor" lootmax="9">
        <category name="weapons" />
        <category name="clothes" />
        <category name="tools" />
        <tag name="floor" />
        <tag name="shelves" />
        <tag name="ground" />
        <point pos="1.280762 -1.087738 0.534241" range="0.339402" height="1.312256" />
        <point pos="-2.489868 -1.087738 -0.568787" range="0.479492" height="1.198730" />
        <point pos="1.435303 -1.087738 -0.435181" range="0.492053" height="1.533203" />
        <point pos="-1.784058 -1.087738 0.510315" range="0.548584" height="1.371460" />
        <point pos="2.228149 -1.087738 0.369354" range="0.622205" height="1.669312" />
        <point pos="-0.109009 -1.087738 -0.011322" range="0.913440" height="2.000000" />
        <point pos="-1.440674 -1.087740 -0.539337" range="0.509003" height="1.272507" />
        <point pos="-2.695191 -1.087740 0.466858" range="0.363585" height="0.999451" />
        <point pos="2.449341 -1.087740 -0.670532" range="0.377808" height="0.944519" />
    </container>
</group>
<!-- LOCKED_CONTAINER_BLUE_MILITARY_END -->`;

function injectCustomTypesRegistration(xml: string) {
  if (String(xml || "").includes('file name="locked-container-types.xml"')) return xml;

  const ceCustomPattern = /<ce\s+folder=["']custom["'][^>]*>[\s\S]*?<\/ce>/i;
  if (ceCustomPattern.test(xml)) {
    return xml.replace(ceCustomPattern, (block) => block.replace(/<\/ce>/i, '    <file name="locked-container-types.xml" type="types" />\n</ce>'));
  }

  const insert = '\n\t<ce folder="custom">\n\t\t<file name="locked-container-types.xml" type="types" />\n\t</ce>\n';
  if (!xml.includes("</economycore>")) throw new Error("cfgeconomycore.xml sem </economycore>.");
  return xml.replace("</economycore>", `${insert}</economycore>`);
}

function injectLockedContainerMapGroup(xml: string) {
  const value = String(xml || "");
  const existingGroupPattern = /\s*<group\s+name=["']Land_ContainerLocked_Blue_DE["'][\s\S]*?<\/group>\s*/i;
  if (existingGroupPattern.test(value)) {
    return value.replace(existingGroupPattern, `\n${LOCKED_CONTAINER_MAPGROUP_BLOCK}\n`);
  }

  const closingTag = value.includes("</mapgroupproto>") ? "</mapgroupproto>" : value.includes("</map>") ? "</map>" : "";
  if (!closingTag) throw new Error("mapgroupproto.xml sem tag final </map> ou </mapgroupproto>.");
  return value.replace(closingTag, `${LOCKED_CONTAINER_MAPGROUP_BLOCK}\n${closingTag}`);
}


export async function ensureLockedContainerSetupNow() {
  const [economyCoreXml, mapGroupProtoXml] = await Promise.all([
    downloadTextFile(MAP_EVENT_ECONOMY_CORE_PATH),
    downloadTextFile(MAP_EVENT_MAPGROUPPROTO_PATH),
  ]);

  const nextEconomyCoreXml = injectCustomTypesRegistration(economyCoreXml);
  const nextMapGroupProtoXml = injectLockedContainerMapGroup(mapGroupProtoXml);

  await Promise.all([
    uploadTextFile(MAP_EVENT_ECONOMY_CORE_PATH, nextEconomyCoreXml),
    uploadTextFile(MAP_EVENT_CUSTOM_TYPES_PATH, LOCKED_CONTAINER_TYPES_XML),
    uploadTextFile(MAP_EVENT_MAPGROUPPROTO_PATH, nextMapGroupProtoXml),
  ]);

  return {
    ok: true as const,
    paths: [MAP_EVENT_ECONOMY_CORE_PATH, MAP_EVENT_CUSTOM_TYPES_PATH, MAP_EVENT_MAPGROUPPROTO_PATH],
    changedEconomyCore: nextEconomyCoreXml !== economyCoreXml,
    changedMapGroupProto: nextMapGroupProtoXml !== mapGroupProtoXml,
  };
}

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
