import { getPrimaryServerId } from "../serverRegistry";
import { getServerRuntimeContext } from "../serverRuntime";
import { PermissionsBitField } from "discord.js";

export function buildDiscordCommands() {
  const adminPermission = PermissionsBitField.Flags.Administrator.toString();

  return [
    {
      name: "reset-ranking",
      description: "Reset all rankings without reprocessing old logs.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "start-match",
      description:
        "Start a new tracked match and create its private ranking channel.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "stop-match",
      description: "Stop the active match and freeze its ranking.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "delete-match",
      description:
        "Delete the active/finished match channel and match data.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-daily",
      description: "Wipe only the daily ranking.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-weekly",
      description: "Wipe only the weekly ranking.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-streaks",
      description: "Wipe current streaks and streak feed history.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-all",
      description:
        "Wipe all competitive stats while keeping parser/message infrastructure.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-player",
      description:
        "Remove one player from rankings, streaks and active match.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
      options: [
        {
          name: "player",
          description: "Player name to remove.",
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: "clear-channel",
      description: "Clear recent messages from the current channel.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
      options: [
        {
          name: "amount",
          description: "Number of recent messages to delete.",
          type: 4,
          required: false,
          min_value: 1,
          max_value: 100,
        },
      ],
    },
    {
      name: "wipe-online",
      description: "Clear the online players list.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "refresh-feeds",
      description: "Force refresh all Discord feeds and rankings.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "bot-status",
      description: "Show bot state and feed diagnostics.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-longshots",
      description: "Clear long shot feed and ranking data.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "wipe-killfeed",
      description: "Clear kill feed events.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "link",
      description: "Link your Discord account to your DayZ gamertag.",
      dmPermission: false,
      options: [
        {
          name: "gamertag",
          description: "Your DayZ / console gamertag.",
          type: 3,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "unlink",
      description: "Unlink your Discord account from your DayZ gamertag.",
      dmPermission: false,
    },
    {
      name: "bank",
      description: "View your coin balance.",
      dmPermission: false,
    },
    {
      name: "addcoins",
      description: "Add coins to a linked player wallet.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
      options: [
        {
          name: "gamertag",
          description: "Linked DayZ gamertag.",
          type: 3,
          required: true,
          autocomplete: true,
        },
        {
          name: "amount",
          description: "Coin amount to add.",
          type: 4,
          required: true,
          min_value: 1,
        },
        {
          name: "reason",
          description: "Optional reason for the transaction.",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "removecoins",
      description: "Remove coins from a linked player wallet.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
      options: [
        {
          name: "gamertag",
          description: "Linked DayZ gamertag.",
          type: 3,
          required: true,
          autocomplete: true,
        },
        {
          name: "amount",
          description: "Coin amount to remove.",
          type: 4,
          required: true,
          min_value: 1,
        },
        {
          name: "reason",
          description: "Optional reason for the transaction.",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "setcoins",
      description: "Set a linked player wallet balance.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
      options: [
        {
          name: "gamertag",
          description: "Linked DayZ gamertag.",
          type: 3,
          required: true,
          autocomplete: true,
        },
        {
          name: "amount",
          description: "New wallet balance.",
          type: 4,
          required: true,
          min_value: 0,
        },
        {
          name: "reason",
          description: "Optional reason for the transaction.",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "shop",
      description: "Open interactive DayZ shop UI.",
      dmPermission: false,
    },
    {
      name: "shop-buy",
      description: "Create a DayZ shop spawn order for the next restart.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
      options: [
        {
          name: "item",
          description: "Shop item name or DayZ class name.",
          type: 3,
          required: true,
        },
        {
          name: "coords",
          description: "iZurvive coordinates, example: 4587.29 / 8373.59",
          type: 3,
          required: true,
        },
        {
          name: "y",
          description: "Optional height/Y coordinate. Defaults to 0.",
          type: 10,
          required: false,
        },
      ],
    },
    {
      name: "shop-queue",
      description: "Show pending DayZ shop spawn orders.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "shop-deploy",
      description:
        "Inject pending shop orders into events.xml and cfgeventspawns.xml.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "shop-clear",
      description:
        "Remove SHOP_BOT XML blocks after restart and mark included orders as spawned.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "shop-catalog",
      description: "Show the current simple shop catalog.",
      defaultMemberPermissions: adminPermission,
      dmPermission: false,
    },
    {
      name: "player-stats",
      description: "Show stats for a player.",
      dmPermission: false,
      options: [
        {
          name: "player",
          description: "Player name to search.",
          type: 3,
          required: true,
        },
      ],
    },
  ];
}



const SECONDARY_CORE_COMMANDS = new Set([
  "link",
  "unlink",
  "bank",
  "addcoins",
  "removecoins",
  "setcoins",
  "shop",
  "shop-queue",
  "shop-deploy",
  "shop-clear",
  "shop-catalog",
]);

export type DiscordCommandRegistrationScope = "full" | "core";

type DiscordCommandSettingsLike = Record<
  string,
  { enabled?: boolean } | undefined
>;

export function buildEnabledDiscordCommands(
  settings?: DiscordCommandSettingsLike,
  scope: DiscordCommandRegistrationScope = "full",
) {
  return buildDiscordCommands().filter((command) =>
    settings?.[command.name]?.enabled !== false
    && (scope === "full" || SECONDARY_CORE_COMMANDS.has(command.name)),
  );
}

export async function registerDiscordCommands(
  client: any,
  settings?: DiscordCommandSettingsLike,
  serverId = getPrimaryServerId(),
  scope: DiscordCommandRegistrationScope = "full",
) {
  try {
    const commands = buildEnabledDiscordCommands(settings, scope);

    const guildId = getServerRuntimeContext(serverId).discord.guildId;
    if (guildId) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
    } else {
      await client.application?.commands.set(commands);
    }

    console.log(`✅ ${commands.length} comandos do Discord sincronizados [${serverId}] (${scope})`);
  } catch (err) {
    console.error("❌ erro registrando comandos:", err);
    throw err;
  }
}
