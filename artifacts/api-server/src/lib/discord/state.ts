export function ensureBotState(state: any) {
  state.players = state.players || {};
  state.dailyPlayers = state.dailyPlayers || {};
  state.weeklyPlayers = state.weeklyPlayers || {};
  state.onlinePlayers = state.onlinePlayers || {};
  state.onlineSessions = state.onlineSessions || {};
  state.onlineActivitySamples = state.onlineActivitySamples || [];
  state.shopOrders = state.shopOrders || [];
  state.shopSavedLocations = state.shopSavedLocations || [];
  state.shopResetMonitor = state.shopResetMonitor || null;
  state.shopAutoDeploy = state.shopAutoDeploy || null;
  state.files = state.files || {};
  state.recentEventIds = state.recentEventIds || [];
  state.killFeedEvents = state.killFeedEvents || [];
  state.longShotEvents = state.longShotEvents || [];
  state.currentKillStreaks = state.currentKillStreaks || {};
  state.killStreakEvents = state.killStreakEvents || [];
  state.discordMessageIds = state.discordMessageIds || {};
  state.activeMatch = state.activeMatch || null;
  state.discordCommandSettings = state.discordCommandSettings || {};

  return state;
}
