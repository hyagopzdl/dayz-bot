import { addPlaytimeRewardMinutes } from "../../../economy";
import { getPlayerLinkByGamertag } from "../../../playerLinks";
import type { AppState } from "../../../state";

export type PlaytimeRewardConfig = {
  enabled: boolean;
  rewardCoins: number;
  rewardMinutes: number;
  tickMinutes: number;
};

const DEFAULT_REWARD_COINS = 60;
const DEFAULT_REWARD_MINUTES = 60;
const DEFAULT_TICK_MINUTES = 5;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPlaytimeRewardConfig(): PlaytimeRewardConfig {
  return {
    enabled: process.env.ECONOMY_PLAYTIME_REWARD_ENABLED === "true",
    rewardCoins: readPositiveInt(process.env.ECONOMY_PLAYTIME_REWARD_COINS, DEFAULT_REWARD_COINS),
    rewardMinutes: readPositiveInt(process.env.ECONOMY_PLAYTIME_REWARD_MINUTES, DEFAULT_REWARD_MINUTES),
    tickMinutes: readPositiveInt(process.env.ECONOMY_PLAYTIME_TICK_MINUTES, DEFAULT_TICK_MINUTES),
  };
}

function isOnlineValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return false;

  const maybeOnline = value as { online?: unknown };
  return maybeOnline.online !== false;
}

export function getOnlineGamertagsForRewards(state: AppState): string[] {
  return Object.entries((state.onlinePlayers || {}) as Record<string, unknown>)
    .filter(([, value]) => isOnlineValue(value))
    .map(([gamertag]) => gamertag)
    .filter(Boolean);
}

export function processPlaytimeRewards(state: AppState, config = getPlaytimeRewardConfig()) {
  if (!config.enabled) {
    return { changed: false, processed: 0, rewarded: 0, paidCoins: 0 };
  }

  const onlineGamertags = getOnlineGamertagsForRewards(state);
  let changed = false;
  let processed = 0;
  let rewarded = 0;
  let paidCoins = 0;

  for (const onlineGamertag of onlineGamertags) {
    const link = getPlayerLinkByGamertag(state, onlineGamertag);
    if (!link) continue;

    processed += 1;
    const result = addPlaytimeRewardMinutes({
      state,
      link,
      minutes: config.tickMinutes,
      rewardMinutes: config.rewardMinutes,
      rewardCoins: config.rewardCoins,
      reason: `Online time reward (${config.rewardCoins} coins / ${config.rewardMinutes} minutes)`,
    });

    changed = true;

    if (result.paid) {
      rewarded += 1;
      paidCoins += result.paidAmount;
    }
  }

  return { changed, processed, rewarded, paidCoins };
}
