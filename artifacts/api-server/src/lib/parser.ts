import fs from "fs";
import crypto from "crypto";
import { getStateAsync, saveStateAsync, AppState, PlayerStats } from "./state";
import { MANIFEST_FILE } from "./nitradoDownloader";

const KILL_REGEX = /Player "([^"]+)".*?killed by Player "([^"]+)"/;
const CONNECT_REGEX = /Player "([^"]+)".*?is connected/;
const DISCONNECT_REGEX = /Player "([^"]+)".*?has been disconnected/;

const LONG_SHOT_MIN_DISTANCE = 100;

type AdmEventTime = {
  dateString: string;
  date: Date;
};

function getBrazilDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};

  parts.forEach((p) => {
    map[p.type] = p.value;
  });

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
  };
}

function getWeekKeyFromDateString(dateString: string) {
  const [year, month, day] = dateString.split("-").map(Number);
  const localDate = new Date(year, month - 1, day, 0, 0, 0);

  const weekDay = localDate.getDay();
  const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;

  const monday = new Date(localDate);
  monday.setDate(localDate.getDate() + diffToMonday);

  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(monday.getDate()).padStart(2, "0")}`;
}

function getBrazilWeekKey(date = new Date()) {
  return getWeekKeyFromDateString(getBrazilDateParts(date).date);
}

function extractBaseDateFromLog(lines: string[]): string | null {
  for (const line of lines.slice(0, 20)) {
    const match = line.match(/AdminLog started on (\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }

  return null;
}

function extractBaseDateFromFilePath(filePath: string): string | null {
  const match = filePath.match(/_(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.ADM$/);
  return match ? match[1] : null;
}

function extractLineSeconds(line: string): number | null {
  const match = line.match(/^(\d{2}):(\d{2}):(\d{2})\s*\|/);
  if (!match) return null;

  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function addDaysToDateString(baseDate: string, days: number) {
  const [year, month, day] = baseDate.split("-").map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0);

  date.setDate(date.getDate() + days);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

function createAdmEventTime(
  baseDate: string,
  dayOffset: number,
  seconds: number,
): AdmEventTime {
  const dateString = addDaysToDateString(baseDate, dayOffset);

  const [year, month, day] = dateString.split("-").map(Number);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return {
    dateString,
    date: new Date(year, month - 1, day, hours, minutes, secs),
  };
}

function getDiscordTimestamp(eventTime: AdmEventTime | null) {
  return Math.floor((eventTime?.date || new Date()).getTime() / 1000);
}

function isTodayInBrazil(eventTime: AdmEventTime) {
  return eventTime.dateString === getBrazilDateParts().date;
}

function isThisWeekInBrazil(eventTime: AdmEventTime) {
  return getWeekKeyFromDateString(eventTime.dateString) === getBrazilWeekKey();
}

function eventId(fileName: string, lineNumber: number, line: string) {
  return crypto
    .createHash("sha1")
    .update(`${fileName}:${lineNumber}:${line.trim()}`)
    .digest("hex");
}

function ensurePlayer(obj: Record<string, PlayerStats>, name: string) {
  if (!obj[name]) {
    obj[name] = { kills: 0, deaths: 0 };
  }
}

function ensureStateDefaults(state: AppState) {
  state.players = state.players || {};
  state.dailyPlayers = state.dailyPlayers || {};
  state.weeklyPlayers = state.weeklyPlayers || {};
  state.onlinePlayers = state.onlinePlayers || {};
  state.files = state.files || {};
  state.recentEventIds = state.recentEventIds || [];
  state.killFeedEvents = state.killFeedEvents || [];
  state.longShotEvents = state.longShotEvents || [];
  state.currentKillStreaks = state.currentKillStreaks || {};
  state.killStreakEvents = state.killStreakEvents || [];
  state.discordMessageIds = state.discordMessageIds || {};
  state.activeMatch = state.activeMatch || null;

  return state;
}

function extractWeapon(line: string): string {
  const lower = line.toLowerCase();

  if (lower.includes("with ")) {
    const match = line.match(/\bwith\s+(.+?)(?:\s+from|\s+\(|$)/i);
    if (match?.[1]) return match[1].trim();
  }

  if (lower.includes("explosion")) return "Explosion";
  if (lower.includes("fall damage")) return "Fall Damage";
  if (lower.includes("vehicle")) return "Vehicle";

  return "Unknown";
}


function extractDistance(line: string): number | null {
  const match = line.match(/\bfrom\s+(\d+(?:\.\d+)?)\s*(?:m|meter|meters)?\b/i);

  if (!match?.[1]) return null;

  const distance = Number(match[1]);

  if (!Number.isFinite(distance)) return null;

  return distance;
}

function addLongShotEvent(
  state: AppState,
  killer: string,
  victim: string,
  weapon: string,
  distance: number | null,
  eventTime: AdmEventTime | null,
) {
  if (!distance || distance < LONG_SHOT_MIN_DISTANCE) return;

  state.longShotEvents = state.longShotEvents || [];

  state.longShotEvents.push({
    killer,
    victim,
    weapon,
    distance: Math.round(distance),
    timestamp: getDiscordTimestamp(eventTime),
  });

  state.longShotEvents = state.longShotEvents.slice(-150);

  console.log(
    `🎯 long shot: ${killer} matou ${victim} a ${Math.round(distance)}m com ${weapon}`,
  );
}

function addKillFeedEvent(
  state: AppState,
  killer: string,
  victim: string,
  weapon: string,
  eventTime: AdmEventTime | null,
) {
  state.killFeedEvents.push({
    killer,
    victim,
    weapon,
    at: (eventTime?.date || new Date()).toISOString(),
  });

  state.killFeedEvents = state.killFeedEvents.slice(-100);
}

function addKillStreakMilestoneEvent(
  state: AppState,
  player: string,
  streak: number,
  eventTime: AdmEventTime | null,
) {
  state.killStreakEvents.push({
    type: "streak",
    player,
    streak,
    timestamp: getDiscordTimestamp(eventTime),
  });

  state.killStreakEvents = state.killStreakEvents.slice(-150);
  state.longShotEvents = (state.longShotEvents || []).slice(-150);

  console.log(`📈 ${player} atingiu ${streak} kill streak`);
}

function addKillStreakEndedEvent(
  state: AppState,
  player: string,
  streak: number,
  killer: string,
  eventTime: AdmEventTime | null,
) {
  state.killStreakEvents.push({
    type: "ended",
    player,
    streak,
    killer,
    timestamp: getDiscordTimestamp(eventTime),
  });

  state.killStreakEvents = state.killStreakEvents.slice(-150);
  state.longShotEvents = (state.longShotEvents || []).slice(-150);

  console.log(`🛑 ${killer} encerrou streak de ${streak} de ${player}`);
}

function updateKillStreaks(
  state: AppState,
  killer: string,
  victim: string,
  eventTime: AdmEventTime | null,
) {
  if (!killer || !victim) return;
  if (killer.toLowerCase() === victim.toLowerCase()) return;

  const victimCurrentStreak = state.currentKillStreaks[victim] || 0;

  if (victimCurrentStreak >= 5) {
    addKillStreakEndedEvent(
      state,
      victim,
      victimCurrentStreak,
      killer,
      eventTime,
    );
  }

  state.currentKillStreaks[victim] = 0;

  const killerCurrentStreak = (state.currentKillStreaks[killer] || 0) + 1;
  state.currentKillStreaks[killer] = killerCurrentStreak;

  if (killerCurrentStreak >= 5 && killerCurrentStreak % 5 === 0) {
    addKillStreakMilestoneEvent(state, killer, killerCurrentStreak, eventTime);
  }

  state.killStreakEvents = state.killStreakEvents.slice(-150);
  state.longShotEvents = (state.longShotEvents || []).slice(-150);
}

function updateOnlineSessionStats(state: AppState, killer: string, victim: string) {
  const killerOnline = state.onlinePlayers?.[killer];

  if (killerOnline) {
    killerOnline.sessionKills = Number(killerOnline.sessionKills || 0) + 1;
    killerOnline.sessionStreak = Number(killerOnline.sessionStreak || 0) + 1;
  }

  const victimOnline = state.onlinePlayers?.[victim];

  if (victimOnline) {
    victimOnline.sessionDeaths = Number(victimOnline.sessionDeaths || 0) + 1;
    victimOnline.sessionStreak = 0;
  }
}

function addKill(
  state: AppState,
  killer: string,
  victim: string,
  weapon: string,
  distance: number | null,
  eventTime: AdmEventTime | null,
) {
  ensurePlayer(state.players, killer);
  ensurePlayer(state.players, victim);

  state.players[killer].kills += 1;
  state.players[victim].deaths += 1;

  if (eventTime && isTodayInBrazil(eventTime)) {
    ensurePlayer(state.dailyPlayers, killer);
    ensurePlayer(state.dailyPlayers, victim);

    state.dailyPlayers[killer].kills += 1;
    state.dailyPlayers[victim].deaths += 1;
  }

  if (eventTime && isThisWeekInBrazil(eventTime)) {
    ensurePlayer(state.weeklyPlayers, killer);
    ensurePlayer(state.weeklyPlayers, victim);

    state.weeklyPlayers[killer].kills += 1;
    state.weeklyPlayers[victim].deaths += 1;
  }

  if (state.activeMatch?.status === "active") {
    ensurePlayer(state.activeMatch.players, killer);
    ensurePlayer(state.activeMatch.players, victim);

    state.activeMatch.players[killer].kills += 1;
    state.activeMatch.players[victim].deaths += 1;
  }

  updateOnlineSessionStats(state, killer, victim);

  updateKillStreaks(state, killer, victim, eventTime);
  addKillFeedEvent(state, killer, victim, weapon, eventTime);
  addLongShotEvent(state, killer, victim, weapon, distance, eventTime);
}

function markOnline(
  state: AppState,
  player: string,
  eventTime: AdmEventTime | null,
) {
  const now = (eventTime?.date || new Date()).toISOString();
  const current = state.onlinePlayers[player];

  state.onlinePlayers[player] = {
    online: true,
    connectedAt: current?.connectedAt || now,
    lastSeenAt: now,
    sessionKills: Number(current?.sessionKills || 0),
    sessionDeaths: Number(current?.sessionDeaths || 0),
    sessionStreak: Number(current?.sessionStreak || 0),
  };
}

function markOffline(state: AppState, player: string) {
  delete state.onlinePlayers[player];
}

function cleanupOnlinePlayers(state: AppState) {
  state.onlinePlayers = state.onlinePlayers || {};
}

function applyResets(state: AppState) {
  const { date: today } = getBrazilDateParts();
  const currentWeek = getBrazilWeekKey();

  if (state.lastDailyReset !== today) {
    console.log("🌅 reset diário");
    state.dailyPlayers = {};
    state.lastDailyReset = today;
  }

  if (state.lastWeeklyReset !== currentWeek) {
    console.log("📆 reset semanal");
    state.weeklyPlayers = {};
    state.lastWeeklyReset = currentWeek;
  }
}

function readManifestFiles(): string[] {
  if (!fs.existsSync(MANIFEST_FILE)) {
    if (fs.existsSync("ADM.log")) return ["ADM.log"];
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
    return Array.isArray(manifest.files) ? manifest.files : [];
  } catch {
    return [];
  }
}

function processFile(filePath: string, state: AppState) {
  if (!fs.existsSync(filePath)) return;

  const fileName = filePath;
  const log = fs.readFileSync(filePath, "utf-8");
  const lines = log.split(/\r?\n/);

  const baseDate =
    extractBaseDateFromLog(lines) || extractBaseDateFromFilePath(filePath);

  if (!baseDate) {
    console.log(`⚠️ não consegui detectar data base do ADM: ${fileName}`);
  } else {
    console.log(`🗓️ data base ADM: ${baseDate}`);
  }

  const cursor = state.files[fileName] || {
    lastLine: 0,
    lastProcessedAt: new Date().toISOString(),
  };

  let start = cursor.lastLine || 0;

  if (start > lines.length) {
    console.log(`♻️ arquivo rotacionado/encurtado: ${fileName}`);
    start = 0;
  }

  let currentDayOffset = 0;
  let previousSeconds: number | null = null;

  for (let i = 0; i < start; i++) {
    const seconds = extractLineSeconds(lines[i] || "");
    if (seconds === null) continue;

    if (previousSeconds !== null && seconds < previousSeconds) {
      currentDayOffset++;
    }

    previousSeconds = seconds;
  }

  let newKills = 0;
  let ignoredDailyKills = 0;
  let ignoredWeeklyKills = 0;
  let killsWithoutDate = 0;
  let newConnections = 0;
  let newDisconnections = 0;

  const dedupe = new Set(state.recentEventIds || []);

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const lineSeconds = extractLineSeconds(line);

    if (
      lineSeconds !== null &&
      previousSeconds !== null &&
      lineSeconds < previousSeconds
    ) {
      currentDayOffset++;
    }

    previousSeconds = lineSeconds ?? previousSeconds;

    const eventTime =
      baseDate && lineSeconds !== null
        ? createAdmEventTime(baseDate, currentDayOffset, lineSeconds)
        : null;

    const id = eventId(fileName, i, line);

    if (dedupe.has(id)) {
      continue;
    }

    const killMatch = line.match(KILL_REGEX);

    if (killMatch) {
      const victim = killMatch[1]?.trim();
      const killer = killMatch[2]?.trim();

      if (!killer || !victim) {
        console.log("⚠️ kill inválida sem killer/victim:", line);
        continue;
      }

      const weapon = extractWeapon(line);
      const distance = extractDistance(line);

      addKill(state, killer, victim, weapon, distance, eventTime);

      if (!eventTime) killsWithoutDate++;
      if (eventTime && !isTodayInBrazil(eventTime)) ignoredDailyKills++;
      if (eventTime && !isThisWeekInBrazil(eventTime)) ignoredWeeklyKills++;

      state.recentEventIds.push(id);
      dedupe.add(id);

      newKills++;
      console.log(`🔫 ${killer} matou ${victim} com ${weapon}`);
      continue;
    }

    const connectMatch = line.match(CONNECT_REGEX);

    if (connectMatch) {
      const player = connectMatch[1];

      markOnline(state, player, eventTime);
      state.recentEventIds.push(id);
      dedupe.add(id);

      newConnections++;
      console.log(`🟢 ${player} entrou`);
      continue;
    }

    const disconnectMatch = line.match(DISCONNECT_REGEX);

    if (disconnectMatch) {
      const player = disconnectMatch[1];

      markOffline(state, player);
      state.recentEventIds.push(id);
      dedupe.add(id);

      newDisconnections++;
      console.log(`🔴 ${player} saiu`);
      continue;
    }
  }

  cursor.lastLine = lines.length;
  cursor.lastProcessedAt = new Date().toISOString();

  state.files[fileName] = cursor;
  state.lastLine = lines.length;
  state.lastFileName = fileName;

  state.recentEventIds = state.recentEventIds.slice(-10000);
  state.killFeedEvents = state.killFeedEvents.slice(-100);
  state.killStreakEvents = state.killStreakEvents.slice(-150);
  state.longShotEvents = (state.longShotEvents || []).slice(-150);

  console.log(`🎯 novas kills: ${newKills}`);
  console.log(`⚠️ kills sem data: ${killsWithoutDate}`);
  console.log(
    `🌅 kills ignoradas no diário por data antiga: ${ignoredDailyKills}`,
  );
  console.log(
    `📆 kills ignoradas no semanal por semana antiga: ${ignoredWeeklyKills}`,
  );
  console.log(`🟢 conexões: ${newConnections}`);
  console.log(`🔴 desconexões: ${newDisconnections}`);
}

export async function getLeaderboard() {
  console.log("🔥 PARSER FOI CHAMADO");

  const state = ensureStateDefaults(await getStateAsync());

  applyResets(state);

  const files = readManifestFiles();

  if (!files.length) {
    console.log("⚠️ nenhum arquivo ADM local encontrado");

    cleanupOnlinePlayers(state);
    await saveStateAsync(state);

    return {
      global: state.players,
      daily: state.dailyPlayers,
      weekly: state.weeklyPlayers,
    };
  }

  for (const file of files) {
    try {
      processFile(file, state);
    } catch (err) {
      console.error(`❌ erro processando ${file}:`, err);
    }
  }

  cleanupOnlinePlayers(state);

  console.log(`🟢 online agora: ${Object.keys(state.onlinePlayers).length}`);

  await saveStateAsync(state);

  return {
    global: state.players,
    daily: state.dailyPlayers,
    weekly: state.weeklyPlayers,
  };
}
