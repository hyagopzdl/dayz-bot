import type { AppState, PlayerLink } from "./state";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./i18n";
import { getPersistedKnownGamertags } from "./tenantCommerceStore";

export function normalizeGamertag(gamertag: string): string {
  return gamertag.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isValidGamertag(gamertag: string): boolean {
  const trimmed = gamertag.trim();
  return trimmed.length >= 2 && trimmed.length <= 32 && !/[\r\n\t]/.test(trimmed);
}

function ensurePlayerLinkState(state: AppState) {
  state.playerLinks = state.playerLinks || {};
  state.playerLinksByGamertag = state.playerLinksByGamertag || {};

  for (const [discordId, link] of Object.entries(state.playerLinks)) {
    const normalized = link.gamertagNormalized || normalizeGamertag(link.gamertag);
    link.gamertagNormalized = normalized;
    state.playerLinksByGamertag[normalized] = discordId;
    for (const alt of state.playerAlts?.[discordId] || []) {
      const altNormalized = normalizeGamertag(alt);
      if (altNormalized && !state.playerLinksByGamertag[altNormalized]) {
        state.playerLinksByGamertag[altNormalized] = discordId;
      }
    }
  }
}

export function getPlayerLinkByDiscordId(state: AppState, discordId: string): PlayerLink | null {
  ensurePlayerLinkState(state);
  return state.playerLinks?.[discordId] || null;
}

export function getPlayerLinkByGamertag(state: AppState, gamertag: string): PlayerLink | null {
  ensurePlayerLinkState(state);
  const discordId = state.playerLinksByGamertag?.[normalizeGamertag(gamertag)];
  return discordId ? state.playerLinks?.[discordId] || null : null;
}

export function linkPlayerToGamertag(params: {
  state: AppState;
  discordId: string;
  gamertag: string;
  locale?: Locale | string | null;
}): { ok: true; link: PlayerLink } | { ok: false; reason: "INVALID_GAMERTAG" | "GAMERTAG_ALREADY_LINKED" } {
  const { state, discordId, gamertag } = params;
  ensurePlayerLinkState(state);

  if (!isValidGamertag(gamertag)) {
    return { ok: false, reason: "INVALID_GAMERTAG" };
  }

  const now = new Date().toISOString();
  const normalized = normalizeGamertag(gamertag);
  const existingDiscordId = state.playerLinksByGamertag?.[normalized];

  if (existingDiscordId && existingDiscordId !== discordId) {
    return { ok: false, reason: "GAMERTAG_ALREADY_LINKED" };
  }

  const previous = state.playerLinks?.[discordId];
  if (previous?.gamertagNormalized && previous.gamertagNormalized !== normalized) {
    delete state.playerLinksByGamertag?.[previous.gamertagNormalized];
  }

  const link: PlayerLink = {
    discordId,
    gamertag: gamertag.trim(),
    gamertagNormalized: normalized,
    locale: normalizeLocale(params.locale || previous?.locale || DEFAULT_LOCALE),
    linkedAt: previous?.linkedAt || now,
    updatedAt: now,
  };

  state.playerLinks![discordId] = link;
  state.playerLinksByGamertag![normalized] = discordId;

  return { ok: true, link };
}

export function setPlayerLocale(state: AppState, discordId: string, locale: Locale | string): PlayerLink | null {
  ensurePlayerLinkState(state);
  const link = state.playerLinks?.[discordId];
  if (!link) return null;

  link.locale = normalizeLocale(locale);
  link.updatedAt = new Date().toISOString();
  return link;
}

export function unlinkPlayer(state: AppState, discordId: string): PlayerLink | null {
  ensurePlayerLinkState(state);
  const link = state.playerLinks?.[discordId];
  if (!link) return null;

  delete state.playerLinks?.[discordId];
  if (link.gamertagNormalized) {
    delete state.playerLinksByGamertag?.[link.gamertagNormalized];
  }
  for (const alt of state.playerAlts?.[discordId] || []) {
    const normalized = normalizeGamertag(alt);
    if (state.playerLinksByGamertag?.[normalized] === discordId) delete state.playerLinksByGamertag[normalized];
  }
  delete state.playerAlts?.[discordId];

  return link;
}

function getKnownGamertagNames(state: AppState): string[] {
  const namesByNormalized = new Map<string, string>();

  // Historical combat stats are the long-lived source of known players.
  for (const playerName of Object.keys(state.players || {})) {
    const normalized = normalizeGamertag(playerName);
    if (normalized && !namesByNormalized.has(normalized)) namesByNormalized.set(normalized, playerName);
  }

  // A newly seen player may be online before ever recording a kill/death.
  // onlinePlayers is already scoped to the active server context, so accepting it
  // here does not leak identities between tenants.
  for (const playerName of Object.keys(state.onlinePlayers || {})) {
    const normalized = normalizeGamertag(playerName);
    if (normalized && !namesByNormalized.has(normalized)) namesByNormalized.set(normalized, playerName);
  }

  for (const playerName of getPersistedKnownGamertags()) {
    const normalized = normalizeGamertag(playerName);
    if (normalized && !namesByNormalized.has(normalized)) namesByNormalized.set(normalized, playerName);
  }

  return [...namesByNormalized.values()];
}

export function findKnownGamertag(state: AppState, gamertag: string): string | null {
  const normalized = normalizeGamertag(gamertag);
  if (!normalized) return null;

  for (const playerName of getKnownGamertagNames(state)) {
    if (normalizeGamertag(playerName) === normalized) return playerName;
  }

  return null;
}

export function searchKnownGamertags(state: AppState, query: string, limit = 25): string[] {
  const normalizedQuery = normalizeGamertag(query);
  const players = getKnownGamertagNames(state);

  const exact: string[] = [];
  const startsWith: string[] = [];
  const includes: string[] = [];

  for (const playerName of players) {
    const normalizedPlayer = normalizeGamertag(playerName);
    if (!normalizedQuery) {
      includes.push(playerName);
    } else if (normalizedPlayer === normalizedQuery) {
      exact.push(playerName);
    } else if (normalizedPlayer.startsWith(normalizedQuery)) {
      startsWith.push(playerName);
    } else if (normalizedPlayer.includes(normalizedQuery)) {
      includes.push(playerName);
    }
  }

  return [...exact, ...startsWith, ...includes].slice(0, limit);
}
