import { discordAvatarUrl, type PortalSession } from "../auth/session";
import { getPlayerAccountGamertags } from "./playerAccounts";
import { findKnownGamertag, getPlayerLinkByDiscordId, normalizeGamertag } from "./playerLinks";
import type { AppState, PlayerStats } from "./state";

type ProfilePeriod = "overall" | "weekly" | "daily";

function safeRatio(kills: number, deaths: number) {
  return deaths > 0 ? Number((kills / deaths).toFixed(2)) : kills;
}

function playerStats(pool: Record<string, PlayerStats> | undefined, gamertag: string | null) {
  const raw = gamertag ? pool?.[gamertag] : undefined;
  const kills = Number(raw?.kills || 0);
  const deaths = Number(raw?.deaths || 0);
  return { kills, deaths, kd: safeRatio(kills, deaths) };
}

function poolFor(state: AppState, period: ProfilePeriod) {
  if (period === "daily") return state.dailyPlayers || {};
  if (period === "weekly") return state.weeklyPlayers || {};
  return state.players || {};
}

function rankByKills(pool: Record<string, PlayerStats>, gamertag: string | null) {
  if (!gamertag || !pool[gamertag]) return null;
  const me = playerStats(pool, gamertag);
  let ahead = 0;
  for (const [name, raw] of Object.entries(pool)) {
    if (name === gamertag) continue;
    const kills = Number(raw?.kills || 0);
    const deaths = Number(raw?.deaths || 0);
    if (kills > me.kills || (kills === me.kills && (deaths < me.deaths || (deaths === me.deaths && name.localeCompare(gamertag) < 0)))) ahead += 1;
  }
  return ahead + 1;
}

function bestStreak(state: AppState, gamertag: string | null) {
  if (!gamertag) return 0;
  let best = Number(state.currentKillStreaks?.[gamertag] || 0);
  for (const event of state.killStreakEvents || []) {
    if (event.player === gamertag) best = Math.max(best, Number(event.streak || 0));
  }
  return best;
}

function bestLongshot(state: AppState, gamertag: string | null) {
  if (!gamertag) return null;
  let best: { distance: number; weapon?: string; victim?: string; timestamp?: number } | null = null;
  for (const event of state.longShotEvents || []) {
    if (event.killer !== gamertag) continue;
    const distance = Number(event.distance || 0);
    if (!best || distance > best.distance) {
      best = { distance, weapon: event.weapon, victim: event.victim, timestamp: event.timestamp };
    }
  }
  return best;
}

function periodSnapshot(state: AppState, gamertag: string | null, period: ProfilePeriod) {
  const pool = poolFor(state, period);
  return {
    ...playerStats(pool, gamertag),
    rank: rankByKills(pool, gamertag),
  };
}

function combatProfile(state: AppState, gamertag: string | null) {
  return {
    stats: {
      overall: periodSnapshot(state, gamertag, "overall"),
      weekly: periodSnapshot(state, gamertag, "weekly"),
      daily: periodSnapshot(state, gamertag, "daily"),
    },
    records: {
      currentStreak: gamertag ? Number(state.currentKillStreaks?.[gamertag] || 0) : 0,
      bestStreak: bestStreak(state, gamertag),
      longestShot: bestLongshot(state, gamertag),
    },
  };
}

function clanForDiscordId(state: AppState, discordId: string | null | undefined) {
  if (!discordId) return null;
  const clanId = state.clanMemberships?.[discordId];
  const clan = clanId ? state.clans?.[clanId] : undefined;
  const member = clan?.members.find((entry) => entry.discordId === discordId);
  if (!clan || !member) return null;
  return {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    role: member.role,
    joinedAt: member.joinedAt,
    memberCount: clan.members.length,
  };
}

export function buildPlayerProfile(state: AppState, session: PortalSession) {
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const gamertag = link?.gamertag || null;
  const accountGamertags = link ? getPlayerAccountGamertags(state, session.discordId) : [];

  return {
    identity: {
      discordId: session.discordId,
      username: session.username,
      displayName: session.globalName || session.username,
      avatarUrl: discordAvatarUrl(session),
      portalRole: session.role,
      linked: Boolean(link),
      gamertag,
      linkedAt: link?.linkedAt || null,
      online: gamertag ? Boolean(state.onlinePlayers?.[gamertag]) : false,
      linkedCharacters: accountGamertags.length,
    },
    ...combatProfile(state, gamertag),
    clan: clanForDiscordId(state, session.discordId),
    sections: { timeline: "coming-soon", achievements: "coming-soon" },
  };
}

export function buildPublicPlayerProfile(state: AppState, rawGamertag: string) {
  const gamertag = findKnownGamertag(state, rawGamertag);
  if (!gamertag) return null;

  const discordId = state.playerLinksByGamertag?.[normalizeGamertag(gamertag)] || null;
  return {
    identity: {
      gamertag,
      online: Boolean(state.onlinePlayers?.[gamertag]),
    },
    ...combatProfile(state, gamertag),
    clan: clanForDiscordId(state, discordId),
    sections: { timeline: "coming-soon", achievements: "coming-soon" },
  };
}
