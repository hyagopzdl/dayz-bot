import { buildDiscordCommands } from "./commands";

export type DiscordCommandSetting = {
  enabled: boolean;
  updatedAt?: string;
};

export type DiscordCommandSettings = Record<string, DiscordCommandSetting>;

export type DiscordCommandDescriptor = {
  name: string;
  description: string;
  category: "player" | "admin";
  enabled: boolean;
  updatedAt?: string;
};

export const DISABLED_COMMAND_MESSAGE =
  "This command is temporarily unavailable. Please try again later.";

export function normalizeDiscordCommandSettings(value: unknown): DiscordCommandSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const normalized: DiscordCommandSettings = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const commandName = String(name || "").trim().toLowerCase();
    if (!commandName) continue;
    const setting = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    normalized[commandName] = {
      enabled: setting.enabled !== false,
      updatedAt: typeof setting.updatedAt === "string" ? setting.updatedAt : undefined,
    };
  }
  return normalized;
}

export function isDiscordCommandEnabled(
  settings: DiscordCommandSettings | undefined,
  commandName: string,
): boolean {
  return settings?.[String(commandName || "").toLowerCase()]?.enabled !== false;
}

export function listDiscordCommandDescriptors(
  settings: DiscordCommandSettings | undefined,
): DiscordCommandDescriptor[] {
  return buildDiscordCommands()
    .map((command) => ({
      name: command.name,
      description: command.description,
      category: "defaultMemberPermissions" in command && command.defaultMemberPermissions ? "admin" as const : "player" as const,
      enabled: isDiscordCommandEnabled(settings, command.name),
      updatedAt: settings?.[command.name]?.updatedAt,
    }))
    .sort((a, b) => {
      if (a.category !== b.category) return a.category === "player" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
