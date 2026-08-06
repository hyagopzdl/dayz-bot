import { normalizeDiscordCommandSettings, type DiscordCommandSettings } from "./discord/commandSettings";

export type AdmDownloadMode = "legacy" | "shadow" | "optimized";

export type ServiceSettings = {
  shopEnabled: boolean;
  livePresenceEnabled: boolean;
  storePresenceHistory: boolean;
  admDownloadMode: AdmDownloadMode;
};

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = {
  shopEnabled: true,
  livePresenceEnabled: true,
  storePresenceHistory: true,
  admDownloadMode: "shadow",
};

export function normalizeServiceSettings(value: unknown): ServiceSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  const admDownloadMode = raw.admDownloadMode === "legacy" || raw.admDownloadMode === "optimized"
    ? raw.admDownloadMode
    : "shadow";

  return {
    shopEnabled: raw.shopEnabled !== false,
    livePresenceEnabled: raw.livePresenceEnabled !== false,
    storePresenceHistory: raw.storePresenceHistory !== false,
    admDownloadMode,
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
  settings: unknown,
  serviceSettings: unknown,
): DiscordCommandSettings {
  const effective = normalizeDiscordCommandSettings(settings);
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
