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
const MAP_EVENT_GROUPS_PATH = `${MAP_EVENT_MISSION_DIR}/cfgeventgroups.xml`;
const AIRDROP_MILITARY_GROUP_NAME = "Panel_Airdrop_Military";
const LOCKED_CONTAINER_TYPES_FILE = "locked-container-types.xml";
const LOCKED_CONTAINER_FTP_DOWNLOAD_TIMEOUT_MS = 45000;
const LOCKED_CONTAINER_FTP_UPLOAD_TIMEOUT_MS = 60000;

let lockedContainerSetupOperation: Promise<unknown> | null = null;

const LOCKED_CONTAINER_DEFINITIONS = [
  {
    color: "red",
    theme: "Militar",
    className: "Land_ContainerLocked_Red_DE",
    keyClassName: "ShippingContainerKeys_Red",
    startMarker: "LOCKED_CONTAINER_RED_MILITARY_START",
    endMarker: "LOCKED_CONTAINER_RED_MILITARY_END",
    lootmax: 9,
    usages: ["LockedContainer_Military"],
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
    lootmax: 10,
    usages: ["LockedContainer_Medical"],
    categories: ["tools"],
  },
  {
    color: "yellow",
    theme: "Construção",
    className: "Land_ContainerLocked_Yellow_DE",
    keyClassName: "ShippingContainerKeys_Yellow",
    startMarker: "LOCKED_CONTAINER_YELLOW_CONSTRUCTION_START",
    endMarker: "LOCKED_CONTAINER_YELLOW_CONSTRUCTION_END",
    lootmax: 11,
    usages: ["LockedContainer_Construction"],
    categories: ["tools", "containers"],
  },
  {
    color: "orange",
    theme: "Raid",
    className: "Land_ContainerLocked_Orange_DE",
    keyClassName: "ShippingContainerKeys_Orange",
    startMarker: "LOCKED_CONTAINER_ORANGE_RAID_START",
    endMarker: "LOCKED_CONTAINER_ORANGE_RAID_END",
    lootmax: 7,
    usages: ["LockedContainer_Raid"],
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
${LOCKED_CONTAINER_DEFINITIONS.map((def) => `    <type name="${def.className}"><nominal>0</nominal><lifetime>2400</lifetime><restock>0</restock><min>0</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="containers"/></type>
    <type name="${def.keyClassName}"><nominal>5</nominal><lifetime>14400</lifetime><restock>0</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/></type>`).join("\n")}

    <!-- Vermelho — Militar -->
    <type name="M4A1"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="AKM"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="FAL"><nominal>4</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="SVD"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="M14"><nominal>3</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Mag_STANAG_30Rnd"><nominal>18</nominal><lifetime>14400</lifetime><restock>900</restock><min>4</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>70</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Mag_STANAG_60Rnd"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Mag_AKM_30Rnd"><nominal>18</nominal><lifetime>14400</lifetime><restock>900</restock><min>4</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>70</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Mag_FAL_20Rnd"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>80</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Mag_SVD_10Rnd"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>80</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Mag_M14_20Rnd"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>80</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Ammo_556x45"><nominal>16</nominal><lifetime>14400</lifetime><restock>900</restock><min>4</min><quantmin>20</quantmin><quantmax>40</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Ammo_762x39"><nominal>16</nominal><lifetime>14400</lifetime><restock>900</restock><min>4</min><quantmin>20</quantmin><quantmax>40</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="Ammo_308Win"><nominal>14</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>10</quantmin><quantmax>30</quantmax><cost>70</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="PlateCarrierVest"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>90</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="clothes"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>
    <type name="NVGoggles"><nominal>4</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>90</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Military"/><value name="Tier4"/></type>

    <!-- Azul — Médico -->
    <type name="BandageDressing"><nominal>30</nominal><lifetime>14400</lifetime><restock>900</restock><min>8</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>20</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="Morphine"><nominal>14</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="Epinephrine"><nominal>14</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="TetracyclineAntibiotics"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>50</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="CharcoalTablets"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="PainkillerTablets"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="VitaminBottle"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>
    <type name="FirstAidKit"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>70</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Medical"/></type>

    <!-- Amarelo — Construção -->
    <type name="NailBox"><nominal>30</nominal><lifetime>14400</lifetime><restock>900</restock><min>8</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="WoodenPlank"><nominal>12</nominal><lifetime>14400</lifetime><restock>900</restock><min>3</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>50</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="containers"/><usage name="LockedContainer_Construction"/></type>
    <type name="MetalPlate"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="containers"/><usage name="LockedContainer_Construction"/></type>
    <type name="Hammer"><nominal>10</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Hatchet"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Handsaw"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>60</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Pliers"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>50</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Shovel"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>50</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Pickaxe"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>50</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="SledgeHammer"><nominal>6</nominal><lifetime>14400</lifetime><restock>900</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>70</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Wrench"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="Screwdriver"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="MetalWire"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="BarbedWire"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="CombinationLock4"><nominal>6</nominal><lifetime>14400</lifetime><restock>900</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>80</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>
    <type name="EpoxyPutty"><nominal>8</nominal><lifetime>14400</lifetime><restock>900</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>40</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Construction"/></type>

    <!-- Laranja — Raid -->
    <type name="Plastic_Explosive"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>200</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="RemoteDetonator"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>200</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="M67Grenade"><nominal>8</nominal><lifetime>14400</lifetime><restock>1800</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>120</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="LandMineTrap"><nominal>4</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>180</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="ClaymoreMine"><nominal>4</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>180</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="tools"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="Ammo_40mm_Explosive"><nominal>7</nominal><lifetime>14400</lifetime><restock>1800</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>140</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="Ammo_40mm_ChemGas"><nominal>5</nominal><lifetime>14400</lifetime><restock>1800</restock><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>140</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
    <type name="M79"><nominal>8</nominal><lifetime>14400</lifetime><restock>1800</restock><min>2</min><quantmin>-1</quantmin><quantmax>-1</quantmax><cost>160</cost><flags count_in_cargo="1" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/><category name="weapons"/><usage name="LockedContainer_Raid"/><value name="Tier4"/></type>
</types>
`;

const AIRDROP_MILITARY_GROUP_START = "PANEL_AIRDROP_MILITARY_START";
const AIRDROP_MILITARY_GROUP_END = "PANEL_AIRDROP_MILITARY_END";

const AIRDROP_MILITARY_GROUP_XML = `<!-- ${AIRDROP_MILITARY_GROUP_START} -->
<group name="${AIRDROP_MILITARY_GROUP_NAME}">
    <child type="Land_Container_1Moh_DE" deloot="0" lootmax="0" lootmin="0" x="0" y="0" z="0" a="155.7" />

    <!-- Super helicrash smoke triangle -->
    <child type="Wreck_UH1Y" spawnsecondary="false" deloot="0" lootmax="0" lootmin="0" x="-14" y="-10" z="-10" a="45" />
    <child type="Wreck_UH1Y" spawnsecondary="false" deloot="0" lootmax="0" lootmin="0" x="14" y="-10" z="-10" a="135" />
    <child type="Wreck_UH1Y" spawnsecondary="false" deloot="0" lootmax="0" lootmin="0" x="0" y="-10" z="16" a="270" />

    <!-- Physical military loot around the central drop -->
    <child type="M4A1" spawnsecondary="false" x="2.0" y="-0.5" z="1.0" a="0" />
    <child type="AKM" spawnsecondary="false" x="-2.0" y="-0.5" z="1.0" a="0" />
    <child type="FAL" spawnsecondary="false" x="2.2" y="-0.5" z="-1.0" a="0" />
    <child type="Mag_STANAG_60Rnd" spawnsecondary="false" x="1.2" y="-0.5" z="2.2" a="111.5" />
    <child type="Mag_AKM_30Rnd" spawnsecondary="false" x="-1.2" y="-0.5" z="2.2" a="17.2" />
    <child type="Mag_FAL_20Rnd" spawnsecondary="false" x="-0.6" y="-0.5" z="1.4" a="-14.6" />
    <child type="NVGoggles" spawnsecondary="false" x="0.8" y="-0.5" z="2.0" a="165.7" />
    <child type="PlateCarrierVest" spawnsecondary="false" x="-2.0" y="-0.5" z="-1.0" a="0" />
    <child type="AmmoBox" spawnsecondary="false" x="-0.3" y="-0.5" z="3.0" a="10.2" />
    <child type="GrenadeM67" spawnsecondary="false" x="1.0" y="-0.5" z="-2.0" a="0" />
</group>
<!-- ${AIRDROP_MILITARY_GROUP_END} -->`;

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

function getMapGroupProtoClosingTag(xml: string) {
  const value = String(xml || "");
  if (/<\/prototype>/i.test(value)) return "</prototype>";
  if (/<\/mapgroupproto>/i.test(value)) return "</mapgroupproto>";
  if (/<\/map>/i.test(value)) return "</map>";
  return "";
}

function injectLockedContainerMapGroups(xml: string) {
  let value = String(xml || "");
  const closingTag = getMapGroupProtoClosingTag(value);
  if (!closingTag) throw new Error("mapgroupproto.xml sem tag final suportada: </prototype>, </mapgroupproto> ou </map>.");

  for (const def of LOCKED_CONTAINER_DEFINITIONS) {
    value = removeManagedBlock(value, def.startMarker, def.endMarker);
    if ("legacyStartMarker" in def && "legacyEndMarker" in def) value = removeManagedBlock(value, def.legacyStartMarker, def.legacyEndMarker);

    const existingGroupPattern = new RegExp(`\\s*<group\\s+name=["']${escapeRegExp(def.className)}["'][\\s\\S]*?<\\/group>\\s*`, "gi");
    // Remove every previous group for this container class, not just the first one.
    // Leftover groups with broad usages (Military/Special/etc.) can still contaminate
    // the CE pool and cause wrong loot like vehicles, keys, or medical items.
    value = value.replace(existingGroupPattern, "\n");
    value = value.replace(new RegExp(`${escapeRegExp(closingTag)}\\s*$`, "i"), `${buildMapGroupBlock(def)}\n${closingTag}`);
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

function getGroupsForClass(xml: string, className: string) {
  const pattern = new RegExp(`<group\\s+name=["']${escapeRegExp(className)}["'][\\s\\S]*?<\\/group>`, "gi");
  return String(xml || "").match(pattern) || [];
}

function getUsageNames(xml: string) {
  return Array.from(String(xml || "").matchAll(/<usage\s+name=["']([^"']+)["']\s*\/?\s*>/gi)).map((match) => match[1]);
}

function hasManagedOrMatchingGroup(xml: string, def: (typeof LOCKED_CONTAINER_DEFINITIONS)[number]) {
  const groups = getGroupsForClass(xml, def.className);
  if (!groups.length) return false;

  return groups.some((group) => {
    const usages = getUsageNames(group);
    return def.usages.every((usage) => usages.includes(usage)) && usages.every((usage) => def.usages.includes(usage));
  });
}

function hasDuplicateGroupsForClass(xml: string, className: string) {
  return getGroupsForClass(xml, className).length > 1;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} demorou mais de ${Math.round(timeoutMs / 1000)}s. Tente novamente; o FTP da Nitrado pode demorar quando o servidor está sob carga.`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function downloadLockedContainerTextFile(path: string) {
  return withTimeout(downloadTextFile(path), LOCKED_CONTAINER_FTP_DOWNLOAD_TIMEOUT_MS, `Download FTP de ${path}`);
}

async function uploadLockedContainerTextFile(path: string, content: string) {
  return withTimeout(uploadTextFile(path, content), LOCKED_CONTAINER_FTP_UPLOAD_TIMEOUT_MS, `Upload FTP de ${path}`);
}

async function tryDownloadTextFile(path: string) {
  try {
    return await downloadLockedContainerTextFile(path);
  } catch (err) {
    return "";
  }
}

async function withLockedContainerSetupLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = lockedContainerSetupOperation;
  if (previous) await previous.catch(() => undefined);

  const current = operation();
  lockedContainerSetupOperation = current.finally(() => {
    if (lockedContainerSetupOperation === current) lockedContainerSetupOperation = null;
  });

  return current;
}

function getEventGroupsClosingTag(xml: string) {
  const value = String(xml || "");
  if (/<\/eventgroups>/i.test(value)) return "</eventgroups>";
  if (/<\/groups>/i.test(value)) return "</groups>";
  if (/<\/eventgroupdef>/i.test(value)) return "</eventgroupdef>";
  return "";
}

function injectAirdropMilitaryGroup(xml: string) {
  let value = String(xml || "");
  value = removeManagedBlock(value, AIRDROP_MILITARY_GROUP_START, AIRDROP_MILITARY_GROUP_END);
  const existingGroupPattern = new RegExp(`\\s*<group\\s+name=["']${escapeRegExp(AIRDROP_MILITARY_GROUP_NAME)}["'][\\s\\S]*?<\\/group>\\s*`, "i");
  value = value.replace(existingGroupPattern, "\n");
  const closingTag = getEventGroupsClosingTag(value);
  if (closingTag) return value.replace(new RegExp(`${escapeRegExp(closingTag)}\\s*$`, "i"), `${AIRDROP_MILITARY_GROUP_XML}\n${closingTag}`);
  if (!value.trim()) return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<eventgroupdef>\n${AIRDROP_MILITARY_GROUP_XML}\n</eventgroupdef>\n`;
  throw new Error("cfgeventgroups.xml sem tag final suportada: </eventgroupdef>, </eventgroups> ou </groups>.");
}

function removeAirdropMilitaryGroup(xml: string) {
  let value = removeManagedBlock(String(xml || ""), AIRDROP_MILITARY_GROUP_START, AIRDROP_MILITARY_GROUP_END);
  const existingGroupPattern = new RegExp(`\\s*<group\\s+name=["']${escapeRegExp(AIRDROP_MILITARY_GROUP_NAME)}["'][\\s\\S]*?<\\/group>\\s*`, "i");
  return value.replace(existingGroupPattern, "\n");
}

function hasAirdropMilitaryGroup(xml: string) {
  const value = String(xml || "");
  return value.includes(AIRDROP_MILITARY_GROUP_START) || new RegExp(`<group\\s+name=["']${escapeRegExp(AIRDROP_MILITARY_GROUP_NAME)}["']`, "i").test(value);
}

async function checkAirdropMilitarySetupUnlocked() {
  const eventGroupsXml = await tryDownloadTextFile(MAP_EVENT_GROUPS_PATH);
  const checks = [
    { key: "eventGroup:airdropMilitary", label: `cfgeventgroups.xml tem ${AIRDROP_MILITARY_GROUP_NAME}`, ok: hasAirdropMilitaryGroup(eventGroupsXml), path: MAP_EVENT_GROUPS_PATH },
  ];
  const missing = checks.filter((check) => !check.ok).length;
  const status = missing === 0 ? "installed" : "not_installed";
  return { ok: true as const, status, installed: status === "installed", missing, total: checks.length, checkedAt: new Date().toISOString(), checks, paths: [MAP_EVENT_GROUPS_PATH] };
}

export async function checkAirdropMilitarySetupNow() {
  return withLockedContainerSetupLock(checkAirdropMilitarySetupUnlocked);
}

async function ensureAirdropMilitarySetupUnlocked() {
  const eventGroupsXml = await tryDownloadTextFile(MAP_EVENT_GROUPS_PATH);
  const nextEventGroupsXml = injectAirdropMilitaryGroup(eventGroupsXml);
  if (nextEventGroupsXml !== eventGroupsXml) await uploadLockedContainerTextFile(MAP_EVENT_GROUPS_PATH, nextEventGroupsXml);
  return { ok: true as const, paths: [MAP_EVENT_GROUPS_PATH], changedEventGroups: nextEventGroupsXml !== eventGroupsXml };
}

export async function ensureAirdropMilitarySetupNow() {
  return withLockedContainerSetupLock(ensureAirdropMilitarySetupUnlocked);
}

async function uninstallAirdropMilitarySetupUnlocked() {
  const eventGroupsXml = await downloadLockedContainerTextFile(MAP_EVENT_GROUPS_PATH);
  const nextEventGroupsXml = removeAirdropMilitaryGroup(eventGroupsXml);
  if (nextEventGroupsXml !== eventGroupsXml) await uploadLockedContainerTextFile(MAP_EVENT_GROUPS_PATH, nextEventGroupsXml);
  return { ok: true as const, paths: [MAP_EVENT_GROUPS_PATH], changedEventGroups: nextEventGroupsXml !== eventGroupsXml };
}

export async function uninstallAirdropMilitarySetupNow() {
  return withLockedContainerSetupLock(uninstallAirdropMilitarySetupUnlocked);
}

async function checkLockedContainerSetupUnlocked() {
  const economyCoreXml = await tryDownloadTextFile(MAP_EVENT_ECONOMY_CORE_PATH);
  const mapGroupProtoXml = await tryDownloadTextFile(MAP_EVENT_MAPGROUPPROTO_PATH);
  const customTypesXml = await tryDownloadTextFile(MAP_EVENT_CUSTOM_TYPES_PATH);

  const checks = [
    { key: "economyCoreRegistration", label: `cfgeconomycore.xml registra custom/${LOCKED_CONTAINER_TYPES_FILE}`, ok: hasFileRegistration(economyCoreXml), path: MAP_EVENT_ECONOMY_CORE_PATH },
    { key: "customTypesFile", label: `custom/${LOCKED_CONTAINER_TYPES_FILE} existe`, ok: /<types[\s>]/i.test(customTypesXml), path: MAP_EVENT_CUSTOM_TYPES_PATH },
    ...LOCKED_CONTAINER_DEFINITIONS.map((def) => ({ key: `mapGroup:${def.className}`, label: `mapgroupproto.xml tem ${def.className} usando somente ${def.usages.join(", ")}`, ok: hasManagedOrMatchingGroup(mapGroupProtoXml, def), path: MAP_EVENT_MAPGROUPPROTO_PATH })),
    ...LOCKED_CONTAINER_DEFINITIONS.map((def) => ({ key: `mapGroupDuplicate:${def.className}`, label: `mapgroupproto.xml não tem grupo duplicado para ${def.className}`, ok: !hasDuplicateGroupsForClass(mapGroupProtoXml, def.className), path: MAP_EVENT_MAPGROUPPROTO_PATH })),
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

export async function checkLockedContainerSetupNow() {
  return withLockedContainerSetupLock(checkLockedContainerSetupUnlocked);
}

async function ensureLockedContainerSetupUnlocked() {
  const economyCoreXml = await downloadLockedContainerTextFile(MAP_EVENT_ECONOMY_CORE_PATH);
  const mapGroupProtoXml = await downloadLockedContainerTextFile(MAP_EVENT_MAPGROUPPROTO_PATH);

  const nextEconomyCoreXml = injectCustomTypesRegistration(economyCoreXml);
  const nextMapGroupProtoXml = injectLockedContainerMapGroups(mapGroupProtoXml);

  if (nextEconomyCoreXml !== economyCoreXml) await uploadLockedContainerTextFile(MAP_EVENT_ECONOMY_CORE_PATH, nextEconomyCoreXml);
  await uploadLockedContainerTextFile(MAP_EVENT_CUSTOM_TYPES_PATH, LOCKED_CONTAINER_TYPES_XML);
  if (nextMapGroupProtoXml !== mapGroupProtoXml) await uploadLockedContainerTextFile(MAP_EVENT_MAPGROUPPROTO_PATH, nextMapGroupProtoXml);

  return {
    ok: true as const,
    paths: [MAP_EVENT_ECONOMY_CORE_PATH, MAP_EVENT_CUSTOM_TYPES_PATH, MAP_EVENT_MAPGROUPPROTO_PATH],
    changedEconomyCore: nextEconomyCoreXml !== economyCoreXml,
    changedMapGroupProto: nextMapGroupProtoXml !== mapGroupProtoXml,
  };
}

export async function ensureLockedContainerSetupNow() {
  return withLockedContainerSetupLock(ensureLockedContainerSetupUnlocked);
}

async function uninstallLockedContainerSetupUnlocked() {
  const economyCoreXml = await downloadLockedContainerTextFile(MAP_EVENT_ECONOMY_CORE_PATH);
  const mapGroupProtoXml = await downloadLockedContainerTextFile(MAP_EVENT_MAPGROUPPROTO_PATH);

  const nextEconomyCoreXml = removeCustomTypesRegistration(economyCoreXml);
  const nextMapGroupProtoXml = removeLockedContainerMapGroups(mapGroupProtoXml);
  const emptyTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<types>\n</types>\n`;

  if (nextEconomyCoreXml !== economyCoreXml) await uploadLockedContainerTextFile(MAP_EVENT_ECONOMY_CORE_PATH, nextEconomyCoreXml);
  await uploadLockedContainerTextFile(MAP_EVENT_CUSTOM_TYPES_PATH, emptyTypesXml);
  if (nextMapGroupProtoXml !== mapGroupProtoXml) await uploadLockedContainerTextFile(MAP_EVENT_MAPGROUPPROTO_PATH, nextMapGroupProtoXml);

  return {
    ok: true as const,
    paths: [MAP_EVENT_ECONOMY_CORE_PATH, MAP_EVENT_CUSTOM_TYPES_PATH, MAP_EVENT_MAPGROUPPROTO_PATH],
    changedEconomyCore: nextEconomyCoreXml !== economyCoreXml,
    changedMapGroupProto: nextMapGroupProtoXml !== mapGroupProtoXml,
  };
}

export async function uninstallLockedContainerSetupNow() {
  return withLockedContainerSetupLock(uninstallLockedContainerSetupUnlocked);
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
