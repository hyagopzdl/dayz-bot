import { discordAvatarUrl, type PortalSession } from "../auth/session";
import { getOrCreateWalletForLink } from "./economy";
import { getPlayerLinkByDiscordId } from "./playerLinks";
import { getShopCatalog } from "./shopCatalog";
import type { AppState, KillFeedEvent, PlayerStats } from "./state";

const LEADERBOARD_LIMIT = 5;
const RECENT_ACTIVITY_LIMIT = 5;
const SHOP_PREVIEW_LIMIT = 3;

function safeRatio(kills: number, deaths: number) {
  if (deaths <= 0) return kills;
  return Number((kills / deaths).toFixed(2));
}

function rankPlayers(players: Record<string, PlayerStats>) {
  return Object.entries(players || {})
    .map(([gamertag, stats]) => ({
      gamertag,
      kills: Number(stats?.kills || 0),
      deaths: Number(stats?.deaths || 0),
      kd: safeRatio(Number(stats?.kills || 0), Number(stats?.deaths || 0)),
    }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.gamertag.localeCompare(b.gamertag));
}

function getLongshot(state: AppState, gamertag: string | null) {
  if (!gamertag) return 0;
  return (state.longShotEvents || []).reduce((best, event) => {
    return event.killer === gamertag ? Math.max(best, Number(event.distance || 0)) : best;
  }, 0);
}

function mapActivity(event: KillFeedEvent, gamertag: string) {
  const isKill = event.killer === gamertag;
  return {
    id: `${event.at}:${event.killer}:${event.victim}`,
    type: isKill ? "kill" : "death",
    opponent: isKill ? event.victim : event.killer,
    weapon: event.weapon || null,
    at: event.at,
  };
}

export function buildPlayerDashboard(state: AppState, session: PortalSession) {
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const player = link ? state.players?.[link.gamertag] || null : null;
  const wallet = link ? getOrCreateWalletForLink(state, link).wallet : null;
  const leaderboard = rankPlayers(state.players || {});
  const playerRank = link ? leaderboard.findIndex((entry) => entry.gamertag === link.gamertag) + 1 : 0;
  const displayName = session.globalName || session.username;
  const gamertag = link?.gamertag || null;
  const recentActivity = gamertag
    ? (state.killFeedEvents || [])
        .filter((event) => event.killer === gamertag || event.victim === gamertag)
        .slice(-RECENT_ACTIVITY_LIMIT)
        .reverse()
        .map((event) => mapActivity(event, gamertag))
    : [];

  let shopPreview: Array<{
    id: string;
    name: string;
    price: number;
    imageUrl: string | null;
    category: string | null;
  }> = [];

  try {
    shopPreview = getShopCatalog()
      .items.filter((item) => item.enabled !== false)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
      .slice(0, SHOP_PREVIEW_LIMIT)
      .map((item) => ({
        id: item.id,
        name: item.popularName || item.name,
        price: Number(item.price || 0),
        imageUrl: item.imageUrl || null,
        category: item.category || null,
      }));
  } catch {
    // The dashboard must remain available while the catalog cache is warming up.
  }

  return {
    profile: {
      discordId: session.discordId,
      username: session.username,
      displayName,
      avatarUrl: discordAvatarUrl(session),
      role: session.role,
      gamertag,
      linked: Boolean(link),
    },
    stats: {
      coins: Number(wallet?.balance || 0),
      rank: playerRank || null,
      kills: Number(player?.kills || 0),
      deaths: Number(player?.deaths || 0),
      kd: safeRatio(Number(player?.kills || 0), Number(player?.deaths || 0)),
      longshot: getLongshot(state, gamertag),
    },
    leaderboard: leaderboard.slice(0, LEADERBOARD_LIMIT).map((entry, index) => ({
      ...entry,
      rank: index + 1,
      isCurrentPlayer: entry.gamertag === gamertag,
    })),
    recentActivity,
    shopPreview,
    activeMatch: state.activeMatch?.status === "active"
      ? {
          id: state.activeMatch.id,
          name: state.activeMatch.name,
          startedAt: state.activeMatch.startedAt,
          playerStats: gamertag ? state.activeMatch.players?.[gamertag] || null : null,
        }
      : null,
  };
}
