import type { MapEventPreset, MapEventPresetId } from "./mapEventTypes";

export const mapEventPresets: MapEventPreset[] = [
  {
    id: "locked_container_blue",
    name: "Locked Container",
    description: "Container azul trancado com loot militar interno via locked-container-types.xml + mapgroupproto.xml.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Blue_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Militar",
    eventPrefix: "StaticContainerLockedBlue",
    defaultEventName: "StaticContainerLockedBlue",
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
    position: "fixed",
    limit: "child",
    children: [
      { type: "Land_ContainerLocked_Blue_DE", min: 1, max: 1, lootmin: 5, lootmax: 9 },
    ],
    notes: [
      "Use uma coordenada plana e sem objetos próximos.",
      "O loot militar depende do setup locked instalado.",
    ],
  },
];

export function getMapEventPresets() {
  return mapEventPresets.map((preset) => ({ ...preset, children: preset.children.map((child) => ({ ...child })) }));
}

export function findMapEventPreset(presetId: string) {
  return mapEventPresets.find((preset) => preset.id === (presetId as MapEventPresetId)) || null;
}
