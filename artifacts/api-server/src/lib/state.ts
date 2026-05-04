import fs from "fs";
import path from "path";

// 🔥 FORÇA caminho correto do projeto
const FILE = path.resolve(process.cwd(), "state.json");

export function getState() {
  if (!fs.existsSync(FILE)) {
    return {
      players: {},
      onlinePlayers: {},
      lastLine: 0,
    };
  }

  const data = JSON.parse(fs.readFileSync(FILE, "utf-8"));

  return {
    players: data.players || {},
    onlinePlayers: data.onlinePlayers || {},
    lastLine: data.lastLine || 0,
  };
}

export function saveState(data: any) {
  const safeData = {
    players: data.players || {},
    onlinePlayers: data.onlinePlayers || {},
    lastLine: data.lastLine || 0,
  };

  fs.writeFileSync(FILE, JSON.stringify(safeData, null, 2));

  console.log("💾 STATE SALVO EM:", FILE);
}
