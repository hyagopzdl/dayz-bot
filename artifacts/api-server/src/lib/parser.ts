import fs from "fs";
import { getState, saveState } from "./state";

const KILL_REGEX = /Player "(.+?)".*killed by Player "(.+?)"/;

export function getLeaderboard() {
  console.log("🔥 PARSER FOI CHAMADO");

  const log = fs.readFileSync("ADM.log", "utf-8");
  const lines = log.split("\n");

  const state = getState();

  // 🔥 SEMPRE INICIALIZA DIREITO
  let leaderboard: Record<string, { kills: number; deaths: number }> =
    state.players || {};

  let start = state.lastLine || 0;

  // 🔥 SE NÃO TEM PLAYERS → RECONSTRÓI
  if (!leaderboard || Object.keys(leaderboard).length === 0) {
    console.log("♻️ reconstruindo estado...");
    start = 0;
    leaderboard = {};
  }

  console.log(`📄 total linhas: ${lines.length}`);
  console.log(`📍 processando de: ${start}`);

  let newKills = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    const match = line.match(KILL_REGEX);
    if (!match) continue;

    const victim = match[1];
    const killer = match[2];

    // 🔥 GARANTE SEMPRE
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

  console.log(`🎯 novas kills: ${newKills}`);

  // 🔥 DEBUG FORÇADO
  console.log("💾 VAI SALVAR:", leaderboard);

  // 🔥 SALVA GARANTIDO
  saveState({
    players: leaderboard || {},
    lastLine: lines.length,
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
