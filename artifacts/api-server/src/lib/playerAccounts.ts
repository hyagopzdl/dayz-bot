import type { PortalSession } from "../auth/session";
import { findKnownGamertag, getPlayerLinkByDiscordId, normalizeGamertag } from "./playerLinks";
import type { AppState, PlayerStats } from "./state";

export const PLAYER_ALT_LIMIT = 5;

function ensureAltState(state: AppState) {
  state.playerAlts ||= {};
  state.playerLinksByGamertag ||= {};

  for (const [discordId, rawAlts] of Object.entries(state.playerAlts)) {
    const main = state.playerLinks?.[discordId]?.gamertag;
    const mainNormalized = main ? normalizeGamertag(main) : "";
    const seen = new Set<string>();
    const clean: string[] = [];

    for (const raw of Array.isArray(rawAlts) ? rawAlts : []) {
      const known = findKnownGamertag(state, String(raw || ""));
      if (!known) continue;
      const normalized = normalizeGamertag(known);
      if (!normalized || normalized === mainNormalized || seen.has(normalized)) continue;
      const owner = state.playerLinksByGamertag[normalized];
      if (owner && owner !== discordId) continue;
      seen.add(normalized);
      clean.push(known);
      state.playerLinksByGamertag[normalized] = discordId;
    }

    state.playerAlts[discordId] = clean.slice(0, PLAYER_ALT_LIMIT);
  }
}

function requireMain(state: AppState, session: PortalSession) {
  ensureAltState(state);
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  if (!link) throw new Error("Link your main DayZ account with /link on Discord first.");
  return link;
}

function statsFor(pool: Record<string, PlayerStats> | undefined, gamertag: string) {
  const stats = pool?.[gamertag];
  const kills = Number(stats?.kills || 0);
  const deaths = Number(stats?.deaths || 0);
  return { kills, deaths, kd: deaths > 0 ? Number((kills / deaths).toFixed(2)) : kills };
}

function bestStreak(state: AppState, gamertags: Set<string>) {
  let best = 0;
  for (const name of gamertags) best = Math.max(best, Number(state.currentKillStreaks?.[name] || 0));
  for (const event of state.killStreakEvents || []) {
    if (gamertags.has(event.player)) best = Math.max(best, Number(event.streak || 0));
  }
  return best;
}

function bestLongshot(state: AppState, gamertags: Set<string>) {
  let best: { distance: number; gamertag: string; weapon?: string; victim?: string } | null = null;
  for (const event of state.longShotEvents || []) {
    if (!gamertags.has(event.killer)) continue;
    const distance = Number(event.distance || 0);
    if (!best || distance > best.distance) {
      best = { distance, gamertag: event.killer, weapon: event.weapon, victim: event.victim };
    }
  }
  return best;
}

function combinedStats(state: AppState, gamertags: string[], period: "overall" | "weekly" | "daily") {
  const pool = period === "daily" ? state.dailyPlayers : period === "weekly" ? state.weeklyPlayers : state.players;
  let kills = 0;
  let deaths = 0;
  for (const gamertag of gamertags) {
    const stats = statsFor(pool, gamertag);
    kills += stats.kills;
    deaths += stats.deaths;
  }
  return { kills, deaths, kd: deaths > 0 ? Number((kills / deaths).toFixed(2)) : kills };
}

export function getPlayerAccountGamertags(state: AppState, discordId: string) {
  ensureAltState(state);
  const main = state.playerLinks?.[discordId]?.gamertag;
  if (!main) return [];
  return [main, ...(state.playerAlts?.[discordId] || [])];
}

export function buildPlayerAccountsDashboard(state: AppState, session: PortalSession) {
  ensureAltState(state);
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  if (!link) {
    return {
      linked: false,
      accounts: [],
      combined: null,
      config: { maxAlts: PLAYER_ALT_LIMIT },
    };
  }

  const gamertags = getPlayerAccountGamertags(state, session.discordId);
  const names = new Set(gamertags);
  const accounts = gamertags.map((gamertag, index) => ({
    gamertag,
    type: index === 0 ? "main" : "alt",
    ...statsFor(state.players, gamertag),
    online: Boolean(state.onlinePlayers?.[gamertag]),
  }));

  return {
    linked: true,
    accounts,
    combined: {
      overall: combinedStats(state, gamertags, "overall"),
      weekly: combinedStats(state, gamertags, "weekly"),
      daily: combinedStats(state, gamertags, "daily"),
      bestStreak: bestStreak(state, names),
      longestShot: bestLongshot(state, names),
    },
    config: { maxAlts: PLAYER_ALT_LIMIT },
  };
}

export function addPlayerAlt(state: AppState, session: PortalSession, rawGamertag: unknown) {
  const link = requireMain(state, session);
  const requested = String(rawGamertag ?? "").trim();
  const knownGamertag = findKnownGamertag(state, requested);
  if (!knownGamertag) throw new Error("That gamertag has not been seen on this server yet.");

  const normalized = normalizeGamertag(knownGamertag);
  if (normalized === link.gamertagNormalized) throw new Error("That is already your main account.");

  const owner = state.playerLinksByGamertag?.[normalized];
  if (owner && owner !== session.discordId) throw new Error("That gamertag is already linked to another Discord account.");

  const alts = state.playerAlts?.[session.discordId] || [];
  if (alts.some((entry) => normalizeGamertag(entry) === normalized)) throw new Error("That account is already linked as an alt.");
  if (alts.length >= PLAYER_ALT_LIMIT) throw new Error(`You can link up to ${PLAYER_ALT_LIMIT} alt accounts.`);

  state.playerAlts![session.discordId] = [...alts, knownGamertag];
  state.playerLinksByGamertag![normalized] = session.discordId;
  return knownGamertag;
}

export function removePlayerAlt(state: AppState, session: PortalSession, rawGamertag: unknown) {
  const link = requireMain(state, session);
  const normalized = normalizeGamertag(String(rawGamertag ?? ""));
  if (!normalized || normalized === link.gamertagNormalized) throw new Error("The main account cannot be removed here.");

  const alts = state.playerAlts?.[session.discordId] || [];
  const existing = alts.find((entry) => normalizeGamertag(entry) === normalized);
  if (!existing) throw new Error("That alt is not linked to your account.");

  state.playerAlts![session.discordId] = alts.filter((entry) => normalizeGamertag(entry) !== normalized);
  if (state.playerLinksByGamertag?.[normalized] === session.discordId) delete state.playerLinksByGamertag[normalized];
  return existing;
}

export function setMainPlayerAccount(state: AppState, session: PortalSession, rawGamertag: unknown) {
  const link = requireMain(state, session);
  const normalized = normalizeGamertag(String(rawGamertag ?? ""));
  if (!normalized) throw new Error("Select an account to make main.");
  if (normalized === link.gamertagNormalized) return link.gamertag;

  const alts = state.playerAlts?.[session.discordId] || [];
  const nextMain = alts.find((entry) => normalizeGamertag(entry) === normalized);
  if (!nextMain) throw new Error("Only one of your linked alts can be promoted to main.");

  const previousMain = link.gamertag;
  link.gamertag = nextMain;
  link.gamertagNormalized = normalized;
  link.updatedAt = new Date().toISOString();
  state.playerAlts![session.discordId] = [previousMain, ...alts.filter((entry) => normalizeGamertag(entry) !== normalized)];
  state.playerLinksByGamertag![normalizeGamertag(previousMain)] = session.discordId;
  state.playerLinksByGamertag![normalized] = session.discordId;

  const wallet = state.wallets?.[session.discordId];
  if (wallet) {
    wallet.gamertag = nextMain;
    wallet.updatedAt = new Date().toISOString();
  }

  const clanId = state.clanMemberships?.[session.discordId];
  const clan = clanId ? state.clans?.[clanId] : undefined;
  const member = clan?.members.find((entry) => entry.discordId === session.discordId);
  if (member) member.gamertag = nextMain;

  return nextMain;
}
