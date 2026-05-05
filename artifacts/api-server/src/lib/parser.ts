import fs from "fs";
import crypto from "crypto";
import { getState, saveState, AppState, PlayerStats } from "./state";
import { MANIFEST_FILE } from "./nitradoDownloader";

const KILL_REGEX = /Player "([^"]+)".*?killed by Player "([^"]+)"/;
const CONNECT_REGEX = /Player "([^"]+)".*?is connected/;
const DISCONNECT_REGEX = /Player "([^"]+)".*?has been disconnected/;

const ONLINE_TTL_MS = 45 * 60 * 1000;

function getBrazilDateParts() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};

  parts.forEach((p) => {
    map[p.type] = p.value;
  });

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
  };
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

function addKill(state: AppState, killer: string, victim: string) {
  ensurePlayer(state.players, killer);
  ensurePlayer(state.players, victim);

  state.players[killer].kills += 1;
  state.players[victim].deaths += 1;

  ensurePlayer(state.dailyPlayers, killer);
  ensurePlayer(state.dailyPlayers, victim);

  state.dailyPlayers[killer].kills += 1;
  state.dailyPlayers[victim].deaths += 1;

  ensurePlayer(state.weeklyPlayers, killer);
  ensurePlayer(state.weeklyPlayers, victim);

  state.weeklyPlayers[killer].kills += 1;
  state.weeklyPlayers[victim].deaths += 1;
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
  const { date: today, weekday } = getBrazilDateParts();

  if (state.lastDailyReset !== today) {
    console.log("🌅 reset diário");
    state.dailyPlayers = {};
    state.lastDailyReset = today;
  }

  if (weekday === "seg." && state.lastWeeklyReset !== today) {
    console.log("📆 reset semanal");
    state.weeklyPlayers = {};
    state.lastWeeklyReset = today;
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

    const killMatch = line.match(KILL_REGEX);
    if (killMatch) {
      const victim = killMatch[1];
      const killer = killMatch[2];

      addKill(state, killer, victim);
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
