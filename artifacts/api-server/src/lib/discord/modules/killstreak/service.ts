import { getStateAsync, saveStateAsync } from "../../../state";
import { KILLSTREAK_MAX_EVENTS } from "../../constants";
import { ensureBotState } from "../../state";

export function getKillStreakMeta(streak: number) {
  if (streak >= 25) {
    return {
      emoji: "🌌",
      color: "#FF4FD8",
      en: "reached a GODLIKE",
      pt: "alcançou uma sequência DIVINA de",
    };
  }

  if (streak >= 20) {
    return {
      emoji: "☢️",
      color: "#A020F0",
      en: "is ANNIHILATING the server with a",
      pt: "está ANIQUILANDO o servidor com uma sequência de",
    };
  }

  if (streak >= 15) {
    return {
      emoji: "⚡️",
      color: "#FFD700",
      en: "became UNSTOPPABLE with a",
      pt: "se tornou IMPARÁVEL com uma sequência de",
    };
  }

  if (streak >= 10) {
    return {
      emoji: "🔥",
      color: "#00FF88",
      en: "is DOMINATING with a",
      pt: "está DOMINANDO com uma sequência de",
    };
  }

  return {
    emoji: "📈",
    color: "#0099FF",
    en: "is on a",
    pt: "está em uma sequência de",
  };
}

export async function registerKillStreakFromKill(options: {
  killer: string;
  victim: string;
  weapon?: string;
  timestamp?: number;
}) {
  const killer = options.killer?.trim();
  const victim = options.victim?.trim();

  if (!killer || !victim) return;
  if (killer.toLowerCase() === victim.toLowerCase()) return;

  const state = ensureBotState(await getStateAsync());
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);

  const victimCurrentStreak = Number(state.currentKillStreaks[victim] || 0);

  if (victimCurrentStreak >= 5) {
    state.killStreakEvents.push({
      type: "ended",
      killer,
      player: victim,
      streak: victimCurrentStreak,
      timestamp,
    });
  }

  state.currentKillStreaks[victim] = 0;

  const killerCurrentStreak = Number(state.currentKillStreaks[killer] || 0) + 1;
  state.currentKillStreaks[killer] = killerCurrentStreak;

  if (killerCurrentStreak >= 5 && killerCurrentStreak % 5 === 0) {
    state.killStreakEvents.push({
      type: "streak",
      player: killer,
      streak: killerCurrentStreak,
      timestamp,
    });
  }

  state.killStreakEvents = state.killStreakEvents.slice(-KILLSTREAK_MAX_EVENTS);

  await saveStateAsync(state);
}

