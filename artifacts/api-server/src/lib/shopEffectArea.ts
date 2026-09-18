import type { ShopOrder } from "./state";

export const SHOP_EFFECT_AREA_PREFIX = "SHOP_BOT_";
export const SHOP_EFFECT_AREA_PARTICLE = "graphics/particles/fire_medium_camp_01";

type EffectArea = {
  AreaName?: string;
  Type?: string;
  TriggerType?: string;
  Data?: {
    Pos?: unknown;
    Radius?: number;
    PosHeight?: number;
    NegHeight?: number;
    InnerRingCount?: number;
    InnerPartDist?: number;
    OuterRingToggle?: number | boolean;
    OuterPartDist?: number;
    OuterOffset?: number;
    VerticalLayers?: number;
    VerticalOffset?: number;
    ParticleName?: string;
    [key: string]: unknown;
  };
  PlayerData?: {
    AroundPartName?: string;
    TinyPartName?: string;
    PPERequesterType?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function sanitizeAreaPart(value: string) {
  return String(value || "order")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "order";
}

function formatCoordinate(value: number) {
  return Number(value.toFixed(3));
}

export function buildShopEffectAreaName(order: ShopOrder, index = 0) {
  const id = sanitizeAreaPart(order.id || String(index));
  return `SHOP_BOT_${id}`;
}

export function buildShopEffectArea(order: ShopOrder, index = 0): EffectArea {
  return {
    AreaName: buildShopEffectAreaName(order, index),
    Type: "ContaminatedArea_Static",
    TriggerType: "EffectTrigger",
    Data: {
      Pos: [
        formatCoordinate(Number(order.x)),
        formatCoordinate(Number(order.y ?? 0)),
        formatCoordinate(Number(order.z)),
      ],
      Radius: 1,
      PosHeight: 5,
      NegHeight: 1,
      InnerRingCount: 1,
      InnerPartDist: 1,
      OuterRingToggle: 0,
      OuterPartDist: 1,
      OuterOffset: 0,
      VerticalLayers: 0,
      VerticalOffset: 0,
      ParticleName: SHOP_EFFECT_AREA_PARTICLE,
    },
    PlayerData: {
      AroundPartName: "",
      TinyPartName: "",
      PPERequesterType: "",
    },
  };
}

export function parseShopEffectAreaFile(json: string): { root: Record<string, unknown>; areas: EffectArea[] } {
  const parsed = JSON.parse(String(json || "{}")) as Record<string, unknown>;
  const rawAreas = parsed.Areas;

  if (rawAreas !== undefined && !Array.isArray(rawAreas)) {
    throw new Error("SHOP EFFECT AREA FAILED: cfgEffectArea.json has an invalid Areas value.");
  }

  return {
    root: parsed,
    areas: Array.isArray(rawAreas) ? rawAreas as EffectArea[] : [],
  };
}

export function injectShopEffectAreas(json: string, orders: ShopOrder[]) {
  const { root, areas } = parseShopEffectAreaFile(json);
  const retained = areas.filter((area) =>
    !String(area.AreaName || "").startsWith(SHOP_EFFECT_AREA_PREFIX),
  );

  const injected = orders.map((order, index) => buildShopEffectArea(order, index));
  root.Areas = [...retained, ...injected];

  return JSON.stringify(root, null, 2) + "\n";
}

export function removeShopEffectAreas(json: string) {
  const { root, areas } = parseShopEffectAreaFile(json);
  const retained = areas.filter(
    (area) => !String(area.AreaName || "").startsWith(SHOP_EFFECT_AREA_PREFIX),
  );

  root.Areas = retained;

  return {
    json: JSON.stringify(root, null, 2) + "\n",
    removed: areas.length - retained.length,
  };
}

export function hasShopEffectAreas(json: string, orders?: ShopOrder[]) {
  const { areas } = parseShopEffectAreaFile(json);

  if (!orders) {
    return areas.some((area) => String(area.AreaName || "").startsWith(SHOP_EFFECT_AREA_PREFIX));
  }

  return orders.every((order, index) =>
    areas.some((area) => String(area.AreaName || "") === buildShopEffectAreaName(order, index)),
  );
}
