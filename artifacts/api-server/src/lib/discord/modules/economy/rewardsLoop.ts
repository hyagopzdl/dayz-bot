import { getPlaytimeRewardConfig, processPlaytimeRewards } from "./rewards";
import type { AppState } from "../../../state";

type EconomyRewardsStateAccess = {
  getState: () => Promise<AppState>;
  saveState: (state: AppState) => Promise<void>;
};

let rewardsLoopStarted = false;

export function startEconomyRewardsLoop(stateAccess: EconomyRewardsStateAccess) {
  if (rewardsLoopStarted) return;

  const config = getPlaytimeRewardConfig();
  if (!config.enabled) {
    console.log("🪙 Playtime rewards disabled");
    return;
  }

  rewardsLoopStarted = true;
  const intervalMs = Math.max(1, config.tickMinutes) * 60 * 1000;

  async function tick() {
    try {
      const latestConfig = getPlaytimeRewardConfig();
      if (!latestConfig.enabled) return;

      const state = await stateAccess.getState();
      const result = processPlaytimeRewards(state, latestConfig);

      if (!result.changed) return;

      await stateAccess.saveState(state);

      if (result.processed > 0) {
        console.log("🪙 playtime rewards processed", {
          processed: result.processed,
          rewarded: result.rewarded,
          paidCoins: result.paidCoins,
          tickMinutes: latestConfig.tickMinutes,
          rewardMinutes: latestConfig.rewardMinutes,
          rewardCoins: latestConfig.rewardCoins,
        });
      }
    } catch (err) {
      console.error("❌ playtime rewards tick failed:", err);
    }
  }

  console.log("🪙 Playtime rewards enabled", {
    rewardCoins: config.rewardCoins,
    rewardMinutes: config.rewardMinutes,
    tickMinutes: config.tickMinutes,
  });

  setInterval(() => {
    void tick();
  }, intervalMs);
}
