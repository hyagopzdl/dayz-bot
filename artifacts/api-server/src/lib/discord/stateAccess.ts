import { getStateAsync, saveDiscordRuntimeStateOnlyAsync, saveDiscordStateAsync, type AppState } from "../state";
import { ensureBotState } from "./state";
import { getManagedServerById, getPrimaryServerId } from "../serverRegistry";
import { getServerRuntimeContext, runInServerDataContext } from "../serverRuntime";

// Discord creates several state-access objects during startup (feeds, command
// registration and interactions). Keep one in-flight hydration per server so
// those paths can never materialize the same large AppState concurrently.
const stateHydrationPromises = new Map<string, Promise<AppState>>();

export function createDiscordStateAccess(serverId = getPrimaryServerId()) {
  const runtime = getServerRuntimeContext(serverId);
  const resolvedServerId = runtime.serverId;

  function assertDiscordServiceEnabled() {
    const currentServer = getManagedServerById(resolvedServerId);
    if (currentServer && !currentServer.enabled) {
      throw new Error(`SERVER_DISABLED:${resolvedServerId}`);
    }
  }

  async function getState() {
    assertDiscordServiceEnabled();

    const existing = stateHydrationPromises.get(resolvedServerId);
    if (existing) return existing;

    const hydration = runInServerDataContext(resolvedServerId, async () => {
      const state = ensureBotState(await getStateAsync());
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
    });

    stateHydrationPromises.set(resolvedServerId, hydration);
    try {
      return await hydration;
    } finally {
      stateHydrationPromises.delete(resolvedServerId);
    }
  }

  async function saveState(state: any) {
    assertDiscordServiceEnabled();
    await runInServerDataContext(resolvedServerId, () => saveDiscordStateAsync(ensureBotState(state)));
    console.log("💾 state salvo pelo Discord", { serverId: resolvedServerId });
  }

  async function saveRuntimeState(state: any) {
    assertDiscordServiceEnabled();
    await runInServerDataContext(resolvedServerId, () => saveDiscordRuntimeStateOnlyAsync(
      ensureBotState(state),
      `discord:feeds-runtime:${resolvedServerId}`,
    ));
    console.log("💾 runtime do Discord salvo", { serverId: resolvedServerId });
  }

  return { serverId: resolvedServerId, getState, saveState, saveRuntimeState };
}
