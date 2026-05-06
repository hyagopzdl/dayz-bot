import fs from "fs";
import crypto from "crypto";
import { getState, saveState, AppState, PlayerStats } from "./state";
import { MANIFEST_FILE } from "./nitradoDownloader";

const KILL_REGEX = /Player "([^"]+)".*?killed by Player "([^"]+)"/;
const CONNECT_REGEX = /Player "([^"]+)".*?is connected/;
const DISCONNECT_REGEX = /Player "([^"]+)".*?has been disconnected/;

const ONLINE_TTL_MS = 45 * 60 * 1000;

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

function getBrazilWeekKey(date = new Date()) {
  const brazilDateString = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const localDate = new Date(`${brazilDateString}T00:00:00`);

  const day = localDate.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(localDate);
  monday.setDate(localDate.getDate() + diffToMonday);

  return monday.toISOString().slice(0, 10);
}

function extractTimestamp(line: string): Date | null {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  if (!match) return null;

  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function isTodayInBrazil(eventDate: Date) {
  return getBrazilDateParts(eventDate).date === getBrazilDateParts().date;
}

function isThisWeekInBrazil(eventDate: Date) {
  return getBrazilWeekKey(eventDate) === getBrazilWeekKey();
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

function addKill(
  state: AppState,
  killer: string,
  victim: string,
  eventDate: Date | null,
) {
  ensurePlayer(state.players, killer);
  ensurePlayer(state.players, victim);

  state.players[killer].kills += 1;
  state.players[victim].deaths += 1;

  if (eventDate && isTodayInBrazil(eventDate)) {
    ensurePlayer(state.dailyPlayers, killer);
    ensurePlayer(state.dailyPlayers, victim);

    state.dailyPlayers[killer].kills += 1;
    state.dailyPlayers[victim].deaths += 1;
  }

  if (eventDate && isThisWeekInBrazil(eventDate)) {
    ensurePlayer(state.weeklyPlayers, killer);
    ensurePlayer(state.weeklyPlayers, victim);

    state.weeklyPlayers[killer].kills += 1;
    state.weeklyPlayers[victim].deaths += 1;
  }
}

function markOnline(state: AppState, player: string) {
  state.onlinePlayers[player] = {
    online: true,
    lastSeenAt: new Date().toISOString(),
  };
}

function markOffline(state: AppState, player: string) {
  delete state.onlinePlayers[player];
}

function cleanupOnlinePlayers(state: AppState) {
  const now = Date.now();

  for (const [player, data] of Object.entries(state.onlinePlayers)) {
    const lastSeen = new Date(data.lastSeenAt).getTime();

    if (!Number.isFinite(lastSeen) || now - lastSeen > ONLINE_TTL_MS) {
      delete state.onlinePlayers[player];
    }
  }
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

  const cursor = state.files[fileName] || {
    lastLine: 0,
    lastProcessedAt: new Date().toISOString(),
  };

  let start = cursor.lastLine || 0;

  if (start > lines.length) {
    console.log(`♻️ arquivo rotacionado/encurtado: ${fileName}`);
    start = 0;
  }

  console.log(`📄 ${fileName}`);
  console.log(`📄 total linhas: ${lines.length}`);
  console.log(`📍 processando de: ${start}`);

  let newKills = 0;
  let ignoredDailyKills = 0;
  let ignoredWeeklyKills = 0;
  let newConnections = 0;
  let newDisconnections = 0;

  const dedupe = new Set(state.recentEventIds || []);

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const id = eventId(fileName, i, line);

    if (dedupe.has(id)) {
      continue;
    }

    const eventDate = extractTimestamp(line);

    const killMatch = line.match(KILL_REGEX);
    if (killMatch) {
      const victim = killMatch[1];
      const killer = killMatch[2];

      addKill(state, killer, victim, eventDate);

      if (eventDate && !isTodayInBrazil(eventDate)) ignoredDailyKills++;
      if (eventDate && !isThisWeekInBrazil(eventDate)) ignoredWeeklyKills++;

      state.recentEventIds.push(id);
      dedupe.add(id);

      newKills++;
      console.log(`🔫 ${killer} matou ${victim}`);
      continue;
    }

    const connectMatch = line.match(CONNECT_REGEX);
    if (connectMatch) {
      const player = connectMatch[1];

      markOnline(state, player);
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

  console.log(`🎯 novas kills: ${newKills}`);
  console.log(
    `🌅 kills ignoradas no diário por data antiga: ${ignoredDailyKills}`,
  );
  console.log(
    `📆 kills ignoradas no semanal por semana antiga: ${ignoredWeeklyKills}`,
  );
  console.log(`🟢 conexões: ${newConnections}`);
  console.log(`🔴 desconexões: ${newDisconnections}`);
}

export function getLeaderboard() {
  console.log("🔥 PARSER FOI CHAMADO");

  const state = getState();

  applyResets(state);

  const files = readManifestFiles();

  if (!files.length) {
    console.log("⚠️ nenhum arquivo ADM local encontrado");
    cleanupOnlinePlayers(state);
    saveState(state);

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

  saveState(state);

  return {
    global: state.players,
    daily: state.dailyPlayers,
    weekly: state.weeklyPlayers,
  };
}
