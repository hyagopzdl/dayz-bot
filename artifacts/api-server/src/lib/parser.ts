import fs from "fs";
import { getState, saveState } from "./state";

const KILL_REGEX = /Player "(.+?)".*killed by Player "(.+?)"/;

// 🔥 ADICIONA REGEX DE CONEXÃO
const CONNECT_REGEX = /Player "(.+?)".*is connected/;
const DISCONNECT_REGEX = /Player "(.+?)".*has been disconnected/;

export function getLeaderboard() {
  console.log("🔥 PARSER FOI CHAMADO");

  const log = fs.readFileSync("ADM.log", "utf-8");
  const lines = log.split("\n");

  const state = getState();

  let leaderboard: Record<string, { kills: number; deaths: number }> =
    state.players || {};

  let onlinePlayers: Record<string, boolean> = state.onlinePlayers || {};

  let start = state.lastLine || 0;

  if (!leaderboard || Object.keys(leaderboard).length === 0) {
    console.log("♻️ reconstruindo estado...");
    start = 0;
    leaderboard = {};
    onlinePlayers = {};
  }

  console.log(`📄 total linhas: ${lines.length}`);
  console.log(`📍 processando de: ${start}`);

  let newKills = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    // 🔥 KILLS
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

      newKills++;

      console.log(`🔫 ${killer} matou ${victim}`);
    }

    // 🔥 CONECTOU
    const connectMatch = line.match(CONNECT_REGEX);
    if (connectMatch) {
      const player = connectMatch[1];
      onlinePlayers[player] = true;
      console.log(`🟢 ${player} entrou`);
    }

    // 🔥 DESCONECTOU
    const disconnectMatch = line.match(DISCONNECT_REGEX);
    if (disconnectMatch) {
      const player = disconnectMatch[1];
      delete onlinePlayers[player];
      console.log(`🔴 ${player} saiu`);
    }
  }

  console.log(`🎯 novas kills: ${newKills}`);
  console.log(`🟢 online agora: ${Object.keys(onlinePlayers).length}`);

  console.log("💾 VAI SALVAR:", leaderboard);

  saveState({
    players: leaderboard || {},
    lastLine: lines.length,
    onlinePlayers, // 🔥 AGORA SALVA
  });

  return Object.entries(leaderboard)
    .map(([name, data]) => {
      const kills = data.kills || 0;
      const deaths = data.deaths || 0;

      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);

      return { name, kills, deaths, kd };
    })
    .sort((a, b) => b.kills - a.kills);
}
