import { getStateAsync, saveStateAsync } from "../state";
import { ensureBotState } from "./state";

export function createDiscordStateAccess() {
  async function getState() {
    const state = ensureBotState(await getStateAsync());

    console.log("📊 Discord lendo state:", {
      global: Object.keys(state.players || {}).length,
      daily: Object.keys(state.dailyPlayers || {}).length,
      weekly: Object.keys(state.weeklyPlayers || {}).length,
      online: Object.keys(state.onlinePlayers || {}).length,
      killfeed: (state.killFeedEvents || []).length,
      killStreakEvents: (state.killStreakEvents || []).length,
      longShotEvents: (state.longShotEvents || []).length,
      messages: Object.keys(state.discordMessageIds || {}).length,
    });

    return state;
  }

  async function saveState(state: any) {
    await saveStateAsync(ensureBotState(state));
    console.log("💾 state salvo pelo Discord");
  }

  return { getState, saveState };
}
