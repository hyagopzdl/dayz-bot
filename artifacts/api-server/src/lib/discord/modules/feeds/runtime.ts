import { Client, TextBasedChannel, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";
import {
  BOT_ICON,
  BOT_NAME,
  KILLFEED_MESSAGE_PREFIX,
  KILLFEED_PAGE_SIZE,
  KILLSTREAK_MAX_EVENTS,
  KILLSTREAK_MESSAGE_PREFIX,
  KILLSTREAK_PAGE_SIZE,
  LONGSHOT_MAX_EVENTS,
  LONGSHOT_MESSAGE_PREFIX,
  LONGSHOT_PAGE_SIZE,
  MESSAGE_FILE_DAILY,
  MESSAGE_FILE_GLOBAL,
  MESSAGE_FILE_LONGSHOT_RANKING,
  MESSAGE_FILE_ONLINE_LIST,
  MESSAGE_FILE_STREAK_RANKING,
  MESSAGE_FILE_WEEKLY,
} from "../../constants";
import { getKillStreakMeta } from "../killstreak/service";
import { getCoreStateFingerprint } from "../../../state";
import { getServerRuntimeContext } from "../../../serverRuntime";

type DiscordFeedRuntimeContext = {
  serverId: string;
  client: Client;
  categoryId: string;
  globalChannel: TextBasedChannel;
  dailyChannel: TextBasedChannel;
  weeklyChannel: TextBasedChannel;
  onlineListChannel: TextBasedChannel | null;
  killfeedChannel: TextBasedChannel | null;
  killStreakChannel: TextBasedChannel | null;
  longShotChannel: TextBasedChannel | null;
  longShotRankingChannel: TextBasedChannel | null;
  streakRankingChannel: TextBasedChannel | null;
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
  saveRuntimeState: (state: any) => Promise<void>;
};

const discordLoopRunningServers = new Set<string>();

export function createDiscordFeedRuntime(ctx: DiscordFeedRuntimeContext) {
  const {
    serverId,
    client,
    categoryId: CATEGORY_ID,
    globalChannel,
    dailyChannel,
    weeklyChannel,
    onlineListChannel,
    killfeedChannel,
    killStreakChannel,
    longShotChannel,
    longShotRankingChannel,
    streakRankingChannel,
    getState,
    saveState,
    saveRuntimeState,
  } = ctx;

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

function getBrazilDateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};

  parts.forEach((part) => {
    map[part.type] = part.value;
  });

  return `${map.year}-${map.month}-${map.day}`;
}

function getBrazilWeekKey(date = new Date()) {
  const dateKey = getBrazilDateKey(date);
  const [year, month, day] = dateKey.split("-").map(Number);

  const localDate = new Date(year, month - 1, day, 0, 0, 0);
  const weekDay = localDate.getDay();
  const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;

  const monday = new Date(localDate);
  monday.setDate(localDate.getDate() + diffToMonday);

  const mondayYear = monday.getFullYear();
  const mondayMonth = String(monday.getMonth() + 1).padStart(2, "0");
  const mondayDay = String(monday.getDate()).padStart(2, "0");

  return `${mondayYear}-${mondayMonth}-${mondayDay}`;
}

async function resetRankings() {
  const state = await getState();

  const discordMessageIds = state.discordMessageIds || {};
  const files = state.files || {};
  const recentEventIds = state.recentEventIds || [];
  const lastLine = state.lastLine;
  const lastFileName = state.lastFileName;

  const today = getBrazilDateKey();
  const currentWeek = getBrazilWeekKey();

  state.players = {};
  state.dailyPlayers = {};
  state.weeklyPlayers = {};
  state.killFeedEvents = [];
  state.currentKillStreaks = {};
  state.killStreakEvents = [];
  state.longShotEvents = [];
  state.onlinePlayers = {};
  state.onlineSessions = {};
  state.activeMatch = null;

  state.globalStartedAt = today;
  state.dailyStartedAt = today;
  state.weeklyStartedAt = today;
  state.lastDailyReset = today;
  state.lastWeeklyReset = currentWeek;

  state.files = files;
  state.recentEventIds = recentEventIds;
  state.lastLine = lastLine;
  state.lastFileName = lastFileName;
  state.discordMessageIds = discordMessageIds;

  markCurrentAdmFilesAsProcessed(state);

  await saveState(state);
}

function mapPlayers(obj: any) {
  return Object.entries(obj || {})
    .map(([name, d]: any) => ({ name, ...d }))
    .sort((a, b) => b.kills - a.kills);
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeDisplayPlayerName(name: string) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findNormalizedKey(record: Record<string, any>, player: string) {
  const normalized = normalizeDisplayPlayerName(player);

  return (
    Object.keys(record || {}).find(
      (name) => normalizeDisplayPlayerName(name) === normalized,
    ) || null
  );
}

function formatSessionKd(kills: number, deaths: number) {
  if (deaths <= 0) {
    return kills > 0 ? kills.toFixed(2) : "0.00";
  }

  return (kills / deaths).toFixed(2);
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
        `**No data available yet**\nNenhum dado disponível ainda.` +
        `\n\u200B\n\u200B\n` +
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

function getBestLongShots(state: any) {
  const unique = new Map<string, any>();

  for (const event of state.longShotEvents || []) {
    const killer = event?.killer || "Unknown";
    const victim = event?.victim || "Unknown";
    const weapon = formatWeapon(event?.weapon);
    const distance = Math.round(Number(event?.distance || 0));
    const timestamp = Number(event?.timestamp || 0);

    if (!distance || distance < 100) continue;

    const key = `${killer}:${victim}:${weapon}:${distance}:${timestamp}`;
    unique.set(key, { killer, victim, weapon, distance, timestamp });
  }

  return [...unique.values()]
    .sort((a, b) => Number(b.distance || 0) - Number(a.distance || 0))
    .slice(0, 10);
}

function getBestStreaks(state: any) {
  const bestByPlayer = new Map<string, number>();

  for (const event of state.killStreakEvents || []) {
    if (event?.type !== "streak") continue;

    const player = event.player || "Unknown";
    const streak = Number(event.streak || 0);

    if (streak > Number(bestByPlayer.get(player) || 0)) {
      bestByPlayer.set(player, streak);
    }
  }

  for (const [player, streak] of Object.entries(
    state.currentKillStreaks || {},
  )) {
    const value = Number(streak || 0);

    if (value > Number(bestByPlayer.get(player) || 0)) {
      bestByPlayer.set(player, value);
    }
  }

  return [...bestByPlayer.entries()]
    .map(([player, streak]) => ({ player, streak }))
    .sort((a, b) => Number(b.streak || 0) - Number(a.streak || 0))
    .slice(0, 10);
}

function createLongShotRankingEmbed(state: any) {
  const records = getBestLongShots(state);
  const embed = createBaseEmbed("#A020F0");

  if (!records.length) {
    embed.setDescription(
      buildHeader("🎯", "Long Shot Ranking", "Top distance eliminations.") +
        `**No long shots yet**\nNenhum long shot registrado ainda.` +
        `\n\u200B\n\u200B\n` +
        buildFooter(),
    );

    return embed;
  }

  const maxName = Math.min(
    Math.max(...records.map((record) => record.killer.length)),
    18,
  );

  const maxDistance = Math.max(
    ...records.map((record) => `${record.distance}m`.length),
  );

  let description = buildHeader(
    "🎯",
    "Long Shot Ranking",
    `${records.length} top long shot${records.length === 1 ? "" : "s"}.`,
  );

  records.forEach((record, index) => {
    const rank = getRank(index);
    const trimmedName =
      record.killer.length > maxName
        ? record.killer.slice(0, maxName - 1) + "…"
        : record.killer;

    const name = padEnd(trimmedName, maxName);
    const distance = padStart(`${record.distance}m`, maxDistance);
    const weapon = formatWeapon(record.weapon);

    description += `${rank} \`${name}\` \`${distance}\` \`${weapon}\`\n\n`;
  });

  description += buildFooter();

  embed.setDescription(description);

  return embed;
}

function createStreakRankingEmbed(state: any) {
  const records = getBestStreaks(state);
  const embed = createBaseEmbed("#FF4FD8");

  if (!records.length) {
    embed.setDescription(
      buildHeader("🔥", "Streaks Ranking", "Top kill streak records.") +
        `**No streak records yet**\nNenhum recorde de streak ainda.` +
        `\n\u200B\n\u200B\n` +
        buildFooter(),
    );

    return embed;
  }

  const maxName = Math.min(
    Math.max(...records.map((record) => record.player.length)),
    18,
  );

  const maxStreak = Math.max(
    ...records.map((record) => `${record.streak}x Streak`.length),
  );

  let description = buildHeader(
    "🔥",
    "Streaks Ranking",
    `${records.length} top streak record${records.length === 1 ? "" : "s"}.`,
  );

  records.forEach((record, index) => {
    const rank = getRank(index);
    const trimmedName =
      record.player.length > maxName
        ? record.player.slice(0, maxName - 1) + "…"
        : record.player;

    const name = padEnd(trimmedName, maxName);
    const streak = padStart(`${record.streak}x Streak`, maxStreak);

    description += `${rank} \`${name}\` \`${streak}\`\n\n`;
  });

  description += buildFooter();

  embed.setDescription(description);

  return embed;
}

function cleanupOnlineGhosts(state: any) {
  state.onlinePlayers = state.onlinePlayers || {};

  const now = Date.now();
  const maxOnlineAgeMs = 12 * 60 * 60 * 1000;

  for (const [player, data] of Object.entries(state.onlinePlayers || {})) {
    const info = data as any;

    if (!info?.online) {
      delete state.onlinePlayers[player];
      continue;
    }

    const lastSeen = new Date(
      info.lastSeenAt || info.connectedAt || 0,
    ).getTime();

    if (!lastSeen || now - lastSeen > maxOnlineAgeMs) {
      delete state.onlinePlayers[player];
      console.log(`🧹 removendo online fantasma: ${player}`);
    }
  }
}

function getOnlinePlayerNames(state: any) {
  return Object.keys(state.onlinePlayers || {})
    .filter((name) => {
      const player = state.onlinePlayers?.[name] as any;

      if (player === true) return true;

      return Boolean(player?.online);
    })
    .sort((a, b) => a.localeCompare(b));
}

function formatOnlineListEmbed(state: any) {
  const players = getOnlinePlayerNames(state);
  const embed = createBaseEmbed("#00FF88");

  if (!players.length) {
    embed.setDescription(
      buildHeader("🟢", "Players Online", "Live server activity") +
        `**No players online**\nNenhum jogador online no momento.` +
        `\n\u200B\n\u200B\n` +
        buildFooter(),
    );

    return embed;
  }

  const lines = players
    .map((name) => {
      const onlineKey = findPlayerKey(state.onlinePlayers, name) || name;
      const rawOnlinePlayer = state.onlinePlayers?.[onlineKey];
      const onlinePlayer =
        rawOnlinePlayer === true
          ? {
              online: true,
              connectedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            }
          : rawOnlinePlayer || {};

      const sessionKey =
        findNormalizedKey(state.onlineSessions || {}, name) ||
        findPlayerKey(state.onlineSessions || {}, name) ||
        onlineKey;
      const onlineSession = state.onlineSessions?.[sessionKey] || {};

      const session = getOnlineSessionTime({
        connectedAt: onlineSession.connectedAt || onlinePlayer.connectedAt,
        lastSeenAt: onlineSession.lastSeenAt || onlinePlayer.lastSeenAt,
      });

      const sessionKills = Number(onlineSession.kills || 0);
      const sessionDeaths = Number(onlineSession.deaths || 0);
      const sessionKd = formatSessionKd(sessionKills, sessionDeaths);

      return (
        `**${name}**\n` +
        `Kill(s): \`${sessionKills}\` • ` +
        `Death(s): \`${sessionDeaths}\` • ` +
        `K/D: \`${sessionKd}\` • ` +
        `Session: \`${session}\``
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
      `\n\u200B\n` +
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

function longShotPageKey(pageIndex: number) {
  return `${LONGSHOT_MESSAGE_PREFIX}${pageIndex}.json`;
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
    ) +
      `Tracking the latest PvP activity across the server.` +
      `\n\u200B\n` +
      buildFooter(),
  );
}

function createKillFeedEmptyEmbed() {
  return createBaseEmbed("#FF3333").setDescription(
    buildHeader("🔫", "Kill Feed", "Live PvP activity") +
      `**No recent kills yet**\nNenhuma kill recente ainda.` +
      `\n\u200B\n\u200B\n` +
      buildFooter(),
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
      `**No streak events yet**\nNenhuma sequência registrada ainda.` +
      `\n\u200B\n\u200B\n` +
      buildFooter(),
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

function createLongShotEmptyEmbed() {
  return createBaseEmbed("#FF3333").setDescription(
    `\u200B\n` +
      `🎯 **Long Shot Feed**\n` +
      `Elite distance eliminations.\n` +
      `\u200B\n\u200B\n` +
      `**No long shots yet**\n` +
      `Nenhum long shot registrado ainda.\n` +
      `\n\u200B\n\u200B\n` +
      buildFooter(),
  );
}

function formatLongShotEmbed(event: any) {
  const timestamp = Number(
    event.timestamp || Math.floor(Date.now() / 1000),
  );

  const killer = event.killer || "Unknown";
  const victim = event.victim || "Unknown";
  const distance = Math.round(Number(event.distance || 0));
  const weapon = formatWeapon(event.weapon);

  return createBaseEmbed("#FF3333").setDescription(
    `\u200B\n` +
      `🎯 **Long Shot**\n\n` +
      `**${killer}** killed 💀 **${victim}**\n` +
      `at **${distance}m** with **${weapon}**\n` +
      `\u200B\n\u200B\n` +
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

async function deleteBotMessagesFromChannel(channel: any) {
  try {
    let deleted = 0;
    let before: string | undefined;

    for (let batch = 0; batch < 5; batch++) {
      const messages = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!messages.size) break;

      before = messages.last()?.id;

      for (const message of messages.values()) {
        if (message.author?.id !== client.user?.id) continue;

        try {
          await message.delete();
          deleted++;
        } catch {}
      }

      if (messages.size < 100) break;
    }

    console.log(`🧹 mensagens antigas do bot removidas: ${deleted}`);
  } catch (err) {
    console.error("❌ erro limpando mensagens antigas do canal", err);
  }
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
    const count = getOnlinePlayerNames(state).length;
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

  const events = [...(state.killFeedEvents || [])];

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

  const uniqueEventsMap = new Map<string, any>();

  for (const rawEvent of state.killStreakEvents || []) {
    const type = rawEvent?.type || "unknown";
    const player = rawEvent?.player || "Unknown";
    const killer = rawEvent?.killer || rawEvent?.endedBy || "";
    const streak = Number(rawEvent?.streak || 0);

    const timestamp = Number(
      rawEvent?.timestamp ||
        (rawEvent?.at
          ? Math.floor(new Date(rawEvent.at).getTime() / 1000)
          : 0),
    );

    if (!timestamp || Number.isNaN(timestamp)) continue;

    const key = `${type}:${player}:${killer}:${streak}:${timestamp}`;

    uniqueEventsMap.set(key, {
      ...rawEvent,
      type,
      player,
      killer,
      streak,
      timestamp,
    });
  }

  const events = [...uniqueEventsMap.values()]
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-KILLSTREAK_MAX_EVENTS);

  state.killStreakEvents = [...events];

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

async function updateLongShotFeed(state: any) {
  if (!longShotChannel) return;

  const uniqueEventsMap = new Map<string, any>();

  for (const rawEvent of state.longShotEvents || []) {
    const killer = rawEvent?.killer || "Unknown";
    const victim = rawEvent?.victim || "Unknown";
    const weapon = formatWeapon(rawEvent?.weapon);
    const distance = Math.round(Number(rawEvent?.distance || 0));

    const timestamp = Number(
      rawEvent?.timestamp ||
        (rawEvent?.at
          ? Math.floor(new Date(rawEvent.at).getTime() / 1000)
          : 0),
    );

    if (!timestamp || Number.isNaN(timestamp) || distance < 100) continue;

    const key = `${killer}:${victim}:${weapon}:${distance}:${timestamp}`;

    uniqueEventsMap.set(key, {
      ...rawEvent,
      killer,
      victim,
      weapon,
      distance,
      timestamp,
    });
  }

  const events = [...uniqueEventsMap.values()]
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-LONGSHOT_MAX_EVENTS);

  state.longShotEvents = [...events];

  if (!events.length) {
    await sendOrEdit(state, longShotChannel, longShotPageKey(0), [
      createLongShotEmptyEmbed(),
    ]);

    await deleteExtraPages(
      state,
      longShotChannel,
      1,
      LONGSHOT_MESSAGE_PREFIX,
    );

    return;
  }

  const pages = chunkArray(events, LONGSHOT_PAGE_SIZE);

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const embeds = pages[pageIndex].map(formatLongShotEmbed);

    await sendOrEdit(
      state,
      longShotChannel,
      longShotPageKey(pageIndex),
      embeds,
    );
  }

  await deleteExtraPages(
    state,
    longShotChannel,
    pages.length,
    LONGSHOT_MESSAGE_PREFIX,
  );
}

async function updateLeaderboard() {
  if (discordLoopRunningServers.has(serverId)) return;

  discordLoopRunningServers.add(serverId);

  try {
    const state = await getState();
    const coreBeforeFeedUpdate = getCoreStateFingerprint(state);

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
        title: "Global Ranking",
        subtitle: `${globalPlayers.length} player${globalPlayers.length === 1 ? "" : "s"} on the global ranking.`,
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
        color: "#0099FF",
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
        color: "#00FF88",
      }),
    );

    if (longShotRankingChannel) {
      await sendOrEdit(
        state,
        longShotRankingChannel,
        MESSAGE_FILE_LONGSHOT_RANKING,
        createLongShotRankingEmbed(state),
      );
    }

    if (streakRankingChannel) {
      await sendOrEdit(
        state,
        streakRankingChannel,
        MESSAGE_FILE_STREAK_RANKING,
        createStreakRankingEmbed(state),
      );
    }

    await updateOnlineCount(state);
    await updateOnlineList(state);
    await updateKillFeed(state);
    await updateKillStreakFeed(state);
    await updateLongShotFeed(state);
    await updateMatchRanking(state);

    // The feed loop normally changes only Discord runtime fields. Compare against the
    // snapshot taken at loop start so unrelated parser activity before this loop does
    // not force a 1.2 MB core write. If anything core actually changed during the loop
    // (including a concurrent parser mutation), keep the safe full-save path.
    const coreChangedDuringFeedUpdate = getCoreStateFingerprint(state) !== coreBeforeFeedUpdate;
    if (coreChangedDuringFeedUpdate) await saveState(state);
    else await saveRuntimeState(state);
  } catch (err) {
    console.error("❌ erro ao atualizar leaderboard", err);
  } finally {
    discordLoopRunningServers.delete(serverId);
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

function findPlayerName(state: any, query: string) {
  const normalized = query.toLowerCase();

  const pools = [
    state.players || {},
    state.dailyPlayers || {},
    state.weeklyPlayers || {},
    state.onlinePlayers || {},
  ];

  for (const pool of pools) {
    const found = Object.keys(pool).find(
      (name) => name.toLowerCase() === normalized,
    );

    if (found) return found;
  }

  for (const pool of pools) {
    const found = Object.keys(pool).find((name) =>
      name.toLowerCase().includes(normalized),
    );

    if (found) return found;
  }

  return null;
}

function getPlayerRank(playersObj: any, playerName: string) {
  const players = Object.entries(playersObj || {})
    .map(([name, data]: any) => ({
      name,
      kills: Number(data?.kills || 0),
    }))
    .filter((player) => player.kills > 0)
    .sort((a, b) => b.kills - a.kills);

  const index = players.findIndex((player) => player.name === playerName);

  return index >= 0 ? index + 1 : null;
}

function getBestStreakForPlayer(state: any, playerName: string) {
  const streakEvents = state.killStreakEvents || [];
  const bestFromEvents = streakEvents
    .filter((event: any) => event.player === playerName)
    .reduce(
      (max: number, event: any) => Math.max(max, Number(event.streak || 0)),
      0,
    );

  const current = Number(state.currentKillStreaks?.[playerName] || 0);

  return Math.max(bestFromEvents, current);
}

function getLongestShotForPlayer(state: any, playerName: string) {
  const events = state.longShotEvents || [];

  return (
    events
      .filter((event: any) => event.killer === playerName)
      .sort(
        (a: any, b: any) =>
          Number(b.distance || 0) - Number(a.distance || 0),
      )[0] || null
  );
}

function getFavoriteWeaponForPlayer(state: any, playerName: string) {
  const weaponCounts = new Map<string, number>();

  for (const event of state.killFeedEvents || []) {
    if (event.killer !== playerName) continue;

    const weapon = formatWeapon(event.weapon);

    if (!weapon || weapon.toLowerCase() === "unknown") continue;

    weaponCounts.set(weapon, (weaponCounts.get(weapon) || 0) + 1);
  }

  const sorted = [...weaponCounts.entries()].sort((a, b) => b[1] - a[1]);

  return sorted[0]?.[0] || null;
}

function getLongShotRank(state: any, playerName: string) {
  const bestByPlayer = new Map<string, number>();

  for (const event of state.longShotEvents || []) {
    const killer = event.killer;
    const distance = Number(event.distance || 0);

    if (!killer || distance <= 0) continue;

    bestByPlayer.set(
      killer,
      Math.max(bestByPlayer.get(killer) || 0, distance),
    );
  }

  const ranking = [...bestByPlayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([player]) => player);

  const index = ranking.indexOf(playerName);

  return index >= 0 ? index + 1 : null;
}

function getStreakRank(state: any, playerName: string) {
  const bestByPlayer = new Map<string, number>();

  for (const event of state.killStreakEvents || []) {
    const player = event.player;
    const streak = Number(event.streak || 0);

    if (!player || streak <= 0) continue;

    bestByPlayer.set(
      player,
      Math.max(bestByPlayer.get(player) || 0, streak),
    );
  }

  for (const [player, streak] of Object.entries(
    state.currentKillStreaks || {},
  )) {
    bestByPlayer.set(
      player,
      Math.max(bestByPlayer.get(player) || 0, Number(streak || 0)),
    );
  }

  const ranking = [...bestByPlayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([player]) => player);

  const index = ranking.indexOf(playerName);

  return index >= 0 ? index + 1 : null;
}

function createPlayerStatsEmbed(state: any, playerQuery: string) {
  const playerName = findPlayerName(state, playerQuery) || playerQuery;
  const stats = state.players?.[playerName] || { kills: 0, deaths: 0 };
  const dailyStats = state.dailyPlayers?.[playerName] || {
    kills: 0,
    deaths: 0,
  };
  const weeklyStats = state.weeklyPlayers?.[playerName] || {
    kills: 0,
    deaths: 0,
  };
  const onlineInfo = state.onlinePlayers?.[playerName];

  const kills = Number(stats.kills || 0);
  const deaths = Number(stats.deaths || 0);
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);

  const bestStreak = getBestStreakForPlayer(state, playerName);
  const longestShot = getLongestShotForPlayer(state, playerName);
  const favoriteWeapon = getFavoriteWeaponForPlayer(state, playerName);

  const globalRank = getPlayerRank(state.players, playerName);
  const weeklyRank = getPlayerRank(state.weeklyPlayers, playerName);
  const longShotRank = getLongShotRank(state, playerName);
  const streakRank = getStreakRank(state, playerName);

  const connectedAt = onlineInfo?.connectedAt
    ? Math.floor(new Date(onlineInfo.connectedAt).getTime() / 1000)
    : null;

  const statusLine = onlineInfo
    ? `🟢 Online • Connected <t:${connectedAt}:R>`
    : `⚫ Offline`;

  const precisionLines = [
    longestShot
      ? `Longest Shot: **${Math.round(Number(longestShot.distance || 0))}m** with **${formatWeapon(longestShot.weapon)}**`
      : `Longest Shot: **None**`,
  ];

  if (
    favoriteWeapon &&
    favoriteWeapon.toLowerCase() !== "unknown" &&
    favoriteWeapon.toLowerCase() !== "none"
  ) {
    precisionLines.push(`Favorite Weapon: **${favoriteWeapon}**`);
  }

  const description =
    `\u200B\n` +
    `🎖️ **PLAYER STATS**\n\n` +
    `**${playerName}**\n` +
    `${statusLine}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚔️ **Combat Performance**\n\n` +
    `Kills: **${kills}**\n` +
    `Deaths: **${deaths}**\n` +
    `K/D Ratio: **${kd}**\n` +
    `Best Streak: **${bestStreak}x**\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🎯 **Precision**\n\n` +
    `${precisionLines.join("\n")}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `📊 **Rankings**\n\n` +
    `Global (Geral): **${globalRank ? `#${globalRank}` : "Unranked"}**\n` +
    `Weekly (Semanal): **${weeklyRank ? `#${weeklyRank}` : "Unranked"}**\n` +
    `Long Shots: **${longShotRank ? `#${longShotRank}` : "Unranked"}**\n` +
    `Streaks: **${streakRank ? `#${streakRank}` : "Unranked"}**\n` +
    `\u200B\n`;

  return createBaseEmbed("#FFD700").setDescription(description);
}

function createMatchEmbed(state: any) {
  const match = state.activeMatch;

  if (!match) {
    return createBaseEmbed("#FF3333").setDescription(
      buildHeader("🎮", "Match Ranking", "No active match") +
        `There is no match data available.\nNenhuma partida ativa no momento.` +
        `\n\u200B\n\u200B\n` +
        buildFooter(),
    );
  }

  const players = mapPlayers(match.players || {});
  const statusText =
    match.status === "active"
      ? "Live match in progress"
      : "Final match result";
  const startedTs = Math.floor(new Date(match.startedAt).getTime() / 1000);
  const endedTs = match.endedAt
    ? Math.floor(new Date(match.endedAt).getTime() / 1000)
    : null;

  const embed = formatLeaderboardEmbed(players, {
    emoji: match.status === "active" ? "🎮" : "🏁",
    title:
      match.status === "active" ? "Match Ranking" : "Final Match Ranking",
    subtitle: `${statusText} • Started <t:${startedTs}:f>${endedTs ? ` • Ended <t:${endedTs}:f>` : ""}`,
    color: match.status === "active" ? "#00FF88" : "#FFD700",
  });

  return embed;
}

async function updateMatchRanking(state: any) {
  if (!state.activeMatch?.channelId) return;

  try {
    const channel = await client.channels.fetch(
      state.activeMatch.channelId,
    );

    if (!channel || !("send" in channel)) {
      console.log("⚠️ canal da match inválido, limpando activeMatch");

      state.activeMatch = null;

      return;
    }

    const key = `match_${state.activeMatch.id}_ranking`;

    await sendOrEdit(state, channel as any, key, createMatchEmbed(state));

    state.activeMatch.messageId = state.discordMessageIds?.[key];
  } catch (err: any) {
    if (err?.code === 10003) {
      console.log(
        "⚠️ canal da match não existe mais, limpando activeMatch",
      );

      state.activeMatch = null;

      return;
    }

    console.error("❌ erro ao atualizar ranking da match", err);
  }
}

function resetDaily(state: any) {
  const today = getBrazilDateKey();
  state.dailyPlayers = {};
  state.dailyStartedAt = today;
  state.lastDailyReset = today;
}

function resetWeekly(state: any) {
  const today = getBrazilDateKey();
  const currentWeek = getBrazilWeekKey();
  state.weeklyPlayers = {};
  state.weeklyStartedAt = today;
  state.lastWeeklyReset = currentWeek;
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

function markCurrentAdmFilesAsProcessed(state: any) {
  state.files = state.files || {};

  try {
    const manifestPath = getServerRuntimeContext(serverId).storage.manifestFile;

    if (!fs.existsSync(manifestPath)) {
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const files = Array.isArray(manifest.files) ? manifest.files : [];

    for (const file of files) {
      if (!file || !fs.existsSync(file)) continue;

      const lineCount = fs
        .readFileSync(file, "utf-8")
        .split(/\r?\n/).length;

      state.files[file] = {
        lastLine: lineCount,
        lastProcessedAt: new Date().toISOString(),
      };

      state.lastFileName = file;
      state.lastLine = lineCount;
    }

    console.log(`🧭 cursores ADM preservados/avançados: ${files.length}`);
  } catch (err) {
    console.error("❌ erro ao avançar cursores ADM no wipe", err);
  }
}


  return {
    resetRankings,
    updateLeaderboard,
    createPlayerStatsEmbed,
    updateMatchRanking,
    resetDaily,
    resetWeekly,
    resetStreaks,
    wipePlayer,
    sendOrEdit,
    deleteBotMessagesFromChannel,
    killfeedPageKey,
    killStreakPageKey,
    longShotPageKey,
    createKillFeedEmptyEmbed,
    createKillStreakEmptyEmbed,
    createLongShotEmptyEmbed,
  };
}
