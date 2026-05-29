export type MapEventPresetId =
  | "locked_container_blue"
  | "locked_container_yellow"
  | "locked_container_mixed"
  | "shipping_key_blue"
  | "shipping_key_yellow";

export type MapEventChild = {
  type: string;
  min: number;
  max: number;
  lootmin?: number;
  lootmax?: number;
};

export type MapEventPreset = {
  id: MapEventPresetId;
  name: string;
  description: string;
  eventPrefix: string;
  defaultEventName: string;
  nominal: number;
  min: number;
  max: number;
  lifetime: number;
  restock: number;
  saferadius: number;
  distanceradius: number;
  cleanupradius: number;
  deletable: boolean;
  initRandom: boolean;
  removeDamaged: boolean;
  position: "fixed" | "player" | "uniform";
  limit: "child" | "mixed";
  children: MapEventChild[];
  notes?: string[];
};

export type MapEventPosition = {
  x: number;
  z: number;
  a?: number;
};

export type MapEventInjectRequest = {
  presetId: MapEventPresetId;
  name?: string;
  x: number;
  z: number;
  angle?: number;
  quantity?: number;
  lifetime?: number;
  safeRadius?: number;
  distanceRadius?: number;
  cleanupRadius?: number;
};

export type ResolvedMapEvent = {
  id: string;
  name: string;
  eventName: string;
  preset: MapEventPreset;
  position: MapEventPosition;
  nominal: number;
  min: number;
  max: number;
  lifetime: number;
  saferadius: number;
  distanceradius: number;
  cleanupradius: number;
  children: MapEventChild[];
};

export type MapEventDeployResult = {
  ok: true;
  id: string;
  eventName: string;
  presetId: MapEventPresetId;
  path: string;
};

export type MapEventCleanupResult = {
  ok: true;
  clearedEventsXml: boolean;
  clearedEventSpawnsXml: boolean;
  path: string;
};
