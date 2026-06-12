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
const LOCKED_CONTAINER_TYPES_FILE = "locked-container-types.xml";

const LOCKED_CONTAINER_DEFINITIONS = [
  {
    color: "red",
    theme: "Militar",
    className: "Land_ContainerLocked_Red_DE",
    keyClassName: "ShippingContainerKeys_Red",
    startMarker: "LOCKED_CONTAINER_RED_MILITARY_START",
    endMarker: "LOCKED_CONTAINER_RED_MILITARY_END",
    lootmax: 9,
    usages: ["Military"],
    categories: ["weapons", "clothes", "tools"],
  },
  {
    color: "blue",
    theme: "Médico",
    className: "Land_ContainerLocked_Blue_DE",
    keyClassName: "ShippingContainerKeys_Blue",
    startMarker: "LOCKED_CONTAINER_BLUE_MEDICAL_START",
    endMarker: "LOCKED_CONTAINER_BLUE_MEDICAL_END",
    legacyStartMarker: "LOCKED_CONTAINER_BLUE_MILITARY_START",
    legacyEndMarker: "LOCKED_CONTAINER_BLUE_MILITARY_END",
    lootmax: 12,
    usages: ["Medic", "Medical"],
    categories: ["tools", "clothes"],
  },
  {
    color: "yellow",
    theme: "Construção",
    className: "Land_ContainerLocked_Yellow_DE",
    keyClassName: "ShippingContainerKeys_Yellow",
    startMarker: "LOCKED_CONTAINER_YELLOW_CONSTRUCTION_START",
    endMarker: "LOCKED_CONTAINER_YELLOW_CONSTRUCTION_END",
    lootmax: 14,
    usages: ["Industrial"],
    categories: ["tools", "containers"],
  },
  {
    color: "orange",
    theme: "Raid",
    className: "Land_ContainerLocked_Orange_DE",
    keyClassName: "ShippingContainerKeys_Orange",
    startMarker: "LOCKED_CONTAINER_ORANGE_RAID_START",
    endMarker: "LOCKED_CONTAINER_ORANGE_RAID_END",
    lootmax: 8,
    usages: ["Military", "Industrial"],
    categories: ["weapons", "tools"],
  },
] as const;

const LOCKED_CONTAINER_POINTS = [
  '<point pos="1.280762 -1.087738 0.534241" range="0.339402" height="1.312256" />',
  '<point pos="-2.489868 -1.087738 -0.568787" range="0.479492" height="1.198730" />',
  '<point pos="1.435303 -1.087738 -0.435181" range="0.492053" height="1.533203" />',
  '<point pos="-1.784058 -1.087738 0.510315" range="0.548584" height="1.371460" />',
  '<point pos="2.228149 -1.087738 0.369354" range="0.622205" height="1.669312" />',
  '<point pos="-0.109009 -1.087738 -0.011322" range="0.913440" height="2.000000" />',
  '<point pos="-1.440674 -1.087740 -0.539337" range="0.509003" height="1.272507" />',
  '<point pos="-2.695191 -1.087740 0.466858" range="0.363585" height="0.999451" />',
  '<point pos="2.449341 -1.087740 -0.670532" range="0.377808" height="0.944519" />',
];

const LOCKED_CONTAINER_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<types>
${LOCKED_CONTAINER_DEFINITIONS.map((def) => `    <type name="${def.className}"><nominal>0</nominal><lifetime>2400</lifetime><restock>0</restock><min>0</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="containers"/>${def.usages.map((usage) => `<usage name="${usage}"/>`).join("")}</type>
    <type name="${def.keyClassName}"><nominal>5</nominal><lifetime>14400</lifetime><restock>0</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/>${def.usages.map((usage) => `<usage name="${usage}"/>`).join("")}<value name="Tier4"/></type>`).join("\n")}

    <!-- Militar -->
    <type name="M4A1"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="AKM"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="FAL"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="VSS"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Mag_STANAG_30Rnd"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="Mag_AKM_30Rnd"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="PlateCarrierVest"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="clothes"/><usage name="Military"/><value name="Tier4"/></type>

    <!-- Médico -->
    <type name="BandageDressing"><nominal>30</nominal><lifetime>14400</lifetime><restock>900</restock><min>8</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>20</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Medic"/><usage name="Medical"/></type>
    <type name="SalineBagIV"><nominal>12</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Medic"/><usage name="Medical"/></type>
    <type name="Morphine"><nominal>12</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Medic"/><usage name="Medical"/></type>
    <type name="Epinephrine"><nominal>12</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Medic"/><usage name="Medical"/></type>

    <!-- Construção -->
    <type name="NailBox"><nominal>20</nominal><lifetime>14400</lifetime><restock>900</restock><min>5</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>80</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Industrial"/></type>
    <type name="Hammer"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Industrial"/></type>
    <type name="Hatchet"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Industrial"/></type>
    <type name="Handsaw"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Industrial"/></type>

    <!-- Raid -->
    <type name="Plastic_Explosive"><nominal>4</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>200</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="RemoteDetonator"><nominal>4</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>200</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="Military"/><value name="Tier4"/></type>
    <type name="M67Grenade"><nominal>8</nominal><lifetime>14400</lifetime><restock>1800</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>120</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="Military"/><value name="Tier4"/></type>
</types>
`;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMapGroupBlock(def: (typeof LOCKED_CONTAINER_DEFINITIONS)[number]) {
  const usageLines = def.usages.map((usage) => `    <usage name="${usage}" />`).join("\n");
  const categoryLines = def.categories.map((category) => `        <category name="${category}" />`).join("\n");
  const pointLines = LOCKED_CONTAINER_POINTS.map((point) => `        ${point}`).join("\n");
  return `<!-- ${def.startMarker} -->
<group name="${def.className}" lootmax="${def.lootmax}">
${usageLines}
    <container name="lootFloor" lootmax="${def.lootmax}">
${categoryLines}
        <tag name="floor" />
        <tag name="shelves" />
        <tag name="ground" />
${pointLines}
    </container>
</group>
<!-- ${def.endMarker} -->`;
}

function removeManagedBlock(xml: string, startMarker: string, endMarker: string) {
  const pattern = new RegExp(`\\s*<!--\\s*${escapeRegExp(startMarker)}\\s*-->[\\s\\S]*?<!--\\s*${escapeRegExp(endMarker)}\\s*-->\\s*`, "gi");
  return xml.replace(pattern, "\n");
}

function injectCustomTypesRegistration(xml: string) {
  if (String(xml || "").includes(`file name="${LOCKED_CONTAINER_TYPES_FILE}"`)) return xml;

  const ceCustomPattern = /<ce\s+folder=["']custom["'][^>]*>[\s\S]*?<\/ce>/i;
  if (ceCustomPattern.test(xml)) {
    return xml.replace(ceCustomPattern, (block) => block.replace(/<\/ce>/i, `    <file name="${LOCKED_CONTAINER_TYPES_FILE}" type="types" />\n</ce>`));
  }

  const insert = `\n\t<ce folder="custom">\n\t\t<file name="${LOCKED_CONTAINER_TYPES_FILE}" type="types" />\n\t</ce>\n`;
  if (!xml.includes("</economycore>")) throw new Error("cfgeconomycore.xml sem </economycore>.");
  return xml.replace("</economycore>", `${insert}</economycore>`);
}

function removeCustomTypesRegistration(xml: string) {
  let next = String(xml || "").replace(new RegExp(`\\s*<file\\s+name=["']${escapeRegExp(LOCKED_CONTAINER_TYPES_FILE)}["']\\s+type=["']types["']\\s*\\/?>`, "gi"), "");
  next = next.replace(/\s*<ce\s+folder=["']custom["'][^>]*>\s*<\/ce>\s*/gi, "\n");
  return next;
}

function injectLockedContainerMapGroups(xml: string) {
  let value = String(xml || "");
  for (const def of LOCKED_CONTAINER_DEFINITIONS) {
    value = removeManagedBlock(value, def.startMarker, def.endMarker);
    if ("legacyStartMarker" in def && "legacyEndMarker" in def) value = removeManagedBlock(value, def.legacyStartMarker, def.legacyEndMarker);
    const existingGroupPattern = new RegExp(`\\s*<group\\s+name=["']${escapeRegExp(def.className)}["'][\\s\\S]*?<\\/group>\\s*`, "i");
    if (existingGroupPattern.test(value)) {
      value = value.replace(existingGroupPattern, `\n${buildMapGroupBlock(def)}\n`);
    } else {
      const closingTag = value.includes("</mapgroupproto>") ? "</mapgroupproto>" : value.includes("</map>") ? "</map>" : "";
      if (!closingTag) throw new Error("mapgroupproto.xml sem tag final </map> ou </mapgroupproto>.");
      value = value.replace(closingTag, `${buildMapGroupBlock(def)}\n${closingTag}`);
    }
  }
  return value;
}

function removeLockedContainerMapGroups(xml: string) {
  let value = String(xml || "");
  for (const def of LOCKED_CONTAINER_DEFINITIONS) {
    value = removeManagedBlock(value, def.startMarker, def.endMarker);
    if ("legacyStartMarker" in def && "legacyEndMarker" in def) value = removeManagedBlock(value, def.legacyStartMarker, def.legacyEndMarker);
  }
  return value;
}

function hasFileRegistration(xml: string) {
  return new RegExp(`<file\\s+name=["']${escapeRegExp(LOCKED_CONTAINER_TYPES_FILE)}["']\\s+type=["']types["']`, "i").test(String(xml || ""));
}

function hasManagedOrMatchingGroup(xml: string, def: (typeof LOCKED_CONTAINER_DEFINITIONS)[number]) {
  const value = String(xml || "");
  return value.includes(def.startMarker) || new RegExp(`<group\\s+name=["']${escapeRegExp(def.className)}["']`, "i").test(value);
}

async function tryDownloadTextFile(path: string) {
  try {
    return await downloadTextFile(path);
  } catch (err) {
    return "";
  }
}

export async function checkLockedContainerSetupNow() {
  const [economyCoreXml, mapGroupProtoXml, customTypesXml] = await Promise.all([
    tryDownloadTextFile(MAP_EVENT_ECONOMY_CORE_PATH),
    tryDownloadTextFile(MAP_EVENT_MAPGROUPPROTO_PATH),
    tryDownloadTextFile(MAP_EVENT_CUSTOM_TYPES_PATH),
  ]);

  const checks = [
    { key: "economyCoreRegistration", label: `cfgeconomycore.xml registra custom/${LOCKED_CONTAINER_TYPES_FILE}`, ok: hasFileRegistration(economyCoreXml), path: MAP_EVENT_ECONOMY_CORE_PATH },
    { key: "customTypesFile", label: `custom/${LOCKED_CONTAINER_TYPES_FILE} existe`, ok: /<types[\s>]/i.test(customTypesXml), path: MAP_EVENT_CUSTOM_TYPES_PATH },
    ...LOCKED_CONTAINER_DEFINITIONS.map((def) => ({ key: `mapGroup:${def.className}`, label: `mapgroupproto.xml tem ${def.className} (${def.theme})`, ok: hasManagedOrMatchingGroup(mapGroupProtoXml, def), path: MAP_EVENT_MAPGROUPPROTO_PATH })),
    ...LOCKED_CONTAINER_DEFINITIONS.flatMap((def) => [
      { key: `type:${def.className}`, label: `${def.className} declarado no types custom`, ok: customTypesXml.includes(`type name="${def.className}"`) || customTypesXml.includes(`type name='${def.className}'`), path: MAP_EVENT_CUSTOM_TYPES_PATH },
      { key: `type:${def.keyClassName}`, label: `${def.keyClassName} declarado no types custom`, ok: customTypesXml.includes(`type name="${def.keyClassName}"`) || customTypesXml.includes(`type name='${def.keyClassName}'`), path: MAP_EVENT_CUSTOM_TYPES_PATH },
    ]),
  ];

  const missing = checks.filter((check) => !check.ok).length;
  const hasAnyManagedPiece = checks.some((check) => check.ok && check.key !== "customTypesFile");
  const status = missing === 0 ? "installed" : !hasAnyManagedPiece ? "not_installed" : "partial";

  return {
    ok: true as const,
    status,
    installed: status === "installed",
    missing,
    total: checks.length,
    checkedAt: new Date().toISOString(),
    checks,
    paths: [MAP_EVENT_ECONOMY_CORE_PATH, MAP_EVENT_CUSTOM_TYPES_PATH, MAP_EVENT_MAPGROUPPROTO_PATH],
  };
}

export async function ensureLockedContainerSetupNow() {
  const [economyCoreXml, mapGroupProtoXml] = await Promise.all([
    downloadTextFile(MAP_EVENT_ECONOMY_CORE_PATH),
    downloadTextFile(MAP_EVENT_MAPGROUPPROTO_PATH),
  ]);

  const nextEconomyCoreXml = injectCustomTypesRegistration(economyCoreXml);
  const nextMapGroupProtoXml = injectLockedContainerMapGroups(mapGroupProtoXml);

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

export async function uninstallLockedContainerSetupNow() {
  const [economyCoreXml, mapGroupProtoXml] = await Promise.all([
    downloadTextFile(MAP_EVENT_ECONOMY_CORE_PATH),
    downloadTextFile(MAP_EVENT_MAPGROUPPROTO_PATH),
  ]);

  const nextEconomyCoreXml = removeCustomTypesRegistration(economyCoreXml);
  const nextMapGroupProtoXml = removeLockedContainerMapGroups(mapGroupProtoXml);
  const emptyTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<types>\n</types>\n`;

  await Promise.all([
    uploadTextFile(MAP_EVENT_ECONOMY_CORE_PATH, nextEconomyCoreXml),
    uploadTextFile(MAP_EVENT_CUSTOM_TYPES_PATH, emptyTypesXml),
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
