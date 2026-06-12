import type { MapEventPreset, MapEventPresetId } from "./mapEventTypes";

const shared = {
  nominal: 1,
  min: 1,
  max: 0,
  lifetime: 2400,
  restock: 0,
  saferadius: 500,
  distanceradius: 500,
  cleanupradius: 250,
  deletable: true,
  initRandom: false,
  removeDamaged: false,
  position: "fixed" as const,
  limit: "child" as const,
};

export const mapEventPresets: MapEventPreset[] = [
  {
    id: "locked_container_red_military",
    name: "Vermelho — Militar",
    description: "Armas, munições, coletes e equipamentos militares.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Red_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Militar",
    colorLabel: "Vermelho",
    eventPrefix: "StaticContainerLockedRed",
    defaultEventName: "StaticContainerLockedRed",
    ...shared,
    children: [{ type: "Land_ContainerLocked_Red_DE", min: 1, max: 1, lootmin: 5, lootmax: 9 }],
  },
  {
    id: "locked_container_blue_medical",
    name: "Azul — Médico",
    description: "Remédios, bandagens, saline, morphine e suprimentos médicos.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Blue_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Médico",
    colorLabel: "Azul",
    eventPrefix: "StaticContainerLockedBlue",
    defaultEventName: "StaticContainerLockedBlue",
    ...shared,
    children: [{ type: "Land_ContainerLocked_Blue_DE", min: 1, max: 1, lootmin: 5, lootmax: 12 }],
  },
  {
    id: "locked_container_yellow_construction",
    name: "Amarelo — Construção",
    description: "Ferramentas, nails, materiais e itens de construção.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Yellow_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Construção",
    colorLabel: "Amarelo",
    eventPrefix: "StaticContainerLockedYellow",
    defaultEventName: "StaticContainerLockedYellow",
    ...shared,
    children: [{ type: "Land_ContainerLocked_Yellow_DE", min: 1, max: 1, lootmin: 6, lootmax: 14 }],
  },
  {
    id: "locked_container_orange_raid",
    name: "Laranja — Raid",
    description: "Explosivos, granadas e ferramentas de raid.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Orange_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Raid",
    colorLabel: "Laranja",
    eventPrefix: "StaticContainerLockedOrange",
    defaultEventName: "StaticContainerLockedOrange",
    ...shared,
    children: [{ type: "Land_ContainerLocked_Orange_DE", min: 1, max: 1, lootmin: 4, lootmax: 8 }],
  },
];

export function getMapEventPresets() {
  return mapEventPresets.map((preset) => ({ ...preset, children: preset.children.map((child) => ({ ...child })) }));
}

export function findMapEventPreset(presetId: string) {
  return mapEventPresets.find((preset) => preset.id === (presetId as MapEventPresetId)) || null;
}
