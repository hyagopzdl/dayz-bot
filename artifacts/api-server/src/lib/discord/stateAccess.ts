import { getStateAsync, saveDiscordRuntimeStateOnlyAsync, saveDiscordStateAsync } from "../state";
import { ensureBotState } from "./state";
import { getPrimaryServerId } from "../serverRegistry";
import { getServerRuntimeContext, runInServerDataContext } from "../serverRuntime";

export function createDiscordStateAccess(serverId = getPrimaryServerId()) {
  // Resolve through the runtime boundary instead of reading the registry map
  // directly. During primary bootstrap the registry may not have hydrated yet,
  // while secondary servers must still resolve to an explicit managed server.
  const runtime = getServerRuntimeContext(serverId);
  const resolvedServerId = runtime.serverId;

  async function getState() {
    const state = ensureBotState(await runInServerDataContext(resolvedServerId, () => getStateAsync()));

    console.log("📊 Discord lendo state:", {
      serverId: resolvedServerId,
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
    await runInServerDataContext(resolvedServerId, () => saveDiscordStateAsync(ensureBotState(state)));
    console.log("💾 state salvo pelo Discord", { serverId: resolvedServerId });
  }

  async function saveRuntimeState(state: any) {
    await runInServerDataContext(resolvedServerId, () => saveDiscordRuntimeStateOnlyAsync(
      ensureBotState(state),
      `discord:feeds-runtime:${resolvedServerId}`,
    ));
    console.log("💾 runtime do Discord salvo", { serverId: resolvedServerId });
  }

  return { serverId: resolvedServerId, getState, saveState, saveRuntimeState };
}
