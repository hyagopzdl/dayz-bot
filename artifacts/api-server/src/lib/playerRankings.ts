import type { PortalSession } from "../auth/session";
import { getPlayerLinkByDiscordId } from "./playerLinks";
import type { AppState, PlayerStats } from "./state";

export type PlayerRankingPeriod = "overall" | "weekly" | "daily";
export type PlayerRankingCategory = "kills" | "kd" | "streak" | "longshot";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const KD_MIN_KILLS = 10;

function safeRatio(kills: number, deaths: number) {
  if (deaths <= 0) return kills;
  return Number((kills / deaths).toFixed(2));
}

function playerPool(state: AppState, period: PlayerRankingPeriod): Record<string, PlayerStats> {
  if (period === "daily") return state.dailyPlayers || {};
  if (period === "weekly") return state.weeklyPlayers || {};
  return state.players || {};
}

function playerStatsEntry(gamertag: string, stats: PlayerStats) {
  const kills = Number(stats?.kills || 0);
  const deaths = Number(stats?.deaths || 0);
  return { gamertag, kills, deaths, kd: safeRatio(kills, deaths) };
}

function getBestStreaks(state: AppState) {
  const bestByPlayer = new Map<string, number>();

  for (const event of state.killStreakEvents || []) {
    if (event?.type !== "streak") continue;
    const streak = Number(event.streak || 0);
    if (streak > Number(bestByPlayer.get(event.player) || 0)) bestByPlayer.set(event.player, streak);
  }

  for (const [player, streak] of Object.entries(state.currentKillStreaks || {})) {
    const value = Number(streak || 0);
    if (value > Number(bestByPlayer.get(player) || 0)) bestByPlayer.set(player, value);
  }

  return [...bestByPlayer.entries()]
    .map(([gamertag, value]) => ({ gamertag, value }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.gamertag.localeCompare(b.gamertag));
}

function getBestLongshots(state: AppState) {
  const bestByPlayer = new Map<string, { distance: number; weapon: string | null; victim: string | null; timestamp: number }>();

  for (const event of state.longShotEvents || []) {
    const distance = Number(event?.distance || 0);
    if (!event?.killer || distance <= 0) continue;
    const current = bestByPlayer.get(event.killer);
    if (!current || distance > current.distance) {
      bestByPlayer.set(event.killer, {
        distance,
        weapon: event.weapon || null,
        victim: event.victim || null,
        timestamp: Number(event.timestamp || 0),
      });
    }
  }

  return [...bestByPlayer.entries()]
    .map(([gamertag, record]) => ({ gamertag, value: record.distance, ...record }))
    .sort((a, b) => b.value - a.value || a.gamertag.localeCompare(b.gamertag));
}

function normalizePeriod(value: unknown): PlayerRankingPeriod {
  return value === "daily" || value === "weekly" ? value : "overall";
}

function normalizeCategory(value: unknown): PlayerRankingCategory {
  return value === "kd" || value === "streak" || value === "longshot" ? value : "kills";
}

function pageNumber(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function buildPlayerRankings(
  state: AppState,
  session: PortalSession,
  options: { period?: unknown; category?: unknown; page?: unknown; pageSize?: unknown } = {},
) {
  const requestedPeriod = normalizePeriod(options.period);
  const category = normalizeCategory(options.category);
  const period: PlayerRankingPeriod = category === "streak" || category === "longshot" ? "overall" : requestedPeriod;
  const pageSize = pageNumber(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const requestedPage = pageNumber(options.page, 1);
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const currentGamertag = link?.gamertag || null;

  let ranked: any[] = [];

  if (category === "streak") {
    ranked = getBestStreaks(state).map((entry) => ({ ...entry, streak: entry.value }));
  } else if (category === "longshot") {
    ranked = getBestLongshots(state).map((entry) => ({
      ...entry,
      distance: entry.value,
    }));
  } else {
    const entries = Object.entries(playerPool(state, period)).map(([gamertag, stats]) => playerStatsEntry(gamertag, stats));
    if (category === "kd") {
      ranked = entries
        .filter((entry) => entry.kills >= KD_MIN_KILLS)
        .sort((a, b) => b.kd - a.kd || b.kills - a.kills || a.deaths - b.deaths || a.gamertag.localeCompare(b.gamertag));
    } else {
      ranked = entries
        .filter((entry) => entry.kills > 0 || entry.deaths > 0)
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.gamertag.localeCompare(b.gamertag));
    }
  }

  const total = ranked.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  const currentIndex = currentGamertag ? ranked.findIndex((entry) => entry.gamertag === currentGamertag) : -1;

  const entries = ranked.slice(start, start + pageSize).map((entry, index) => ({
    ...entry,
    rank: start + index + 1,
    isCurrentPlayer: entry.gamertag === currentGamertag,
  }));

  const currentPlayer = currentIndex >= 0
    ? { ...ranked[currentIndex], rank: currentIndex + 1, isCurrentPlayer: true }
    : currentGamertag
      ? { gamertag: currentGamertag, rank: null, isCurrentPlayer: true }
      : null;

  return {
    scope: "players" as const,
    period,
    requestedPeriod,
    category,
    entries,
    currentPlayer,
    pagination: { page, pageSize, total, totalPages },
    config: {
      kdMinimumKills: KD_MIN_KILLS,
      supportedPeriods: category === "streak" || category === "longshot" ? ["overall"] : ["overall", "weekly", "daily"],
      categories: ["kills", "kd", "streak", "longshot"],
      clans: { available: false, status: "coming_soon" },
    },
  };
}
