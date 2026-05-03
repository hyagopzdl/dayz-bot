import fs from "fs";

const STATE_FILE = "state.json";

export function getState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastLine: 0 };
  }

  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export function saveState(state: any) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
