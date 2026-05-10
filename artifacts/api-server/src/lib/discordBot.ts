import {
  Client,
  GatewayIntentBits,
  TextBasedChannel,
  EmbedBuilder,
  PermissionsBitField,
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

  if (state.activeMatch) {
    state.activeMatch.players = state.activeMatch.players || {};
  }

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

    function sanitizeChannelName(value: string) {
      return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    }

    function createMatchChannelName() {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = now.toISOString().slice(11, 16).replace(":", "-");
      return sanitizeChannelName(`match-${date}-${time}`);
    }

    function getUnixTimestamp(dateString?: string) {
      const time = dateString ? new Date(dateString).getTime() : Date.now();
      return Math.floor(time / 1000);
    }

    function formatDuration(startedAt?: string, endedAt?: string) {
      if (!startedAt) return "Unknown";

      const start = new Date(startedAt).getTime();
      const end = endedAt ? new Date(endedAt).getTime() : Date.now();
      const minutes = Math.max(0, Math.floor((end - start) / 60000));

      if (minutes < 60) return `${minutes} min`;

      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return `${hours}h ${rest}m`;
    }

    function getRankPosition(players: any[], playerName: string) {
      const index = players.findIndex(
        (p) => p.name.toLowerCase() === playerName.toLowerCase(),
      );

      return index >= 0 ? index + 1 : null;
    }

    function findPlayerName(state: any, query: string) {
      const normalized = query.trim().toLowerCase();
      const pools = [
        state.players || {},
        state.dailyPlayers || {},
        state.weeklyPlayers || {},
        state.currentKillStreaks || {},
        state.onlinePlayers || {},
        state.activeMatch?.players || {},
      ];

      for (const pool of pools) {
        const match = Object.keys(pool).find(
          (name) => name.toLowerCase() === normalized,
        );
        if (match) return match;
      }

      for (const pool of pools) {
        const match = Object.keys(pool).find((name) =>
          name.toLowerCase().includes(normalized),
        );
        if (match) return match;
      }

      return query.trim();
    }

    function getPlayerStatsLine(stats: any) {
      const kills = Number(stats?.kills || 0);
      const deaths = Number(stats?.deaths || 0);
      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);

      return { kills, deaths, kd };
    }

    function formatPlayerStatsEmbed(state: any, playerQuery: string) {
      const player = findPlayerName(state, playerQuery);
      const globalStats = state.players?.[player];
      const dailyStats = state.dailyPlayers?.[player];
      const weeklyStats = state.weeklyPlayers?.[player];
      const matchStats = state.activeMatch?.players?.[player];

      const globalPlayers = mapPlayers(state.players);
      const dailyPlayers = mapPlayers(state.dailyPlayers);
      const weeklyPlayers = mapPlayers(state.weeklyPlayers);
      const matchPlayers = mapPlayers(state.activeMatch?.players || {});

      if (!globalStats && !dailyStats && !weeklyStats && !matchStats) {
        return createBaseEmbed("#FF3333").setDescription(
          buildHeader("🔎", "Player Stats", `Search: ${playerQuery}`) +
            `**Player not found**\nNo stats found for \`${playerQuery}\`.` +
            buildFooter(),
        );
      }

      const global = getPlayerStatsLine(globalStats);
      const daily = getPlayerStatsLine(dailyStats);
      const weekly = getPlayerStatsLine(weeklyStats);
      const match = getPlayerStatsLine(matchStats);
      const currentStreak = Number(state.currentKillStreaks?.[player] || 0);
      const online = Boolean(state.onlinePlayers?.[player]);

      const globalRank = getRankPosition(globalPlayers, player);
      const dailyRank = getRankPosition(dailyPlayers, player);
      const weeklyRank = getRankPosition(weeklyPlayers, player);
      const matchRank = getRankPosition(matchPlayers, player);

      let description = buildHeader(
        "📊",
        "Player Stats",
        `Detailed stats for **${player}**`,
      );

      description +=
        `**Status:** ${online ? "🟢 Online" : "⚫ Offline"}\n` +
        `**Current Streak:** ${currentStreak} kill${currentStreak === 1 ? "" : "s"}\n\n` +
        `🏆 **Global**\n` +
        `Kills: **${global.kills}** • Deaths: **${global.deaths}** • K/D: **${global.kd}**${globalRank ? ` • Rank: **#${globalRank}**` : ""}\n\n` +
        `🌅 **Daily**\n` +
        `Kills: **${daily.kills}** • Deaths: **${daily.deaths}** • K/D: **${daily.kd}**${dailyRank ? ` • Rank: **#${dailyRank}**` : ""}\n\n` +
        `📆 **Weekly**\n` +
        `Kills: **${weekly.kills}** • Deaths: **${weekly.deaths}** • K/D: **${weekly.kd}**${weeklyRank ? ` • Rank: **#${weeklyRank}**` : ""}`;

      if (state.activeMatch) {
        description +=
          `\n\n🎮 **Current Match**\n` +
          `Kills: **${match.kills}** • Deaths: **${match.deaths}** • K/D: **${match.kd}**${matchRank ? ` • Rank: **#${matchRank}**` : ""}`;
      }

      description += buildFooter();

      return createBaseEmbed("#0099FF").setDescription(description);
    }

    function formatMatchRankingEmbed(match: any) {
      const players = mapPlayers(match?.players || {});
      const status = match?.status === "finished" ? "Finished" : "Live";
      const statusEmoji = match?.status === "finished" ? "🏁" : "🎮";
      const startedTs = getUnixTimestamp(match?.startedAt);
      const endedTs = match?.endedAt ? getUnixTimestamp(match.endedAt) : null;

      const embed = createBaseEmbed(match?.status === "finished" ? "#FFD700" : "#00FF88");

      let description = buildHeader(
        statusEmoji,
        `Match Ranking (${status})`,
        `${match?.name || "Match"} • Started <t:${startedTs}:R>`,
      );

      if (match?.status === "finished" && endedTs) {
        description += `🏁 Finished <t:${endedTs}:R> • Duration: **${formatDuration(
          match.startedAt,
          match.endedAt,
        )}**\n\n`;
      }

      if (!players.length) {
        description += `**No kills registered yet**\nKills during this match will appear here.\n`;
      } else {
        const maxName = Math.min(
          Math.max(...players.map((p) => p.name.length)),
          18,
        );
        const maxKillsLength = Math.max(
          ...players.map((p) => `${p.kills} kills`.length),
        );
        const KD_WIDTH = 8;

        players.slice(0, 10).forEach((p, i) => {
          const rank = getRank(i);
          const trimmedName =
            p.name.length > maxName
              ? p.name.slice(0, maxName - 1) + "…"
              : p.name;
          const name = padEnd(trimmedName, maxName);
          const killsText = `${p.kills} kills`;
          const kills = padStart(killsText, maxKillsLength);
          const kd =
            p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
          const kdText = `K/D ${kd}`;
          const kdFormatted = padStart(kdText, KD_WIDTH);

          description += `${rank} \`${name}\` \`${kills}\` \`${kdFormatted}\`\n\n`;
        });
      }

      description += buildFooter();

      return embed.setDescription(description);
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

      const list = players.map((name) => `• ${name}`).join("\n");

      embed.setDescription(
        buildHeader(
          "🟢",
          "Players Online",
          `${players.length}/10 survivors currently connected`,
        ) +
          `${list}` +
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
        ) + `Tracking the latest PvP activity across the server.`,
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

    async function updateMatchRanking(state: any) {
      if (!state.activeMatch?.channelId) return;

      try {
        const channel = (await client.channels.fetch(
          state.activeMatch.channelId,
        )) as TextBasedChannel | null;

        if (!channel) return;

        await sendOrEdit(
          state,
          channel,
          "message_active_match.json",
          formatMatchRankingEmbed(state.activeMatch),
        );

        state.activeMatch.messageId =
          state.discordMessageIds?.["message_active_match.json"] ||
          state.activeMatch.messageId;
      } catch (err) {
        console.error("❌ erro ao atualizar ranking da match", err);
      }
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

    function adminOnlyCommand(name: string, description: string, options: any[] = []) {
      return {
        name,
        description,
        defaultMemberPermissions:
          PermissionsBitField.Flags.Administrator.toString(),
        dmPermission: false,
        options,
      };
    }

    async function registerCommands() {
      try {
        const commands = [
          adminOnlyCommand(
            "reset-ranking",
            "Reset all rankings without reprocessing old logs.",
          ),
          adminOnlyCommand("start-match", "Start a match and create its ranking channel."),
          adminOnlyCommand("stop-match", "Stop the active match and freeze its ranking."),
          adminOnlyCommand("delete-match", "Delete the active/finished match channel and data."),
          adminOnlyCommand("wipe-daily", "Reset only the daily ranking."),
          adminOnlyCommand("wipe-weekly", "Reset only the weekly ranking."),
          adminOnlyCommand("wipe-streaks", "Reset kill streaks and streak feed."),
          adminOnlyCommand("wipe-all", "Reset all rankings, feeds, streaks and active match data."),
          adminOnlyCommand("wipe-player", "Remove a player from all rankings and streaks.", [
            {
              name: "player",
              description: "Player name to wipe.",
              type: 3,
              required: true,
            },
          ]),
          {
            name: "player-stats",
            description: "Show player stats.",
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
        console.error("❌ erro registrando slash commands:", err);
      }
    }

    function isAdminInteraction(interaction: any) {
      return interaction.memberPermissions?.has(
        PermissionsBitField.Flags.Administrator,
      );
    }

    async function requireAdmin(interaction: any) {
      if (isAdminInteraction(interaction)) return true;

      await interaction.reply({
        content: "❌ Only administrators can use this command.",
        ephemeral: true,
      });

      return false;
    }

    async function handleStartMatch(interaction: any) {
      if (!(await requireAdmin(interaction))) return;

      await interaction.deferReply({ ephemeral: true });

      const state = await getState();

      if (state.activeMatch?.status === "active") {
        await interaction.editReply(
          `❌ There is already an active match: <#${state.activeMatch.channelId}>`,
        );
        return;
      }

      const guild = interaction.guild ||
        (process.env.DISCORD_SERVER_ID
          ? await client.guilds.fetch(process.env.DISCORD_SERVER_ID)
          : null);

      if (!guild) {
        await interaction.editReply("❌ Could not resolve the Discord server.");
        return;
      }

      const channelName = createMatchChannelName();
      const channelOptions: any = {
        name: channelName,
        type: ChannelType.GuildText,
        reason: "DayZ match started by bot command",
      };

      if (process.env.DISCORD_MATCH_CATEGORY_ID) {
        channelOptions.parent = process.env.DISCORD_MATCH_CATEGORY_ID;
      }

      const channel = await guild.channels.create(channelOptions);
      const now = new Date().toISOString();

      state.activeMatch = {
        id: `match-${Date.now()}`,
        name: channelName,
        channelId: channel.id,
        startedAt: now,
        status: "active",
        players: {},
      };

      await sendOrEdit(
        state,
        channel,
        "message_active_match.json",
        formatMatchRankingEmbed(state.activeMatch),
      );

      state.activeMatch.messageId = state.discordMessageIds["message_active_match.json"];

      await saveState(state);

      await interaction.editReply(`✅ Match started: <#${channel.id}>`);
    }

    async function handleStopMatch(interaction: any) {
      if (!(await requireAdmin(interaction))) return;

      await interaction.deferReply({ ephemeral: true });

      const state = await getState();

      if (!state.activeMatch) {
        await interaction.editReply("❌ There is no active match to stop.");
        return;
      }

      if (state.activeMatch.status === "finished") {
        await interaction.editReply("❌ The current match is already finished.");
        return;
      }

      state.activeMatch.status = "finished";
      state.activeMatch.endedAt = new Date().toISOString();

      await updateMatchRanking(state);
      await saveState(state);

      await interaction.editReply(
        `🏁 Match finished: <#${state.activeMatch.channelId}>`,
      );
    }

    async function handleDeleteMatch(interaction: any) {
      if (!(await requireAdmin(interaction))) return;

      await interaction.deferReply({ ephemeral: true });

      const state = await getState();

      if (!state.activeMatch) {
        await interaction.editReply("❌ There is no match to delete.");
        return;
      }

      const channelId = state.activeMatch.channelId;

      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && "delete" in channel) {
          await (channel as any).delete("DayZ match deleted by bot command");
        }
      } catch (err) {
        console.error("❌ erro deletando canal da match", err);
      }

      delete state.activeMatch;
      delete state.discordMessageIds["message_active_match.json"];

      await saveState(state);

      await interaction.editReply("🗑️ Match deleted.");
    }

    async function handleWipeDaily(interaction: any) {
      if (!(await requireAdmin(interaction))) return;
      await interaction.deferReply({ ephemeral: true });

      const state = await getState();
      state.dailyPlayers = {};
      state.dailyStartedAt = new Date().toISOString().slice(0, 10);
      state.lastDailyReset = state.dailyStartedAt;

      await saveState(state);
      await updateLeaderboard();
      await interaction.editReply("✅ Daily ranking wiped.");
    }

    async function handleWipeWeekly(interaction: any) {
      if (!(await requireAdmin(interaction))) return;
      await interaction.deferReply({ ephemeral: true });

      const state = await getState();
      state.weeklyPlayers = {};
      state.weeklyStartedAt = new Date().toISOString().slice(0, 10);
      state.lastWeeklyReset = state.weeklyStartedAt;

      await saveState(state);
      await updateLeaderboard();
      await interaction.editReply("✅ Weekly ranking wiped.");
    }

    async function handleWipeStreaks(interaction: any) {
      if (!(await requireAdmin(interaction))) return;
      await interaction.deferReply({ ephemeral: true });

      const state = await getState();
      state.currentKillStreaks = {};
      state.killStreakEvents = [];

      await saveState(state);
      await updateLeaderboard();
      await interaction.editReply("✅ Kill streaks wiped.");
    }

    async function handleWipePlayer(interaction: any) {
      if (!(await requireAdmin(interaction))) return;
      await interaction.deferReply({ ephemeral: true });

      const state = await getState();
      const playerInput = interaction.options.getString("player", true);
      const player = findPlayerName(state, playerInput);

      delete state.players[player];
      delete state.dailyPlayers[player];
      delete state.weeklyPlayers[player];
      delete state.currentKillStreaks[player];
      delete state.onlinePlayers[player];

      if (state.activeMatch?.players) {
        delete state.activeMatch.players[player];
      }

      state.killStreakEvents = (state.killStreakEvents || []).filter(
        (event: any) =>
          event.player?.toLowerCase() !== player.toLowerCase() &&
          event.killer?.toLowerCase() !== player.toLowerCase(),
      );

      state.killFeedEvents = (state.killFeedEvents || []).filter(
        (event: any) =>
          event.killer?.toLowerCase() !== player.toLowerCase() &&
          event.victim?.toLowerCase() !== player.toLowerCase(),
      );

      await saveState(state);
      await updateLeaderboard();

      await interaction.editReply(`✅ Player wiped: ${player}`);
    }

    async function handleWipeAll(interaction: any) {
      if (!(await requireAdmin(interaction))) return;
      await interaction.deferReply({ ephemeral: true });

      const state = await getState();
      const today = new Date().toISOString().slice(0, 10);

      state.players = {};
      state.dailyPlayers = {};
      state.weeklyPlayers = {};
      state.onlinePlayers = {};
      state.killFeedEvents = [];
      state.currentKillStreaks = {};
      state.killStreakEvents = [];
      delete state.activeMatch;

      state.globalStartedAt = today;
      state.dailyStartedAt = today;
      state.weeklyStartedAt = today;
      state.lastDailyReset = today;
      state.lastWeeklyReset = today;

      await saveState(state);
      await updateLeaderboard();

      await interaction.editReply("✅ All rankings, feeds, streaks and active match data wiped.");
    }

    async function handlePlayerStats(interaction: any) {
      const player = interaction.options.getString("player", true);
      const state = await getState();

      await interaction.reply({
        embeds: [formatPlayerStatsEmbed(state, player)],
        ephemeral: true,
      });
    }

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      try {
        switch (interaction.commandName) {
          case "reset-ranking":
            if (!(await requireAdmin(interaction))) return;
            await interaction.deferReply({ ephemeral: true });
            await resetRankings();
            await updateLeaderboard();
            await interaction.editReply("✅ Rankings successfully reset.");
            return;
          case "start-match":
            await handleStartMatch(interaction);
            return;
          case "stop-match":
            await handleStopMatch(interaction);
            return;
          case "delete-match":
            await handleDeleteMatch(interaction);
            return;
          case "wipe-daily":
            await handleWipeDaily(interaction);
            return;
          case "wipe-weekly":
            await handleWipeWeekly(interaction);
            return;
          case "wipe-streaks":
            await handleWipeStreaks(interaction);
            return;
          case "wipe-all":
            await handleWipeAll(interaction);
            return;
          case "wipe-player":
            await handleWipePlayer(interaction);
            return;
          case "player-stats":
            await handlePlayerStats(interaction);
            return;
          default:
            return;
        }
      } catch (err) {
        console.error(`❌ erro no /${interaction.commandName}:`, err);

        const message = "❌ Command failed.";

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(message);
        } else {
          await interaction.reply({ content: message, ephemeral: true });
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
