type SystemName = "shop" | "live" | "economy" | "admin" | "discord" | "nitrado";

type RuntimeMode = "full" | "shop-only" | "maintenance";

function normalize(value: string | undefined | null) {
  return String(value || "").trim().toLowerCase();
}

function readBoolEnv(name: string, defaultValue: boolean) {
  const value = normalize(process.env[name]);

  if (["1", "true", "yes", "y", "on", "enabled"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "n", "off", "disabled"].includes(value)) {
    return false;
  }

  return defaultValue;
}

function getMode(): RuntimeMode {
  const mode = normalize(process.env.APP_MODE || process.env.RUNTIME_MODE);

  if (mode === "shop-only" || mode === "shop_only" || mode === "shop") {
    return "shop-only";
  }

  if (mode === "maintenance" || mode === "maint" || mode === "safe") {
    return "maintenance";
  }

  return "full";
}

function defaultForSystem(system: SystemName, mode: RuntimeMode) {
  if (mode === "maintenance") {
    return system === "admin";
  }

  if (mode === "shop-only") {
    return ["shop", "admin", "discord", "nitrado"].includes(system);
  }

  if (system === "economy") return false;

  return true;
}

const mode = getMode();

export const systems = {
  mode,
  shop: readBoolEnv("SYSTEM_SHOP", defaultForSystem("shop", mode)),
  live: readBoolEnv("SYSTEM_LIVE", defaultForSystem("live", mode)),
  economy: readBoolEnv("SYSTEM_ECONOMY", defaultForSystem("economy", mode)),
  admin: readBoolEnv("SYSTEM_ADMIN", defaultForSystem("admin", mode)),
  discord: readBoolEnv("SYSTEM_DISCORD", defaultForSystem("discord", mode)),
  nitrado: readBoolEnv("SYSTEM_NITRADO", defaultForSystem("nitrado", mode)),
};

export function getSystemsSnapshot() {
  return { ...systems };
}

export function logSystems() {
  console.log("🧩 Runtime systems:", getSystemsSnapshot());
}

export function isLiveRuntimeEnabled() {
  return systems.live && systems.nitrado;
}

export function isShopRuntimeEnabled() {
  return systems.shop;
}
