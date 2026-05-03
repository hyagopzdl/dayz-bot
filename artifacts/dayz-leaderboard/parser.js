import fs from "fs";

const STATE_FILE = "state.json";

type PlayerStats = {
  kills: number;
  deaths: number;
};

type State = {
  lastLine: number;
  players: Record<string, PlayerStats>;
  processed: string[];
};

function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastLine: 0,
      players: {},
      processed: []
    };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function saveState(state: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getLeaderboard() {
  if (!fs.existsSync("ADM.log")) return [];

  const log = fs.readFileSync("ADM.log", "utf-8");
  const lines = log.split("\n");

  const state = loadState();

  // reset se arquivo reiniciou
  if (lines.length < state.lastLine) {
    state.lastLine = 0;
    state.processed = [];
  }

  const newLines = lines.slice(state.lastLine);

  const killRegex =
    /Player "(.*?)".*killed by Player "(.*?)".*with (.*?) from ([\d.]+) meters/;

  for (const line of newLines) {
    const match = line.match(killRegex);
    if (!match) continue;

    const victim = match[1];
    const killer = match[2];

    const eventId = line;

    if (state.processed.includes(eventId)) continue;
    state.processed.push(eventId);

    if (!state.players[victim]) {
      state.players[victim] = { kills: 0, deaths: 0 };
    }

    if (!state.players[killer]) {
      state.players[killer] = { kills: 0, deaths: 0 };
    }

    state.players[victim].deaths++;

    if (killer !== victim) {
      state.players[killer].kills++;
    }
  }

  state.lastLine = lines.length;
  saveState(state);

  return Object.entries(state.players)
    .map(([name, stats]) => {
      const kd = stats.kills / (stats.deaths || 1);

      return {
        name,
        kills: stats.kills,
        kd: kd.toFixed(2)
      };
    })
    .sort((a, b) => b.kills - a.kills);
}