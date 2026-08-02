export type ServiceSettings = {
  shopEnabled: boolean;
  livePresenceEnabled: boolean;
  storePresenceHistory: boolean;
};

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = {
  shopEnabled: true,
  livePresenceEnabled: true,
  storePresenceHistory: true,
};

export function normalizeServiceSettings(value: unknown): ServiceSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    shopEnabled: raw.shopEnabled !== false,
    livePresenceEnabled: raw.livePresenceEnabled !== false,
    storePresenceHistory: raw.storePresenceHistory !== false,
  };
}

export function isShopServiceEnabled(state: { serviceSettings?: unknown } | null | undefined): boolean {
  return normalizeServiceSettings(state?.serviceSettings).shopEnabled;
}

export function isLivePresenceEnabled(state: { serviceSettings?: unknown } | null | undefined): boolean {
  return normalizeServiceSettings(state?.serviceSettings).livePresenceEnabled;
}

export function isPresenceHistoryEnabled(state: { serviceSettings?: unknown } | null | undefined): boolean {
  return normalizeServiceSettings(state?.serviceSettings).storePresenceHistory;
}

export const SHOP_COMMAND_NAMES = new Set([
  "shop",
  "shop-buy",
  "shop-queue",
  "shop-deploy",
  "shop-clear",
  "shop-catalog",
]);

export function applyServiceSettingsToCommandSettings(
  settings: Record<string, { enabled?: boolean; updatedAt?: string } | undefined> | undefined,
  serviceSettings: unknown,
) {
  const effective = { ...(settings || {}) };
  const normalized = normalizeServiceSettings(serviceSettings);

  if (!normalized.shopEnabled) {
    for (const commandName of SHOP_COMMAND_NAMES) {
      effective[commandName] = {
        ...(effective[commandName] || {}),
        enabled: false,
      };
    }
  }

  return effective;
}
