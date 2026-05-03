import fs from "fs";
import { getState, saveState } from "./state";

const KILL_REGEX = /Player "(.+?)".*killed by Player "(.+?)"/;

let leaderboard: Record<string, { kills: number }> = {};

export function getLeaderboard() {
  console.log("🔥 PARSER FOI CHAMADO");

  const log = fs.readFileSync("ADM.log", "utf-8");
  const lines = log.split("\n");

  const state = getState();
  const start = state.lastLine || 0;

  console.log(`📄 total linhas: ${lines.length}`);
  console.log(`📍 processando de: ${start}`);

  let newKills = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    const match = line.match(KILL_REGEX);

    if (match) {
      const victim = match[1];
      const killer = match[2];

      if (!leaderboard[killer]) {
        leaderboard[killer] = { kills: 0 };
      }

      leaderboard[killer].kills += 1;

      newKills++;

      console.log(`🔫 ${killer} matou ${victim}`);
    }
  }

  console.log(`🎯 novas kills: ${newKills}`);

  // 🔥 salva progresso
  saveState({ lastLine: lines.length });

  return Object.entries(leaderboard)
    .map(([name, data]) => ({
      name,
      kills: data.kills,
    }))
    .sort((a, b) => b.kills - a.kills);
}
