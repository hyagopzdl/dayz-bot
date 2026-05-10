import {
  Client,
  GatewayIntentBits,
  TextBasedChannel,
  EmbedBuilder,
  PermissionsBitField,
  PermissionFlagsBits,
  ColorResolvable,
  ChannelType,
} from "discord.js";
import { getStateAsync, saveStateAsync } from "./state";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const MESSAGE_FILE_GLOBAL = "message_global.json";
const MESSAGE_FILE_DAILY = "message_daily.json";
const MESSAGE_FILE_WEEKLY = "message_weekly.json";
const MESSAGE_FILE_ONLINE_LIST = "message_online_list.json";

const KILLFEED_PAGE_SIZE = 9;
const KILLFEED_MESSAGE_PREFIX = "message_killfeed_page_";

const KILLSTREAK_PAGE_SIZE = 10;
const KILLSTREAK_MAX_EVENTS = 150;
const KILLSTREAK_MESSAGE_PREFIX = "message_killstreak_page_";

const BOT_NAME = "PZ's DayZ Bot";

const BOT_ICON =
  "https://media.discordapp.net/attachments/1501806293583659048/1501832841703723088/pz-avatar.png?ex=69fd8254&is=69fc30d4&hm=2075bd7c316893afbf66950ab1373fc5d5a076662bc5ad1033b6763f6689b63c&=&format=webp&quality=lossless&width=1526&height=1526";

const NITRADO_SERVICE_ID = process.env.NITRADO_SERVICE_ID || "19149785";
const NITRADO_SERVER_CONFIG_FILE =
  process.env.NITRADO_SERVER_CONFIG_FILE ||
  "/games/ni13029176_1/noftp/dayzps/config/serverDZ.cfg";

let discordLoopRunning = false;

function ensureBotState(state: any) {
  state.players = state.players || {};
  state.dailyPlayers = state.dailyPlayers || {};
  state.weeklyPlayers = state.weeklyPlayers || {};
  state.onlinePlayers = state.onlinePlayers || {};
  state.files = state.files || {};
  state.recentEventIds = state.recentEventIds || [];
  state.killFeedEvents = state.killFeedEvents || [];
  state.currentKillStreaks = state.currentKillStreaks || {};
  state.killStreakEvents = state.killStreakEvents || [];
  state.discordMessageIds = state.discordMessageIds || {};
  state.activeMatch = state.activeMatch || null;

  return state;
}

function getKillStreakMeta(streak: number) {
  if (streak >= 25) {
    return {
      emoji: "🌌",
      color: "#FF4FD8",
      en: "reached a GODLIKE",
      pt: "alcançou uma sequência DIVINA de",
    };
  }

  if (streak >= 20) {
    return {
      emoji: "☢️",
      color: "#A020F0",
      en: "is ANNIHILATING the server with a",
      pt: "está ANIQUILANDO o servidor com uma sequência de",
    };
  }

  if (streak >= 15) {
    return {
      emoji: "⚡️",
      color: "#FFD700",
      en: "became UNSTOPPABLE with a",
      pt: "se tornou IMPARÁVEL com uma sequência de",
    };
  }

  if (streak >= 10) {
    return {
      emoji: "🔥",
      color: "#00FF88",
      en: "is DOMINATING with a",
      pt: "está DOMINANDO com uma sequência de",
    };
  }

  return {
    emoji: "📈",
    color: "#0099FF",
    en: "is on a",
    pt: "está em uma sequência de",
  };
}


function requireNitradoToken() {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  return process.env.NITRADO_TOKEN;
}

async function nitradoFetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const token = requireNitradoToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Nitrado HTTP ${response.status}: ${text}`);
  }

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function getNitradoFileDownloadUrl(filePath: string): Promise<string> {
  const json = await nitradoFetchJson(
    `https://api.nitrado.net/services/${NITRADO_SERVICE_ID}/gameservers/file_server/download?file=${encodeURIComponent(
      filePath,
    )}`,
  );

  const url = json?.data?.token?.url;

  if (!url) {
    throw new Error("Nitrado não retornou URL de download do server config");
  }

  return url;
}

async function getNitradoFileUploadUrl(filePath: string): Promise<string> {
  const json = await nitradoFetchJson(
    `https://api.nitrado.net/services/${NITRADO_SERVICE_ID}/gameservers/file_server/upload?file=${encodeURIComponent(
      filePath,
    )}`,
  );

  const url = json?.data?.token?.url;

  if (!url) {
    throw new Error("Nitrado não retornou URL de upload do server config");
  }

  return url;
}

async function readNitradoServerConfig() {
  const url = await getNitradoFileDownloadUrl(NITRADO_SERVER_CONFIG_FILE);
  const response = await fetch(`${url}&t=${Date.now()}`);

  if (!response.ok) {
    throw new Error(`ADM config download HTTP ${response.status}: ${await response.text()}`);
  }

  return response.text();
}

async function writeNitradoServerConfig(content: string) {
  const url = await getNitradoFileUploadUrl(NITRADO_SERVER_CONFIG_FILE);
  const response = await fetch(`${url}&t=${Date.now()}`, {
    method: "PUT",
    body: content,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

  if (!response.ok) {
    throw new Error(`ADM config upload HTTP ${response.status}: ${await response.text()}`);
  }
}

function setDayZServerPassword(config: string, password: string) {
  const escapedPassword = password.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `password = "${escapedPassword}";`;

  if (/^\s*password\s*=.*;\s*$/im.test(config)) {
    return config.replace(/^\s*password\s*=.*;\s*$/im, line);
  }

  return `${config.trimEnd()}\n${line}\n`;
}

async function applyServerPassword(password: string) {
  const config = await readNitradoServerConfig();
  await writeNitradoServerConfig(setDayZServerPassword(config, password));
}

async function removeServerPassword() {
  const config = await readNitradoServerConfig();
  await writeNitradoServerConfig(setDayZServerPassword(config, ""));
}

async function restartNitradoServer() {
  await nitradoFetchJson(
    `https://api.nitrado.net/services/${NITRADO_SERVICE_ID}/gameservers/restart`,
    { method: "POST" },
  );
}

export async function registerKillStreakFromKill(options: {
  killer: string;
  victim: string;
  weapon?: string;
  timestamp?: number;
}) {
  const killer = options.killer?.trim();
  const victim = options.victim?.trim();

  if (!killer || !victim) return;
  if (killer.toLowerCase() === victim.toLowerCase()) return;

  const state = ensureBotState(await getStateAsync());
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);

  const victimCurrentStreak = Number(state.currentKillStreaks[victim] || 0);

  if (victimCurrentStreak >= 5) {
    state.killStreakEvents.push({
      type: "ended",
      killer,
      player: victim,
      streak: victimCurrentStreak,
      timestamp,
    });
  }

  state.currentKillStreaks[victim] = 0;

  const killerCurrentStreak = Number(state.currentKillStreaks[killer] || 0) + 1;
  state.currentKillStreaks[killer] = killerCurrentStreak;

  if (killerCurrentStreak >= 5 && killerCurrentStreak % 5 === 0) {
    state.killStreakEvents.push({
      type: "streak",
      player: killer,
      streak: killerCurrentStreak,
      timestamp,
    });
  }

  state.killStreakEvents = state.killStreakEvents.slice(-KILLSTREAK_MAX_EVENTS);

  await saveStateAsync(state);
}

export async function startDiscordBot() {
  if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não definido");
    return;
  }

  client.once("ready", async () => {
    console.log("🤖 Discord conectado");

    const globalChannel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_ID!,
    )) as TextBasedChannel;

    const dailyChannel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_DAILY_ID!,
    )) as TextBasedChannel;

    const weeklyChannel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_WEEKLY_ID!,
    )) as TextBasedChannel;

    const onlineListChannel = process.env.DISCORD_ONLINE_LIST_CHANNEL_ID
      ? ((await client.channels.fetch(
          process.env.DISCORD_ONLINE_LIST_CHANNEL_ID,
        )) as TextBasedChannel)
      : null;

    const killfeedChannel = process.env.DISCORD_KILLFEED_CHANNEL_ID
      ? ((await client.channels.fetch(
          process.env.DISCORD_KILLFEED_CHANNEL_ID,
        )) as TextBasedChannel)
      : null;

    const killStreakChannel = process.env.DISCORD_KILLSTREAK_CHANNEL_ID
      ? ((await client.channels.fetch(
          process.env.DISCORD_KILLSTREAK_CHANNEL_ID,
        )) as TextBasedChannel)
      : null;

    const CATEGORY_ID = process.env.DISCORD_ONLINE_CHANNEL_ID!;

    function padEnd(str: string, size: number) {
      return str.length >= size ? str : str + " ".repeat(size - str.length);
    }

    function padStart(str: string, size: number) {
      return str.length >= size ? str : " ".repeat(size - str.length) + str;
    }

    function getRank(i: number) {
      if (i === 0) return "🥇";
      if (i === 1) return "🥈";
      if (i === 2) return "🥉";

      const nums = ["4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
      return nums[i - 3] || `${i + 1}️⃣`;
    }

    async function getState() {
      const state = ensureBotState(await getStateAsync());

      console.log("📊 Discord lendo state:", {
        global: Object.keys(state.players || {}).length,
        daily: Object.keys(state.dailyPlayers || {}).length,
        weekly: Object.keys(state.weeklyPlayers || {}).length,
        online: Object.keys(state.onlinePlayers || {}).length,
        killfeed: (state.killFeedEvents || []).length,
        killStreakEvents: (state.killStreakEvents || []).length,
        messages: Object.keys(state.discordMessageIds || {}).length,
      });

      return state;
    }

    async function saveState(state: any) {
      await saveStateAsync(ensureBotState(state));
      console.log("💾 state salvo pelo Discord");
    }

    function formatDate(dateString?: string) {
      if (!dateString) return "Unknown";

      const date = new Date(`${dateString}T00:00:00`);

      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(date);
    }

    function getRelativeDays(dateString?: string) {
      if (!dateString) return "Unknown";

      const start = new Date(`${dateString}T00:00:00`).getTime();
      const now = Date.now();

      const days = Math.max(
        0,
        Math.floor((now - start) / (1000 * 60 * 60 * 24)),
      );

      if (days === 0) return "today";
      if (days === 1) return "1 day ago";

      return `${days} days ago`;
    }

    function getNextDailyResetTimestamp() {
      const now = new Date();
      const next = new Date(now);

      next.setUTCHours(3, 0, 0, 0);

      if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
      }

      return Math.floor(next.getTime() / 1000);
    }

    function getNextWeeklyResetTimestamp() {
      const now = new Date();
      const next = new Date(now);

      next.setUTCHours(3, 0, 0, 0);

      const currentDay = next.getUTCDay();
      const daysUntilMonday = currentDay === 1 ? 7 : (8 - currentDay) % 7;

      next.setUTCDate(next.getUTCDate() + daysUntilMonday);

      return Math.floor(next.getTime() / 1000);
    }

    function getDailyResetTime() {
      const ts = getNextDailyResetTimestamp();
      return `Resets <t:${ts}:R> • <t:${ts}:t>`;
    }

    function getWeeklyResetTime() {
      const ts = getNextWeeklyResetTimestamp();
      return `Resets <t:${ts}:R> • <t:${ts}:F>`;
    }

    function buildHeader(emoji: string, title: string, subtitle: string) {
      return `\u200B\n${emoji} **${title}**\n${subtitle}\n\u200B\n\u200B\n`;
    }

    function buildFooter() {
      const timestamp = Math.floor(Date.now() / 1000);
      return `\u200B\n⏱️ Updated <t:${timestamp}:R>`;
    }

    function createBaseEmbed(color: any, withAuthor = true) {
      const embed = new EmbedBuilder().setColor(color);

      if (withAuthor) {
        embed.setAuthor({
          name: BOT_NAME,
          iconURL: BOT_ICON,
        });
      }

      return embed;
    }

    async function resetRankings() {
      const state = await getState();
      const today = new Date().toISOString().slice(0, 10);

      state.players = {};
      state.dailyPlayers = {};
      state.weeklyPlayers = {};
      state.killFeedEvents = [];
      state.currentKillStreaks = {};
      state.killStreakEvents = [];
      state.activeMatch = null;

      state.globalStartedAt = today;
      state.dailyStartedAt = today;
      state.weeklyStartedAt = today;

      state.files = state.files || {};
      state.recentEventIds = state.recentEventIds || [];
      state.onlinePlayers = state.onlinePlayers || {};
      state.discordMessageIds = state.discordMessageIds || {};

      await saveState(state);
    }

    function mapPlayers(obj: any) {
      return Object.entries(obj || {})
        .map(([name, d]: any) => ({ name, ...d }))
        .sort((a, b) => b.kills - a.kills);
    }

    function getOnlinePlayerNames(state: any) {
      return Object.keys(state.onlinePlayers || {}).sort((a, b) =>
        a.localeCompare(b),
      );
    }

    function formatDuration(ms: number) {
      const totalMinutes = Math.max(0, Math.floor(ms / 60000));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }

    function getOnlineSessionTime(player: any) {
      const startedAt = player?.connectedAt || player?.lastSeenAt;
      const start = startedAt ? new Date(startedAt).getTime() : Date.now();

      return formatDuration(Date.now() - start);
    }

    function formatLeaderboardEmbed(
      players: any[],
      options: {
        emoji: string;
        title: string;
        subtitle: string;
        color: string;
      },
    ) {
      const embed = createBaseEmbed(options.color);

      if (!players.length) {
        embed.setDescription(
          buildHeader(options.emoji, options.title, options.subtitle) +
            `**No data available yet**\nStart playing and claim the top spot!` +
            buildFooter(),
        );

        return embed;
      }

      const maxName = Math.min(
        Math.max(...players.map((p) => p.name.length)),
        18,
      );

      const maxKillsLength = Math.max(
        ...players.map((p) => `${p.kills} kills`.length),
      );

      const KD_WIDTH = 8;

      let description = buildHeader(
        options.emoji,
        options.title,
        options.subtitle,
      );

      players.slice(0, 10).forEach((p, i) => {
        const rank = getRank(i);

        const trimmedName =
          p.name.length > maxName ? p.name.slice(0, maxName - 1) + "…" : p.name;

        const name = padEnd(trimmedName, maxName);

        const killsText = `${p.kills} kills`;
        const kills = padStart(killsText, maxKillsLength);

        const kd =
          p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);

        const kdText = `K/D ${kd}`;
        const kdFormatted = padStart(kdText, KD_WIDTH);

        description += `${rank} \`${name}\` \`${kills}\` \`${kdFormatted}\`\n\n`;
      });

      description += buildFooter();

      embed.setDescription(description);

      return embed;
    }

    function formatOnlineListEmbed(state: any) {
      const players = getOnlinePlayerNames(state);
      const embed = createBaseEmbed("#00FF88");

      if (!players.length) {
        embed.setDescription(
          buildHeader("🟢", "Players Online", "Live server activity") +
            `**No players online**\nThe server is currently quiet.` +
            buildFooter(),
        );

        return embed;
      }

      const lines = players
        .map((name) => {
          const globalKey = findPlayerKey(state.players, name) || name;
          const stats = state.players?.[globalKey] || { kills: 0, deaths: 0 };
          const streakKey = findPlayerKey(state.currentKillStreaks, name) || name;
          const streak = Number(state.currentKillStreaks?.[streakKey] || 0);
          const onlineKey = findPlayerKey(state.onlinePlayers, name) || name;
          const session = getOnlineSessionTime(state.onlinePlayers?.[onlineKey]);

          return (
            `**${name}**\n` +
            `\`Kill(s): ${stats.kills || 0}\` • ` +
            `\`Death(s): ${stats.deaths || 0}\` • ` +
            `\`Streak: ${streak}\` • ` +
            `\`Session: ${session}\``
          );
        })
        .join("\n\n");

      embed.setDescription(
        buildHeader(
          "🟢",
          "Players Online",
          `${players.length}/10 survivors currently connected`,
        ) +
          lines +
          buildFooter(),
      );

      return embed;
    }

    function chunkArray<T>(items: T[], size: number): T[][] {
      const chunks: T[][] = [];

      for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
      }

      return chunks;
    }

    function killfeedPageKey(pageIndex: number) {
      return `${KILLFEED_MESSAGE_PREFIX}${pageIndex}.json`;
    }

    function killStreakPageKey(pageIndex: number) {
      return `${KILLSTREAK_MESSAGE_PREFIX}${pageIndex}.json`;
    }

    function formatWeapon(weapon: string | undefined) {
      const clean = weapon?.trim();

      if (!clean || clean.toLowerCase() === "unknown") {
        return "Unknown";
      }

      return clean;
    }

    function createKillFeedHeaderEmbed(eventsCount: number) {
      return createBaseEmbed("#FF3333").setDescription(
        buildHeader(
          "🔫",
          "Kill Feed",
          `${eventsCount} recent kill${eventsCount === 1 ? "" : "s"} detected`,
        ) + `Tracking the latest PvP activity across the server.` + buildFooter(),
      );
    }

    function createKillFeedEmptyEmbed() {
      return createBaseEmbed("#FF3333").setDescription(
        buildHeader("🔫", "Kill Feed", "Live PvP activity") +
          `**No recent kills**\nKill someone and keep the feed alive!`,
      );
    }

    function formatKillFeedEmbed(event: any) {
      const killer = event.killer || "Unknown";
      const victim = event.victim || "Unknown";
      const weapon = formatWeapon(event.weapon);

      return createBaseEmbed("#FF3333", false).setDescription(
        `**${killer}** \`[${weapon}]\` killed 💀 **${victim}**`,
      );
    }

    function createKillStreakEmptyEmbed() {
      return createBaseEmbed("#FF3333").setDescription(
        buildHeader("📈", "Kill Streak Feed", "Persistent streak history") +
          `**No streak events yet**\nReach 5 kills in a row to enter the feed!`,
      );
    }

    function formatKillStreakEmbed(event: any) {
      const timestamp = Number(
        event.timestamp || Math.floor(Date.now() / 1000),
      );

      if (event.type === "ended") {
        const killer = event.killer || event.endedBy || "Unknown";
        const player = event.player || "Unknown";
        const streak = Number(event.streak || 0);

        return createBaseEmbed("#FF3333").setDescription(
          `\u200B\n` +
            `🛑 **Kill Streak Ended**\n\n` +
            `**${killer}** ended **${player}'s** ${streak} kill streak\n` +
            `**${killer}** encerrou a sequência de ${streak} kills de **${player}**\n\n` +
            `<t:${timestamp}:f>`,
        );
      }

      const streak = Number(event.streak || 0);
      const player = event.player || "Unknown";
      const meta = getKillStreakMeta(streak);

      return createBaseEmbed(meta.color).setDescription(
        `\u200B\n` +
          `${meta.emoji} **${streak}x Kill Streak**\n\n` +
          `**${player}** ${meta.en} ${streak} kill streak\n` +
          `**${player}** ${meta.pt} ${streak} kills\n\n` +
          `<t:${timestamp}:f>`,
      );
    }

    async function sendOrEdit(
      state: any,
      channel: any,
      key: string,
      embedOrEmbeds: any,
    ) {
      state.discordMessageIds = state.discordMessageIds || {};

      const embeds = Array.isArray(embedOrEmbeds)
        ? embedOrEmbeds
        : [embedOrEmbeds];

      let messageId: string | null = state.discordMessageIds[key] || null;
      let message: any = null;

      if (messageId) {
        try {
          message = await channel.messages.fetch(messageId);
        } catch {
          message = null;
        }
      }

      if (message) {
        await message.edit({ embeds });
        console.log(`✏️ mensagem editada: ${key}`);
        return;
      }

      const newMsg = await channel.send({ embeds });
      state.discordMessageIds[key] = newMsg.id;

      console.log(`📨 nova mensagem enviada: ${key}`);
    }

    async function deleteMessageByKey(state: any, channel: any, key: string) {
      state.discordMessageIds = state.discordMessageIds || {};

      const messageId = state.discordMessageIds[key];

      if (messageId) {
        try {
          const message = await channel.messages.fetch(messageId);
          await message.delete();
        } catch {}
      }

      delete state.discordMessageIds[key];
    }

    async function deleteExtraPages(
      state: any,
      channel: any,
      neededPages: number,
      prefix: string,
    ) {
      state.discordMessageIds = state.discordMessageIds || {};

      const keys = Object.keys(state.discordMessageIds).filter((key) =>
        key.startsWith(prefix),
      );

      for (const key of keys) {
        const match = key.match(new RegExp(`^${prefix}(\\d+)\\.json$`));

        if (!match) continue;

        const pageIndex = Number(match[1]);

        if (pageIndex >= neededPages) {
          await deleteMessageByKey(state, channel, key);
        }
      }
    }

    async function updateOnlineCount(state: any) {
      try {
        const count = Object.keys(state.onlinePlayers || {}).length;
        const category = await client.channels.fetch(CATEGORY_ID);

        if (!category || !("setName" in category)) {
          console.error("❌ canal/categoria online inválido");
          return;
        }

        const MAX_PLAYERS = 10;

        let newName = `━━━〔 PLAYERS ONLINE: ${count}/${MAX_PLAYERS} 〕━━━`;

        if (count >= 5) {
          newName = `━━━〔 PLAYERS ONLINE: ${count}/${MAX_PLAYERS} 🔥 〕━━━`;
        }

        if ((category as any).name === newName) {
          return;
        }

        await (category as any).setName(newName);
      } catch (err) {
        console.error("❌ erro ao atualizar categoria online", err);
      }
    }

    async function updateOnlineList(state: any) {
      if (!onlineListChannel) return;

      await sendOrEdit(
        state,
        onlineListChannel,
        MESSAGE_FILE_ONLINE_LIST,
        formatOnlineListEmbed(state),
      );
    }

    async function updateKillFeed(state: any) {
      if (!killfeedChannel) return;

      const events = [...(state.killFeedEvents || [])].reverse();

      if (!events.length) {
        await sendOrEdit(state, killfeedChannel, killfeedPageKey(0), [
          createKillFeedEmptyEmbed(),
        ]);

        await deleteExtraPages(
          state,
          killfeedChannel,
          1,
          KILLFEED_MESSAGE_PREFIX,
        );
        return;
      }

      const pages = chunkArray(events, KILLFEED_PAGE_SIZE);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const embeds = pages[pageIndex].map(formatKillFeedEmbed);

        if (pageIndex === 0) {
          embeds.unshift(createKillFeedHeaderEmbed(events.length));
        }

        await sendOrEdit(
          state,
          killfeedChannel,
          killfeedPageKey(pageIndex),
          embeds,
        );
      }

      await deleteExtraPages(
        state,
        killfeedChannel,
        pages.length,
        KILLFEED_MESSAGE_PREFIX,
      );

      state.killFeedEvents = [];
    }

    async function updateKillStreakFeed(state: any) {
      if (!killStreakChannel) return;

      const events = [...(state.killStreakEvents || [])]
        .slice(-KILLSTREAK_MAX_EVENTS)
        .reverse();

      if (!events.length) {
        await sendOrEdit(state, killStreakChannel, killStreakPageKey(0), [
          createKillStreakEmptyEmbed(),
        ]);

        await deleteExtraPages(
          state,
          killStreakChannel,
          1,
          KILLSTREAK_MESSAGE_PREFIX,
        );

        return;
      }

      const pages = chunkArray(events, KILLSTREAK_PAGE_SIZE);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const embeds = pages[pageIndex].map(formatKillStreakEmbed);

        await sendOrEdit(
          state,
          killStreakChannel,
          killStreakPageKey(pageIndex),
          embeds,
        );
      }

      await deleteExtraPages(
        state,
        killStreakChannel,
        pages.length,
        KILLSTREAK_MESSAGE_PREFIX,
      );
    }

    async function updateLeaderboard() {
      if (discordLoopRunning) return;

      discordLoopRunning = true;

      try {
        const state = await getState();

        if (!state.globalStartedAt) {
          state.globalStartedAt =
            state.lastDailyReset ||
            state.lastWeeklyReset ||
            new Date().toISOString().slice(0, 10);
        }

        const globalPlayers = mapPlayers(state.players);
        const dailyPlayers = mapPlayers(state.dailyPlayers);
        const weeklyPlayers = mapPlayers(state.weeklyPlayers);

        await sendOrEdit(
          state,
          globalChannel,
          MESSAGE_FILE_GLOBAL,
          formatLeaderboardEmbed(globalPlayers, {
            emoji: "🏆",
            title: "General Ranking (Geral)",
            subtitle: `Count started on ${formatDate(
              state.globalStartedAt,
            )} (${getRelativeDays(state.globalStartedAt)})`,
            color: "#FFD700",
          }),
        );

        await sendOrEdit(
          state,
          dailyChannel,
          MESSAGE_FILE_DAILY,
          formatLeaderboardEmbed(dailyPlayers, {
            emoji: "🌅",
            title: "Daily Ranking (Diário)",
            subtitle: getDailyResetTime(),
            color: "#FF00AA",
          }),
        );

        await sendOrEdit(
          state,
          weeklyChannel,
          MESSAGE_FILE_WEEKLY,
          formatLeaderboardEmbed(weeklyPlayers, {
            emoji: "📆",
            title: "Weekly Ranking (Semanal)",
            subtitle: getWeeklyResetTime(),
            color: "#0099FF",
          }),
        );

        await updateOnlineCount(state);
        await updateOnlineList(state);
        await updateKillFeed(state);
        await updateKillStreakFeed(state);
        await updateMatchRanking(state);

        await saveState(state);
      } catch (err) {
        console.error("❌ erro ao atualizar leaderboard", err);
      } finally {
        discordLoopRunning = false;
      }
    }


    function getRankPosition(playersObj: any, playerName: string) {
      const players = mapPlayers(playersObj);
      const index = players.findIndex(
        (player) => player.name.toLowerCase() === playerName.toLowerCase(),
      );

      return index >= 0 ? index + 1 : null;
    }

    function findPlayerKey(obj: any, playerName: string) {
      return Object.keys(obj || {}).find(
        (name) => name.toLowerCase() === playerName.toLowerCase(),
      );
    }

    function createPlayerStatsEmbed(state: any, playerName: string) {
      const globalKey = findPlayerKey(state.players, playerName);
      const dailyKey = findPlayerKey(state.dailyPlayers, playerName);
      const weeklyKey = findPlayerKey(state.weeklyPlayers, playerName);
      const streakKey = findPlayerKey(state.currentKillStreaks, playerName);
      const onlineKey = findPlayerKey(state.onlinePlayers, playerName);

      const canonicalName = globalKey || dailyKey || weeklyKey || streakKey || onlineKey || playerName;
      const stats = state.players?.[globalKey || canonicalName] || { kills: 0, deaths: 0 };
      const dailyStats = state.dailyPlayers?.[dailyKey || canonicalName] || { kills: 0, deaths: 0 };
      const weeklyStats = state.weeklyPlayers?.[weeklyKey || canonicalName] || { kills: 0, deaths: 0 };
      const currentStreak = Number(state.currentKillStreaks?.[streakKey || canonicalName] || 0);
      const kd = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills.toFixed(2);
      const globalRank = getRankPosition(state.players, canonicalName);
      const dailyRank = getRankPosition(state.dailyPlayers, canonicalName);
      const weeklyRank = getRankPosition(state.weeklyPlayers, canonicalName);
      const isOnline = Boolean(onlineKey);

      return createBaseEmbed("#0099FF").setDescription(
        `\u200B\n` +
          `👤 **Player Stats**\n` +
          `${canonicalName}\n\u200B\n\u200B\n` +
          `**Kills:** ${stats.kills}\n` +
          `**Deaths:** ${stats.deaths}\n` +
          `**K/D:** ${kd}\n` +
          `**Current Streak:** ${currentStreak}\n\n` +
          `**Daily:** ${dailyStats.kills} kills / ${dailyStats.deaths} deaths${dailyRank ? ` • #${dailyRank}` : ""}\n` +
          `**Weekly:** ${weeklyStats.kills} kills / ${weeklyStats.deaths} deaths${weeklyRank ? ` • #${weeklyRank}` : ""}\n` +
          `**Global Rank:** ${globalRank ? `#${globalRank}` : "Unranked"}\n` +
          `**Status:** ${isOnline ? "🟢 Online" : "⚫ Offline"}` +
          buildFooter(),
      );
    }

    function createMatchEmbed(state: any) {
      const match = state.activeMatch;

      if (!match) {
        return createBaseEmbed("#FF3333").setDescription(
          buildHeader("🎮", "Match Ranking", "No active match") +
            `There is no match data available.` +
            buildFooter(),
        );
      }

      const players = mapPlayers(match.players || {});
      const statusText = match.status === "active" ? "Live match in progress" : "Final match result";
      const startedTs = Math.floor(new Date(match.startedAt).getTime() / 1000);
      const endedTs = match.endedAt ? Math.floor(new Date(match.endedAt).getTime() / 1000) : null;

      const embed = formatLeaderboardEmbed(players, {
        emoji: match.status === "active" ? "🎮" : "🏁",
        title: match.status === "active" ? "Match Ranking" : "Final Match Ranking",
        subtitle: `${statusText} • Started <t:${startedTs}:f>${endedTs ? ` • Ended <t:${endedTs}:f>` : ""}`,
        color: match.status === "active" ? "#00FF88" : "#FFD700",
      });

      return embed;
    }

    async function updateMatchRanking(state: any) {
      if (!state.activeMatch?.channelId) return;

      try {
        const channel = await client.channels.fetch(state.activeMatch.channelId);
        if (!channel || !("send" in channel)) return;

        const key = `match_${state.activeMatch.id}_ranking`;
        await sendOrEdit(state, channel as any, key, createMatchEmbed(state));
        state.activeMatch.messageId = state.discordMessageIds?.[key];
      } catch (err) {
        console.error("❌ erro ao atualizar ranking da match", err);
      }
    }

    function resetDaily(state: any) {
      state.dailyPlayers = {};
      state.dailyStartedAt = new Date().toISOString().slice(0, 10);
      state.lastDailyReset = state.dailyStartedAt;
    }

    function resetWeekly(state: any) {
      state.weeklyPlayers = {};
      state.weeklyStartedAt = new Date().toISOString().slice(0, 10);
      state.lastWeeklyReset = state.weeklyStartedAt;
    }

    function resetStreaks(state: any) {
      state.currentKillStreaks = {};
      state.killStreakEvents = [];
    }

    function wipePlayer(state: any, playerName: string) {
      const collections = [
        state.players,
        state.dailyPlayers,
        state.weeklyPlayers,
        state.currentKillStreaks,
        state.onlinePlayers,
      ];

      for (const collection of collections) {
        const key = findPlayerKey(collection, playerName);
        if (key) delete collection[key];
      }

      if (state.activeMatch?.players) {
        const key = findPlayerKey(state.activeMatch.players, playerName);
        if (key) delete state.activeMatch.players[key];
      }
    }

    async function assertAdmin(interaction: any) {
      if (
        !interaction.memberPermissions?.has(
          PermissionsBitField.Flags.Administrator,
        )
      ) {
        await interaction.reply({
          content: "❌ Only administrators can use this command.",
          ephemeral: true,
        });

        return false;
      }

      return true;
    }

    async function registerCommands() {
      try {
        const adminPermission = PermissionsBitField.Flags.Administrator.toString();

        const commands = [
          {
            name: "reset-ranking",
            description: "Reset all rankings without reprocessing old logs.",
            defaultMemberPermissions: adminPermission,
            dmPermission: false,
          },
          {
            name: "start-match",
            description: "Start a new tracked match and create its private ranking channel.",
            defaultMemberPermissions: adminPermission,
            dmPermission: false,
            options: [
              {
                name: "password",
                description: "Optional server password. If provided, the bot applies it and restarts the server.",
                type: 3,
                required: false,
              },
            ],
          },
          {
            name: "stop-match",
            description: "Stop the active match and freeze its ranking.",
            defaultMemberPermissions: adminPermission,
            dmPermission: false,
          },
          {
            name: "delete-match",
            description: "Delete the active/finished match channel and match data.",
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
            description: "Wipe all competitive stats while keeping parser/message infrastructure.",
            defaultMemberPermissions: adminPermission,
            dmPermission: false,
          },
          {
            name: "wipe-player",
            description: "Remove one player from rankings, streaks and active match.",
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

        if (process.env.DISCORD_SERVER_ID) {
          const guild = await client.guilds.fetch(
            process.env.DISCORD_SERVER_ID,
          );

          await guild.commands.set(commands);
        } else {
          await client.application?.commands.set(commands);
        }
      } catch (err) {
        console.error("❌ erro registrando comandos:", err);
      }
    }

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      try {
        if (interaction.commandName === "player-stats") {
          const player = interaction.options.getString("player", true);
          const state = await getState();

          await interaction.reply({
            embeds: [createPlayerStatsEmbed(state, player)],
            ephemeral: true,
          });

          return;
        }

        if (!(await assertAdmin(interaction))) return;

        await interaction.deferReply({ ephemeral: true });

        if (interaction.commandName === "reset-ranking") {
          await resetRankings();
          await updateLeaderboard();
          await interaction.editReply("✅ Rankings successfully reset.");
          return;
        }

        if (interaction.commandName === "start-match") {
          const state = await getState();
          const password = interaction.options.getString("password", false)?.trim();

          if (state.activeMatch) {
            await interaction.editReply(
              `❌ There is already a match saved: ${state.activeMatch.name}. Use /stop-match or /delete-match before starting another one.`,
            );
            return;
          }

          const guild = interaction.guild;
          if (!guild) {
            await interaction.editReply("❌ This command must be used inside a server.");
            return;
          }

          if (password) {
            await interaction.editReply("🔒 Applying server password and restarting the server...");
            await applyServerPassword(password);
            await restartNitradoServer();
          }

          const date = new Date().toISOString().slice(0, 10);
          const id = `${Date.now()}`;
          const channelName = `match-${date}`;
          const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: process.env.DISCORD_MATCH_CATEGORY_ID || undefined,
            permissionOverwrites: [
              {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel],
              },
              {
                id: interaction.user.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
              },
              {
                id: client.user!.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.ManageChannels,
                ],
              },
            ],
          });

          state.activeMatch = {
            id,
            name: channelName,
            channelId: channel.id,
            startedAt: new Date().toISOString(),
            status: "active",
            players: {},
            serverPasswordApplied: Boolean(password),
            password: password || undefined,
          };

          await updateMatchRanking(state);
          await saveState(state);

          await interaction.editReply(
            password
              ? `✅ Match started in <#${channel.id}>. Server password applied and restart requested.`
              : `✅ Match started in <#${channel.id}>. No server password was applied.`,
          );
          return;
        }

        if (interaction.commandName === "stop-match") {
          const state = await getState();

          if (!state.activeMatch) {
            await interaction.editReply("❌ There is no match to stop.");
            return;
          }

          if (state.activeMatch.status === "finished") {
            await interaction.editReply("⚠️ The current match is already finished.");
            return;
          }

          const hadServerPassword = Boolean(state.activeMatch.serverPasswordApplied);

          if (hadServerPassword) {
            await interaction.editReply("🔓 Removing server password and restarting the server...");
            await removeServerPassword();
            await restartNitradoServer();
          }

          state.activeMatch.status = "finished";
          state.activeMatch.endedAt = new Date().toISOString();
          state.activeMatch.serverPasswordApplied = false;
          delete state.activeMatch.password;

          await updateMatchRanking(state);
          await saveState(state);
          await interaction.editReply(
            hadServerPassword
              ? "🏁 Match stopped, ranking frozen, password removed and restart requested."
              : "🏁 Match stopped and ranking frozen.",
          );
          return;
        }

        if (interaction.commandName === "delete-match") {
          const state = await getState();

          if (!state.activeMatch) {
            await interaction.editReply("❌ There is no match to delete.");
            return;
          }

          try {
            const channel = await client.channels.fetch(state.activeMatch.channelId);
            if (channel && "delete" in channel) {
              await (channel as any).delete();
            }
          } catch (err) {
            console.error("❌ erro deletando canal da match", err);
          }

          const matchKeyPrefix = `match_${state.activeMatch.id}_`;
          for (const key of Object.keys(state.discordMessageIds || {})) {
            if (key.startsWith(matchKeyPrefix)) {
              delete state.discordMessageIds[key];
            }
          }

          state.activeMatch = null;
          await saveState(state);
          await interaction.editReply("🗑️ Match channel and data deleted.");
          return;
        }

        if (interaction.commandName === "wipe-daily") {
          const state = await getState();
          resetDaily(state);
          await saveState(state);
          await updateLeaderboard();
          await interaction.editReply("✅ Daily ranking wiped.");
          return;
        }

        if (interaction.commandName === "wipe-weekly") {
          const state = await getState();
          resetWeekly(state);
          await saveState(state);
          await updateLeaderboard();
          await interaction.editReply("✅ Weekly ranking wiped.");
          return;
        }

        if (interaction.commandName === "wipe-streaks") {
          const state = await getState();
          resetStreaks(state);
          await saveState(state);
          await updateLeaderboard();
          await interaction.editReply("✅ Kill streaks wiped.");
          return;
        }

        if (interaction.commandName === "wipe-all") {
          await resetRankings();
          await updateLeaderboard();
          await interaction.editReply("✅ All competitive stats wiped.");
          return;
        }

        if (interaction.commandName === "wipe-player") {
          const player = interaction.options.getString("player", true);
          const state = await getState();
          wipePlayer(state, player);
          await saveState(state);
          await updateLeaderboard();
          await interaction.editReply(`✅ Player wiped: ${player}`);
          return;
        }
      } catch (err) {
        console.error("❌ erro processando comando Discord:", err);

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("❌ Command failed.");
        } else {
          await interaction.reply({
            content: "❌ Command failed.",
            ephemeral: true,
          });
        }
      }
    });

    await registerCommands();
    await updateLeaderboard();

    setInterval(
      async () => {
        await updateLeaderboard();
      },
      5 * 60 * 1000,
    );
  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
