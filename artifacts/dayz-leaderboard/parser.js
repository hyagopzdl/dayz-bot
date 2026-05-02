import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_FILE = path.join(__dirname, 'ADM.log');
const STATE_FILE = path.join(__dirname, 'state.json');

const KILL_REGEX = /Player "(.*?)".*?killed by Player "(.*?)".*?with (.*?) from ([\d.]+) meters/;

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lastLine: 0, players: {}, processed: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function ensurePlayer(players, name) {
  if (!players[name]) {
    players[name] = { kills: 0, deaths: 0 };
  }
}

export function getLeaderboard() {
  const state = loadState();

  let lines;
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    lines = content.split('\n').filter(l => l.trim() !== '');
  } catch {
    return buildLeaderboard(state.players);
  }

  // Detect log file reset (file shrunk)
  if (lines.length < state.lastLine) {
    state.lastLine = 0;
    state.processed = [];
  }

  const newLines = lines.slice(state.lastLine);

  for (const line of newLines) {
    const eventId = line.trim();
    if (!eventId) continue;
    if (state.processed.includes(eventId)) continue;

    const match = KILL_REGEX.exec(line);
    if (match) {
      const victim = match[1];
      const killer = match[2];

      ensurePlayer(state.players, victim);
      ensurePlayer(state.players, killer);

      state.players[victim].deaths += 1;

      // Skip suicides
      if (killer !== victim) {
        state.players[killer].kills += 1;
      }

      state.processed.push(eventId);
    }
  }

  state.lastLine = lines.length;
  saveState(state);

  return buildLeaderboard(state.players);
}

function buildLeaderboard(players) {
  return Object.entries(players)
    .map(([name, stats]) => ({
      name,
      kills: stats.kills,
      deaths: stats.deaths,
      kd: stats.deaths === 0
        ? stats.kills.toFixed(2)
        : (stats.kills / stats.deaths).toFixed(2),
    }))
    .sort((a, b) => b.kills - a.kills);
}
