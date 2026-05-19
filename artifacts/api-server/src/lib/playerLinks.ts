import type { AppState, PlayerLink } from "./state";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./i18n";

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

  return link;
}
