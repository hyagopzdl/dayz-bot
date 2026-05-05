import fs from "fs";
import { getState, saveState } from "./state";

const KILL_REGEX = /Player "([^"]+)"[\s\S]*?killed by Player "([^"]+)"/;

// 🔥 REGEX DE CONEXÃO
const CONNECT_REGEX = /Player "(.+?)".*is connected/;
const DISCONNECT_REGEX = /Player "(.+?)".*has been disconnected/;

// 🇧🇷 DATA NO FUSO DO BRASIL
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

  const map: any = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
  };
}

export function getLeaderboard() {
  console.log("🔥 PARSER FOI CHAMADO");

  const log = fs.readFileSync("ADM.log", "utf-8");
  const lines = log.split("\n");

  const state = getState();

  let leaderboard = state.players || {};

  let dailyPlayers = state.dailyPlayers || {};

  let weeklyPlayers = state.weeklyPlayers || {};

  let onlinePlayers = state.onlinePlayers || {};

  let start = state.lastLine || 0;

  // 🔥 DETECTA MUDANÇA DE ARQUIVO (CRÍTICO)
  const currentFileTime = fs.statSync("ADM.log").mtimeMs;

  if (state.lastFileTime !== currentFileTime) {
    console.log("📂 arquivo mudou → resetando leitura");

    start = 0;
    state.lastFileTime = currentFileTime;
  }

  // 🔥 RESET POR DATA (BRASIL)
  const { date: today, weekday } = getBrazilDateParts();

  if (state.lastDailyReset !== today) {
    console.log("🌅 reset diário (00:00 Brasil)");
    dailyPlayers = {};
    state.lastDailyReset = today;
  }

  if (weekday === "seg." && state.lastWeeklyReset !== today) {
    console.log("📆 reset semanal (segunda 00:00 Brasil)");
    weeklyPlayers = {};
    state.lastWeeklyReset = today;
  }

  // 🔥 RECONSTRUÇÃO
  if (!leaderboard || Object.keys(leaderboard).length === 0) {
    console.log("♻️ reconstruindo estado...");
    start = 0;
    leaderboard = {};
    dailyPlayers = {};
    weeklyPlayers = {};
    onlinePlayers = {};
  }

  // 🔥 DETECTA RESET DE LOG
  if (start > lines.length) {
    console.log("♻️ log resetado, continuando sem perder dados...");
    start = 0;
  }

  console.log(`📄 total linhas: ${lines.length}`);
  console.log(`📍 processando de: ${start}`);

  let newKills = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    // 🔫 KILLS
    const match = line.match(KILL_REGEX);
    if (match) {
      const victim = match[1];
      const killer = match[2];

      if (!leaderboard[killer]) {
        leaderboard[killer] = { kills: 0, deaths: 0 };
      }
      if (!leaderboard[victim]) {
        leaderboard[victim] = { kills: 0, deaths: 0 };
      }

      leaderboard[killer].kills += 1;
      leaderboard[victim].deaths += 1;

      if (!dailyPlayers[killer]) dailyPlayers[killer] = { kills: 0, deaths: 0 };
      if (!dailyPlayers[victim]) dailyPlayers[victim] = { kills: 0, deaths: 0 };

      dailyPlayers[killer].kills += 1;
      dailyPlayers[victim].deaths += 1;

      if (!weeklyPlayers[killer])
        weeklyPlayers[killer] = { kills: 0, deaths: 0 };
      if (!weeklyPlayers[victim])
        weeklyPlayers[victim] = { kills: 0, deaths: 0 };

      weeklyPlayers[killer].kills += 1;
      weeklyPlayers[victim].deaths += 1;

      newKills++;

      console.log(`🔫 ${killer} matou ${victim}`);
    }

    // 🟢 CONECTOU
    const connectMatch = line.match(CONNECT_REGEX);
    if (connectMatch) {
      const player = connectMatch[1];
      onlinePlayers[player] = true;
      console.log(`🟢 ${player} entrou`);
    }

    // 🔴 DESCONECTOU
    const disconnectMatch = line.match(DISCONNECT_REGEX);
    if (disconnectMatch) {
      const player = disconnectMatch[1];
      delete onlinePlayers[player];
      console.log(`🔴 ${player} saiu`);
    }
  }

  console.log(`🎯 novas kills: ${newKills}`);
  console.log(`🟢 online agora: ${Object.keys(onlinePlayers).length}`);

  saveState({
    players: leaderboard,
    dailyPlayers,
    weeklyPlayers,
    lastDailyReset: state.lastDailyReset,
    lastWeeklyReset: state.lastWeeklyReset,
    lastLine: lines.length,
    onlinePlayers,
    lastFileTime: state.lastFileTime, // 🔥 IMPORTANTE
  });

  return {
    global: leaderboard,
    daily: dailyPlayers,
    weekly: weeklyPlayers,
  };
}
