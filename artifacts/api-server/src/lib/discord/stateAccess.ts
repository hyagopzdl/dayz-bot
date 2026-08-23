import { getStateAsync, saveDiscordRuntimeStateOnlyAsync, saveDiscordStateAsync } from "../state";
import { ensureBotState } from "./state";
import { getManagedServerById, getPrimaryServerId } from "../serverRegistry";
import { runInServerDataContext } from "../serverRuntime";

export function createDiscordStateAccess(serverId = getPrimaryServerId()) {
  if (!getManagedServerById(serverId)) throw new Error(`Discord runtime server not found: ${serverId}`);
  async function getState() {
    const state = ensureBotState(await runInServerDataContext(serverId, () => getStateAsync()));

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
    await runInServerDataContext(serverId, () => saveDiscordStateAsync(ensureBotState(state)));
    console.log("💾 state salvo pelo Discord");
  }

  async function saveRuntimeState(state: any) {
    await runInServerDataContext(serverId, () => saveDiscordRuntimeStateOnlyAsync(
      ensureBotState(state),
      `discord:feeds-runtime:${serverId}`,
    ));
    console.log("💾 runtime do Discord salvo", { serverId });
  }

  return { serverId, getState, saveState, saveRuntimeState };
}
