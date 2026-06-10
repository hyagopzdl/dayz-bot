import fs from "fs";
import crypto from "crypto";
import { getStateAsync, saveStateAsync, AppState, PlayerStats } from "./state";
import { MANIFEST_FILE } from "./nitradoDownloader";
import {
  getShopResetMonitorPersistenceKey,
  tryAutoClearShopAfterAdmReset,
} from "./shop";
import { isLiveRuntimeEnabled } from "./systems";

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

function extractAdmFileStartMs(filePath: string): number {
  const match = filePath.match(/_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/);

  if (!match) return Number.MAX_SAFE_INTEGER;

  const [, datePart, hours, minutes, seconds] = match;
  const [year, month, day] = datePart.split("-").map(Number);

  return new Date(
    year,
    month - 1,
    day,
    Number(hours),
    Number(minutes),
    Number(seconds),
  ).getTime();
}

function sortAdmFilesChronologically(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const diff = extractAdmFileStartMs(a) - extractAdmFileStartMs(b);

    if (diff !== 0) return diff;

    return a.localeCompare(b);
  });
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
  return Math.floor(Date.now() / 1000);
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

function normalizePlayerKey(name: string) {
  return normalizeOnlineName(name);
}

function findOnlinePlayerKey(state: AppState, player: string) {
  return findRecordKeyByPlayerName(state.onlinePlayers || {}, player);
}

function normalizeOnlineName(name: string) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findRecordKeyByPlayerName(record: Record<string, any>, player: string) {
  const normalized = normalizeOnlineName(player);

  return (
    Object.keys(record || {}).find(
      (name) => normalizeOnlineName(name) === normalized,
    ) || null
  );
}

function ensureOnlineState(state: AppState) {
  state.onlinePlayers = state.onlinePlayers || {};
  state.onlineActivitySamples = state.onlineActivitySamples || [];
  (state as any).onlineConnectionEvents = Array.isArray((state as any).onlineConnectionEvents)
    ? (state as any).onlineConnectionEvents
    : [];
  (state as any).onlineSessions = (state as any).onlineSessions || {};
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
  state.onlineActivitySamples = state.onlineActivitySamples || [];
  (state as any).onlineConnectionEvents = Array.isArray((state as any).onlineConnectionEvents)
    ? (state as any).onlineConnectionEvents
    : [];
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
    at: new Date().toISOString(),
  });

  state.killFeedEvents = state.killFeedEvents.slice(-99);
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

function updateOnlineSessionStats(
  state: AppState,
  killer: string,
  victim: string,
  eventTime: AdmEventTime | null,
) {
  ensureOnlineState(state);

  const now = new Date().toISOString();

  const updateSession = (
    playerName: string,
    updater: (session: any) => void,
  ) => {
    const onlineKey = findOnlinePlayerKey(state, playerName);

    if (!onlineKey) return;

    const onlinePlayer = state.onlinePlayers?.[onlineKey] as any;

    if (!onlinePlayer || onlinePlayer.online !== true) return;

    const sessionKey =
      findRecordKeyByPlayerName((state as any).onlineSessions || {}, onlineKey) ||
      onlineKey;

    const existingSession = (state as any).onlineSessions[sessionKey] || {};

    const session = {
      connectedAt:
        existingSession.connectedAt ||
        onlinePlayer.connectedAt ||
        onlinePlayer.lastSeenAt ||
        now,
      lastSeenAt: now,
      kills: Number(existingSession.kills || 0),
      deaths: Number(existingSession.deaths || 0),
      streak: Number(existingSession.streak || 0),
    };

    updater(session);

    if (sessionKey !== onlineKey) {
      delete (state as any).onlineSessions[sessionKey];
    }

    (state as any).onlineSessions[onlineKey] = session;
  };

  updateSession(killer, (session) => {
    session.kills = Number(session.kills || 0) + 1;
    session.streak = Number(session.streak || 0) + 1;
  });

  updateSession(victim, (session) => {
    session.deaths = Number(session.deaths || 0) + 1;
    session.streak = 0;
  });
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

  updateOnlineSessionStats(state, killer, victim, eventTime);

  updateKillStreaks(state, killer, victim, eventTime);
  addKillFeedEvent(state, killer, victim, weapon, eventTime);
  addLongShotEvent(state, killer, victim, weapon, distance, eventTime);
}

function markOnline(
  state: AppState,
  player: string,
  eventTime: AdmEventTime | null,
) {
  ensureOnlineState(state);

  const now = new Date().toISOString();
  const existingOnlineKey = findOnlinePlayerKey(state, player);
  const key = existingOnlineKey || player;

  const current = state.onlinePlayers[key] as any;
  const existingSessionKey =
    findRecordKeyByPlayerName((state as any).onlineSessions || {}, key) || key;
  const currentSession = (state as any).onlineSessions[existingSessionKey];

  if (existingOnlineKey && existingOnlineKey !== player) {
    delete state.onlinePlayers[player];
  }

  if (existingSessionKey !== key) {
    delete (state as any).onlineSessions[existingSessionKey];
  }

  state.onlinePlayers[key] = {
    online: true,
    connectedAt: current?.connectedAt || currentSession?.connectedAt || now,
    lastSeenAt: now,
  };

  (state as any).onlineSessions[key] = {
    connectedAt: currentSession?.connectedAt || current?.connectedAt || now,
    lastSeenAt: now,
    kills: Number(currentSession?.kills || 0),
    deaths: Number(currentSession?.deaths || 0),
    streak: Number(currentSession?.streak || 0),
  };
}

function markOffline(state: AppState, player: string) {
  ensureOnlineState(state);

  const key = findOnlinePlayerKey(state, player) || player;
  const sessionKey =
    findRecordKeyByPlayerName((state as any).onlineSessions || {}, key) || key;

  delete state.onlinePlayers[key];
  delete (state as any).onlineSessions[sessionKey];
}

function cleanupOnlinePlayers(state: AppState) {
  ensureOnlineState(state);

  // Online presence is controlled only by real ADM connect/disconnect events.
  // Session stats are stored separately and cleared on disconnect.
}


function recordOnlineActivitySample(state: AppState) {
  const samples = Array.isArray(state.onlineActivitySamples)
    ? state.onlineActivitySamples
    : [];
  const now = new Date();
  const bucketMs = 15 * 60 * 1000;
  const bucket = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs).toISOString();
  const online = Object.keys(state.onlinePlayers || {}).length;
  const last = samples[samples.length - 1];

  if (last?.bucket === bucket) {
    if (Number(last.online || 0) === online) {
      state.onlineActivitySamples = samples;
      return false;
    }

    last.online = online;
    state.onlineActivitySamples = samples;
    return true;
  }

  const cutoff = now.getTime() - 8 * 24 * 60 * 60 * 1000;
  state.onlineActivitySamples = samples
    .filter((sample) => {
      const time = Date.parse(String(sample.bucket || ""));
      return Number.isFinite(time) && time >= cutoff;
    })
    .concat({ bucket, online })
    .slice(-900);

  return true;
}

function recordOnlineConnectionEvent(state: AppState, player: string, eventTime: AdmEventTime | null) {
  ensureOnlineState(state);

  const at = eventTime?.date?.toISOString() || new Date().toISOString();
  const events = Array.isArray((state as any).onlineConnectionEvents)
    ? (state as any).onlineConnectionEvents
    : [];
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;

  (state as any).onlineConnectionEvents = events
    .filter((event: any) => {
      const time = Date.parse(String(event.at || ""));
      return Number.isFinite(time) && time >= cutoff;
    })
    .concat({
      player: String(player || "Unknown"),
      playerNormalized: normalizeOnlineName(player),
      at,
    })
    .slice(-5000);
}

function setOnlineRecord(
  onlinePlayers: Record<string, any>,
  onlineSessions: Record<string, any>,
  player: string,
  eventTime: AdmEventTime | null,
) {
  const existingKey = findRecordKeyByPlayerName(onlinePlayers, player);
  const key = existingKey || player;
  const at = eventTime?.date.toISOString() || new Date().toISOString();
  const current = onlinePlayers[key] as any;
  const currentSession = onlineSessions[key] as any;

  if (existingKey && existingKey !== player) {
    delete onlinePlayers[player];
    delete onlineSessions[player];
  }

  onlinePlayers[key] = {
    online: true,
    connectedAt: current?.connectedAt || currentSession?.connectedAt || at,
    lastSeenAt: at,
  };

  onlineSessions[key] = {
    connectedAt: currentSession?.connectedAt || current?.connectedAt || at,
    lastSeenAt: at,
    kills: Number(currentSession?.kills || 0),
    deaths: Number(currentSession?.deaths || 0),
    streak: Number(currentSession?.streak || 0),
  };
}

function deleteOnlineRecord(
  onlinePlayers: Record<string, any>,
  onlineSessions: Record<string, any>,
  player: string,
) {
  const key = findRecordKeyByPlayerName(onlinePlayers, player) || player;
  const sessionKey = findRecordKeyByPlayerName(onlineSessions, key) || key;

  delete onlinePlayers[key];
  delete onlineSessions[sessionKey];
}

function rebuildOnlinePresenceFromAdmFiles(
  state: AppState,
  files: string[],
): boolean {
  ensureOnlineState(state);

  const previousOnlinePlayers = state.onlinePlayers || {};
  const previousSessions = ((state as any).onlineSessions || {}) as Record<
    string,
    any
  >;

  let rebuiltOnlinePlayers: Record<string, any> = {};
  let rebuiltOnlineSessions: Record<string, any> = {};

  for (const filePath of sortAdmFilesChronologically(files)) {
    if (!fs.existsSync(filePath)) continue;

    const log = fs.readFileSync(filePath, "utf-8");
    const lines = log.split(/\r?\n/);
    const baseDate =
      extractBaseDateFromLog(lines) || extractBaseDateFromFilePath(filePath);

    // Every ADM file represents a new DayZ server process. Presence from older
    // files must not leak into the current online list. Rebuilding presence from
    // scratch avoids ghost players when disconnect events are missed around
    // restarts, crashes, or log rotation.
    rebuiltOnlinePlayers = {};
    rebuiltOnlineSessions = {};

    let currentDayOffset = 0;
    let previousSeconds: number | null = null;

    for (const rawLine of lines) {
      const line = rawLine?.trim();
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

      const connectMatch = line.match(CONNECT_REGEX);

      if (connectMatch?.[1]) {
        setOnlineRecord(
          rebuiltOnlinePlayers,
          rebuiltOnlineSessions,
          connectMatch[1],
          eventTime,
        );
        continue;
      }

      const disconnectMatch = line.match(DISCONNECT_REGEX);

      if (disconnectMatch?.[1]) {
        deleteOnlineRecord(
          rebuiltOnlinePlayers,
          rebuiltOnlineSessions,
          disconnectMatch[1],
        );
      }
    }
  }

  for (const [player, session] of Object.entries(rebuiltOnlineSessions)) {
    const previousKey =
      findRecordKeyByPlayerName(previousSessions, player) || player;
    const previousSession = previousSessions[previousKey] as any;

    if (!previousSession) continue;

    rebuiltOnlineSessions[player] = {
      ...session,
      kills: Number(previousSession.kills || 0),
      deaths: Number(previousSession.deaths || 0),
      streak: Number(previousSession.streak || 0),
    };
  }

  const before = Object.keys(previousOnlinePlayers)
    .map(normalizeOnlineName)
    .sort()
    .join("|");
  const after = Object.keys(rebuiltOnlinePlayers)
    .map(normalizeOnlineName)
    .sort()
    .join("|");

  state.onlinePlayers = rebuiltOnlinePlayers;
  (state as any).onlineSessions = rebuiltOnlineSessions;

  if (before !== after) {
    console.log(
      `🧭 online recalculado pelos ADMs: ${Object.keys(rebuiltOnlinePlayers).length}`,
    );
    return true;
  }

  return false;
}

function applyResets(state: AppState): boolean {
  const { date: today } = getBrazilDateParts();
  const currentWeek = getBrazilWeekKey();
  let changed = false;

  if (state.lastDailyReset !== today) {
    console.log("🌅 reset diário");
    state.dailyPlayers = {};
    state.lastDailyReset = today;
    changed = true;
  }

  if (state.lastWeeklyReset !== currentWeek) {
    console.log("📆 reset semanal");
    state.weeklyPlayers = {};
    state.lastWeeklyReset = currentWeek;
    changed = true;
  }

  return changed;
}

function readManifestFiles(): string[] {
  if (!fs.existsSync(MANIFEST_FILE)) {
    if (fs.existsSync("ADM.log")) return ["ADM.log"];
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
    return Array.isArray(manifest.files)
      ? sortAdmFilesChronologically(manifest.files)
      : [];
  } catch {
    return [];
  }
}

function processFile(filePath: string, state: AppState): boolean {
  ensureOnlineState(state);
  if (!fs.existsSync(filePath)) return false;

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

  const previousLastLine = cursor.lastLine || 0;
  let start = previousLastLine;
  let cursorChanged = false;

  if (start > lines.length) {
    console.log(`♻️ arquivo rotacionado/encurtado: ${fileName}`);
    start = 0;
    cursorChanged = true;
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
      recordOnlineConnectionEvent(state, player, eventTime);
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

  const foundNewEvents = newKills > 0 || newConnections > 0 || newDisconnections > 0;
  const advancedCursor = lines.length !== previousLastLine;
  const shouldPersistCursor = cursorChanged || advancedCursor || foundNewEvents;

  if (shouldPersistCursor) {
    cursor.lastLine = lines.length;
    cursor.lastProcessedAt = new Date().toISOString();

    state.files[fileName] = cursor;
    state.lastLine = lines.length;
    state.lastFileName = fileName;
  }

  state.recentEventIds = state.recentEventIds.slice(-10000);
  state.killFeedEvents = state.killFeedEvents.slice(-99);
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

  return shouldPersistCursor;
}

export async function getLeaderboard() {
  if (!isLiveRuntimeEnabled()) {
    console.log("⏸️ parser LIVE/NITRADO ignorado: sistema desabilitado");
    const state = ensureStateDefaults(await getStateAsync());
    return {
      global: state.players,
      daily: state.dailyPlayers,
      weekly: state.weeklyPlayers,
    };
  }

  console.log("🔥 PARSER FOI CHAMADO");

  const state = ensureStateDefaults(await getStateAsync());

  let changed = applyResets(state);

  const files = readManifestFiles();

  if (!files.length) {
    console.log("⚠️ nenhum arquivo ADM local encontrado");

    cleanupOnlinePlayers(state);
    if (changed) {
      await saveStateAsync(state);
    } else {
      console.log("⏭️ parser sem arquivos e sem mudanças; state não salvo");
    }

    return {
      global: state.players,
      daily: state.dailyPlayers,
      weekly: state.weeklyPlayers,
    };
  }

  const orderedFiles = sortAdmFilesChronologically(files);

  for (const file of orderedFiles) {
    try {
      changed = processFile(file, state) || changed;
    } catch (err) {
      console.error(`❌ erro processando ${file}:`, err);
    }
  }

  try {
    changed = rebuildOnlinePresenceFromAdmFiles(state, orderedFiles) || changed;
  } catch (err) {
    console.error("❌ erro recalculando players online pelos ADMs:", err);
  }

  try {
    const monitorBefore = getShopResetMonitorPersistenceKey(state);
    const clearResult = await tryAutoClearShopAfterAdmReset(state, orderedFiles);
    const monitorChanged = getShopResetMonitorPersistenceKey(state) !== monitorBefore;
    changed = Boolean(clearResult) || monitorChanged || changed;
  } catch (err) {
    console.error("❌ erro no auto-clear da shop após reset ADM:", err);
  }

  cleanupOnlinePlayers(state);
  changed = recordOnlineActivitySample(state) || changed;

  console.log(`🟢 online agora: ${Object.keys(state.onlinePlayers).length}`);

  if (changed) {
    await saveStateAsync(state);
  } else {
    console.log("⏭️ parser sem mudanças; state não salvo");
  }

  return {
    global: state.players,
    daily: state.dailyPlayers,
    weekly: state.weeklyPlayers,
  };
}
