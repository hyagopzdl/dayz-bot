import type { MapEventPreset, MapEventPresetId } from "./mapEventTypes";

const defaultLockedContainerValues = {
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
    description: "Container vermelho trancado com armas, munições, carregadores e equipamentos militares.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Red_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Militar",
    eventPrefix: "StaticContainerLockedRed",
    defaultEventName: "StaticContainerLockedRed",
    ...defaultLockedContainerValues,
    children: [{ type: "Land_ContainerLocked_Red_DE", min: 1, max: 1, lootmin: 5, lootmax: 9 }],
    notes: ["Requer suporte a Locked Containers instalado em Settings > Eventos."],
  },
  {
    id: "locked_container_blue_medical",
    name: "Azul — Médico",
    description: "Container azul trancado com bandagens, remédios, bolsas de sangue e suprimentos médicos.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Blue_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Médico",
    eventPrefix: "StaticContainerLockedBlue",
    defaultEventName: "StaticContainerLockedBlue",
    ...defaultLockedContainerValues,
    children: [{ type: "Land_ContainerLocked_Blue_DE", min: 1, max: 1, lootmin: 6, lootmax: 12 }],
    notes: ["Requer suporte a Locked Containers instalado em Settings > Eventos."],
  },
  {
    id: "locked_container_yellow_construction",
    name: "Amarelo — Construção",
    description: "Container amarelo trancado com ferramentas, nails, reparos e materiais de construção.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Yellow_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Construção",
    eventPrefix: "StaticContainerLockedYellow",
    defaultEventName: "StaticContainerLockedYellow",
    ...defaultLockedContainerValues,
    children: [{ type: "Land_ContainerLocked_Yellow_DE", min: 1, max: 1, lootmin: 8, lootmax: 14 }],
    notes: ["Requer suporte a Locked Containers instalado em Settings > Eventos."],
  },
  {
    id: "locked_container_orange_raid",
    name: "Laranja — Raid",
    description: "Container laranja trancado com itens de raid/base e ferramentas de invasão.",
    imageUrl: "https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Orange_DE.png",
    eventTypeLabel: "Locked Container",
    lootTypeLabel: "Raid",
    eventPrefix: "StaticContainerLockedOrange",
    defaultEventName: "StaticContainerLockedOrange",
    ...defaultLockedContainerValues,
    children: [{ type: "Land_ContainerLocked_Orange_DE", min: 1, max: 1, lootmin: 4, lootmax: 8 }],
    notes: ["Requer suporte a Locked Containers instalado em Settings > Eventos."],
  },
];

export function getMapEventPresets() {
  return mapEventPresets.map((preset) => ({ ...preset, children: preset.children.map((child) => ({ ...child })) }));
}

export function findMapEventPreset(presetId: string) {
  return mapEventPresets.find((preset) => preset.id === (presetId as MapEventPresetId)) || null;
}
