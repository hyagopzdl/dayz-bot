import type { AppState } from "./state";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 99;

export function buildPlayerKillFeed(state: AppState, requestedLimit?: unknown) {
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsedLimit)))
    : DEFAULT_LIMIT;

  const retained = Array.isArray(state.killFeedEvents) ? state.killFeedEvents : [];
  const events = retained
    .slice(-limit)
    .reverse()
    .map((event, index) => ({
      id: `${event.at}:${event.killer}:${event.victim}:${index}`,
      killer: event.killer,
      victim: event.victim,
      weapon: event.weapon || "Unknown",
      distance: Number.isFinite(Number(event.distance)) ? Number(event.distance) : null,
      at: event.at,
    }));

  return {
    events,
    retained: retained.length,
    limit,
    updatedAt: events[0]?.at || null,
  };
}
