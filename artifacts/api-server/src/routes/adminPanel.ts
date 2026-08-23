import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import sharp from "sharp";
import { Router, type Request, type Response } from "express";
import { Routes } from "discord.js";
import { deployPendingShopOrders, getShopRuntimeStatus, SHOP_EVENTS_PATH } from "../lib/shop";
import {
  checkAirdropMilitarySetupNow,
  checkLockedContainerSetupNow,
  cleanupMapEventsNow,
  ensureAirdropMilitarySetupNow,
  ensureLockedContainerSetupNow,
  getMapEventPresetPayload,
  injectMapEventNow,
  uninstallAirdropMilitarySetupNow,
  uninstallLockedContainerSetupNow,
} from "../lib/mapEvents/mapEventService";
import {
  createScheduledMapEvent,
  deleteScheduledMapEvent,
  listScheduledMapEvents,
  runScheduledMapEventNow,
  startMapEventScheduler,
  updateScheduledMapEventStatus,
} from "../lib/mapEvents/mapEventScheduleService";
import {
  deleteShopCatalogCategory,
  deleteShopCatalogItem,
  ensureShopCatalogLoaded,
  getShopCatalog,
  normalizeShopCatalogId,
  reorderShopCategories,
  reorderShopItems,
  toggleShopCatalogItem,
  upsertShopCatalogCategoryItem,
  upsertShopCatalogItem,
  type ShopCatalog,
  type ShopItem,
} from "../lib/shopCatalog";
import {
  addCoins,
  removeCoins,
  setCoins,
  getOrCreateWalletForLink,
} from "../lib/economy";
import {
  getDayzItemByClassName,
  getDayzItemsPage,
  searchDayzItemsFromDatabase,
  toggleDayzItemInDatabase,
  updateDayzItemInDatabase,
} from "../lib/dayzItemsService";
import {
  createManagedServerDraft,
  getStateAsync,
  saveStateAsync,
  flushStateAsync,
  getStatePersistenceMetrics,
  getDiscordRuntimePersistenceMetrics,
  getStateDomainPersistenceMetrics,
  getGranularPlayerStatsPersistenceMetrics,
  getPlayerPositionHistoryMetrics,
  getLatestPlayerPositionSnapshot,
  type AppState,
  type PlayerLink,
  type Wallet,
  updateManagedServerDraft,
  updateManagedServerScopedSettings,
  markManagedServerNitradoValidated,
  setManagedServerRuntimeEnabled,
  setManagedServerRuntimePaused,
  flushServerRuntimePendingStateAsync,
  createManagedOrganization,
  createManagedOrganizationForOwner,
  upsertOrganizationMembership,
  removeOrganizationMembership,
  saveOrganizationNitradoCredential,
  removeOrganizationNitradoCredential,
  refreshManagedServerRegistryFromDb,
} from "../lib/state";
import { getDiscordClient } from "../lib/discordBot";
import { listDiscordCommandDescriptors, normalizeDiscordCommandSettings } from "../lib/discord/commandSettings";
import { registerDiscordCommands } from "../lib/discord/commands";
import { applyServiceSettingsToCommandSettings, normalizeServiceSettings } from "../lib/serviceSettings";
import { buildMapVotePollOptionText, buildMapVotePollQuestion, buildMapVotePublicWelcomePayload } from "../lib/discord/modules/map-vote/ui";
import { downloadTextFile, uploadTextFile } from "../lib/nitradoFtp";
import { getAdmDownloadMetrics, setAdmDownloadMode } from "../lib/nitradoDownloader";
import { getRuntimePerformanceMetrics } from "../lib/runtimeMetrics";
import { getNetworkMetrics } from "../lib/networkMetrics";
import { getManagedServerById, getPrimaryServerDescriptor, getPrimaryServerId, getServerFoundationDiagnostics, listManagedServers } from "../lib/serverRegistry";
import { getActiveServerId, isServerRuntimeLocked, runInServerDataContext, runInServerMaintenanceContext, runInServerRuntimeContext, runWithServerMaintenanceLock } from "../lib/serverRuntime";
import {
  discoverNitradoServices,
  getIntegrationOnboardingStatus,
  listDiscordGuildChannels,
  listDiscordGuildOptions,
  testOrganizationNitradoCredential,
  validateNitradoServiceSetup,
} from "../lib/serverIntegrations";
import { runManagedServerActivationPreflight } from "../lib/serverPreflight";
import { getPlayerPortalContextDiagnostics } from "../lib/playerPortalServerContext";
import { getPlayerLinkByGamertag } from "../lib/playerLinks";
import {
  getManagedServerRuntimeCoordinatorDiagnostics,
  requestManagedServerRuntimeCycle,
  resetManagedServerRuntimeCircuit,
} from "../lib/serverRuntimeCoordinator";
import {
  buildOrganizationId,
  canOrganizationRole,
  getDefaultOrganizationId,
  getManagedOrganizationById,
  getOrganizationFoundationDiagnostics,
  getUserOrganizationMembership,
  listManagedOrganizations,
  listOrganizationMemberships,
  listUserOrganizationMemberships,
  isSaasSelfServiceEnabled,
} from "../lib/organizationRegistry";
import {
  getOrganizationIntegrationStatus,
  getOrganizationIntegrationsDiagnostics,
} from "../lib/organizationIntegrations";
import { getShopCatalogDiagnostics, cloneShopCatalog } from "../lib/shopCatalog";
import { getAdminServerAccess } from "../lib/adminUsers";

const router = Router();

// Every authenticated admin request must execute inside the server bound to
// that admin account. This prevents implicit getActiveServerId() fallbacks from
// reading/writing the primary server when admin2 is managing a secondary.
router.use(async (req, res, next) => {
  const adminSession = req.adminSession;
  const serverId = String(adminSession?.serverId || "").trim();
  if (!adminSession || !serverId) return next();
  const server = getManagedServerById(serverId);
  if (!server) return next();
  try {
    const access = await getAdminServerAccess(adminSession.adminUserId, serverId);
    if (!access || access.organizationId !== server.organizationId) {
      res.status(403).json({ error: "ADMIN_SERVER_FORBIDDEN", serverId });
      return;
    }
    (req as any).adminServerAccess = access;
    return runInServerDataContext(serverId, () => next());
  } catch (error) {
    next(error);
  }
});

startMapEventScheduler();
const TOKEN_COOKIE = "admin_panel_token";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

type AdminState = AppState & Record<string, any>;

function buildServerRuntimeObservability() {
  const coordinator = getManagedServerRuntimeCoordinatorDiagnostics();
  const coordinatorByServer = new Map((coordinator.servers || []).map((item: any) => [item.serverId, item]));
  const adm = getAdmDownloadMetrics();
  const admByServer = new Map((adm.servers || []).map((item: any) => [item.serverId, item]));

  return listManagedServers().map((server) => {
    const persistence = getStatePersistenceMetrics(server.id);
    const domains = getStateDomainPersistenceMetrics(server.id);
    const granular = getGranularPlayerStatsPersistenceMetrics(server.id);
    const discordRuntime = getDiscordRuntimePersistenceMetrics(server.id);
    const positions = getPlayerPositionHistoryMetrics(server.id);
    const runtime = getRuntimePerformanceMetrics(server.id);
    const coordinatorStatus = coordinatorByServer.get(server.id) as any;
    const admStatus = admByServer.get(server.id) as any;
    return {
      serverId: server.id,
      serverName: server.name,
      primary: server.primary,
      runtimeEnabled: server.runtimeEnabled,
      onboardingStatus: server.onboardingStatus,
      executable: Boolean(coordinatorStatus?.executable),
      state: {
        bootSource: domains.bootSource,
        reads: persistence.reads,
        writes: persistence.writes,
        failedWrites: persistence.failedWrites,
        totalPayloadBytesWritten: persistence.totalPayloadBytesWritten,
        pendingDomains: domains.pendingDomains,
        domainFlushes: domains.flushes,
        domainRowsWritten: domains.rowsWritten,
        domainBytesWritten: domains.totalPayloadBytesWritten,
        granularRowsAppliedAtBoot: granular.rowsAppliedAtBoot,
        granularPendingPlayers: granular.pendingPlayers,
        granularRowsWritten: granular.rowsWritten,
        granularFailedBatches: granular.failedBatches,
        positionObservations: positions.observationsReceived,
        positionPlayers: positions.uniquePlayersObserved,
        positionRowsWritten: positions.rowsWritten,
        positionFailedBatches: positions.failedBatches,
        discordRuntimeWrites: discordRuntime.writes,
        discordRuntimeFailedWrites: discordRuntime.failedWrites,
      },
      runtime: {
        cyclesStarted: runtime.cyclesStarted,
        cyclesCompleted: runtime.cyclesCompleted,
        skippedOverlaps: runtime.cyclesSkippedOverlap,
        cycleFailures: runtime.cycleFailures,
        averageCycleDurationMs: runtime.averageCycleDurationMs,
        averageDownloadDurationMs: runtime.averageDownloadDurationMs,
        averageParserDurationMs: runtime.averageParserDurationMs,
        lastCycleFinishedAt: runtime.lastCycleFinishedAt,
        lastError: coordinatorStatus?.lastError,
        health: coordinatorStatus?.health || (server.runtimeEnabled ? "starting" : "stopped"),
        paused: Boolean(coordinatorStatus?.paused),
        consecutiveFailures: Number(coordinatorStatus?.consecutiveFailures || 0),
        circuitState: coordinatorStatus?.circuitState || "closed",
        circuitSkips: Number(coordinatorStatus?.circuitSkips || 0),
        circuitRetryAt: coordinatorStatus?.circuitRetryAt || null,
        lastHealthyAt: coordinatorStatus?.lastHealthyAt || null,
      },
      adm: {
        cycles: Number(admStatus?.cycles || 0),
        downloads: Number(admStatus?.downloads || 0),
        bytesDownloaded: Number(admStatus?.bytesDownloaded || 0),
        averageBytesPerCycle: Number(admStatus?.averageBytesPerCycle || 0),
        projected30DayBytes: Number(admStatus?.projected30DayBytes || 0),
        downloadFailures: Number(admStatus?.downloadFailures || 0),
      },
    };
  });
}


type SpawnZonePointPayload = { id: string; x: number; z: number; createdAt?: string; updatedAt?: string };
type SpawnZonePayload = { id: string; name: string; color: string; enabled: boolean; points: SpawnZonePointPayload[]; createdAt: string; updatedAt: string };
type MapRotationSettingsPayload = { pollChannelId?: string; pollCategoryId?: string; pollQuestion?: string; pollOpenDay?: string; pollOpenTime?: string; pollCloseDay?: string; pollCloseTime?: string; pollTimezone?: string; autoCreatePoll?: boolean; recurringPollAfterFinish?: boolean; autoApplyWinner?: boolean; applyOnNextRestart?: boolean; tiePolicy?: string; minVotes?: number; spawnFilePath?: string; serverName?: string; mapVoteWelcomeMessageId?: string };
type MapRotationPollOptionPayload = { zoneId: string; name: string; answerId?: number; votes?: number };
type MapRotationActivePollPayload = { id: string; channelId: string; messageId: string; question: string; status: string; createdAt: string; openAt?: string; closesAt?: string; windowId?: string; durationMs?: number; recurring?: boolean; options: MapRotationPollOptionPayload[]; totalVotes?: number; winnerZoneId?: string; winnerName?: string; lastFetchedAt?: string; finalizedAt?: string; appliedAt?: string; finalReason?: string; rawUrl?: string };
type MapRotationAutomationPayload = { lastPollWindowId?: string; lastCloseWindowId?: string; lastCheckedAt?: string; lastAction?: string; lastError?: string; currentWindowId?: string; currentWindowOpenAt?: string; currentWindowCloseAt?: string; nextWindowOpenAt?: string; nextWindowCloseAt?: string; activePollClosesAt?: string; activePollOverdueByMs?: number; nextRecurringPollAt?: string; recurringPollDurationMs?: number; lastRecurringPollAt?: string; lastCategoryUpdateAt?: string; lastCategoryName?: string; lastDeletedPollMessageId?: string; lastDeletedPollAt?: string; lastMissingPollMessageId?: string; lastMissingPollAt?: string; schedulerIntervalMs?: number };
type MapRotationPayload = { zones: SpawnZonePayload[]; currentZoneId?: string; nextZoneId?: string; voteHistory: any[]; settings: MapRotationSettingsPayload; activePoll?: MapRotationActivePollPayload; automation?: MapRotationAutomationPayload; updatedAt: string };

const SPAWN_ZONE_FILE_PATH = SHOP_EVENTS_PATH.replace(/\/db\/events\.xml$/i, "/cfgplayerspawnpoints.xml");

const SPAWN_ZONE_COLORS = ["#e11d48", "#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"];
const SPAWN_ZONE_WORLD_SIZE = 15360;
const SPAWN_ZONE_MAP_TILE_SIZE = 512;
const SPAWN_ZONE_MAP_TILE_MAX_ZOOM = 5;

function resolveChernarusMapPath() {
  return path.resolve(
    process.cwd(),
    process.env.SHOP_MAP_IMAGE_PATH || "assets/maps/chernarus-map-pz-bot.png",
  );
}

function normalizeSpawnZoneName(value: unknown) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.slice(0, 48);
}

function normalizeSpawnZoneColor(value: unknown, fallback = SPAWN_ZONE_COLORS[0]) {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function normalizeSpawnZoneCoordinate(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(SPAWN_ZONE_WORLD_SIZE, Number(numeric.toFixed(2))));
}

function makeSpawnZonePoint(x: unknown, z: unknown): SpawnZonePointPayload {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    x: normalizeSpawnZoneCoordinate(x),
    z: normalizeSpawnZoneCoordinate(z),
    createdAt: now,
    updatedAt: now,
  };
}

function extractFreshSpawnPointsFromCfg(xml: unknown): SpawnZonePointPayload[] {
  const value = String(xml || "");
  const freshMatch = value.match(/<fresh>[\s\S]*?<\/fresh>/i);
  if (!freshMatch) throw new Error("cfgplayerspawnpoints.xml sem bloco <fresh> suportado.");
  const bubblesMatch = freshMatch[0].match(/<generator_posbubbles>[\s\S]*?<\/generator_posbubbles>/i);
  if (!bubblesMatch) throw new Error("cfgplayerspawnpoints.xml sem bloco <fresh>/<generator_posbubbles> suportado.");
  const points: SpawnZonePointPayload[] = [];
  const regex = /<pos\b[^>]*\bx=["']([^"']+)["'][^>]*\bz=["']([^"']+)["'][^>]*\/?>(?:<\/pos>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(bubblesMatch[0]))) {
    const x = Number(String(match[1] || "").replace(",", "."));
    const z = Number(String(match[2] || "").replace(",", "."));
    if (Number.isFinite(x) && Number.isFinite(z)) points.push(makeSpawnZonePoint(x, z));
  }
  if (!points.length) throw new Error("Nenhuma coordenada <pos x=... z=...> encontrada em fresh/generator_posbubbles.");
  return points;
}

function normalizeSpawnZone(zone: any, index = 0): SpawnZonePayload {
  const now = new Date().toISOString();
  const points = Array.isArray(zone?.points)
    ? zone.points.map((point: any) => ({
        id: String(point?.id || crypto.randomUUID()),
        x: normalizeSpawnZoneCoordinate(point?.x),
        z: normalizeSpawnZoneCoordinate(point?.z),
        createdAt: point?.createdAt || now,
        updatedAt: point?.updatedAt || now,
      }))
    : [];
  return {
    id: String(zone?.id || crypto.randomUUID()),
    name: normalizeSpawnZoneName(zone?.name) || `Zona ${index + 1}`,
    color: normalizeSpawnZoneColor(zone?.color, SPAWN_ZONE_COLORS[index % SPAWN_ZONE_COLORS.length]),
    enabled: zone?.enabled !== false,
    points,
    createdAt: zone?.createdAt || now,
    updatedAt: zone?.updatedAt || now,
  };
}

function defaultSpawnZone(): SpawnZonePayload {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "VMC",
    color: SPAWN_ZONE_COLORS[0],
    enabled: true,
    points: [],
    createdAt: now,
    updatedAt: now,
  };
}


function normalizeMapVoteTimezone(value: unknown) {
  const fallback = process.env.MAP_VOTE_TIMEZONE || process.env.SHOP_RESTART_TIMEZONE || "America/Sao_Paulo";
  const candidate = String(value || fallback).trim() || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function normalizeMapRotationSettings(value: unknown): MapRotationSettingsPayload {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const minVotes = Number(input.minVotes ?? 0);
  return {
    pollChannelId: String(input.pollChannelId || "").trim(),
    pollCategoryId: String(input.pollCategoryId || process.env.MAP_VOTE_CATEGORY_ID || "1515944927257825341").trim(),
    pollQuestion: String(input.pollQuestion || buildMapVotePollQuestion()).trim().slice(0, 240),
    serverName: String(input.serverName || process.env.ADMIN_PANEL_SERVER_NAME || process.env.SERVER_NAME || "DayZ Server").trim().slice(0, 80) || "DayZ Server",
    pollOpenDay: String(input.pollOpenDay || "monday"),
    pollOpenTime: String(input.pollOpenTime || "12:00").slice(0, 5),
    pollCloseDay: String(input.pollCloseDay || "sunday"),
    pollCloseTime: String(input.pollCloseTime || "23:59").slice(0, 5),
    pollTimezone: normalizeMapVoteTimezone(input.pollTimezone),
    autoCreatePoll: Boolean(input.autoCreatePoll),
    recurringPollAfterFinish: Boolean(input.recurringPollAfterFinish),
    autoApplyWinner: Boolean(input.autoApplyWinner),
    applyOnNextRestart: input.applyOnNextRestart === true,
    tiePolicy: ["manual", "keep_current", "random"].includes(String(input.tiePolicy || "")) ? String(input.tiePolicy) : "manual",
    minVotes: Number.isFinite(minVotes) && minVotes > 0 ? Math.floor(minVotes) : 0,
    spawnFilePath: String(input.spawnFilePath || SPAWN_ZONE_FILE_PATH).trim() || SPAWN_ZONE_FILE_PATH,
    mapVoteWelcomeMessageId: String(input.mapVoteWelcomeMessageId || "").trim(),
  };
}


function mergeMapRotationClientSnapshot(rotation: MapRotationPayload, snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return rotation;
  const input = snapshot as Partial<MapRotationPayload>;
  if (Array.isArray(input.zones) && input.zones.length > 0) {
    const zones = input.zones.map((zone: any, index: number) => normalizeSpawnZone(zone, index));
    rotation.zones = zones;
    if (!zones.some((zone) => zone.id === rotation.currentZoneId)) {
      rotation.currentZoneId = zones.some((zone) => zone.id === input.currentZoneId) ? input.currentZoneId : rotation.currentZoneId;
    }
    if (!zones.some((zone) => zone.id === rotation.currentZoneId)) rotation.currentZoneId = zones[0]?.id;
    if (!zones.some((zone) => zone.id === rotation.nextZoneId)) {
      rotation.nextZoneId = zones.some((zone) => zone.id === input.nextZoneId) ? input.nextZoneId : undefined;
    }
  }
  if (input.currentZoneId && rotation.zones.some((zone) => zone.id === input.currentZoneId)) rotation.currentZoneId = input.currentZoneId;
  if (input.nextZoneId && rotation.zones.some((zone) => zone.id === input.nextZoneId)) rotation.nextZoneId = input.nextZoneId;
  if (Array.isArray(input.voteHistory) && input.voteHistory.length > 0) rotation.voteHistory = input.voteHistory.slice(-24);
  if (input.settings && typeof input.settings === "object") {
    rotation.settings = normalizeMapRotationSettings({ ...(rotation.settings || {}), ...input.settings });
  }
  return rotation;
}

function mergeSpawnZonesRequestSnapshot(rotation: MapRotationPayload, body: any) {
  if (body?.rotation && typeof body.rotation === "object") mergeMapRotationClientSnapshot(rotation, body.rotation);
  if (body?.spawnZones && typeof body.spawnZones === "object") mergeMapRotationClientSnapshot(rotation, body.spawnZones);
  return rotation;
}


const SPAWN_ZONE_WEEKDAY_INDEX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function getZonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(byType.get("year"));
  const month = Number(byType.get("month"));
  const day = Number(byType.get("day"));
  const hour = Number(byType.get("hour"));
  const minute = Number(byType.get("minute"));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

function addCalendarDays(parts: Pick<ReturnType<typeof getZonedDateParts>, "year" | "month" | "day">, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function zonedLocalDateTimeToDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  let date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedDateParts(date, timeZone);
    const expected = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const diff = expected - actual;
    if (diff === 0) break;
    date = new Date(date.getTime() + diff);
  }
  return date;
}

function parseSpawnZoneTime(time: unknown, fallback: string) {
  const [hourRaw, minuteRaw] = String(time || fallback).split(":");
  const hour = Math.max(0, Math.min(23, Number(hourRaw || 0)));
  const minute = Math.max(0, Math.min(59, Number(minuteRaw || 0)));
  return { hour, minute };
}

function nextWeekdayDate(day: unknown, time: unknown, from = new Date(), timeZone = "America/Sao_Paulo") {
  const targetDay = SPAWN_ZONE_WEEKDAY_INDEX[String(day || "sunday")] ?? 0;
  const { hour, minute } = parseSpawnZoneTime(time, "23:59");
  const localNow = getZonedDateParts(from, timeZone);
  const diff = (targetDay - localNow.weekday + 7) % 7;
  let localDate = addCalendarDays(localNow, diff);
  let next = zonedLocalDateTimeToDate(localDate.year, localDate.month, localDate.day, hour, minute, timeZone);
  if (next.getTime() <= from.getTime()) {
    localDate = addCalendarDays(localDate, 7);
    next = zonedLocalDateTimeToDate(localDate.year, localDate.month, localDate.day, hour, minute, timeZone);
  }
  return next;
}

function extractDiscordPollCounts(message: any, activePoll: MapRotationActivePollPayload) {
  const answers = Array.isArray(message?.poll?.answers) ? message.poll.answers : [];
  const counts = Array.isArray(message?.poll?.results?.answer_counts) ? message.poll.results.answer_counts : [];
  const countById = new Map<number, number>();
  for (const item of counts) {
    const id = Number(item?.answer_id ?? item?.id);
    if (Number.isFinite(id)) countById.set(id, Number(item?.count || 0));
  }
  const answerIdByText = new Map<string, number>();
  answers.forEach((answer: any, index: number) => {
    const text = String(answer?.poll_media?.text || answer?.text || "").trim();
    const id = Number(answer?.answer_id ?? answer?.id ?? index + 1);
    if (text && Number.isFinite(id)) answerIdByText.set(text.toLowerCase(), id);
  });
  const options = (activePoll.options || []).map((option, index) => {
    const answerId = Number(option.answerId || answerIdByText.get(String(option.name || "").toLowerCase()) || index + 1);
    return {
      ...option,
      answerId,
      votes: Number(countById.get(answerId) || option.votes || 0),
    };
  });
  const totalVotes = options.reduce((sum, option) => sum + Number(option.votes || 0), 0);
  const maxVotes = Math.max(-1, ...options.map((option) => Number(option.votes || 0)));
  const winners = options.filter((option) => Number(option.votes || 0) === maxVotes && maxVotes >= 0);
  const winner = winners.length === 1 ? winners[0] : undefined;
  return {
    ...activePoll,
    options,
    totalVotes,
    winnerZoneId: winner?.zoneId,
    winnerName: winner?.name,
    status: message?.poll?.results?.is_finalized ? "closed" : activePoll.status || "active",
    lastFetchedAt: new Date().toISOString(),
  };
}


function formatMapVoteDateRangePart(date: Date, timeZone: string) {
  const parts = getZonedDateParts(date, timeZone);
  return `${String(parts.day).padStart(2, "0")}.${String(parts.month).padStart(2, "0")}`;
}

function getNextRestartDate(settings: MapRotationSettingsPayload, from = new Date()) {
  const raw = String(process.env.SHOP_RESTART_TIMES || process.env.SERVER_RESTART_TIMES || "00:00").trim();
  const timeZone = normalizeMapVoteTimezone(settings.pollTimezone);
  const localFrom = getZonedDateParts(from, timeZone);
  const candidates = raw.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  let best: Date | null = null;
  for (const candidate of candidates.length ? candidates : ["00:00"]) {
    const { hour, minute } = parseSpawnZoneTime(candidate, "00:00");
    let reset = zonedLocalDateTimeToDate(localFrom.year, localFrom.month, localFrom.day, hour, minute, timeZone);
    if (reset.getTime() <= from.getTime()) {
      const nextDay = addCalendarDays(localFrom, 1);
      reset = zonedLocalDateTimeToDate(nextDay.year, nextDay.month, nextDay.day, hour, minute, timeZone);
    }
    if (!best || reset.getTime() < best.getTime()) best = reset;
  }
  return best || from;
}

function getMapVoteRotationPeriod(settings: MapRotationSettingsPayload, pollCloseAt = new Date()) {
  const timeZone = normalizeMapVoteTimezone(settings.pollTimezone);
  const start = getNextRestartDate(settings, pollCloseAt);
  const startLocal = getZonedDateParts(start, timeZone);
  const rotationDays = Math.max(1, Math.min(31, Number(process.env.MAP_VOTE_ROTATION_DAYS || 7) || 7));
  const endLocal = addCalendarDays(startLocal, rotationDays - 1);
  const end = zonedLocalDateTimeToDate(endLocal.year, endLocal.month, endLocal.day, 23, 59, timeZone);
  return { start, end, timeZone };
}

function getMapVoteRotationPeriodLabel(settings: MapRotationSettingsPayload, pollCloseAt = new Date()) {
  const period = getMapVoteRotationPeriod(settings, pollCloseAt);
  return `${formatMapVoteDateRangePart(period.start, period.timeZone)} ~ ${formatMapVoteDateRangePart(period.end, period.timeZone)}`;
}

function stripMapVotePeriodSuffix(question: string) {
  return String(question || "").replace(/\s*\[\d{2}\.\d{2}\s*~\s*\d{2}\.\d{2}\]\s*$/u, "").trim();
}

function buildMapVotePollQuestionWithPeriod(settings: MapRotationSettingsPayload, pollCloseAt = new Date()) {
  const base = stripMapVotePeriodSuffix(settings.pollQuestion || buildMapVotePollQuestion()) || buildMapVotePollQuestion();
  const periodLabel = getMapVoteRotationPeriodLabel(settings, pollCloseAt);
  return `${base} [${periodLabel}]`.slice(0, 300);
}

const spawnZonePollCreationInFlight = new Map<string, Promise<MapRotationActivePollPayload>>();

async function createDiscordSpawnZonePoll(rotation: MapRotationPayload, optionsOverride: { openAt?: Date; closeAt?: Date; windowId?: string; recurring?: boolean } = {}) {
  const serverId = getActiveServerId();
  const current = spawnZonePollCreationInFlight.get(serverId);
  if (current) return current;
  const inFlight = createDiscordSpawnZonePollUnlocked(rotation, optionsOverride)
    .finally(() => {
      spawnZonePollCreationInFlight.delete(serverId);
    });
  spawnZonePollCreationInFlight.set(serverId, inFlight);
  return inFlight;
}

async function createDiscordSpawnZonePollUnlocked(rotation: MapRotationPayload, optionsOverride: { openAt?: Date; closeAt?: Date; windowId?: string; recurring?: boolean } = {}) {
  const settings = normalizeMapRotationSettings(rotation.settings);
  const channelId = String(settings.pollChannelId || "").trim();
  if (!channelId) throw new Error("Configure o canal da enquete em Spawn Zones > Settings.");
  const options = rotation.zones.filter((zone) => zone.enabled !== false && (zone.points || []).length > 0).slice(0, 10);
  if (options.length < 2) throw new Error("Crie pelo menos 2 zonas habilitadas com pontos para gerar a enquete.");
  const client = getDiscordClient();
  const now = new Date();
  const openAt = optionsOverride.openAt || now;
  const scheduleWindow = getMapRotationScheduleWindow(settings, now);
  let closeAt = optionsOverride.closeAt || scheduleWindow.closeAt;
  if (closeAt.getTime() <= now.getTime()) {
    closeAt = new Date(now.getTime() + Math.max(60 * 60 * 1000, Number(optionsOverride.closeAt ? 0 : scheduleWindow.closeAt.getTime() - scheduleWindow.openAt.getTime())));
  }
  const durationMs = Math.max(60 * 60 * 1000, closeAt.getTime() - now.getTime());
  const durationHours = Math.max(1, Math.min(168, Math.ceil(durationMs / 36e5)));
  const question = buildMapVotePollQuestionWithPeriod(settings, closeAt);
  await createOrUpdateMapVoteWelcomeMessage(rotation, { pin: true, periodLabel: getMapVoteRotationPeriodLabel(settings, closeAt) });
  const body = {
    poll: {
      question: { text: question },
      answers: options.map((zone) => ({ poll_media: { text: buildMapVotePollOptionText(zone, rotation.currentZoneId) } })),
      duration: durationHours,
      allow_multiselect: false,
      layout_type: 1,
    },
  };
  const route = Routes.channelMessages(channelId) as `/${string}`;
  const message = (await client.rest.post(route, { body })) as any;
  const messageId = String(message?.id || "");
  if (!messageId) throw new Error("Discord não retornou o ID da mensagem da enquete.");
  const windowId = optionsOverride.windowId || scheduleWindow.id;
  return {
    id: crypto.randomUUID(),
    channelId,
    messageId,
    question,
    status: "active",
    createdAt: new Date().toISOString(),
    openAt: openAt.toISOString(),
    closesAt: closeAt.toISOString(),
    windowId,
    durationMs: Math.max(60 * 60 * 1000, closeAt.getTime() - openAt.getTime()),
    recurring: Boolean(optionsOverride.recurring),
    options: options.map((zone, index) => ({ zoneId: zone.id, name: zone.name, answerId: index + 1, votes: 0 })),
    totalVotes: 0,
    rawUrl: `https://discord.com/channels/${getManagedServerById(getActiveServerId())?.integrations.discordGuildId || "@me"}/${channelId}/${messageId}`,
  } satisfies MapRotationActivePollPayload;
}

async function fetchDiscordSpawnZonePoll(activePoll: MapRotationActivePollPayload) {
  const client = getDiscordClient();
  const route = Routes.channelMessage(activePoll.channelId, activePoll.messageId) as `/${string}`;
  const message = await client.rest.get(route) as any;
  return extractDiscordPollCounts(message, activePoll);
}

async function expireDiscordSpawnZonePoll(activePoll: MapRotationActivePollPayload) {
  const client = getDiscordClient();
  const route = `/channels/${activePoll.channelId}/polls/${activePoll.messageId}/expire` as `/${string}`;
  const message = await client.rest.post(route, { body: {} }) as any;
  return extractDiscordPollCounts(message, activePoll);
}

function waitMapVotePollResult(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFinalizedDiscordSpawnZonePoll(activePoll: MapRotationActivePollPayload) {
  let expireError: unknown;
  try {
    await expireDiscordSpawnZonePoll(activePoll);
  } catch (err) {
    expireError = err;
  }

  let lastError: unknown = expireError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await waitMapVotePollResult(1_250);
    try {
      const fetched = await fetchDiscordSpawnZonePoll(activePoll);
      if (fetched.status === "closed") return fetched;
      lastError = new Error("Discord ainda nao marcou a enquete como finalizada.");
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || "resultado final indisponivel");
  throw new Error(`Nao foi possivel confirmar o resultado final da enquete no Discord: ${detail}`);
}

async function deleteDiscordSpawnZonePollMessage(activePoll: MapRotationActivePollPayload | undefined | null) {
  const channelId = String(activePoll?.channelId || "").trim();
  const messageId = String(activePoll?.messageId || "").trim();
  if (!channelId || !messageId) return false;
  const client = getDiscordClient();
  const route = Routes.channelMessage(channelId, messageId) as `/${string}`;
  await client.rest.delete(route);
  return true;
}

function isDiscordUnknownMessageError(err: unknown) {
  const value = String((err as any)?.code || "") + " " + String((err as any)?.status || "") + " " + String((err as Error)?.message || err || "");
  return /10008|404|Unknown Message/i.test(value);
}

function markMissingSpawnZonePollMessage(rotation: MapRotationPayload, automation: MapRotationAutomationPayload, activePoll: MapRotationActivePollPayload, source: string) {
  const now = new Date().toISOString();
  rotation.activePoll = {
    ...activePoll,
    status: "closed",
    finalizedAt: activePoll.finalizedAt || now,
  };
  automation.lastMissingPollMessageId = activePoll.messageId;
  automation.lastMissingPollAt = now;
  automation.lastAction = source;
  automation.lastError = undefined;
}

async function deletePreviousClosedSpawnZonePoll(rotation: MapRotationPayload, automation: MapRotationAutomationPayload) {
  const previousPoll = rotation.activePoll;
  if (!previousPoll || previousPoll.status !== "closed") return false;
  if (!previousPoll.channelId || !previousPoll.messageId) return false;
  if (automation.lastDeletedPollMessageId === previousPoll.messageId) return false;
  try {
    const deleted = await deleteDiscordSpawnZonePollMessage(previousPoll);
    if (deleted) {
      automation.lastDeletedPollMessageId = previousPoll.messageId;
      automation.lastDeletedPollAt = new Date().toISOString();
    }
    return deleted;
  } catch (err) {
    if (isDiscordUnknownMessageError(err)) {
      automation.lastDeletedPollMessageId = previousPoll.messageId;
      automation.lastDeletedPollAt = new Date().toISOString();
      return true;
    }
    const detail = err instanceof Error ? err.message : String(err);
    automation.lastError = `Apagar enquete anterior: ${detail}`;
    console.warn("map vote previous poll delete failed", err);
    return false;
  }
}

function previousWeekdayDate(day: unknown, time: unknown, from = new Date(), timeZone = "America/Sao_Paulo") {
  const targetDay = SPAWN_ZONE_WEEKDAY_INDEX[String(day || "monday")] ?? 1;
  const { hour, minute } = parseSpawnZoneTime(time, "12:00");
  const localNow = getZonedDateParts(from, timeZone);
  const diff = (localNow.weekday - targetDay + 7) % 7;
  let localDate = addCalendarDays(localNow, -diff);
  let previous = zonedLocalDateTimeToDate(localDate.year, localDate.month, localDate.day, hour, minute, timeZone);
  if (previous.getTime() > from.getTime()) {
    localDate = addCalendarDays(localDate, -7);
    previous = zonedLocalDateTimeToDate(localDate.year, localDate.month, localDate.day, hour, minute, timeZone);
  }
  return previous;
}

function getMapRotationScheduleWindow(settings: MapRotationSettingsPayload, from = new Date()) {
  const timeZone = normalizeMapVoteTimezone(settings.pollTimezone);
  const openAt = previousWeekdayDate(settings.pollOpenDay, settings.pollOpenTime, from, timeZone);
  let closeAt = nextWeekdayDate(settings.pollCloseDay, settings.pollCloseTime, openAt, timeZone);
  if (closeAt.getTime() <= openAt.getTime()) closeAt = new Date(closeAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const id = `${String(settings.pollOpenDay || "monday")}_${String(settings.pollOpenTime || "12:00")}_${String(settings.pollCloseDay || "sunday")}_${String(settings.pollCloseTime || "23:59")}_${timeZone}_${openAt.toISOString()}_${closeAt.toISOString()}`;
  return { id, openAt, closeAt, timeZone, isOpen: from.getTime() >= openAt.getTime() && from.getTime() < closeAt.getTime(), isClosed: from.getTime() >= closeAt.getTime() };
}

function getNextMapRotationScheduleWindow(settings: MapRotationSettingsPayload, from = new Date()) {
  const timeZone = normalizeMapVoteTimezone(settings.pollTimezone);
  const nextOpenAt = nextWeekdayDate(settings.pollOpenDay, settings.pollOpenTime, from, timeZone);
  let nextCloseAt = nextWeekdayDate(settings.pollCloseDay, settings.pollCloseTime, nextOpenAt, timeZone);
  if (nextCloseAt.getTime() <= nextOpenAt.getTime()) nextCloseAt = new Date(nextCloseAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { openAt: nextOpenAt, closeAt: nextCloseAt, timeZone };
}


function isActivePollInScheduleWindow(activePoll: MapRotationActivePollPayload | undefined, windowInfo: ReturnType<typeof getMapRotationScheduleWindow>) {
  if (!activePoll || !activePoll.createdAt) return false;
  const createdAt = new Date(activePoll.createdAt);
  return createdAt.getTime() >= windowInfo.openAt.getTime() && createdAt.getTime() < windowInfo.closeAt.getTime();
}

function chooseSpawnZonePollWinner(rotation: MapRotationPayload, activePoll: MapRotationActivePollPayload) {
  const settings = normalizeMapRotationSettings(rotation.settings);
  const options = Array.isArray(activePoll.options) ? activePoll.options : [];
  const totalVotes = Number(activePoll.totalVotes || 0);
  if (settings.minVotes && totalVotes < settings.minVotes) {
    return { zone: null as SpawnZonePayload | null, reason: `Votação fechada sem mínimo de votos (${totalVotes}/${settings.minVotes}).` };
  }
  const maxVotes = Math.max(-1, ...options.map((option) => Number(option.votes || 0)));
  if (maxVotes <= 0) return { zone: null as SpawnZonePayload | null, reason: "Votação fechada sem votos." };
  const winners = options.filter((option) => Number(option.votes || 0) === maxVotes);
  if (winners.length === 1) {
    const zone = rotation.zones.find((item) => item.id === winners[0].zoneId) || null;
    return { zone, reason: zone ? "winner" : "Zona vencedora não encontrada." };
  }
  if (settings.tiePolicy === "keep_current" && rotation.currentZoneId) {
    const zone = rotation.zones.find((item) => item.id === rotation.currentZoneId) || null;
    return { zone, reason: zone ? "Empate: mantida a zona atual." : "Empate sem zona atual válida." };
  }
  if (settings.tiePolicy === "random") {
    const option = winners[crypto.randomInt(0, winners.length)];
    const zone = rotation.zones.find((item) => item.id === option.zoneId) || null;
    return { zone, reason: zone ? "Empate: vencedor sorteado." : "Empate sem zona sorteada válida." };
  }
  return { zone: null as SpawnZonePayload | null, reason: "Empate: resolução manual necessária." };
}

async function createOrUpdateMapVoteWelcomeMessage(rotation: MapRotationPayload, options: { pin?: boolean; periodLabel?: string } = {}) {
  const settings = normalizeMapRotationSettings(rotation.settings);
  const channelId = String(settings.pollChannelId || "").trim();
  if (!channelId) throw new Error("Configure o canal da enquete em Spawn Zones > Settings.");
  const client = getDiscordClient();
  const payload = JSON.parse(JSON.stringify(buildMapVotePublicWelcomePayload(settings.serverName, { periodLabel: options.periodLabel })));
  let messageId = String(settings.mapVoteWelcomeMessageId || "").trim();

  if (messageId) {
    try {
      const route = Routes.channelMessage(channelId, messageId) as `/${string}`;
      await client.rest.patch(route, { body: payload });
    } catch (err) {
      console.warn("map vote welcome update failed, creating a new message", err);
      messageId = "";
    }
  }

  if (!messageId) {
    const route = Routes.channelMessages(channelId) as `/${string}`;
    const message = (await client.rest.post(route, { body: payload })) as any;
    messageId = String(message?.id || "");
    if (!messageId) throw new Error("Discord não retornou o ID da mensagem fixa da votação.");
  }

  if (options.pin !== false && messageId) {
    const pinRoute = `/channels/${channelId}/pins/${messageId}` as `/${string}`;
    await client.rest.put(pinRoute, { body: {} }).catch((err) => {
      console.warn("map vote welcome pin failed", err);
    });
  }

  rotation.settings = {
    ...settings,
    mapVoteWelcomeMessageId: messageId,
  };
  return messageId;
}


type MapVoteAnnouncementLocale = "en" | "pt" | "es";

function normalizeMapVoteAnnouncementLocale(value: unknown): MapVoteAnnouncementLocale {
  const locale = String(value || "").trim().toLowerCase();
  if (locale === "pt" || locale === "pt-br" || locale === "pt_br") return "pt";
  if (locale === "es" || locale === "es-es" || locale === "es_es" || locale === "es-la") return "es";
  return "en";
}

function getMapVoteAnnouncementLocale(state?: AdminState): MapVoteAnnouncementLocale {
  const forced = process.env.MAP_VOTE_RESULT_LOCALE || process.env.ADMIN_PANEL_DEFAULT_LOCALE;
  if (forced) return normalizeMapVoteAnnouncementLocale(forced);
  const preferences = state?.mapVoteUserLocales && typeof state.mapVoteUserLocales === "object" ? state.mapVoteUserLocales : {};
  const counts: Record<MapVoteAnnouncementLocale, number> = { en: 0, pt: 0, es: 0 };
  for (const entry of Object.values(preferences) as any[]) {
    const locale = normalizeMapVoteAnnouncementLocale(entry?.locale);
    counts[locale] += 1;
  }
  const best = (Object.entries(counts) as Array<[MapVoteAnnouncementLocale, number]>).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : "en";
}

function getNextRestartLabel(settings: MapRotationSettingsPayload) {
  const raw = String(process.env.SHOP_RESTART_TIMES || process.env.SERVER_RESTART_TIMES || "00:00").trim();
  const timeZone = normalizeMapVoteTimezone(settings.pollTimezone);
  const now = new Date();
  const localNow = getZonedDateParts(now, timeZone);
  const candidates = raw.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  let best: Date | null = null;
  let bestLabel = "00:00";
  for (const candidate of candidates.length ? candidates : ["00:00"]) {
    const { hour, minute } = parseSpawnZoneTime(candidate, "00:00");
    let reset = zonedLocalDateTimeToDate(localNow.year, localNow.month, localNow.day, hour, minute, timeZone);
    if (reset.getTime() <= now.getTime()) {
      const nextDay = addCalendarDays(localNow, 1);
      reset = zonedLocalDateTimeToDate(nextDay.year, nextDay.month, nextDay.day, hour, minute, timeZone);
    }
    if (!best || reset.getTime() < best.getTime()) {
      best = reset;
      bestLabel = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }
  return bestLabel;
}

function buildSpawnZoneWinnerMessage(settings: MapRotationSettingsPayload, zone: SpawnZonePayload, votes: number, locale: MapVoteAnnouncementLocale) {
  const voteLabel = Math.max(0, Number(votes || 0));
  const resetLabel = getNextRestartLabel(settings);
  if (locale === "pt") return `🏆 Votação encerrada. A zona **${zone.name}** venceu a enquete com ${voteLabel} ${voteLabel === 1 ? "voto" : "votos"} e começará no próximo reset das ${resetLabel}.`;
  if (locale === "es") return `🏆 Votación cerrada. La zona **${zone.name}** ganó la encuesta con ${voteLabel} ${voteLabel === 1 ? "voto" : "votos"} y comenzará en el próximo reinicio de las ${resetLabel}.`;
  return `🏆 Voting closed. Zone **${zone.name}** won the poll with ${voteLabel} ${voteLabel === 1 ? "vote" : "votes"} and will start after the next ${resetLabel} reset.`;
}

function buildSpawnZoneNoWinnerMessage(reason: string, locale: MapVoteAnnouncementLocale) {
  if (locale === "pt") return `🗳️ Votação encerrada sem vencedor automático. ${reason}`;
  if (locale === "es") return `🗳️ Votación cerrada sin ganador automático. ${reason}`;
  return `🗳️ Voting closed without an automatic winner. ${reason}`;
}

function sanitizeDiscordChannelNamePart(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 36) || "ZONE";
}

async function updateMapVoteCategoryName(rotation: MapRotationPayload, zone?: SpawnZonePayload | null) {
  const settings = normalizeMapRotationSettings(rotation.settings);
  const categoryId = String(settings.pollCategoryId || "").trim();
  if (!categoryId) return;
  const zoneName = sanitizeDiscordChannelNamePart(zone?.name || rotation.zones.find((item) => item.id === rotation.currentZoneId)?.name || "").toUpperCase();
  const name = `━━━〔 MAP ROTATION: ${zoneName} 〕━━━`.slice(0, 100);
  const client = getDiscordClient();

  try {
    const channel = await client.channels.fetch(categoryId).catch(() => null);
    const editableChannel = channel as unknown as { name?: string; setName?: (name: string, reason?: string) => Promise<unknown> };
    if (editableChannel?.setName) {
      if (editableChannel.name !== name) {
        await editableChannel.setName(name, `Map rotation winner: ${zoneName}`);
      }
    } else {
      const route = Routes.channel(categoryId) as `/${string}`;
      await client.rest.patch(route, { body: { name } });
    }
  } catch (err) {
    const route = Routes.channel(categoryId) as `/${string}`;
    await client.rest.patch(route, { body: { name } });
  }

  const automation = rotation.automation || {};
  rotation.automation = automation;
  automation.lastCategoryUpdateAt = new Date().toISOString();
  automation.lastCategoryName = name;
}

function getActivePollDurationMs(activePoll: MapRotationActivePollPayload) {
  const explicit = Number(activePoll.durationMs || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const createdAt = new Date(activePoll.openAt || activePoll.createdAt || Date.now()).getTime();
  const closesAt = new Date(activePoll.closesAt || Date.now()).getTime();
  const calculated = closesAt - createdAt;
  return Number.isFinite(calculated) && calculated > 0 ? calculated : 7 * 24 * 60 * 60 * 1000;
}

function scheduleRecurringMapVote(rotation: MapRotationPayload, activePoll: MapRotationActivePollPayload) {
  const settings = normalizeMapRotationSettings(rotation.settings);
  if (!settings.recurringPollAfterFinish || !activePoll.appliedAt) return;
  const closedAt = new Date(activePoll.closesAt || activePoll.finalizedAt || activePoll.appliedAt || Date.now());
  const automation = rotation.automation || {};
  rotation.automation = automation;
  automation.nextRecurringPollAt = new Date(closedAt.getTime() + 10 * 60 * 1000).toISOString();
  automation.recurringPollDurationMs = getActivePollDurationMs(activePoll);
}

async function createDueRecurringMapVote(rotation: MapRotationPayload, settings: MapRotationSettingsPayload, automation: MapRotationAutomationPayload, now = new Date()) {
  const recurringPollAt = automation.nextRecurringPollAt ? new Date(automation.nextRecurringPollAt) : null;
  const canCreateRecurringPoll =
    settings.autoCreatePoll &&
    settings.recurringPollAfterFinish &&
    recurringPollAt &&
    Number.isFinite(recurringPollAt.getTime()) &&
    now.getTime() >= recurringPollAt.getTime() &&
    (!rotation.activePoll || rotation.activePoll.status === "closed");

  if (!canCreateRecurringPoll || !recurringPollAt) return false;
  const fallbackWindow = getMapRotationScheduleWindow(settings, now);
  const durationMs = Math.max(60 * 60 * 1000, Number(automation.recurringPollDurationMs || 0) || (fallbackWindow.closeAt.getTime() - fallbackWindow.openAt.getTime()));
  const closeAt = new Date(now.getTime() + durationMs);
  const windowId = `recurring_${recurringPollAt.toISOString()}_${now.toISOString()}_${closeAt.toISOString()}`;
  await deletePreviousClosedSpawnZonePoll(rotation, automation);
  rotation.activePoll = await createDiscordSpawnZonePoll(rotation, { openAt: now, closeAt, windowId, recurring: true });
  automation.lastRecurringPollAt = now.toISOString();
  automation.nextRecurringPollAt = undefined;
  automation.lastAction = recurringPollAt.getTime() < now.getTime() ? "created_overdue_recurring_poll" : "created_recurring_poll";
  return true;
}

async function postSpawnZonePollResult(settings: MapRotationSettingsPayload, content: string) {
  const channelId = String(settings.pollChannelId || "").trim();
  if (!channelId) return;
  const client = getDiscordClient();
  const route = Routes.channelMessages(channelId) as `/${string}`;
  await client.rest.post(route, { body: { content, allowed_mentions: { parse: [] } } });
}

async function applySpawnZoneToServer(rotation: MapRotationPayload, zone: SpawnZonePayload, source: string, totalVotes = 0) {
  const settings = normalizeMapRotationSettings(rotation.settings);
  const filePath = settings.spawnFilePath || SPAWN_ZONE_FILE_PATH;
  const currentXml = await downloadTextFile(filePath);
  const nextXml = replaceFreshSpawnPointsXml(currentXml, zone);
  await uploadTextFile(filePath, nextXml);
  const now = new Date().toISOString();
  rotation.currentZoneId = zone.id;
  if (rotation.nextZoneId === zone.id) rotation.nextZoneId = undefined;
  rotation.settings = settings;
  rotation.voteHistory = [
    ...(Array.isArray(rotation.voteHistory) ? rotation.voteHistory : []),
    {
      id: crypto.randomUUID(),
      winnerZoneId: zone.id,
      winnerName: zone.name,
      totalVotes,
      closedAt: now,
      appliedAt: now,
      source,
    },
  ].slice(-24);
  return filePath;
}

async function finalizeSpawnZonePoll(rotation: MapRotationPayload, options: { apply?: boolean; source?: string; state?: AdminState } = {}) {
  if (!rotation.activePoll) throw new Error("Nenhuma enquete ativa para finalizar.");
  const settings = normalizeMapRotationSettings(rotation.settings);
  const activePoll = await fetchFinalizedDiscordSpawnZonePoll(rotation.activePoll);
  activePoll.status = "closed";
  const { zone, reason } = chooseSpawnZonePollWinner(rotation, activePoll);
  const now = new Date().toISOString();
  activePoll.finalizedAt = now;
  activePoll.finalReason = reason;
  if (!zone) {
    rotation.activePoll = activePoll;
    rotation.voteHistory = [
      ...(Array.isArray(rotation.voteHistory) ? rotation.voteHistory : []),
      { id: crypto.randomUUID(), winnerName: "Sem vencedor", totalVotes: activePoll.totalVotes || 0, closedAt: now, source: options.source || "poll", reason },
    ].slice(-24);
    await postSpawnZonePollResult(settings, buildSpawnZoneNoWinnerMessage(reason, getMapVoteAnnouncementLocale(options.state)));
    return { zone: null as SpawnZonePayload | null, path: "", reason, activePoll };
  }

  rotation.nextZoneId = zone.id;
  let path = "";
  if (options.apply) {
    const shouldApplyImmediately = options.source === "poll-auto" || settings.applyOnNextRestart === false;
    if (shouldApplyImmediately) {
      path = await applySpawnZoneToServer(rotation, zone, options.source || "poll-auto", activePoll.totalVotes || 0);
      activePoll.appliedAt = new Date().toISOString();
      try {
        await updateMapVoteCategoryName(rotation, zone);
      } catch (err) {
        console.warn("map vote category rename failed", err);
        rotation.automation = { ...(rotation.automation || {}), lastError: `Categoria Discord: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      rotation.voteHistory = [
        ...(Array.isArray(rotation.voteHistory) ? rotation.voteHistory : []),
        { id: crypto.randomUUID(), winnerZoneId: zone.id, winnerName: zone.name, totalVotes: activePoll.totalVotes || 0, closedAt: now, source: options.source || "poll-scheduled", scheduled: true },
      ].slice(-24);
    }
  } else {
    rotation.voteHistory = [
      ...(Array.isArray(rotation.voteHistory) ? rotation.voteHistory : []),
      { id: crypto.randomUUID(), winnerZoneId: zone.id, winnerName: zone.name, totalVotes: activePoll.totalVotes || 0, closedAt: now, source: options.source || "poll" },
    ].slice(-24);
  }
  rotation.activePoll = activePoll;
  scheduleRecurringMapVote(rotation, activePoll);
  await postSpawnZonePollResult(settings, buildSpawnZoneWinnerMessage(settings, zone, activePoll.totalVotes || 0, getMapVoteAnnouncementLocale(options.state)));
  return { zone, path, reason, activePoll };
}


const MAP_ROTATION_RUNTIME_AUTOMATION_FIELDS = new Set([
  "lastCheckedAt",
  "currentWindowId",
  "currentWindowOpenAt",
  "currentWindowCloseAt",
  "nextWindowOpenAt",
  "nextWindowCloseAt",
  "activePollClosesAt",
  "activePollOverdueByMs",
  "schedulerIntervalMs",
]);

/**
 * Builds a stable representation containing only map-rotation data that must
 * survive a process restart. Scheduler heartbeat/window fields and live vote
 * refreshes remain available through the in-memory state, but they no longer
 * force the entire bot_state document to be written to Neon every five minutes.
 */
function getPersistedMapRotationSignature(rotation: MapRotationPayload) {
  const automation = Object.fromEntries(
    Object.entries(rotation.automation || {}).filter(([key]) => !MAP_ROTATION_RUNTIME_AUTOMATION_FIELDS.has(key)),
  );

  let activePoll = rotation.activePoll;
  if (activePoll && activePoll.status !== "closed") {
    activePoll = {
      ...activePoll,
      options: (activePoll.options || []).map((option) => ({ ...option, votes: 0 })),
      totalVotes: 0,
      winnerZoneId: undefined,
      winnerName: undefined,
      lastFetchedAt: undefined,
    };
  }

  return JSON.stringify({
    zones: rotation.zones,
    currentZoneId: rotation.currentZoneId,
    nextZoneId: rotation.nextZoneId,
    voteHistory: rotation.voteHistory,
    settings: rotation.settings,
    activePoll,
    automation,
  });
}

function updateMapRotationRuntimeState(state: AdminState, rotation: MapRotationPayload) {
  const previousUpdatedAt = (state.mapRotation as MapRotationPayload | undefined)?.updatedAt;
  state.mapRotation = {
    ...rotation,
    updatedAt: previousUpdatedAt || rotation.updatedAt,
  };
  return state.mapRotation;
}

async function runSpawnZoneAutomationNow() {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const persistedSignatureBeforeRun = getPersistedMapRotationSignature(rotation);
  const settings = normalizeMapRotationSettings(rotation.settings);
  const automation = rotation.automation || {};
  rotation.automation = automation;
  const now = new Date();
  const windowInfo = getMapRotationScheduleWindow(settings, now);
  const nextWindowInfo = getNextMapRotationScheduleWindow(settings, now);
  automation.lastCheckedAt = now.toISOString();
  const previousError = automation.lastError;
  automation.currentWindowId = windowInfo.id;
  automation.currentWindowOpenAt = windowInfo.openAt.toISOString();
  automation.currentWindowCloseAt = windowInfo.closeAt.toISOString();
  automation.nextWindowOpenAt = nextWindowInfo.openAt.toISOString();
  automation.nextWindowCloseAt = nextWindowInfo.closeAt.toISOString();
  automation.schedulerIntervalMs = getSpawnZoneAutomationIntervalMs();

  try {
    const currentZone = rotation.zones.find((zone) => zone.id === rotation.currentZoneId) || null;
    if (currentZone) {
      const expectedCategoryName = `━━━〔 MAP ROTATION: ${sanitizeDiscordChannelNamePart(currentZone.name).toUpperCase()} 〕━━━`.slice(0, 100);
      if (settings.pollCategoryId && automation.lastCategoryName !== expectedCategoryName) {
        await updateMapVoteCategoryName(rotation, currentZone).catch((err) => {
          automation.lastError = `Categoria Discord: ${err instanceof Error ? err.message : String(err)}`;
        });
      }
    }

    if (settings.autoCreatePoll && windowInfo.isOpen && rotation.activePoll && rotation.activePoll.status !== "closed" && !rotation.activePoll.recurring && !isActivePollInScheduleWindow(rotation.activePoll, windowInfo)) {
      try {
        const expiredPoll = await expireDiscordSpawnZonePoll(rotation.activePoll);
        rotation.activePoll = { ...expiredPoll, status: "closed", finalizedAt: now.toISOString(), finalReason: "Substituida por nova janela de automação." };
      } catch (err) {
        console.warn("spawn zone stale poll expire failed", err);
        rotation.activePoll = { ...rotation.activePoll, status: "closed", finalizedAt: now.toISOString(), finalReason: "Substituida por nova janela de automação." };
      }
      automation.lastAction = "closed_stale_poll";
    }

    if (rotation.activePoll && rotation.activePoll.status !== "closed" && windowInfo.isOpen && isActivePollInScheduleWindow(rotation.activePoll, windowInfo)) {
      rotation.activePoll.closesAt = windowInfo.closeAt.toISOString();
    }

    const createdRecurringBeforeWindow = await createDueRecurringMapVote(rotation, settings, automation, now);

    const canCreatePollForOpenWindow =
      settings.autoCreatePoll &&
      !createdRecurringBeforeWindow &&
      windowInfo.isOpen &&
      automation.lastPollWindowId !== windowInfo.id &&
      (!rotation.activePoll || rotation.activePoll.status === "closed");

    if (canCreatePollForOpenWindow) {
      await deletePreviousClosedSpawnZonePoll(rotation, automation);
      rotation.activePoll = await createDiscordSpawnZonePoll(rotation, { windowId: windowInfo.id, openAt: windowInfo.openAt, closeAt: windowInfo.closeAt });
      automation.lastPollWindowId = windowInfo.id;
      automation.lastAction = "created_poll";
    }

    if (rotation.activePoll && rotation.activePoll.status !== "closed") {
      const pollWindowInfo = isActivePollInScheduleWindow(rotation.activePoll, windowInfo)
        ? windowInfo
        : getMapRotationScheduleWindow(settings, new Date(rotation.activePoll.createdAt || now));
      const closeWindowId = rotation.activePoll.windowId || pollWindowInfo.id;
      const parsedClosesAt = rotation.activePoll.closesAt ? new Date(rotation.activePoll.closesAt) : pollWindowInfo.closeAt;
      const closesAt = Number.isFinite(parsedClosesAt.getTime()) ? parsedClosesAt : pollWindowInfo.closeAt;
      automation.activePollClosesAt = closesAt.toISOString();
      automation.activePollOverdueByMs = Math.max(0, now.getTime() - closesAt.getTime());

      if (now.getTime() >= closesAt.getTime() && automation.lastCloseWindowId !== closeWindowId) {
        // Finaliza primeiro quando a enquete venceu. Antes o scheduler fazia um fetch antes de expirar;
        // se esse fetch falhasse, a finalizacao ficava travada mesmo depois do horario configurado.
        try {
          await finalizeSpawnZonePoll(rotation, { apply: Boolean(settings.autoApplyWinner), source: settings.autoApplyWinner ? "poll-auto" : "poll", state });
          automation.lastCloseWindowId = closeWindowId;
          automation.lastAction = settings.autoApplyWinner ? "finalized_and_applied" : "finalized_poll";
          await createDueRecurringMapVote(rotation, settings, automation, new Date());
        } catch (err) {
          if (isDiscordUnknownMessageError(err)) {
            markMissingSpawnZonePollMessage(rotation, automation, rotation.activePoll, "cleared_missing_overdue_poll");
            automation.lastCloseWindowId = closeWindowId;
          } else {
            throw err;
          }
        }
      } else {
        try {
          rotation.activePoll = await fetchDiscordSpawnZonePoll(rotation.activePoll);
        } catch (err) {
          if (isDiscordUnknownMessageError(err)) {
            markMissingSpawnZonePollMessage(rotation, automation, rotation.activePoll, "cleared_missing_active_poll");
          } else {
            throw err;
          }
        }
      }
    } else if (settings.autoCreatePoll && windowInfo.isClosed && automation.lastPollWindowId !== windowInfo.id) {
      automation.lastAction = "missed_closed_window";
    }
  } catch (err) {
    automation.lastError = err instanceof Error ? err.message : String(err);
    automation.lastAction = "error";
  }

  if (automation.lastAction !== "error" && previousError) {
    automation.lastError = "";
  }

  rotation.settings = settings;
  rotation.automation = { ...automation, ...(rotation.automation || {}) };

  const persistedSignatureAfterRun = getPersistedMapRotationSignature(rotation);
  if (persistedSignatureAfterRun !== persistedSignatureBeforeRun) {
    return saveMapRotationState(state, rotation);
  }

  // Keep operational status fresh for the admin panel without waking Neon.
  return updateMapRotationRuntimeState(state, rotation);
}

function getSpawnZoneAutomationIntervalMs() {
  return Math.max(60_000, Number(process.env.SPAWN_ZONE_AUTOMATION_INTERVAL_MS || 300_000));
}

let spawnZoneAutomationStarted = false;
function startSpawnZoneAutomationScheduler() {
  if (spawnZoneAutomationStarted) return;
  spawnZoneAutomationStarted = true;
  const intervalMs = getSpawnZoneAutomationIntervalMs();
  const primaryServerId = getPrimaryServerId();
  const run = () => runInServerRuntimeContext(primaryServerId, () =>
    runSpawnZoneAutomationNow().catch((err) => console.error("spawn zones automation failed", err)),
  );
  const initialTimer = setTimeout(run, 5_000);
  const timer = setInterval(run, intervalMs);
  if (typeof (initialTimer as any).unref === "function") (initialTimer as any).unref();
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}

function renderSpawnPointXml(points: SpawnZonePointPayload[]) {
  return points
    .map((point) => `\t\t\t<pos x="${Number(point.x || 0).toFixed(2)}" z="${Number(point.z || 0).toFixed(2)}" />`)
    .join("\n");
}

function replaceFreshSpawnPointsXml(xml: string, zone: SpawnZonePayload) {
  const nextPositions = renderSpawnPointXml(zone.points || []);
  const posBlock = `\n${nextPositions}\n\t\t`;
  const value = String(xml || "");
  if (!value.trim()) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<playerspawnpoints>\n\t<fresh>\n\t\t<spawn_params>\n\t\t\t<min_dist_infected>30.0</min_dist_infected>\n\t\t\t<max_dist_infected>70.0</max_dist_infected>\n\t\t\t<min_dist_player>30.0</min_dist_player>\n\t\t\t<max_dist_player>100.0</max_dist_player>\n\t\t\t<min_dist_static>0.5</min_dist_static>\n\t\t\t<max_dist_static>2.0</max_dist_static>\n\t\t</spawn_params>\n\n\t\t<generator_params>\n\t\t\t<grid_density>8</grid_density>\n\t\t\t<grid_width>15.0</grid_width>\n\t\t\t<grid_height>15.0</grid_height>\n\t\t\t<min_dist_static>0.5</min_dist_static>\n\t\t\t<max_dist_static>2.0</max_dist_static>\n\t\t\t<min_steepness>-45</min_steepness>\n\t\t\t<max_steepness>45</max_steepness>\n\t\t</generator_params>\n\n\t\t<generator_posbubbles>${posBlock}</generator_posbubbles>\n\t</fresh>\n\n\t<hop>\n\t\t<generator_posbubbles>\n\t\t</generator_posbubbles>\n\t</hop>\n\n\t<travel>\n\t\t<generator_posbubbles>\n\t\t</generator_posbubbles>\n\t</travel>\n</playerspawnpoints>\n`;
  }

  const freshMatch = value.match(/<fresh>[\s\S]*?<\/fresh>/i);
  if (!freshMatch) throw new Error("cfgplayerspawnpoints.xml sem bloco <fresh> suportado.");
  let freshBlock = freshMatch[0];
  if (/<generator_posbubbles>[\s\S]*?<\/generator_posbubbles>/i.test(freshBlock)) {
    freshBlock = freshBlock.replace(/<generator_posbubbles>[\s\S]*?<\/generator_posbubbles>/i, `<generator_posbubbles>${posBlock}</generator_posbubbles>`);
  } else {
    freshBlock = freshBlock.replace(/<\/fresh>/i, `\t\t<generator_posbubbles>${posBlock}</generator_posbubbles>\n\t</fresh>`);
  }
  return value.replace(freshMatch[0], freshBlock);
}

function getMapRotationState(state: AdminState): MapRotationPayload {
  const stored = (state.mapRotation || {}) as Partial<MapRotationPayload>;
  const zones = Array.isArray(stored.zones) ? stored.zones.map((zone: any, index: number) => normalizeSpawnZone(zone, index)) : [];
  const currentZoneId = zones.some((zone) => zone.id === stored.currentZoneId) ? stored.currentZoneId : undefined;
  const nextZoneId = zones.some((zone) => zone.id === stored.nextZoneId) ? stored.nextZoneId : undefined;
  return {
    zones,
    currentZoneId,
    nextZoneId,
    voteHistory: Array.isArray(stored.voteHistory) ? stored.voteHistory : [],
    settings: normalizeMapRotationSettings(stored.settings),
    activePoll: stored.activePoll && typeof stored.activePoll === "object" ? stored.activePoll as MapRotationActivePollPayload : undefined,
    automation: stored.automation && typeof stored.automation === "object" ? stored.automation as MapRotationAutomationPayload : {},
    updatedAt: stored.updatedAt || new Date().toISOString(),
  };
}

async function saveMapRotationState(state: AdminState, rotation: MapRotationPayload) {
  state.mapRotation = {
    ...rotation,
    updatedAt: new Date().toISOString(),
  };
  await saveStateAsync(state);
  await flushStateAsync();
  return state.mapRotation;
}

startSpawnZoneAutomationScheduler();

function findReadySpawnZone(rotation: MapRotationPayload, zoneId: unknown) {
  const zone = rotation.zones.find((item) => item.id === String(zoneId || ""));
  if (!zone) return { zone: null as SpawnZonePayload | null, error: "Zona não encontrada" };
  if (zone.enabled === false) return { zone: null as SpawnZonePayload | null, error: "Zona desabilitada" };
  if (!Array.isArray(zone.points) || zone.points.length === 0) return { zone: null as SpawnZonePayload | null, error: "Zona sem pontos de spawn" };
  return { zone, error: "" };
}

type MemberRow = {
  discordId: string;
  discordName: string;
  gamertag: string;
  gamertagNormalized: string;
  isLinked: boolean;
  locale: string;
  avatarUrl: string | null;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  onlineRewardMinutes: number;
  status: "online" | "offline";
  isOnline: boolean;
  linkedAt: string | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
};

function readCookie(req: Request, name: string) {
  const cookieHeader =
    typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const cookies = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = cookie.slice(0, separatorIndex);
    const value = cookie.slice(separatorIndex + 1);
    if (key === name) return decodeURIComponent(value);
  }

  return "";
}

function getConfiguredToken() {
  return process.env.ADMIN_PANEL_TOKEN || process.env.SHOP_ADMIN_TOKEN || "";
}

function getTokenFromRequest(req: Request) {
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const headerToken =
    typeof req.headers["x-admin-token"] === "string"
      ? req.headers["x-admin-token"]
      : "";
  const authHeader =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const cookieToken = readCookie(req, TOKEN_COOKIE);

  const referer =
    typeof req.headers.referer === "string" ? req.headers.referer : "";
  let refererToken = "";
  try {
    if (referer)
      refererToken = new URL(referer).searchParams.get("token") || "";
  } catch {
    refererToken = "";
  }

  return (
    queryToken || headerToken || bearerToken || cookieToken || refererToken
  );
}

type OrganizationCapability = "view" | "moderate" | "manage" | "own";

function hasPlatformBootstrapAccess(req: Request) {
  const configuredToken = getConfiguredToken();
  return Boolean(configuredToken && getTokenFromRequest(req) === configuredToken);
}

function requireOrganizationAccess(
  req: Request,
  res: Response,
  organizationIdInput: unknown,
  capability: OrganizationCapability = "view",
) {
  // The legacy admin token is intentionally retained as a platform-bootstrap
  // escape hatch during the SaaS migration. Tenant users never receive it.
  if (hasPlatformBootstrapAccess(req)) return true;

  const organizationId = buildOrganizationId(organizationIdInput);
  if (req.adminSession) {
    const bound = req.adminSession.serverId ? getManagedServerById(req.adminSession.serverId) : undefined;
    const access = (req as any).adminServerAccess as { organizationId?: string; role?: any } | undefined;
    if (!bound || !access) {
      res.status(403).json({ error: "ADMIN_SERVER_SETUP_REQUIRED" });
      return false;
    }
    if (bound.organizationId !== organizationId || access.organizationId !== organizationId) {
      res.status(403).json({ error: "ORGANIZATION_FORBIDDEN" });
      return false;
    }
    if (!canOrganizationRole(access.role, capability)) {
      res.status(403).json({ error: "ADMIN_CAPABILITY_FORBIDDEN", capability });
      return false;
    }
    return true;
  }
  if (!req.portalSession) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return false;
  }
  const membership = getUserOrganizationMembership(req.portalSession.discordId, organizationId);
  if (!membership || !canOrganizationRole(membership.role, capability)) {
    res.status(403).json({ error: "ORGANIZATION_FORBIDDEN" });
    return false;
  }
  return true;
}

function requireAdmin(req: Request, res: Response, capability?: OrganizationCapability) {
  if (req.adminSession) {
    const server = req.adminSession.serverId ? getManagedServerById(req.adminSession.serverId) : undefined;
    const access = (req as any).adminServerAccess as { organizationId?: string; role?: any } | undefined;
    if (!server || !access || access.organizationId !== server.organizationId) {
      res.status(403).json({ error: "ADMIN_SERVER_SETUP_REQUIRED" });
      return false;
    }
    const requiredCapability: OrganizationCapability = capability
      || (req.method === "GET" || req.method === "HEAD" ? "view" : "manage");
    if (!canOrganizationRole(access.role, requiredCapability)) {
      res.status(403).json({ error: "ADMIN_CAPABILITY_FORBIDDEN", capability: requiredCapability });
      return false;
    }
    return true;
  }
  const resolvedCapability: OrganizationCapability = capability
    || (req.method === "GET" || req.method === "HEAD" ? "view" : "manage");
  return requireOrganizationAccess(req, res, getPrimaryServerDescriptor().organizationId, resolvedCapability);
}

function requireServerAdmin(req: Request, res: Response, serverIdInput: unknown, capability: OrganizationCapability = "view") {
  const serverId = String(serverIdInput || "").trim();
  const server = getManagedServerById(serverId);
  if (!server) {
    res.status(404).json({ error: "SERVER_NOT_FOUND" });
    return false;
  }
  if (req.adminSession && req.adminSession.serverId !== server.id) {
    res.status(403).json({ error: "SERVER_FORBIDDEN" });
    return false;
  }
  return requireOrganizationAccess(req, res, server.organizationId, capability);
}

function requirePlatformBootstrap(req: Request, res: Response) {
  if (hasPlatformBootstrapAccess(req)) return true;
  res.status(403).json({ error: "PLATFORM_BOOTSTRAP_REQUIRED" });
  return false;
}

function authorizedServersForRequest(req: Request, organizationIdInput?: unknown) {
  if (hasPlatformBootstrapAccess(req)) return listManagedServers();
  if (req.adminSession?.serverId) {
    const server = getManagedServerById(req.adminSession.serverId);
    if (!server) return [];
    const requestedOrganizationId = organizationIdInput ? buildOrganizationId(organizationIdInput) : undefined;
    return !requestedOrganizationId || requestedOrganizationId === server.organizationId ? [server] : [];
  }
  const discordId = req.portalSession?.discordId;
  if (!discordId) return [];
  const requestedOrganizationId = organizationIdInput ? buildOrganizationId(organizationIdInput) : undefined;
  const organizationIds = new Set(listUserOrganizationMemberships(discordId).map((membership) => membership.organizationId));
  return listManagedServers().filter((server) =>
    organizationIds.has(server.organizationId)
    && (!requestedOrganizationId || server.organizationId === requestedOrganizationId),
  );
}

function currentOrganizationIdForRequest(req: Request) {
  if (req.adminSession?.serverId) {
    return getManagedServerById(req.adminSession.serverId)?.organizationId || getPrimaryServerDescriptor().organizationId;
  }
  return getPrimaryServerDescriptor().organizationId;
}

function organizationDiagnosticsForRequest(req: Request) {
  const diagnostics = getOrganizationFoundationDiagnostics();
  const integrationDiagnostics = getOrganizationIntegrationsDiagnostics();
  const thirdPartyOnboardingReady = Boolean(diagnostics.selfServiceEnabled && integrationDiagnostics.encryptionConfigured);
  if (hasPlatformBootstrapAccess(req)) {
    return { ...diagnostics, thirdPartyOnboardingReady, secretEncryptionConfigured: integrationDiagnostics.encryptionConfigured };
  }
  return {
    phase: diagnostics.phase,
    enabled: diagnostics.enabled,
    initialized: diagnostics.initialized,
    authorizationModel: diagnostics.authorizationModel,
    roles: diagnostics.roles,
    credentialIsolation: diagnostics.credentialIsolation,
    selfServiceEnabled: diagnostics.selfServiceEnabled,
    thirdPartyOnboardingReady,
    secretEncryptionConfigured: integrationDiagnostics.encryptionConfigured,
    backgroundPollingAdded: diagnostics.backgroundPollingAdded,
  };
}

function organizationIntegrationDiagnosticsForRequest(req: Request) {
  const diagnostics = getOrganizationIntegrationsDiagnostics();
  if (hasPlatformBootstrapAccess(req)) return diagnostics;
  return {
    phase: diagnostics.phase,
    encryptionConfigured: diagnostics.encryptionConfigured,
    discordCredentialModel: diagnostics.discordCredentialModel,
    discordGuildIsolation: diagnostics.discordGuildIsolation,
    secretsExposedToBrowser: diagnostics.secretsExposedToBrowser,
  };
}

function foundationForRequest(req: Request, providedServers?: ReturnType<typeof listManagedServers>) {
  if (hasPlatformBootstrapAccess(req)) return getServerFoundationDiagnostics();
  const full = getServerFoundationDiagnostics();
  const servers = providedServers || authorizedServersForRequest(req);
  const integrations = organizationIntegrationDiagnosticsForRequest(req);
  return {
    phase: full.phase,
    mode: "tenant-scoped",
    managedServers: servers.length,
    additionalServersEnabled: true,
    onboarding: {
      canCreateDrafts: Boolean(full.onboarding?.canCreateDrafts),
      draftServers: servers.filter((server) => server.onboardingStatus === "draft").length,
      configuredServers: servers.filter((server) => server.onboardingStatus === "configured").length,
      readyServers: servers.filter((server) => server.onboardingStatus === "ready").length,
      runtimeEnabledServers: servers.filter((server) => server.runtimeEnabled).length,
      activationPolicy: full.onboarding?.activationPolicy,
      secretsStoredInRegistry: false,
      integrationValidationMode: full.onboarding?.integrationValidationMode,
      activationPreflightEnabled: Boolean(full.onboarding?.activationPreflightEnabled),
      activationEndpointEnabled: Boolean(full.onboarding?.activationEndpointEnabled),
      playerPortalContextSwitchingEnabled: Boolean(full.onboarding?.playerPortalContextSwitchingEnabled),
      operationalHardeningEnabled: Boolean(full.onboarding?.operationalHardeningEnabled),
      multiTenantFoundationEnabled: true,
      organizationAuthorizationEnabled: true,
      organizationCredentialIsolationEnabled: true,
      serverScopedCommerceSettingsEnabled: true,
      serverScopedShopCatalogEnabled: true,
      backgroundPollingAdded: false,
      backgroundRegistryWritesAdded: false,
    },
    tenancy: {
      authorizationModel: full.tenancy?.authorizationModel || "organization-membership-rbac",
      credentialIsolation: full.tenancy?.credentialIsolation || "organization-nitrado+platform-discord",
      selfServiceEnabled: Boolean(full.tenancy?.selfServiceEnabled),
      thirdPartyOnboardingReady: Boolean(full.tenancy?.thirdPartyOnboardingReady),
      integrations,
    },
    safety: {
      organizationOwnershipRequired: true,
      organizationRbacPrepared: true,
      organizationNitradoCredentialIsolation: true,
      discordCrossOrganizationDiscoveryBlocked: true,
      serverScopedCommerceSettings: true,
      serverScopedShopCatalog: true,
      nitradoTokenNeverReturnedToBrowser: true,
      centralizedScheduler: true,
      perServerExecutionContext: true,
      perServerStateCache: true,
      perServerPersistenceRuntime: true,
      perServerPositionHistory: true,
      activationPreflightGate: true,
      secondaryCircuitBreaker: true,
    },
  };
}

function runtimeCoordinatorForRequest(req: Request, providedServers?: ReturnType<typeof listManagedServers>) {
  const diagnostics = getManagedServerRuntimeCoordinatorDiagnostics();
  if (hasPlatformBootstrapAccess(req)) return diagnostics;
  const servers = providedServers || authorizedServersForRequest(req);
  const allowedIds = new Set(servers.map((server) => server.id));
  const scopedServers = diagnostics.servers.filter((server) => allowedIds.has(server.serverId));
  const activeRuntimeIds = diagnostics.activeRuntimeIds.filter((serverId) => allowedIds.has(serverId));
  return {
    scheduler: diagnostics.scheduler,
    intervalMs: diagnostics.intervalMs,
    healthPolicy: diagnostics.healthPolicy,
    schedulerRunning: diagnostics.schedulerRunning,
    activeRuntimeIds,
    activeRuntimes: activeRuntimeIds.length,
    requestedImmediateRuns: diagnostics.requestedImmediateRuns.filter((serverId) => allowedIds.has(serverId)),
    servers: scopedServers,
  };
}

function catalogIsolationForRequest(req: Request, serverId: string) {
  if (hasPlatformBootstrapAccess(req)) return getShopCatalogDiagnostics();
  const diagnostics = getShopCatalogDiagnostics();
  return {
    phase: diagnostics.phase,
    cacheModel: diagnostics.cacheModel,
    tableModel: diagnostics.tableModel,
    serverId,
    legacyTablesReadOnlyMigrationSource: diagnostics.legacyTablesReadOnlyMigrationSource,
  };
}

function setPanelCookie(req: Request, res: Response) {
  const token = getTokenFromRequest(req);
  if (!token) return;

  res.cookie(TOKEN_COOKIE, token, {
    path: "/admin-panel",
    sameSite: "lax",
    httpOnly: false,
  });
}

function normalizeText(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function formatIso(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function countObject(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  return Object.keys(value).length;
}

function getOnlinePlayerNames(state: AdminState) {
  return new Set(Object.keys(state.onlinePlayers || {}).map(normalizeText));
}

function getLastSeenAt(state: AdminState, gamertag: string) {
  const normalized = normalizeText(gamertag);
  const online = state.onlinePlayers || {};
  const sessions = state.onlineSessions || {};

  for (const [name, value] of Object.entries(online)) {
    if (normalizeText(name) !== normalized) continue;
    const onlineValue = value as { lastSeenAt?: string } | undefined;
    return formatIso(onlineValue?.lastSeenAt) || new Date().toISOString();
  }

  for (const [name, value] of Object.entries(sessions)) {
    if (normalizeText(name) !== normalized) continue;
    const sessionValue = value as
      | { lastSeenAt?: string; connectedAt?: string }
      | undefined;
    return formatIso(sessionValue?.lastSeenAt || sessionValue?.connectedAt);
  }

  return null;
}

function walletToNumbers(wallet?: Partial<Wallet> | null) {
  return {
    balance: Math.floor(Number(wallet?.balance || 0)),
    totalEarned: Math.floor(Number(wallet?.totalEarned || 0)),
    totalSpent: Math.floor(Number(wallet?.totalSpent || 0)),
    onlineRewardMinutes: Math.floor(Number(wallet?.onlineRewardMinutes || 0)),
  };
}

type DiscordMemberSnapshot = {
  discordId: string;
  discordName: string;
  avatarUrl: string | null;
  isOnline: boolean;
};

type DiscordMembersCache = {
  expiresAt: number;
  members: DiscordMemberSnapshot[];
  error: string | null;
};

type DiscordRestMember = {
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
    bot?: boolean;
  };
  nick?: string | null;
  avatar?: string | null;
};

function getDiscordAvatarUrl(userId: string, avatarHash?: string | null) {
  if (!avatarHash) return null;
  const extension = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=96`;
}

async function fetchDiscordMembersViaRest(
  guildId: string,
): Promise<DiscordMemberSnapshot[]> {
  const client = getDiscordClient();
  const members: DiscordMemberSnapshot[] = [];
  let after = "0";

  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "1000", after });
    const route =
      `${Routes.guildMembers(guildId)}?${query.toString()}` as `/${string}`;
    const pageMembers = (await client.rest.get(route)) as DiscordRestMember[];

    if (!Array.isArray(pageMembers) || pageMembers.length === 0) break;

    for (const member of pageMembers) {
      const user = member.user;
      const userId = String(user?.id || "");
      if (!userId || user?.bot) continue;

      members.push({
        discordId: userId,
        discordName: String(
          member.nick ||
            user?.global_name ||
            user?.username ||
            `Discord User ${userId.slice(-4)}`,
        ),
        avatarUrl: getDiscordAvatarUrl(
          userId,
          member.avatar || user?.avatar || null,
        ),
        isOnline: false,
      });
    }

    const lastUserId = pageMembers[pageMembers.length - 1]?.user?.id;
    if (!lastUserId || pageMembers.length < 1000) break;
    after = String(lastUserId);
  }

  return members.sort((a, b) => a.discordName.localeCompare(b.discordName));
}

const DISCORD_MEMBERS_CACHE_TTL_MS = 60_000;
const discordMembersCacheByServer = new Map<string, DiscordMembersCache>();

function emptyDiscordMembersCache(): DiscordMembersCache {
  return { expiresAt: 0, members: [], error: null };
}

async function fetchDiscordMemberSnapshots(
  forceRefresh = false,
): Promise<DiscordMembersCache> {
  const now = Date.now();
  const serverId = getActiveServerId();
  const previousCache = discordMembersCacheByServer.get(serverId) || emptyDiscordMembersCache();
  if (!forceRefresh && previousCache.expiresAt > now) return previousCache;

  try {
    const client = getDiscordClient();
    if (!client.isReady()) throw new Error("Discord client is not ready yet.");

    const server = getManagedServerById(serverId);
    if (!server) throw new Error(`Managed server not found for Discord member lookup: ${serverId}`);
    const configuredGuildId = String(server.integrations.discordGuildId || "").trim();
    if (!configuredGuildId) {
      throw new Error(`Discord is not connected for server ${serverId}.`);
    }
    const guild = await client.guilds.fetch(configuredGuildId);

    if (!guild || guild.id !== configuredGuildId)
      throw new Error(
        `Discord guild not found for managed server ${serverId}.`,
      );

    let members: DiscordMemberSnapshot[] = [];
    let fetchError: string | null = null;

    try {
      const fetchedMembers = await guild.members.fetch({ withPresences: true });
      members = fetchedMembers
        .filter((member) => !member.user.bot)
        .map((member) => {
          const presence = guild.presences.cache.get(member.id);
          const status = presence?.status || "offline";
          return {
            discordId: member.id,
            discordName:
              member.displayName ||
              member.user.globalName ||
              member.user.username ||
              `Discord User ${member.id.slice(-4)}`,
            avatarUrl: member.displayAvatarURL({ extension: "png", size: 96 }),
            isOnline: status !== "offline",
          };
        })
        .sort((a, b) => a.discordName.localeCompare(b.discordName));
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    if (!members.length) {
      const restMembers = await fetchDiscordMembersViaRest(guild.id);
      const presenceById = guild.presences.cache;
      members = restMembers.map((member) => ({
        ...member,
        isOnline:
          (presenceById.get(member.discordId)?.status || "offline") !==
          "offline",
      }));
    }

    if (!members.length) {
      throw new Error(fetchError || "Discord member list returned empty.");
    }

    discordMembersCacheByServer.set(serverId, {
      expiresAt: now + DISCORD_MEMBERS_CACHE_TTL_MS,
      members,
      error: fetchError,
    });
  } catch (err) {
    discordMembersCacheByServer.set(serverId, {
      expiresAt: now + Math.min(DISCORD_MEMBERS_CACHE_TTL_MS, 15_000),
      members: previousCache.members,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return discordMembersCacheByServer.get(serverId) || previousCache;
}

function fallbackDiscordMembersFromLinks(
  state: AdminState,
): DiscordMemberSnapshot[] {
  const onlineNames = getOnlinePlayerNames(state);
  const links = Object.values(state.playerLinks || {}) as PlayerLink[];

  return links
    .filter((link) => link?.discordId)
    .map((link) => ({
      discordId: link.discordId,
      discordName: `Discord User ${link.discordId.slice(-4)}`,
      avatarUrl: null,
      isOnline: Boolean(
        link.gamertag && onlineNames.has(normalizeText(link.gamertag)),
      ),
    }));
}

function buildMemberStats(
  rows: MemberRow[],
  discordError: string | null = null,
) {
  const linked = rows.filter((member) => member.isLinked).length;
  const online = rows.filter((member) => member.isOnline).length;

  return {
    totalMembers: rows.length,
    linkedMembers: linked,
    unlinkedMembers: Math.max(0, rows.length - linked),
    onlineMembers: online,
    discordError,
  };
}

async function buildMemberRows(
  state: AdminState,
  options: { forceDiscordRefresh?: boolean } = {},
): Promise<{ rows: MemberRow[]; stats: ReturnType<typeof buildMemberStats> }> {
  const linksByDiscordId = new Map<string, PlayerLink>();
  for (const link of Object.values(state.playerLinks || {}) as PlayerLink[]) {
    if (link?.discordId) linksByDiscordId.set(link.discordId, link);
  }

  const discordCache = await fetchDiscordMemberSnapshots(
    Boolean(options.forceDiscordRefresh),
  );
  const discordMembers = discordCache.members.length
    ? discordCache.members
    : fallbackDiscordMembersFromLinks(state);
  const onlineNames = getOnlinePlayerNames(state);

  const rows = discordMembers
    .map((discordMember) => {
      const link = linksByDiscordId.get(discordMember.discordId);
      const gamertag = String(link?.gamertag || "").trim();
      const wallet = state.wallets?.[discordMember.discordId] as
        | Wallet
        | undefined;
      const numbers = walletToNumbers(wallet);
      const isDayzOnline = gamertag
        ? onlineNames.has(normalizeText(gamertag))
        : false;
      const isOnline = Boolean(discordMember.isOnline || isDayzOnline);

      return {
        discordId: discordMember.discordId,
        discordName: discordMember.discordName,
        gamertag,
        gamertagNormalized: link?.gamertagNormalized || normalizeText(gamertag),
        isLinked: Boolean(link && gamertag),
        locale: link?.locale || "pt",
        avatarUrl: discordMember.avatarUrl,
        balance: numbers.balance,
        totalEarned: numbers.totalEarned,
        totalSpent: numbers.totalSpent,
        onlineRewardMinutes: numbers.onlineRewardMinutes,
        status: (isOnline ? "online" : "offline") as "online" | "offline",
        isOnline,
        linkedAt: formatIso(link?.linkedAt),
        updatedAt: formatIso(link?.updatedAt),
        lastSeenAt: gamertag ? getLastSeenAt(state, gamertag) : null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isOnline) - Number(a.isOnline) ||
        Number(b.isLinked) - Number(a.isLinked) ||
        a.discordName.localeCompare(b.discordName),
    );

  return { rows, stats: buildMemberStats(rows, discordCache.error) };
}

function filterMembers(
  rows: MemberRow[],
  params: { search: string; filter: string },
) {
  const search = normalizeText(params.search);
  const filter = normalizeText(params.filter);

  return rows.filter((member) => {
    if (filter === "online" && member.status !== "online") return false;
    if (filter === "offline" && member.status !== "offline") return false;
    if (filter === "linked" && !member.isLinked) return false;
    if (filter === "unlinked" && member.isLinked) return false;
    if (filter === "pt" && member.locale !== "pt") return false;
    if (filter === "en" && member.locale !== "en") return false;

    if (!search) return true;
    return [
      member.discordId,
      member.discordName,
      member.gamertag,
      member.gamertagNormalized,
    ].some((value) => normalizeText(value).includes(search));
  });
}

function buildMemberTransactions(
  state: AdminState,
  discordId: string,
  limit = 20,
) {
  const transactions = Array.isArray(state.economyTransactions)
    ? state.economyTransactions
    : [];

  return transactions
    .filter(
      (transaction) =>
        String((transaction as { discordId?: string }).discordId || "") ===
        discordId,
    )
    .slice()
    .reverse()
    .slice(0, limit)
    .map((transaction) => {
      const item = transaction as {
        id?: string;
        discordId?: string;
        gamertag?: string;
        type?: string;
        amount?: number;
        balanceBefore?: number;
        balanceAfter?: number;
        reason?: string;
        createdAt?: string;
        createdBy?: string;
      };

      return {
        id: item.id || "",
        discordId: item.discordId || "",
        gamertag: item.gamertag || "",
        type: item.type || "UNKNOWN",
        amount: Math.floor(Number(item.amount || 0)),
        balanceBefore: Math.floor(Number(item.balanceBefore || 0)),
        balanceAfter: Math.floor(Number(item.balanceAfter || 0)),
        reason: item.reason || "",
        createdAt: formatIso(item.createdAt),
        createdBy: item.createdBy || "system",
      };
    });
}

async function buildMemberDetails(state: AdminState, discordId: string) {
  const { rows } = await buildMemberRows(state);
  const member = rows.find((row) => row.discordId === discordId);
  if (!member) return null;

  return {
    member,
    transactions: buildMemberTransactions(state, discordId, 24),
  };
}

function getEconomyConfig() {
  const rewardCoins = Number(process.env.ECONOMY_PLAYTIME_REWARD_COINS || 60);
  const rewardMinutes = Number(
    process.env.ECONOMY_PLAYTIME_REWARD_MINUTES || 60,
  );
  const tickMinutes = Number(process.env.ECONOMY_PLAYTIME_TICK_MINUTES || 5);
  const enabled = process.env.ECONOMY_PLAYTIME_REWARD_ENABLED === "true";

  return {
    enabled,
    rewardCoins,
    rewardMinutes,
    tickMinutes,
    coinsPerHour:
      rewardMinutes > 0
        ? Math.round((rewardCoins / rewardMinutes) * 60)
        : rewardCoins,
  };
}

async function buildOverviewPayload(state: AdminState) {
  const runtime = getShopRuntimeStatus(state);
  const { rows: members } = await buildMemberRows(state);
  const wallets = Object.values(state.wallets || {}) as Wallet[];
  const transactions = Array.isArray(state.economyTransactions)
    ? state.economyTransactions
    : [];
  const totalCoins = wallets.reduce(
    (sum, wallet) => sum + Math.floor(Number(wallet.balance || 0)),
    0,
  );
  const totalEarned = wallets.reduce(
    (sum, wallet) => sum + Math.floor(Number(wallet.totalEarned || 0)),
    0,
  );
  const totalSpent = wallets.reduce(
    (sum, wallet) => sum + Math.floor(Number(wallet.totalSpent || 0)),
    0,
  );
  const shopOverview = buildShopOverview(state);
  const economyToday = buildEconomyToday(transactions);
  const maxPlayers = Math.max(
    1,
    Math.floor(
      Number(
        process.env.DAYZ_SERVER_MAX_PLAYERS ||
          process.env.ADMIN_PANEL_MAX_PLAYERS ||
          10,
      ),
    ),
  );

  return {
    server: {
      name:
        process.env.ADMIN_PANEL_SERVER_NAME ||
        process.env.SERVER_NAME ||
        "DayZ Server",
      status: "online",
      onlinePlayers: countObject(state.onlinePlayers),
      maxPlayers,
      totalPlayers: countObject(state.players),
      knownPlayers: countObject(state.players),
      linkedMembers: members.length,
      nextRestart: runtime.nextRestartLabel || "unknown",
      minutesUntilRestart: runtime.minutesUntilRestart ?? null,
    },
    combat: {
      dailyKills: sumPlayerKills(state.dailyPlayers),
      dailyDeaths: sumPlayerDeaths(state.dailyPlayers),
      weeklyKills: sumPlayerKills(state.weeklyPlayers),
      weeklyDeaths: sumPlayerDeaths(state.weeklyPlayers),
      totalKills: sumPlayerKills(state.players),
      totalDeaths: sumPlayerDeaths(state.players),
      killfeedEvents: Array.isArray(state.killFeedEvents)
        ? state.killFeedEvents.length
        : 0,
      longShotEvents: Array.isArray(state.longShotEvents)
        ? state.longShotEvents.length
        : 0,
      killStreakEvents: Array.isArray(state.killStreakEvents)
        ? state.killStreakEvents.length
        : 0,
    },
    parser: {
      lastProcessedAt: getLastParserProcessedAt(state),
      files: countObject(state.files),
      lastFileName: state.lastFileName || null,
    },
    economy: {
      ...getEconomyConfig(),
      wallets: wallets.length,
      totalCoins,
      totalEarned,
      totalSpent,
      transactions: transactions.length,
      todayEarned: economyToday.earned,
      todaySpent: economyToday.spent,
      todayNet: economyToday.net,
    },
    locale: {
      active: process.env.ADMIN_PANEL_DEFAULT_LOCALE || "pt-BR",
      available: ["pt-BR", "en-US"],
    },
    shop: {
      state: runtime.state,
      canAcceptPurchase: runtime.canAcceptPurchase,
      reason: runtime.reason,
      ...shopOverview,
    },
    mapEvents: {
      mode: "Manual pelo painel",
    },
    activity: buildActivitySeries(state),
    generatedAt: new Date().toISOString(),
  };
}

function labelForCategory(catalog: ShopCatalog, categoryId: string) {
  const category = catalog.categories.find((entry) => entry.id === categoryId);
  return category?.label || categoryId || "Misc";
}

function buildCatalogPayload() {
  const catalog = getShopCatalog();
  const categoryCounts = new Map<string, number>();

  for (const item of catalog.items) {
    const categoryId = item.category || "misc";
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) || 0) + 1);
  }

  const categories = catalog.categories
    .map((category) => ({
      id: category.id,
      label: category.label,
      emoji: category.emoji || "",
      description: category.description || "",
      enabled: category.enabled !== false,
      sortOrder: Number.isFinite(Number(category.sortOrder))
        ? Number(category.sortOrder)
        : 0,
      itemCount: categoryCounts.get(category.id) || 0,
    }))
    .sort(
      (a, b) =>
        (a.sortOrder || 0) - (b.sortOrder || 0) ||
        a.label.localeCompare(b.label),
    );

  const knownCategoryIds = new Set(categories.map((category) => category.id));
  for (const [categoryId, itemCount] of categoryCounts.entries()) {
    if (knownCategoryIds.has(categoryId)) continue;
    categories.push({
      id: categoryId,
      label: categoryId,
      emoji: "",
      description: "",
      enabled: true,
      sortOrder: categories.length,
      itemCount,
    });
  }

  const items = catalog.items
    .map((item: ShopItem) => ({
      id: item.id,
      name: item.name,
      className: item.className,
      popularName: item.popularName || "",
      category: item.category || "misc",
      categoryLabel: labelForCategory(catalog, item.category || "misc"),
      price: Math.floor(Number(item.price || 0)),
      description: item.description || "",
      imageUrl: item.imageUrl || "",
      enabled: item.enabled !== false,
      spawnEventName: item.spawnEventName || "",
      deliveryKind: item.deliveryKind || "item",
      sortOrder: Number.isFinite(Number(item.sortOrder))
        ? Number(item.sortOrder)
        : 0,
      maxPerRestart: Number.isFinite(Number(item.maxPerRestart))
        ? Number(item.maxPerRestart)
        : null,
    }))
    .sort(
      (a, b) =>
        a.categoryLabel.localeCompare(b.categoryLabel) ||
        (a.sortOrder || 0) - (b.sortOrder || 0) ||
        a.name.localeCompare(b.name),
    );

  return {
    version: catalog.version,
    categories,
    items,
    stats: {
      totalItems: items.length,
      enabledItems: items.filter((item) => item.enabled).length,
      disabledItems: items.filter((item) => !item.enabled).length,
      categories: categories.length,
      averagePrice: items.length
        ? Math.round(
            items.reduce((sum, item) => sum + item.price, 0) / items.length,
          )
        : 0,
    },
    generatedAt: new Date().toISOString(),
  };
}

function formatShopStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending_spawn: "Pending spawn",
    included_in_restart: "Included in restart",
    spawned: "Spawned",
    failed: "Failed",
  };

  return labels[status] || status || "Unknown";
}

function formatShopDateLabel(value: unknown) {
  const date = value ? new Date(String(value)) : null;
  if (!date || Number.isNaN(date.getTime())) return "Unknown date";

  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);

  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";

  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
}

function buildShopQueuePayload(state: AdminState) {
  const catalog = getShopCatalog();
  const runtime = getShopRuntimeStatus(state);
  const orders = Array.isArray(state.shopOrders) ? state.shopOrders : [];
  const links = state.playerLinks || {};
  const catalogByClass = new Map(
    catalog.items.map((item) => [
      String(item.className || "").toLowerCase(),
      item,
    ]),
  );
  const catalogById = new Map(
    catalog.items.map((item) => [String(item.id || "").toLowerCase(), item]),
  );

  const counts = orders.reduce<Record<string, number>>((acc, order) => {
    const status = String(order.status || "unknown");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  const latest = [...orders]
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )
    .slice(0, 100)
    .map((order) => {
      const item =
        catalogByClass.get(String(order.itemClass || "").toLowerCase()) ||
        catalogById.get(String(order.itemClass || "").toLowerCase()) ||
        null;
      const link = links[String(order.discordUserId || "")];

      return {
        id: String(order.id || ""),
        status: String(order.status || "unknown"),
        statusLabel: formatShopStatusLabel(String(order.status || "unknown")),
        itemClass: String(order.itemClass || item?.className || "Unknown item"),
        itemName: String(
          order.itemName ||
            item?.name ||
            item?.popularName ||
            order.itemClass ||
            "Unknown item",
        ),
        imageUrl: item?.imageUrl || "",
        discordUserId: String(order.discordUserId || ""),
        gamertag: link?.gamertag || "Unlinked Discord user",
        x: Number(order.x || 0),
        y: Number(order.y || 0),
        z: Number(order.z || 0),
        createdAt: order.createdAt || null,
        includedAt: order.includedAt || null,
        spawnedAt: order.spawnedAt || null,
        failedAt: order.failedAt || null,
        failReason: order.failReason || "",
        dateLabel: formatShopDateLabel(order.createdAt),
      };
    });

  return {
    runtime: {
      state: runtime.state,
      canAcceptPurchase: runtime.canAcceptPurchase,
      reason: runtime.reason || "",
      nextRestartLabel: runtime.nextRestartLabel || "unknown",
      minutesUntilRestart: runtime.minutesUntilRestart ?? null,
    },
    counts: {
      total: orders.length,
      pending: counts.pending_spawn || 0,
      included: counts.included_in_restart || 0,
      spawned: counts.spawned || 0,
      failed: counts.failed || 0,
    },
    latest,
    generatedAt: new Date().toISOString(),
  };
}

function buildShopTransactionsPayload(
  state: AdminState,
  options: { search?: string; limit?: number } = {},
) {
  const catalog = getShopCatalog();
  const orders = Array.isArray(state.shopOrders) ? state.shopOrders : [];
  const links = state.playerLinks || {};
  const economyTransactions = Array.isArray(state.economyTransactions)
    ? state.economyTransactions
    : [];
  const search = normalizeText(options.search || "");
  const limit = Math.min(
    500,
    Math.max(1, Math.floor(Number(options.limit || 250))),
  );

  const catalogByClass = new Map(
    catalog.items.map((item) => [
      String(item.className || "").toLowerCase(),
      item,
    ]),
  );
  const catalogById = new Map(
    catalog.items.map((item) => [String(item.id || "").toLowerCase(), item]),
  );

  const purchaseByOrderId = new Map<string, any>();
  for (const transaction of economyTransactions) {
    const tx = transaction as {
      type?: string;
      reason?: string;
      createdAt?: string;
    };
    if (tx.type !== "SHOP_PURCHASE") continue;
    const reason = String(tx.reason || "");
    const match = reason.match(/\((shop_[^)]+)\)$/);
    if (match?.[1]) purchaseByOrderId.set(match[1], transaction);
  }

  const transactions = [...orders]
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )
    .map((order) => {
      const item =
        catalogByClass.get(String(order.itemClass || "").toLowerCase()) ||
        catalogById.get(String(order.itemClass || "").toLowerCase()) ||
        null;
      const link = links[String(order.discordUserId || "")];
      const purchase = purchaseByOrderId.get(String(order.id || "")) as
        | {
            amount?: number;
            balanceBefore?: number;
            balanceAfter?: number;
            createdAt?: string;
          }
        | undefined;

      return {
        id: String(order.id || ""),
        status: String(order.status || "unknown"),
        statusLabel: formatShopStatusLabel(String(order.status || "unknown")),
        itemClass: String(order.itemClass || item?.className || "Unknown item"),
        itemName: String(
          order.itemName ||
            item?.name ||
            item?.popularName ||
            order.itemClass ||
            "Unknown item",
        ),
        imageUrl: item?.imageUrl || "",
        discordUserId: String(order.discordUserId || ""),
        gamertag: link?.gamertag || "Unlinked Discord user",
        x: Number(order.x || 0),
        y: Number(order.y || 0),
        z: Number(order.z || 0),
        amount: Math.floor(Number(purchase?.amount || 0)),
        balanceBefore: Math.floor(Number(purchase?.balanceBefore || 0)),
        balanceAfter: Math.floor(Number(purchase?.balanceAfter || 0)),
        createdAt: order.createdAt || purchase?.createdAt || null,
        includedAt: order.includedAt || null,
        spawnedAt: order.spawnedAt || null,
        failedAt: order.failedAt || null,
        failReason: order.failReason || "",
        dateLabel: formatShopDateLabel(order.createdAt || purchase?.createdAt),
      };
    })
    .filter((entry) => {
      if (!search) return true;
      return [
        entry.id,
        entry.itemName,
        entry.itemClass,
        entry.gamertag,
        entry.discordUserId,
        entry.status,
      ].some((value) => normalizeText(value).includes(search));
    })
    .slice(0, limit);

  return {
    transactions,
    stats: {
      totalPurchases: orders.length,
      filtered: transactions.length,
      totalSpent: transactions.reduce(
        (sum, transaction) => sum + Math.floor(Number(transaction.amount || 0)),
        0,
      ),
    },
    generatedAt: new Date().toISOString(),
  };
}

async function readCatalogItemPayload(
  body: unknown,
  fallbackId?: string,
): Promise<ShopItem> {
  const input = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  const requestedClassName = String(
    input.className || input.class_name || input.id || fallbackId || "",
  ).trim();
  const definition = await getDayzItemByClassName(requestedClassName);

  if (!definition || definition.enabled === false) {
    throw new Error(
      "Select a valid enabled DayZ item from the database before saving.",
    );
  }

  const className = definition.className;
  const id = normalizeShopCatalogId(String(input.id || className));
  const name = String(
    input.name || definition.popularName || definition.className,
  ).trim();
  const category =
    normalizeShopCatalogId(String(input.category || "misc")) || "misc";
  const price = Math.floor(Number(input.price || 0));
  const enabled =
    typeof input.enabled === "boolean"
      ? input.enabled
      : input.enabled !== false;
  const imageUrl = String(input.imageUrl || definition.imageUrl || "").trim();

  if (!id) throw new Error("Item id is required.");
  if (!name) throw new Error("Store item name is required.");
  if (!Number.isFinite(price) || price < 0)
    throw new Error("Item price must be a valid positive number.");

  return {
    id,
    name,
    className,
    popularName: definition.popularName || name,
    spawnEventName: definition.spawnEventName,
    deliveryKind: String(definition.spawnEventName || "").startsWith("Vehicle")
      ? "vehicle"
      : "item",
    category,
    price,
    description: input.description
      ? String(input.description).trim()
      : undefined,
    imageUrl: imageUrl || undefined,
    enabled,
    sortOrder: Number.isFinite(Number(input.sortOrder))
      ? Math.floor(Number(input.sortOrder))
      : undefined,
  };
}

function readCatalogCategoryPayload(body: unknown) {
  const input = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  const label = String(input.label || input.name || "").trim();
  const requestedId = String(input.id || label).trim();
  const id = normalizeShopCatalogId(requestedId);
  const description = String(input.description || "").trim();
  const emoji = String(input.emoji || "").trim();
  const enabled =
    typeof input.enabled === "boolean"
      ? input.enabled
      : input.enabled !== false;

  if (!id) throw new Error("Category id is required.");
  if (!label) throw new Error("Category name is required.");

  return {
    id,
    label,
    emoji: emoji || undefined,
    description: description || undefined,
    enabled,
  };
}

function sumPlayerKills(players: unknown) {
  if (!players || typeof players !== "object") return 0;
  return Object.values(
    players as Record<string, Partial<{ kills: number }>>,
  ).reduce(
    (sum, player) => sum + Math.max(0, Math.floor(Number(player?.kills || 0))),
    0,
  );
}

function sumPlayerDeaths(players: unknown) {
  if (!players || typeof players !== "object") return 0;
  return Object.values(
    players as Record<string, Partial<{ deaths: number }>>,
  ).reduce(
    (sum, player) => sum + Math.max(0, Math.floor(Number(player?.deaths || 0))),
    0,
  );
}

function isToday(value: unknown) {
  if (!value) return false;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function buildShopOverview(state: AdminState) {
  const orders = Array.isArray(state.shopOrders) ? state.shopOrders : [];
  const counts = orders.reduce<Record<string, number>>((acc, order) => {
    const status = String((order as { status?: string }).status || "unknown");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: orders.length,
    pending: counts.pending_spawn || 0,
    included: counts.included_in_restart || 0,
    spawned: counts.spawned || 0,
    failed: counts.failed || 0,
  };
}

function buildEconomyToday(transactions: unknown[]) {
  let earned = 0;
  let spent = 0;

  for (const entry of transactions) {
    const transaction = entry as {
      type?: string;
      amount?: number;
      createdAt?: string;
    };
    if (!isToday(transaction.createdAt)) continue;
    const amount = Math.max(0, Math.floor(Number(transaction.amount || 0)));
    const type = String(transaction.type || "");

    if (
      [
        "ADMIN_ADD",
        "PLAYTIME_REWARD",
        "EVENT_REWARD",
        "DONATION_REWARD",
      ].includes(type)
    )
      earned += amount;
    if (["ADMIN_REMOVE", "SHOP_PURCHASE"].includes(type)) spent += amount;
  }

  return { earned, spent, net: earned - spent };
}

function getLastParserProcessedAt(state: AdminState) {
  const files = state.files || {};
  let latest: string | null = null;

  for (const value of Object.values(files)) {
    const cursor = value as { lastProcessedAt?: string } | undefined;
    if (!cursor?.lastProcessedAt) continue;
    if (!latest || String(cursor.lastProcessedAt) > latest)
      latest = String(cursor.lastProcessedAt);
  }

  return latest;
}

function getBrazilHour(date: Date) {
  const value = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  }).format(date);

  return Math.max(0, Math.min(23, Number(value.replace(/\D/g, "")) || 0));
}

function getBrazilWeekdayIndex(date: Date) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(date);

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value);
}

function buildPeakHours(state: AdminState) {
  const samples = Array.isArray(state.onlineActivitySamples)
    ? state.onlineActivitySamples
    : [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const buckets = new Map<
    number,
    { sum: number; count: number; max: number }
  >();

  for (const sample of samples) {
    const date = new Date(String(sample.bucket || ""));
    const time = date.getTime();
    if (!Number.isFinite(time) || time < cutoff) continue;
    const hour = getBrazilHour(date);
    const online = Math.max(0, Number(sample.online || 0));
    const current = buckets.get(hour) || { sum: 0, count: 0, max: 0 };
    current.sum += online;
    current.count += 1;
    current.max = Math.max(current.max, online);
    buckets.set(hour, current);
  }

  if (buckets.size === 0) {
    const hour = getBrazilHour(new Date());
    buckets.set(hour, {
      sum: countObject(state.onlinePlayers),
      count: 1,
      max: countObject(state.onlinePlayers),
    });
  }

  return Array.from(buckets.entries())
    .map(([hour, item]) => ({
      hour,
      label: `${String(hour).padStart(2, "0")}h`,
      average: item.count > 0 ? Number((item.sum / item.count).toFixed(1)) : 0,
      max: item.max,
      samples: item.count,
    }))
    .sort((a, b) => b.average - a.average || b.max - a.max || a.hour - b.hour)
    .slice(0, 8);
}

function buildWeekdayActivity(state: AdminState) {
  const names = [
    "Domingo",
    "Segunda",
    "Terça",
    "Quarta",
    "Quinta",
    "Sexta",
    "Sábado",
  ];
  const rows = names.map((label, index) => ({ index, label, kills: 0 }));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const events = Array.isArray(state.killFeedEvents)
    ? state.killFeedEvents
    : [];

  for (const event of events) {
    const date = new Date(
      String(
        (event as { at?: string; timestamp?: string }).at ||
          (event as { at?: string; timestamp?: string }).timestamp ||
          "",
      ),
    );
    const time = date.getTime();
    if (!Number.isFinite(time) || time < cutoff) continue;
    const index = getBrazilWeekdayIndex(date);
    if (index >= 0) rows[index].kills += 1;
  }

  if (rows.every((row) => row.kills === 0)) {
    const todayIndex = getBrazilWeekdayIndex(new Date());
    if (todayIndex >= 0)
      rows[todayIndex].kills = sumPlayerKills(state.dailyPlayers);
  }

  return rows;
}

function buildActivitySeries(state: AdminState) {
  return {
    peakHours: buildPeakHours(state),
    weekdayActivity: buildWeekdayActivity(state),
  };
}

function renderAdminPanelHtml(token: string) {
  const tokenJson = JSON.stringify(token || "");
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DayZ Admin Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #1E1F22;
      --bg-soft: #232428;
      --surface: #2B2D31;
      --surface-2: #313338;
      --surface-3: #36383F;
      --primary: #5865F2;
      --primary-soft: rgba(88, 101, 242, .14);
      --text: #F2F3F5;
      --text-2: #B5BAC1;
      --text-3: #949BA4;
      --success: #23A55A;
      --warning: #F0B232;
      --danger: #F23F43;
      --border: rgba(255,255,255,.07);
      --border-strong: rgba(255,255,255,.11);
      --shadow-sm: 0 1px 0 rgba(255,255,255,.04) inset, 0 10px 28px rgba(0,0,0,.12);
      --shadow-md: 0 1px 0 rgba(255,255,255,.04) inset, 0 18px 48px rgba(0,0,0,.18);
      --radius: 14px;
      --radius-lg: 18px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      letter-spacing: -.01em;
    }
    button, input, select, textarea { font: inherit; }
    button { border: 0; }
    .app { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }

    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 16px 12px;
      background: #2B2D31;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 8px 8px 16px;
      border-bottom: 1px solid var(--border);
    }
    .logo {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: #313338;
      border: 1px solid var(--border-strong);
      box-shadow: var(--shadow-sm);
      font-size: 18px;
    }
    .brand-title {
      font-size: 14px;
      font-weight: 650;
      letter-spacing: -.02em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--text-3);
      font-size: 12px;
      margin-top: 4px;
    }
    .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--success); }
    .nav-label {
      color: var(--text-3);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: .12em;
      padding: 0 12px;
      text-transform: uppercase;
    }
    .nav { display: grid; gap: 4px; }
    .nav button {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      color: var(--text-2);
      padding: 10px 12px;
      border-radius: 10px;
      background: transparent;
      cursor: pointer;
      transition: background .18s ease, color .18s ease;
      text-align: left;
      font-weight: 520;
    }
    .nav button:hover { background: rgba(255,255,255,.045); color: var(--text); }
    .nav button.active { background: #404249; color: var(--text); }
    .nav button.active::before {
      content: "";
      position: absolute;
      left: -5px;
      top: 9px;
      bottom: 9px;
      width: 3px;
      border-radius: 999px;
      background: var(--primary);
    }
    .sidebar-footer {
      margin-top: auto;
      padding: 14px 8px 4px;
      border-top: 1px solid var(--border);
      color: var(--text-2);
      font-size: 13px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .sidebar-footer-user { min-width: 0; flex: 1 1 auto; }
    .logout-form { margin: 0 0 0 auto; flex: 0 0 auto; }
    .logout-button {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-2);
      border-radius: 8px;
      min-height: 32px;
      padding: 6px 10px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      transition: background .18s ease, color .18s ease, border-color .18s ease;
    }
    .logout-button:hover { background: rgba(255,255,255,.055); color: var(--text); border-color: var(--border-strong); }
    .avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #404249;
      border: 1px solid var(--border-strong);
      color: var(--text);
      font-weight: 700;
      flex: 0 0 auto;
      font-size: 12px;
    }
    .main { min-width: 0; }
    .topbar {
      height: 68px;
      display: flex;
      align-items: center;
      gap: 16px;
      justify-content: space-between;
      padding: 0 28px;
      background: rgba(30,31,34,.92);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(12px);
    }
    .page-title { font-size: 18px; font-weight: 650; letter-spacing: -.025em; }
    .top-actions { display: flex; align-items: center; gap: 10px; }
    .global-search { width: min(440px, 42vw); position: relative; }
    .global-search input, .search input, select, .form-grid input, .form-grid textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      background: #2B2D31;
      outline: none;
      transition: border-color .18s ease, background .18s ease, box-shadow .18s ease;
    }
    .global-search input, .search input, select { height: 40px; padding: 0 13px; }
    .global-search input::placeholder, .search input::placeholder, textarea::placeholder { color: #80848E; }
    .global-search input:focus, .search input:focus, select:focus, .form-grid input:focus, .form-grid textarea:focus {
      border-color: rgba(88,101,242,.72);
      box-shadow: 0 0 0 3px rgba(88,101,242,.12);
      background: #313338;
    }
    .icon-btn, .primary-btn, .ghost-btn, .danger-btn {
      height: 40px;
      border-radius: 12px;
      padding: 0 13px;
      color: var(--text);
      cursor: pointer;
      transition: background .16s ease, border-color .16s ease, opacity .16s ease, transform .16s ease;
      font-weight: 560;
    }
    .icon-btn, .ghost-btn { background: #2B2D31; border: 1px solid var(--border); }
    .icon-btn:hover, .ghost-btn:hover { background: #35373D; border-color: var(--border-strong); }
    .primary-btn { background: var(--primary); color: #fff; }
    .primary-btn:hover { background: #6875ff; transform: translateY(-1px); }
    .danger-btn { background: rgba(242,63,67,.11); color: #ffb4b6; border: 1px solid rgba(242,63,67,.22); }
    .danger-btn:hover { background: rgba(242,63,67,.16); }
    .content { padding: 28px; }
    .view { display: none; animation: fadeIn .18s ease both; }
    .view.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .card {
      background: #2B2D31;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: 18px;
      transition: background .18s ease, border-color .18s ease, transform .18s ease;
    }
    .card:hover { background: #303238; border-color: var(--border-strong); }
    .metric-label {
      color: var(--text-3);
      font-size: 12px;
      font-weight: 620;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .metric-value {
      margin-top: 12px;
      font-size: 24px;
      font-weight: 680;
      letter-spacing: -.045em;
      line-height: 1.05;
    }
    .metric-hint { margin-top: 9px; color: var(--text-3); font-size: 13px; }
    .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) 360px; gap: 14px; margin-top: 14px; align-items: start; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .section-title h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.02em; }
    .chart { display: flex; align-items: end; gap: 9px; height: 224px; padding-top: 12px; }
    .bar-wrap { flex: 1; min-width: 0; display: grid; gap: 8px; align-items: end; height: 100%; }
    .bar {
      border-radius: 8px 8px 3px 3px;
      background: linear-gradient(180deg, #6E78F5, #5865F2);
      min-height: 12px;
      opacity: .92;
      transition: height .22s ease, opacity .16s ease;
    }
    .bar-wrap:hover .bar { opacity: 1; }
    .bar-label { color: var(--text-3); font-size: 11px; text-align: center; white-space: nowrap; }
    .settings-list { display: grid; gap: 10px; }
    .command-settings-summary { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .command-settings-list { display:grid; gap:10px; margin-top:14px; }
    .command-settings-group { display:grid; gap:10px; }
    .command-settings-group + .command-settings-group { margin-top:18px; }
    .command-settings-group-title { color:var(--text-3); font-size:11px; font-weight:700; letter-spacing:.11em; text-transform:uppercase; padding:0 2px; }
    .command-setting-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:18px; align-items:center; padding:15px 16px; border:1px solid var(--border); border-radius:16px; background:#2B2D31; box-shadow:var(--shadow-sm); transition:background .16s ease,border-color .16s ease,opacity .16s ease; }
    .command-setting-row:hover { background:#303238; border-color:var(--border-strong); }
    .command-setting-row.is-disabled { opacity:.72; }
    .command-setting-name { display:flex; align-items:center; gap:9px; font-size:14px; font-weight:650; letter-spacing:-.02em; }
    .command-setting-name code { color:#DDE1FF; background:rgba(88,101,242,.12); border:1px solid rgba(88,101,242,.22); padding:4px 7px; border-radius:8px; font:inherit; }
    .command-setting-description { color:var(--text-3); font-size:12px; line-height:1.45; margin-top:6px; }
    .ios-switch { position:relative; width:51px; height:31px; border-radius:999px; background:#4E5058; border:0; padding:0; cursor:pointer; flex:0 0 auto; transition:background .2s ease,box-shadow .2s ease; box-shadow:inset 0 0 0 1px rgba(255,255,255,.06); }
    .ios-switch::after { content:""; position:absolute; width:27px; height:27px; left:2px; top:2px; border-radius:50%; background:#fff; box-shadow:0 2px 7px rgba(0,0,0,.32); transition:transform .22s cubic-bezier(.2,.8,.2,1); }
    .ios-switch[aria-checked="true"] { background:#23A55A; box-shadow:inset 0 0 0 1px rgba(255,255,255,.10),0 0 0 3px rgba(35,165,90,.10); }
    .ios-switch[aria-checked="true"]::after { transform:translateX(20px); }
    .ios-switch:focus-visible { outline:3px solid rgba(88,101,242,.42); outline-offset:3px; }
    .ios-switch:disabled { cursor:wait; opacity:.62; }
    .settings-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
    .settings-tab { border: 1px solid var(--border); background: rgba(255,255,255,.035); color: var(--text-2); border-radius: 999px; padding: 9px 13px; font-size: 12px; font-weight: 650; cursor: pointer; }
    .settings-tab.active { color: var(--text); border-color: rgba(124,140,255,.55); background: rgba(124,140,255,.13); }
    .settings-panel { display: none; }
    .settings-panel.active { display: grid; gap: 16px; }
    .integration-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .integration-card { border: 1px solid var(--border); background: rgba(255,255,255,.035); border-radius: 18px; padding: 16px; display: grid; min-height: 180px; cursor: pointer; transition: transform .16s ease, border-color .16s ease, background .16s ease; text-align: left; color: var(--text); }
    .integration-card:hover { transform: translateY(-1px); border-color: rgba(124,140,255,.45); background: rgba(255,255,255,.055); }
    .integration-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .integration-icon { width: 48px; height: 48px; border-radius: 15px; display: grid; place-items: center; background: radial-gradient(circle at 30% 20%, rgba(255,145,77,.32), rgba(124,140,255,.14) 52%, rgba(255,255,255,.06)); border: 1px solid rgba(255,255,255,.12); box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 10px 28px rgba(0,0,0,.18); overflow: hidden; }
    .integration-icon img { width: 37px; height: 37px; object-fit: contain; filter: drop-shadow(0 4px 8px rgba(0,0,0,.25)); }
    .integration-card h3 { margin: 18px 0 6px; font-size: 16px; letter-spacing: -.03em; }
    .integration-card p { color: var(--text-3); font-size: 12px; line-height: 1.45; margin: 0; }
    .integration-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 18px; }
    .integration-action { border: 1px solid var(--border); color: var(--text); background: rgba(255,255,255,.05); border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 650; display: inline-flex; align-items: center; gap: 6px; }
    .integration-action.installed { color: var(--ok); border-color: rgba(63,210,143,.38); background: rgba(63,210,143,.10); }
    .settings-empty-note { border: 1px dashed var(--border); border-radius: 16px; padding: 18px; color: var(--text-3); background: rgba(255,255,255,.025); font-size: 13px; }
    .server-onboarding-grid { display:grid; grid-template-columns:minmax(280px,.72fr) minmax(0,1.28fr); gap:16px; align-items:start; }
    .server-onboarding-list { display:grid; gap:10px; }
    .server-onboarding-row { border:1px solid var(--border); border-radius:16px; padding:14px 15px; background:rgba(255,255,255,.025); display:grid; gap:10px; transition:border-color .16s ease,background .16s ease; }
    .server-onboarding-row.selected { border-color:rgba(124,140,255,.52); background:rgba(124,140,255,.08); }
    .server-onboarding-row-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .server-onboarding-row h3 { margin:0; font-size:14px; }
    .server-onboarding-row p { margin:4px 0 0; color:var(--text-3); font-size:11px; }
    .server-onboarding-meta { display:flex; gap:7px; flex-wrap:wrap; }
    .server-onboarding-actions { display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
    .server-onboarding-form { display:grid; gap:14px; }
    .server-preflight-list { display:grid; gap:9px; margin-top:12px; }
    .server-preflight-row { display:grid; grid-template-columns:minmax(120px,.34fr) minmax(0,1fr); gap:12px; padding:12px 13px; border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,.02); }
    .server-preflight-row strong { font-size:12px; }
    .server-preflight-row p { margin:3px 0 0; color:var(--text-3); font-size:11px; line-height:1.45; }
    .server-preflight-empty { padding:16px; border:1px dashed var(--border); border-radius:14px; color:var(--text-3); font-size:12px; }
    .server-onboarding-form .form-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .server-onboarding-form label { color:var(--text-3); font-size:11px; display:grid; gap:6px; }
    .server-onboarding-form input { width:100%; }
    .server-onboarding-form .full { grid-column:1/-1; }
    .server-onboarding-notice { border:1px solid rgba(243,204,90,.18); background:rgba(243,204,90,.07); border-radius:14px; padding:12px 13px; color:#e8d58b; font-size:12px; line-height:1.45; }
    .server-onboarding-info { border:1px solid rgba(124,140,255,.20); background:rgba(124,140,255,.07); border-radius:14px; padding:12px 13px; color:var(--text-2); font-size:12px; line-height:1.5; }
    .server-create-copy { max-width:560px; color:var(--text-3); font-size:13px; line-height:1.55; margin:-4px 0 4px; }
    .server-setup-hero { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .server-setup-hero h2 { margin:0; font-size:18px; letter-spacing:-.03em; }
    .server-setup-hero p { margin:6px 0 0; color:var(--text-3); font-size:12px; }
    .server-setup-progress { margin-top:18px; padding:14px; border:1px solid var(--border); border-radius:16px; background:rgba(255,255,255,.025); }
    .server-setup-progress-head { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--text-2); font-size:12px; }
    .server-setup-progress-track { height:7px; margin-top:10px; border-radius:999px; overflow:hidden; background:rgba(255,255,255,.08); }
    .server-setup-progress-track span { display:block; height:100%; width:50%; border-radius:inherit; background:var(--primary); transition:width .2s ease; }
    .server-setup-tabs { display:flex; gap:6px; padding:5px; margin-top:16px; border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,.025); }
    .server-setup-tab { flex:1; border:0; border-radius:10px; padding:10px 12px; background:transparent; color:var(--text-3); font-size:12px; font-weight:650; cursor:pointer; }
    .server-setup-tab.active { background:rgba(124,140,255,.14); color:var(--text); box-shadow:inset 0 0 0 1px rgba(124,140,255,.24); }
    .server-setup-panel { display:none; gap:14px; margin-top:16px; }
    .server-setup-panel.active { display:grid; }
    .server-setup-status-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
    .server-setup-status-card { border:1px solid var(--border); border-radius:16px; padding:14px; background:rgba(255,255,255,.025); min-height:118px; }
    .server-setup-status-card span { color:var(--text-3); font-size:11px; }
    .server-setup-status-card strong { display:block; margin-top:8px; color:var(--text); font-size:14px; }
    .server-setup-status-card p { margin:7px 0 0; color:var(--text-3); font-size:11px; line-height:1.45; }
    .server-integration-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .server-integration-head h3 { margin:0; font-size:16px; letter-spacing:-.02em; }
    .server-integration-head p { margin:6px 0 0; color:var(--text-3); font-size:12px; line-height:1.5; }
    .server-advanced-details { border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,.02); overflow:hidden; }
    .server-advanced-details summary { cursor:pointer; padding:13px 14px; color:var(--text-2); font-size:12px; font-weight:650; }
    .server-advanced-details[open] summary { border-bottom:1px solid var(--border); }
    .server-advanced-details .form-grid { padding:14px; }
    @media (max-width: 980px) { .server-onboarding-grid { grid-template-columns:1fr; } }
    @media (max-width: 720px) { .server-setup-status-grid { grid-template-columns:1fr; } .server-setup-tabs { overflow:auto; } .server-setup-tab { min-width:110px; } }
    @media (max-width: 620px) { .server-onboarding-form .form-grid { grid-template-columns:1fr; } .server-onboarding-form .full { grid-column:auto; } .server-setup-hero { flex-direction:column; } }
    .integration-modal .modal { width: min(1040px, 96vw); max-height: 92vh; overflow: hidden; padding: 0; display: grid; grid-template-rows: auto 1fr auto; }
    .integration-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 24px; border-bottom: 1px solid var(--border); background: linear-gradient(180deg, rgba(124,140,255,.10), rgba(255,255,255,0)); }
    .integration-modal-title { display: flex; gap: 14px; align-items: center; }
    .integration-modal-title h2 { font-size: 22px; margin: 0; }
    .integration-modal-title p { margin: 5px 0 0; font-size: 13px; color: var(--text-3); }
    .integration-modal-body { overflow: auto; padding: 22px 24px; display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 18px; }
    .integration-modal-section { border: 1px solid var(--border); border-radius: 18px; background: rgba(255,255,255,.035); padding: 16px; }
    .integration-modal-section h3 { margin: 0 0 10px; font-size: 14px; letter-spacing: -.02em; }
    .integration-feature-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .integration-feature-list li { display: flex; gap: 10px; color: var(--text-2); font-size: 13px; line-height: 1.4; }
    .integration-modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; gap: 10px; align-items: center; background: rgba(255,255,255,.025); }
    .settings-loader { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 16px; background: rgba(124,140,255,.08); }
    .settings-loader-title { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text); }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.20); border-top-color: var(--accent); border-radius: 999px; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .progress-bar { height: 7px; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; }
    .progress-bar span { display: block; width: 36%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, rgba(124,140,255,.2), var(--accent), rgba(124,140,255,.2)); animation: progressSweep 1.1s ease-in-out infinite; }
    @keyframes progressSweep { 0% { transform: translateX(-110%); } 100% { transform: translateX(310%); } }
    @media (max-width: 900px) { .integration-modal-body { grid-template-columns: 1fr; } }
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-radius: 14px;
      background: #25262A;
      border: 1px solid var(--border);
    }
    .setting-row b { font-size: 13px; font-weight: 620; }
    .setting-row span { display:block; color: var(--text-3); font-size: 12px; margin-top: 4px; }
    .members-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px auto; gap: 10px; margin-bottom: 14px; }
    .members-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .member-list { display: grid; gap: 10px; }
    .member-card {
      display: grid;
      grid-template-columns: 52px minmax(260px, 1fr) minmax(160px,.62fr) auto;
      gap: 16px;
      align-items: center;
      padding: 14px;
      border-radius: 16px;
      background: #2B2D31;
      border: 1px solid var(--border);
      box-shadow: var(--shadow-sm);
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    .member-card:hover { background: #303238; border-color: var(--border-strong); transform: translateY(-1px); }
    .member-avatar-wrap { position: relative; width: 48px; height: 48px; border-radius: 16px; flex: 0 0 auto; }
    .member-avatar-img, .member-avatar-fallback { width: 48px; height: 48px; border-radius: 16px; display: grid; place-items: center; object-fit: cover; background: #25262A; border: 1px solid var(--border); color: var(--text-2); font-size: 13px; font-weight: 650; }
    .presence-dot { position: absolute; right: -2px; bottom: -2px; width: 13px; height: 13px; border-radius: 999px; background: #6B7280; border: 3px solid #2B2D31; box-shadow: 0 0 0 1px rgba(255,255,255,.04); }
    .presence-dot.online { background: #23A55A; }
    .member-card:hover .presence-dot { border-color: #303238; }
    .member-name { font-weight: 620; letter-spacing: -.018em; }
    .member-meta { color: var(--text-3); font-size: 12px; margin-top: 4px; line-height: 1.35; }
    .member-gamertag { color: var(--text-3); font-size: 13px; margin-top: 4px; line-height: 1.35; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .chip {
      color: var(--text-2);
      border: 1px solid var(--border);
      background: #25262A;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 560;
    }
    .chip.online { color: #B9F6CC; background: rgba(35,165,90,.10); border-color: rgba(35,165,90,.24); }
    .wallet-number { font-size: 18px; font-weight: 680; letter-spacing: -.035em; }
    .actions { display: flex; gap: 7px; justify-content: flex-end; flex-wrap: wrap; }
    .mini-btn {
      height: 32px;
      border-radius: 10px;
      padding: 0 10px;
      background: #35373D;
      color: var(--text-2);
      border: 1px solid var(--border);
      cursor: pointer;
      font-weight: 560;
      transition: background .16s ease, color .16s ease, transform .16s ease, border-color .16s ease;
    }
    .mini-btn:hover { background: #404249; color: var(--text); transform: translateY(-1px); border-color: var(--border-strong); }
    .mini-btn.danger { color: #ffb4b6; background: rgba(242,63,67,.08); border-color: rgba(242,63,67,.18); }
    .mini-btn.disabled { opacity: .52; cursor: not-allowed; transform: none !important; }
    .empty {
      padding: 48px;
      text-align: center;
      border-radius: var(--radius-lg);
      background: #2B2D31;
      border: 1px solid var(--border);
      color: var(--text-3);
    }
    .skeleton {
      height: 82px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: linear-gradient(90deg, #2B2D31, #34363C, #2B2D31);
      background-size: 220% 100%;
      animation: shimmer 1.25s linear infinite;
    }
    @keyframes shimmer { to { background-position: -220% 0; } }
    .sentinel { height: 36px; }
    .catalog-shell { display: grid; gap: 14px; }
    .catalog-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .catalog-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .catalog-breadcrumb { display: flex; align-items: center; gap: 10px; color: var(--text-3); font-size: 13px; }
    .catalog-category-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .catalog-category-card {
      min-height: 156px;
      background: #2B2D31;
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      display: grid;
      align-content: center;
      justify-items: center;
      gap: 10px;
      cursor: pointer;
      position: relative;
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    .catalog-category-card:hover { background: #303238; border-color: var(--border-strong); transform: translateY(-1px); }
    .catalog-category-card.dragging, .catalog-item.dragging { opacity: .58; transform: scale(.985); border-color: rgba(88,101,242,.48); }
    .drag-handle { position: absolute; top: 10px; left: 10px; width: 30px; height: 30px; border-radius: 10px; border: 1px solid var(--border); background: rgba(37,38,42,.88); color: var(--text-3); cursor: grab; display: grid; place-items: center; font-size: 15px; line-height: 1; transition: background .16s ease, color .16s ease, border-color .16s ease, opacity .16s ease; }
    .drag-handle:hover { background: #35373D; color: var(--text); border-color: var(--border-strong); }
    .drag-handle:active { cursor: grabbing; }
    .catalog-category-card.new { border-style: dashed; color: var(--text-3); }
    .category-icon { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; border: 1px solid var(--border); background: #25262A; font-size: 22px; }
    .category-title { font-size: 14px; font-weight: 650; letter-spacing: -.025em; color: var(--text); text-align: center; }
    .category-subtitle { color: var(--text-3); font-size: 12px; text-align: center; }
    .category-delete { position: absolute; top: 10px; right: 10px; opacity: .72; }
    .catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .catalog-item {
      min-width: 0;
      position: relative;
      background: #2B2D31;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      box-shadow: var(--shadow-sm);
      display: grid;
      gap: 12px;
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    .catalog-item:hover { background: #303238; border-color: var(--border-strong); transform: translateY(-1px); }
    .catalog-item .drag-handle { left: auto; right: 10px; top: 10px; }
    .catalog-item-top { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding-right: 34px; }
    .catalog-thumb {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      background: #25262A;
      border: 1px solid var(--border);
      display: grid;
      place-items: center;
      overflow: hidden;
      color: var(--text-3);
      font-size: 18px;
      flex: 0 0 auto;
    }
    .catalog-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .catalog-name { font-size: 14px; font-weight: 650; letter-spacing: -.025em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .catalog-class { color: var(--text-3); font-size: 12px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .catalog-price { font-size: 14px; font-weight: 680; color: var(--text); white-space: nowrap; }
    .catalog-description { min-height: 38px; color: var(--text-2); font-size: 12px; line-height: 1.45; }
    .catalog-meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .catalog-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; padding-top: 2px; }
    .autocomplete-wrap { position: relative; }
    .autocomplete-menu {
      position: absolute;
      z-index: 20;
      left: 0;
      right: 0;
      top: calc(100% + 8px);
      max-height: 280px;
      overflow: auto;
      border: 1px solid var(--border-strong);
      background: #25262b;
      border-radius: 14px;
      box-shadow: var(--shadow-md);
      padding: 6px;
      display: none;
    }
    .autocomplete-menu.open { display: grid; gap: 4px; }
    .autocomplete-option {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--text);
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      padding: 8px;
      border-radius: 12px;
      cursor: pointer;
      text-align: left;
      transition: background .16s ease;
    }
    .autocomplete-option:hover { background: #313338; }
    .autocomplete-option img, .autocomplete-fallback {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      background: #1E1F22;
      border: 1px solid var(--border);
      object-fit: cover;
      display: grid;
      place-items: center;
      color: var(--text-3);
      font-size: 16px;
    }
    .autocomplete-title { font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .autocomplete-subtitle { margin-top: 3px; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .map-loot-picker { display: grid; gap: 10px; }
    .map-loot-selected { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px; border-radius: 12px; background: rgba(255,255,255,.035); border: 1px solid var(--border); }
    .map-loot-selected.is-empty { color: var(--text-3); grid-template-columns: 1fr; }
    .map-loot-thumb { width: 46px; height: 46px; border-radius: 10px; overflow: hidden; background: rgba(255,255,255,.045); border: 1px solid var(--border); display: grid; place-items: center; color: var(--text-3); }
    .map-loot-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .map-loot-title { color: var(--text); font-weight: 650; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .map-loot-subtitle { color: var(--text-3); font-size: 11px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .map-loot-list { display: grid; gap: 8px; }
    .map-loot-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) 84px auto; gap: 10px; align-items: center; padding: 9px; border-radius: 12px; background: rgba(255,255,255,.03); border: 1px solid var(--border); }
    .map-loot-row input { width: 84px; min-width: 0; }
    .map-loot-empty { padding: 12px; border-radius: 12px; border: 1px dashed var(--border-strong); color: var(--text-3); background: rgba(255,255,255,.02); font-size: 12px; }
    @media (max-width: 620px) { .map-loot-selected { grid-template-columns: 42px minmax(0, 1fr); } .map-loot-selected > .mini-btn { grid-column: 1 / -1; width: 100%; } .map-loot-row { grid-template-columns: 38px minmax(0, 1fr); } .map-loot-row input, .map-loot-row .mini-btn { grid-column: 1 / -1; width: 100%; } }
    .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .form-grid .full { grid-column: 1 / -1; }
    .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border-radius: 14px; background: #25262A; border: 1px solid var(--border); }
    .toggle-row input { width: auto; }
    .catalog-empty { padding: 42px; text-align: center; color: var(--text-3); border: 1px dashed var(--border-strong); border-radius: 18px; background: #2B2D31; }
    .shop-queue-shell { display: grid; gap: 14px; }
    .shop-queue-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .shop-queue-status { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
    .shop-queue-list { display: grid; gap: 10px; }
    .shop-queue-order {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 12px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #2B2D31;
    }
    .shop-queue-order:hover { background: #303238; border-color: var(--border-strong); }
    .shop-queue-thumb { width: 48px; height: 48px; border-radius: 13px; overflow: hidden; border: 1px solid var(--border); background: #232428; display: grid; place-items: center; color: var(--text-3); }
    .shop-queue-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .shop-queue-title { font-size: 14px; font-weight: 650; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .shop-queue-subtitle { color: var(--text-3); font-size: 12px; margin-top: 3px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .shop-queue-meta { text-align: right; color: var(--text-3); font-size: 12px; line-height: 1.45; }
    .shop-date-separator { display: flex; align-items: center; gap: 10px; color: var(--text-3); font-size: 12px; font-weight: 650; margin-top: 10px; }
    .shop-date-separator::after { content: ""; height: 1px; flex: 1; background: var(--border); }
    .shop-history-toolbar { display: grid; gap: 10px; margin-bottom: 14px; }
    .shop-history-list { display: grid; gap: 10px; }
    .shop-history-item {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 12px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #25262A;
    }
    .shop-history-thumb { width: 48px; height: 48px; border-radius: 13px; overflow: hidden; border: 1px solid var(--border); background: #1E1F22; display: grid; place-items: center; color: var(--text-3); }
    .shop-history-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .shop-history-title { font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .shop-history-meta { color: var(--text-3); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .shop-history-side { text-align: right; color: var(--text-3); font-size: 12px; line-height: 1.45; }

    .items-shell { display: grid; gap: 14px; }
    .items-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px auto; gap: 10px; align-items: center; }
    .items-list { display: grid; gap: 8px; }
    .dayz-item-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
      padding: 12px 14px;
      border-radius: 16px;
      background: #2B2D31;
      border: 1px solid var(--border);
      box-shadow: var(--shadow-sm);
      cursor: pointer;
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    .dayz-item-row:hover { background: #303238; border-color: var(--border-strong); transform: translateY(-1px); }
    .dayz-item-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 auto; }
    .dayz-item-image {
      width: 44px;
      height: 44px;
      border-radius: 13px;
      background: #25262A;
      border: 1px solid var(--border);
      overflow: hidden;
      display: grid;
      place-items: center;
      color: var(--text-3);
      flex: 0 0 auto;
      font-size: 17px;
    }
    .dayz-item-image img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dayz-item-copy { min-width: 0; display: grid; gap: 4px; }
    .dayz-item-title { color: var(--text); font-size: 14px; font-weight: 650; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dayz-item-subtitle { color: var(--text-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .switch { position: relative; width: 42px; height: 24px; flex: 0 0 auto; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: #4A4D55;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      transition: background .18s ease, border-color .18s ease;
    }
    .switch-slider::before {
      content: "";
      position: absolute;
      width: 18px;
      height: 18px;
      left: 2px;
      top: 2px;
      border-radius: 50%;
      background: #F2F3F5;
      transition: transform .18s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .switch input:checked + .switch-slider { background: var(--primary); border-color: rgba(88,101,242,.65); }
    .switch input:checked + .switch-slider::before { transform: translateX(18px); }
    .item-preview-card { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 14px; background: #25262A; border: 1px solid var(--border); }
    .item-preview-card .dayz-item-image { width: 52px; height: 52px; border-radius: 15px; }
    .items-empty { padding: 42px; text-align: center; color: var(--text-3); border: 1px dashed var(--border-strong); border-radius: 18px; background: #2B2D31; }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      place-items: center;
      background: rgba(0,0,0,.56);
      backdrop-filter: blur(6px);
      z-index: 100;
      padding: 22px;
    }
    .modal-backdrop.open { display: grid; }
    .modal {
      width: min(500px, 100%);
      background: #2B2D31;
      border: 1px solid var(--border-strong);
      border-radius: 18px;
      box-shadow: var(--shadow-md);
      padding: 20px;
      animation: modalIn .18s ease both;
    }
    @keyframes modalIn { from { opacity: 0; transform: scale(.985) translateY(6px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .modal h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.03em; }
    .modal p { color: var(--text-2); margin: 8px 0 18px; line-height: 1.5; }
    .form-grid { display: grid; gap: 12px; }
    label { display: grid; gap: 7px; color: var(--text-2); font-size: 13px; font-weight: 560; }
    .form-grid input, .form-grid textarea { padding: 12px; }
    .form-grid textarea { min-height: 92px; resize: vertical; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
    .toast {
      position: fixed;
      right: 22px;
      bottom: 22px;
      max-width: 380px;
      background: #313338;
      border: 1px solid var(--border-strong);
      color: var(--text);
      padding: 13px 15px;
      border-radius: 14px;
      box-shadow: var(--shadow-md);
      display: none;
      z-index: 120;
    }
    .toast.show { display: block; animation: fadeIn .18s ease both; }

    .member-card.selected {
      border-color: rgba(88,101,242,.55);
      background: #33353B;
    }
    .member-card { cursor: pointer; }
    .detail-drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(440px, 100vw);
      height: 100vh;
      background: #2B2D31;
      border-left: 1px solid var(--border-strong);
      box-shadow: -24px 0 64px rgba(0,0,0,.28);
      z-index: 80;
      transform: translateX(104%);
      transition: transform .22s ease;
      display: flex;
      flex-direction: column;
    }
    .detail-drawer.open { transform: translateX(0); }
    .drawer-header {
      padding: 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .drawer-profile {
      display: flex;
      gap: 12px;
      align-items: center;
      min-width: 0;
    }
    .drawer-title {
      font-size: 16px;
      font-weight: 670;
      letter-spacing: -.03em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .drawer-subtitle { color: var(--text-3); font-size: 12px; margin-top: 4px; }
    .drawer-body {
      padding: 18px;
      overflow: auto;
      display: grid;
      gap: 14px;
    }
    .drawer-card {
      background: #25262A;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
    }
    .drawer-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .drawer-stat {
      background: #2F3137;
      border: 1px solid var(--border);
      border-radius: 13px;
      padding: 11px;
      min-width: 0;
    }
    .drawer-stat span { display:block; color: var(--text-3); font-size: 11px; font-weight: 620; text-transform: uppercase; letter-spacing: .05em; }
    .drawer-stat b { display:block; margin-top: 7px; font-size: 14px; font-weight: 680; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .transaction-list { display: grid; gap: 8px; }
    .transaction-item {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      padding: 11px;
      border-radius: 13px;
      background: #2F3137;
      border: 1px solid var(--border);
    }
    .tx-icon {
      width: 28px;
      height: 28px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      font-size: 13px;
      background: rgba(88,101,242,.14);
      color: #C8CEFF;
    }
    .tx-icon.positive { background: rgba(35,165,90,.12); color: #B9F6CC; }
    .tx-icon.negative { background: rgba(242,63,67,.10); color: #FFB4B6; }
    .tx-title { font-weight: 650; font-size: 13px; letter-spacing: -.02em; }
    .tx-meta { color: var(--text-3); font-size: 12px; margin-top: 4px; line-height: 1.35; }
    .tx-amount { font-weight: 680; font-size: 13px; white-space: nowrap; }
    .tx-amount.positive { color: #B9F6CC; }
    .tx-amount.negative { color: #FFB4B6; }
    .drawer-empty {
      padding: 24px;
      text-align: center;
      color: var(--text-3);
      background: #2F3137;
      border: 1px dashed var(--border-strong);
      border-radius: 14px;
    }
    .drawer-skeleton {
      height: 74px;
      border-radius: 14px;
      background: linear-gradient(90deg, #2F3137, #383A41, #2F3137);
      background-size: 220% 100%;
      animation: shimmer 1.25s linear infinite;
      border: 1px solid var(--border);
    }

    @media (max-width: 1120px) {
      .metric-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .dashboard-grid { grid-template-columns: 1fr; }
      .member-card { grid-template-columns: 48px minmax(0, 1fr); }
      .member-economy, .actions { grid-column: 2; justify-content: flex-start; }
    }
    @media (max-width: 760px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .topbar { padding: 0 16px; }
      .global-search { display:none; }
      .content { padding: 18px; }
      .metric-grid, .members-toolbar, .members-stats { grid-template-columns: 1fr; }
    }


    /* Linear-inspired visual system -------------------------------------------------- */
    :root {
      --bg: #08090a;
      --bg-soft: #0b0c0e;
      --surface: #101114;
      --surface-2: #141519;
      --surface-3: #191b20;
      --surface-elevated: #17181d;
      --primary: #7c8cff;
      --primary-hover: #8b99ff;
      --primary-soft: rgba(124, 140, 255, .14);
      --text: #f3f4f6;
      --text-2: #a0a3ad;
      --text-3: #737782;
      --success: #5ade8d;
      --warning: #f3cc5a;
      --danger: #ff6b72;
      --border: rgba(255,255,255,.075);
      --border-strong: rgba(255,255,255,.13);
      --shadow-sm: 0 1px 0 rgba(255,255,255,.035) inset, 0 1px 2px rgba(0,0,0,.28);
      --shadow-md: 0 1px 0 rgba(255,255,255,.045) inset, 0 22px 70px rgba(0,0,0,.38);
      --radius: 10px;
      --radius-lg: 14px;
    }
    * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.18) transparent; }
    ::selection { background: rgba(124, 140, 255, .35); color: #fff; }
    body {
      background:
        radial-gradient(circle at 18% -10%, rgba(124,140,255,.12), transparent 32%),
        radial-gradient(circle at 82% 0%, rgba(92,214,138,.055), transparent 28%),
        var(--bg);
      color: var(--text);
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
      text-rendering: geometricPrecision;
    }
    .app { grid-template-columns: 248px minmax(0, 1fr); }
    .sidebar {
      background: rgba(8,9,10,.88);
      border-right: 1px solid var(--border);
      padding: 14px 10px;
      gap: 14px;
      backdrop-filter: blur(22px);
    }
    .brand {
      padding: 7px 8px 13px;
      gap: 10px;
      border-bottom-color: rgba(255,255,255,.06);
    }
    .logo {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(255,255,255,.075), rgba(255,255,255,.035));
      color: #dfe3ff;
      font-size: 0;
      box-shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 10px 30px rgba(0,0,0,.26);
    }
    .logo .icon { width: 18px; height: 18px; stroke-width: 1.9; }
    .brand-title { font-size: 13px; font-weight: 650; letter-spacing: -.018em; }
    .status { color: var(--text-3); font-size: 11px; }
    .dot { width: 6px; height: 6px; background: var(--success); box-shadow: 0 0 0 3px rgba(90,222,141,.09); }
    .nav-label { color: #696d78; font-size: 10px; letter-spacing: .13em; padding: 2px 10px; }
    .nav { gap: 2px; }
    .nav button {
      min-height: 34px;
      padding: 7px 10px;
      border-radius: 8px;
      color: #a6a9b3;
      font-size: 13px;
      font-weight: 520;
      letter-spacing: -.01em;
    }
    .nav button:hover { background: rgba(255,255,255,.045); color: #f1f2f5; }
    .nav button.active {
      background: rgba(255,255,255,.075);
      color: #fff;
      box-shadow: 0 1px 0 rgba(255,255,255,.045) inset;
    }
    .nav button.active::before { display: none; }
    .nav-icon, .icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      stroke: currentColor;
      stroke-width: 1.8;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .nav-icon { color: #777b86; }
    .nav button.active .nav-icon, .nav button:hover .nav-icon { color: var(--primary); }
    .sidebar-footer {
      padding: 12px 8px 4px;
      color: var(--text-2);
      border-top-color: rgba(255,255,255,.06);
    }
    .main { background: linear-gradient(180deg, rgba(255,255,255,.018), transparent 160px); }
    .topbar {
      height: 58px;
      padding: 0 22px;
      background: rgba(8,9,10,.78);
      border-bottom-color: var(--border);
      backdrop-filter: blur(18px);
    }
    .page-title { font-size: 15px; font-weight: 660; letter-spacing: -.018em; }
    .global-search { width: min(440px, 36vw); }
    .global-search input, .search input, select, .form-grid input, .form-grid textarea {
      background: rgba(255,255,255,.035);
      border-color: var(--border);
      border-radius: 9px;
      color: var(--text);
      box-shadow: 0 1px 0 rgba(255,255,255,.035) inset;
    }
    .global-search input, .search input, select { height: 34px; padding: 0 11px; }
    .form-grid input, .form-grid textarea { padding: 10px 11px; }
    .global-search input::placeholder, .search input::placeholder, textarea::placeholder { color: #686c76; }
    .global-search input:focus, .search input:focus, select:focus, .form-grid input:focus, .form-grid textarea:focus {
      border-color: rgba(124,140,255,.58);
      box-shadow: 0 0 0 3px rgba(124,140,255,.11), 0 1px 0 rgba(255,255,255,.045) inset;
      background: rgba(255,255,255,.055);
    }
    .content { padding: 22px; max-width: 1500px; }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.025));
      border-color: var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: 16px;
    }
    .card:hover { background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.032)); border-color: var(--border-strong); }
    .metric-grid { gap: 10px; }
    .metric-label { color: var(--text-3); font-size: 11px; letter-spacing: .065em; }
    .metric-value { margin-top: 10px; font-size: 25px; font-weight: 680; letter-spacing: -.055em; }
    .metric-hint { color: var(--text-3); font-size: 12px; }
    .dashboard-grid { gap: 10px; margin-top: 10px; }
    .section-title { margin-bottom: 13px; }
    .section-title h2 { font-size: 14px; font-weight: 650; letter-spacing: -.018em; }
    .chip {
      background: rgba(255,255,255,.055);
      border: 1px solid rgba(255,255,255,.075);
      color: #a8abb5;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 560;
      letter-spacing: -.005em;
    }
    .chip.success, .chip.online, .status-online { color: #9df2b8; background: rgba(90,222,141,.10); border-color: rgba(90,222,141,.18); }
    .chip.warning, .chip.pending { color: #f5db83; background: rgba(243,204,90,.10); border-color: rgba(243,204,90,.18); }
    .chip.danger, .chip.failed, .status-offline { color: #ffadb1; background: rgba(255,107,114,.10); border-color: rgba(255,107,114,.18); }
    .icon-btn, .primary-btn, .ghost-btn, .danger-btn, .mini-btn {
      height: 34px;
      border-radius: 9px;
      padding: 0 11px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      font-size: 12px;
      font-weight: 580;
      letter-spacing: -.005em;
      box-shadow: 0 1px 0 rgba(255,255,255,.035) inset;
    }
    .icon-btn, .ghost-btn, .mini-btn { background: rgba(255,255,255,.035); border: 1px solid var(--border); color: #d9dbe2; }
    .icon-btn:hover, .ghost-btn:hover, .mini-btn:hover { background: rgba(255,255,255,.07); border-color: var(--border-strong); transform: none; }
    .primary-btn {
      background: linear-gradient(180deg, var(--primary-hover), var(--primary));
      color: #ffffff;
      border: 1px solid rgba(255,255,255,.13);
    }
    .primary-btn:hover { filter: brightness(1.04); transform: none; }
    .danger-btn { background: rgba(255,107,114,.09); color: #ffb8bc; border: 1px solid rgba(255,107,114,.20); }
    .avatar {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: rgba(255,255,255,.055);
      border-color: var(--border);
      color: #e7e8ee;
      font-size: 11px;
    }
    .bar { background: linear-gradient(180deg, #9aa5ff, #6d7fff); border-radius: 6px 6px 2px 2px; }
    .setting-row, .drawer-card, .drawer-stat, .transaction-item {
      background: rgba(255,255,255,.032);
      border-color: var(--border);
      border-radius: 11px;
    }
    .members-stats, .members-toolbar { gap: 10px; }
    .member-card, .catalog-card, .catalog-category-card, .dayz-item-card, .shop-queue-item, .shop-history-item {
      background: rgba(255,255,255,.032);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow-sm);
      transition: background .14s ease, border-color .14s ease, transform .14s ease;
    }
    .member-card:hover, .catalog-card:hover, .catalog-category-card:hover, .dayz-item-card:hover, .shop-queue-item:hover, .shop-history-item:hover {
      background: rgba(255,255,255,.055);
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }
    .member-avatar-img, .member-avatar-fallback, .item-image, .catalog-item-image, .dayz-item-image, .shop-queue-thumb, .shop-history-thumb, .autocomplete-fallback {
      background: rgba(255,255,255,.04);
      border-color: var(--border);
      border-radius: 10px;
      color: #bfc4ff;
    }
    .entity-icon { width: 20px; height: 20px; color: #aeb6ff; }
    .catalog-shell, .items-shell, .shop-queue-shell { gap: 10px; }
    .catalog-grid { gap: 10px; }
    .catalog-category-grid { gap: 10px; }
    .catalog-breadcrumb, .member-meta, .dayz-item-subtitle, .catalog-description { color: var(--text-3); }
    .detail-drawer {
      background: rgba(13,14,17,.96);
      border-left-color: var(--border);
      box-shadow: -20px 0 70px rgba(0,0,0,.42);
      backdrop-filter: blur(18px);
    }
    .drawer-header { background: rgba(13,14,17,.82); border-bottom-color: var(--border); }
    .modal-backdrop { background: rgba(0,0,0,.58); backdrop-filter: blur(10px); }
    .modal {
      background: linear-gradient(180deg, #17181c, #121318);
      border: 1px solid var(--border-strong);
      border-radius: 16px;
      box-shadow: 0 28px 90px rgba(0,0,0,.55), 0 1px 0 rgba(255,255,255,.045) inset;
    }
    .modal h2 { font-size: 17px; letter-spacing: -.03em; }
    .toast {
      background: rgba(17,18,22,.96);
      border-color: var(--border-strong);
      color: #fff;
      border-radius: 12px;
      box-shadow: 0 18px 55px rgba(0,0,0,.36);
    }
    .skeleton, .drawer-skeleton {
      background: linear-gradient(90deg, rgba(255,255,255,.035), rgba(255,255,255,.075), rgba(255,255,255,.035));
      background-size: 220% 100%;
      border-color: var(--border);
    }
    .empty, .catalog-empty, .items-empty, .drawer-empty {
      background: rgba(255,255,255,.025);
      border-color: var(--border);
      color: var(--text-3);
      border-radius: 12px;
    }
    .presence-dot { border-color: #08090a; }
    .presence-dot.online { background: var(--success); }
    .tx-icon { background: rgba(124,140,255,.12); color: #cbd1ff; font-size: 0; }
    .tx-icon .icon { width: 15px; height: 15px; }
    .top-actions select { width: 132px; }

    /* Shop catalog and DayZ database cards use legacy class names in the markup. */
    .catalog-item,
    .dayz-item-row {
      background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.024));
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow-sm);
      transition: background .14s ease, border-color .14s ease, transform .14s ease, box-shadow .14s ease;
    }
    .catalog-item:hover,
    .dayz-item-row:hover {
      background: linear-gradient(180deg, rgba(255,255,255,.068), rgba(255,255,255,.034));
      border-color: var(--border-strong);
      transform: translateY(-1px);
      box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 10px 30px rgba(0,0,0,.22);
    }
    .catalog-item.dragging,
    .dayz-item-row.dragging {
      opacity: .62;
      transform: scale(.988);
      border-color: rgba(124,140,255,.48);
    }
    .catalog-thumb,
    .dayz-item-image {
      background: rgba(255,255,255,.04);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: #aeb6ff;
      box-shadow: 0 1px 0 rgba(255,255,255,.035) inset;
    }
    .catalog-thumb img,
    .dayz-item-image img { filter: saturate(.96) contrast(1.02); }
    .catalog-name,
    .dayz-item-title {
      color: var(--text);
      font-weight: 650;
      letter-spacing: -.02em;
    }
    .catalog-class,
    .dayz-item-subtitle {
      color: var(--text-3);
      font-size: 12px;
    }
    .catalog-class {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
      letter-spacing: -.015em;
    }
    .catalog-price {
      color: #f4f5ff;
      font-weight: 680;
      letter-spacing: -.025em;
    }
    .catalog-description { color: var(--text-3); }
    .catalog-meta { gap: 6px; }
    .catalog-actions { border-top: 1px solid rgba(255,255,255,.055); padding-top: 10px; }
    .catalog-item .drag-handle {
      background: rgba(255,255,255,.038);
      border-color: var(--border);
      color: var(--text-3);
      border-radius: 9px;
    }
    .catalog-item .drag-handle:hover {
      background: rgba(255,255,255,.07);
      border-color: var(--border-strong);
      color: var(--text);
    }
    .dayz-item-row { padding: 11px 12px; }
    .dayz-item-main { gap: 11px; }
    .dayz-item-copy { gap: 3px; }
    .items-list { gap: 8px; }
    .switch-slider {
      background: rgba(255,255,255,.12);
      border-color: var(--border);
      box-shadow: 0 1px 0 rgba(255,255,255,.035) inset;
    }
    .switch-slider::before { background: #e6e7eb; box-shadow: 0 2px 8px rgba(0,0,0,.34); }
    .switch input:checked + .switch-slider {
      background: linear-gradient(180deg, var(--primary-hover), var(--primary));
      border-color: rgba(124,140,255,.55);
    }
    .catalog-empty,
    .items-empty {
      background: rgba(255,255,255,.025);
      border-color: var(--border);
      color: var(--text-3);
      border-radius: 12px;
    }
    .item-preview-card {
      background: rgba(255,255,255,.032);
      border-color: var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow-sm);
    }
    @media (max-width: 760px) {
      .content { padding: 16px; }
    }


    /* Mobile responsive hardening -------------------------------------------------- */
    html, body { max-width: 100%; overflow-x: hidden; }
    img, svg, canvas { max-width: 100%; }
    .mobile-menu-btn { display: none; }
    .mobile-nav-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      background: rgba(0,0,0,.54);
      backdrop-filter: blur(8px);
      z-index: 74;
    }
    .mobile-nav-backdrop.open { display: block; }

    @media (max-width: 860px) {
      .app { display: block; min-height: 100vh; }
      body.nav-open { overflow: hidden; }
      .sidebar {
        position: fixed;
        inset: 0 auto 0 0;
        width: min(292px, calc(100vw - 48px));
        height: 100dvh;
        display: flex;
        z-index: 75;
        transform: translateX(calc(-100% - 16px));
        transition: transform .22s ease;
        box-shadow: 22px 0 60px rgba(0,0,0,.42);
      }
      .sidebar.open { transform: translateX(0); }
      .mobile-menu-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        min-width: 38px;
        padding: 0;
      }
      .main { width: 100%; min-width: 0; }
      .topbar {
        min-height: 58px;
        height: auto;
        padding: 10px 12px;
        gap: 10px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
      }
      .page-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 16px;
      }
      .top-actions {
        gap: 7px;
        justify-content: flex-end;
        min-width: 0;
      }
      .top-actions select { display: none; }
      .top-actions .avatar { display: none; }
      #refreshButton {
        width: 38px;
        min-width: 38px;
        padding: 0;
        display: inline-grid;
        place-items: center;
      }
      #refreshButton span { display: none; }
      .global-search { display: none; }
      .content { padding: 14px 12px 22px; width: 100%; max-width: 100%; overflow-x: hidden; }
      .view { min-width: 0; }

      .metric-grid,
      .catalog-stats,
      .members-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
      .dashboard-grid,
      .catalog-toolbar,
      .items-toolbar,
      .members-toolbar,
      .shop-history-toolbar { grid-template-columns: 1fr; gap: 10px; }
      .card { padding: 13px; border-radius: 12px; min-width: 0; }
      .metric-label { font-size: 10px; letter-spacing: .06em; }
      .metric-value { font-size: 20px; margin-top: 8px; }
      .metric-hint { font-size: 11px; margin-top: 7px; }
      .section-title { align-items: flex-start; flex-wrap: wrap; gap: 8px; }
      .section-title h2 { font-size: 14px; }
      .chart { height: 168px; gap: 5px; overflow: hidden; }
      .bar-label { font-size: 9px; }

      .members-toolbar select,
      .items-toolbar select,
      .catalog-toolbar select,
      .search input,
      select { width: 100%; min-width: 0; }
      .member-card {
        grid-template-columns: 44px minmax(0, 1fr);
        gap: 11px;
        padding: 12px;
        border-radius: 12px;
      }
      .member-avatar-wrap,
      .member-avatar-img,
      .member-avatar-fallback { width: 42px; height: 42px; border-radius: 12px; }
      .member-card > * { min-width: 0; }
      .member-economy,
      .actions { grid-column: 1 / -1; justify-content: flex-start; }
      .actions { gap: 6px; }
      .mini-btn { height: 31px; padding: 0 9px; font-size: 12px; }

      .catalog-category-grid,
      .catalog-grid { grid-template-columns: 1fr; gap: 10px; }
      .catalog-category-card { min-height: 118px; padding: 14px; border-radius: 13px; }
      .catalog-item { padding: 12px; min-width: 0; }
      .catalog-item-top { grid-template-columns: 42px minmax(0, 1fr); gap: 10px; padding-right: 32px; }
      .catalog-item-top > :last-child { grid-column: 1 / -1; justify-self: start; }
      .catalog-thumb { width: 42px; height: 42px; border-radius: 10px; }
      .catalog-name,
      .catalog-class,
      .catalog-description,
      .shop-queue-title,
      .shop-queue-subtitle,
      .shop-history-title,
      .shop-history-meta { white-space: normal; overflow-wrap: anywhere; }
      .catalog-meta,
      .catalog-actions { flex-wrap: wrap; }
      .catalog-actions { gap: 7px; }
      .catalog-actions .ghost-btn,
      .catalog-actions .danger-btn { flex: 1 1 132px; padding: 0 10px; }

      .shop-queue-order,
      .shop-history-item {
        grid-template-columns: 42px minmax(0, 1fr);
        gap: 10px;
        padding: 11px;
        border-radius: 12px;
      }
      .shop-queue-thumb,
      .shop-history-thumb { width: 42px; height: 42px; border-radius: 10px; }
      .shop-queue-meta,
      .shop-history-side { grid-column: 1 / -1; text-align: left; }
      .shop-history-toolbar .section-title { margin-bottom: 0; }

      .dayz-item-row {
        align-items: flex-start;
        gap: 10px;
        padding: 11px;
        border-radius: 12px;
      }
      .dayz-item-main { min-width: 0; gap: 10px; }
      .dayz-item-image { width: 40px; height: 40px; border-radius: 10px; }
      .dayz-item-copy { min-width: 0; }
      .dayz-item-title,
      .dayz-item-subtitle { white-space: normal; overflow-wrap: anywhere; }
      .switch { width: 40px; height: 24px; margin-top: 7px; }

      .drawer-stats { grid-template-columns: 1fr; }
      .detail-drawer {
        width: 100vw;
        max-width: 100vw;
        height: 100dvh;
        border-left: 0;
      }
      .drawer-header { padding: 14px 12px; align-items: center; }
      .drawer-body { padding: 12px; gap: 10px; }
      .drawer-card,
      .drawer-stat,
      .transaction-item { border-radius: 12px; }
      .transaction-item { grid-template-columns: 28px minmax(0, 1fr); }
      .tx-amount { grid-column: 2; white-space: normal; }

      .modal-backdrop { padding: 10px; align-items: end; place-items: end stretch; }
      .modal {
        width: 100%;
        max-height: calc(100dvh - 20px);
        overflow: auto;
        border-radius: 16px;
        padding: 16px;
      }
      .modal-actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .modal-actions .ghost-btn,
      .modal-actions .primary-btn,
      .modal-actions .danger-btn { width: 100%; }
      .toast {
        left: 12px;
        right: 12px;
        bottom: 12px;
        max-width: none;
      }
    }

    @media (max-width: 430px) {
      .metric-grid,
      .catalog-stats,
      .members-stats { grid-template-columns: 1fr; }
      .content { padding-left: 10px; padding-right: 10px; }
      .topbar { padding-left: 10px; padding-right: 10px; }
      .catalog-item-top { grid-template-columns: 38px minmax(0, 1fr); }
      .catalog-thumb,
      .shop-queue-thumb,
      .shop-history-thumb { width: 38px; height: 38px; }
      .dayz-item-image { width: 38px; height: 38px; }
      .chip { max-width: 100%; overflow-wrap: anywhere; }
      .ghost-btn, .primary-btn, .danger-btn, .icon-btn { border-radius: 10px; }
    }


    .map-events-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr); gap: 14px; align-items: start; }
    .preset-grid { display: grid; gap: 10px; }
    .preset-card { display: grid; grid-template-columns: 74px minmax(0,1fr); gap: 12px; align-items: center; text-align: left; padding: 13px; border-radius: 14px; background: rgba(255,255,255,.03); border: 1px solid var(--border); cursor: pointer; transition: background .14s ease, border-color .14s ease, transform .14s ease; }
    .preset-card:hover { background: rgba(255,255,255,.05); border-color: var(--border-strong); transform: translateY(-1px); }
    .preset-card.active { border-color: rgba(124,140,255,.55); background: rgba(124,140,255,.12); }
    .preset-card-image { width: 74px; height: 74px; border-radius: 14px; display: grid; place-items: center; overflow: hidden; background: rgba(255,255,255,.045); border: 1px solid var(--border); }
    .preset-card-image img { width: 100%; height: 100%; object-fit: contain; padding: 7px; display: block; }
    .preset-card-body { min-width: 0; display: grid; gap: 7px; }
    .preset-card b { font-size: 14px; }
    .preset-card p { margin: 0; color: var(--text-3); font-size: 12px; line-height: 1.45; }
    .preset-children { display: flex; flex-wrap: wrap; gap: 6px; }
    .field-hint { display: block; margin-top: 6px; color: var(--text-3); font-size: 11px; line-height: 1.35; }
    .map-picker { grid-column: 1 / -1; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: rgba(255,255,255,.025); }
    .map-picker-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; }
    .map-picker-actions { display: flex; align-items: center; gap: 6px; }
    .map-picker-actions button { min-width: 34px; height: 30px; padding: 0 10px; border-radius: 10px; }
    .map-picker-viewport { width: 100%; aspect-ratio: 1 / 1; overflow: hidden; background: #10131b; cursor: crosshair; position: relative; overscroll-behavior: contain; scroll-behavior: auto; }
    .map-picker-viewport.zoomed { overflow: auto; cursor: crosshair; }
    .map-picker-viewport.dragging { cursor: grabbing; user-select: none; }
    .map-picker-inner { position: relative; width: calc(100% * var(--map-zoom, 1)); min-width: 0; aspect-ratio: 1 / 1; }
    .map-picker-inner img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; display: block; user-select: none; -webkit-user-drag: none; }
    .map-picker-pin { position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 999px; transform: translate(-50%, -50%); background: #ff5b6e; border: 3px solid #fff; box-shadow: 0 0 0 5px rgba(255,91,110,.22), 0 8px 30px rgba(0,0,0,.45); pointer-events: none; display: none; }
    .map-picker-pin::after { content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; border-radius: 999px; background: #fff; transform: translate(-50%, -50%); }
    .map-picker-footer { padding: 10px 12px; border-top: 1px solid var(--border); color: var(--text-3); font-size: 11px; line-height: 1.35; }

    .spawn-zones-shell { display: grid; gap: 14px; }
    .segmented-control { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: 14px; background: rgba(255,255,255,.035); }
    .segmented-control button { min-height: 34px; padding: 0 14px; border-radius: 10px; color: var(--text-2); background: transparent; cursor: pointer; font-weight: 650; font-size: 12px; }
    .segmented-control button.active { color: #fff; background: var(--primary); }
    .spawn-zone-tab { display: none; }
    .spawn-zone-tab.active { display: block; }
    .spawn-zones-editor { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 14px; align-items: start; }
    .spawn-zone-map-card { padding: 0; overflow: hidden; }
    .spawn-zone-map-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .spawn-zone-map-actions { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .spawn-zone-map-actions .ghost-btn { height: 28px; min-width: 32px; padding: 0 8px; border-radius: 9px; }
    .spawn-zone-map-title { display: grid; gap: 2px; min-width: 0; }
    .spawn-zone-map-title b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spawn-zone-map-title span { color: var(--text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spawn-zone-map-viewport { width: 100%; aspect-ratio: 1 / 1; overflow: auto; background: #10131b; cursor: crosshair; position: relative; overscroll-behavior: contain; scrollbar-width: thin; }
    .spawn-zone-map-viewport.is-dragging { cursor: grabbing; }
    .spawn-zone-map-inner { position: relative; width: calc(100% * var(--spawn-map-zoom, 1)); min-width: 100%; aspect-ratio: 1 / 1; transform-origin: top left; overflow: hidden; }
    .spawn-zone-map-inner > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; display: block; user-select: none; -webkit-user-drag: none; }
    .spawn-zone-map-tile-layer { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
    .spawn-zone-map-tile { position: absolute; display: block; width: auto; height: auto; object-fit: cover; user-select: none; -webkit-user-drag: none; }
    .spawn-zone-marker { position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 999px; border: 3px solid #fff; box-shadow: 0 0 0 5px rgba(255,255,255,.12), 0 8px 30px rgba(0,0,0,.45); transform: translate(-50%, -50%); cursor: pointer; z-index: 3; }
    .spawn-zone-marker.other { opacity: 1; width: 19px; height: 19px; border-width: 2px; box-shadow: 0 0 0 4px rgba(255,255,255,.10), 0 6px 20px rgba(0,0,0,.35); }
    .spawn-zone-marker.disabled { filter: grayscale(.8); opacity: .68; }
    .spawn-zone-marker.highlight { width: 28px; height: 28px; box-shadow: 0 0 0 8px rgba(255,255,255,.16), 0 10px 34px rgba(0,0,0,.5); z-index: 4; opacity: 1; filter: none; }
    .spawn-zone-marker::after { content: ''; position: absolute; inset: 5px; border-radius: 999px; background: rgba(255,255,255,.92); }
    .spawn-zone-map-footer { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--border); color: var(--text-3); font-size: 11px; }
    .spawn-zone-map-footer span:last-child { display: none; }
    .spawn-zone-sidebar { display: grid; gap: 10px; }
    .spawn-zone-create { width: 100%; height: 46px; border-radius: 14px; font-size: 14px; }
    .spawn-zone-list { display: grid; gap: 8px; max-height: 70vh; overflow: auto; padding-right: 3px; }
    .spawn-zone-card { border: 1px solid var(--border); border-radius: 14px; background: rgba(255,255,255,.025); overflow: hidden; }
    .spawn-zone-card.selected { border-color: rgba(88,101,242,.78); background: rgba(88,101,242,.08); }
    .spawn-zone-card-header { display: grid; grid-template-columns: 18px 1fr auto auto; cursor: pointer; align-items: center; gap: 8px; padding: 10px 12px; }
    .spawn-zone-color { width: 14px; height: 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,.42); }
    .spawn-zone-name-label { min-width: 0; font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spawn-zone-name-input { width: 100%; border: 1px solid rgba(255,255,255,.16); background: rgba(0,0,0,.22); color: var(--text); outline: none; font-weight: 700; font-size: 14px; min-width: 0; border-radius: 9px; height: 30px; padding: 0 8px; }
    .spawn-zone-edit-name { width: 28px; height: 28px; min-width: 28px; padding: 0; border-radius: 9px; display: inline-grid; place-items: center; }
    .spawn-zone-count { color: var(--text-3); font-weight: 700; font-variant-numeric: tabular-nums; }
    .spawn-zone-actions { display: flex; align-items: center; gap: 6px; }
    .spawn-zone-mini-btn { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: rgba(255,255,255,.04); color: var(--text-2); cursor: pointer; border: 1px solid var(--border); }
    .spawn-zone-mini-btn:hover { background: rgba(255,255,255,.08); color: var(--text); }
    .spawn-zone-card:not(:hover) .spawn-zone-actions .spawn-zone-mini-btn { opacity: .55; }
    .spawn-zone-points { display: none; padding: 0 12px 12px 42px; gap: 5px; }
    .spawn-zone-card.selected .spawn-zone-points { display: grid; }
    .spawn-zone-point-row { display: grid; grid-template-columns: 1fr 28px; align-items: center; gap: 6px; color: var(--text-3); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .spawn-zone-point-row button:first-child { text-align: left; color: inherit; background: transparent; cursor: pointer; padding: 5px 0; border-radius: 8px; }
    .spawn-zone-point-row button:first-child:hover { color: var(--text); }
        .spawn-zone-empty { border: 1px dashed var(--border); border-radius: 14px; padding: 16px; color: var(--text-3); background: rgba(255,255,255,.025); font-size: 13px; }
    .spawn-zone-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .spawn-zone-poll-result { display: grid; gap: 8px; margin-top: 12px; }
    .spawn-zone-poll-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; padding: 9px 10px; border: 1px solid var(--border); border-radius: 11px; background: rgba(255,255,255,.025); }
    .spawn-zone-poll-row b { font-size: 13px; }
    .spawn-zone-poll-row span { color: var(--text-3); font-size: 12px; }
    .spawn-zone-rotation-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); gap: 14px; margin-top: 14px; align-items: start; }
    .spawn-zone-control-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .spawn-zone-control-row select { flex: 1; min-width: 180px; height: 40px; border-radius: 12px; border: 1px solid var(--border); background: rgba(255,255,255,.04); color: var(--text); padding: 0 10px; }
    .spawn-zone-history-list { display: grid; gap: 8px; }
    .spawn-zone-history-item { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,.025); }
    .spawn-zone-history-item b { display: block; font-size: 13px; }
    .spawn-zone-setting-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .spawn-zone-settings-card { display: grid; gap: 14px; }
    .spawn-zone-settings-card .form-grid { gap: 12px; }
    .spawn-zone-setting-help { color: var(--text-3); font-size: 12px; line-height: 1.45; margin-top: -4px; }
    .spawn-zone-setting-help strong { color: var(--text-2); }
    .spawn-zone-settings-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .spawn-zone-settings-status { color: var(--text-3); font-size: 12px; }
    .spawn-zone-settings-status.saving { color: #93c5fd; }
    .spawn-zone-settings-status.saved { color: #86efac; }
    .spawn-zone-settings-status.error { color: #fca5a5; }
    .spawn-zone-switch-row { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; padding: 12px; border: 1px solid var(--border); border-radius: 14px; background: rgba(255,255,255,.025); }
    .spawn-zone-switch-row b { display: block; font-size: 13px; color: var(--text); margin-bottom: 4px; }
    .spawn-zone-switch-row span { display: block; font-size: 12px; color: var(--text-3); line-height: 1.35; }
    .spawn-zone-switch-row.disabled { opacity: .55; }
    .spawn-zone-setting-stack { display: grid; gap: 10px; }
    .spawn-zone-settings-divider { height: 1px; background: var(--border); margin: 2px 0; }
    @media (max-width: 1100px) { .spawn-zones-editor, .spawn-zone-rotation-grid { grid-template-columns: 1fr; } .spawn-zone-list { max-height: none; } }

    .map-event-status { display: grid; gap: 10px; }
    .map-event-result { padding: 12px; border-radius: 12px; background: rgba(255,255,255,.025); border: 1px solid var(--border); color: var(--text-2); overflow-wrap: anywhere; }
    .map-event-result b { color: var(--text); }

    .event-builder { display: grid; gap: 14px; }
    .event-builder-layout { display: grid; gap: 14px; }
    .event-builder-step { border: 1px solid var(--border); border-radius: 16px; padding: 14px; background: rgba(255,255,255,.025); }
    .step-kicker { color: var(--text-3); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; }
    .event-type-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .event-type-card { text-align: left; border-radius: 14px; border: 1px solid var(--border); background: rgba(255,255,255,.035); color: var(--text); padding: 14px; cursor: pointer; display: grid; gap: 6px; }
    .event-type-card b { font-size: 14px; }
    .event-type-card span { color: var(--text-3); font-size: 12px; line-height: 1.35; }
    .event-type-card.active { border-color: rgba(124,140,255,.55); background: rgba(124,140,255,.12); }
    .event-type-card.disabled { opacity: .55; cursor: not-allowed; }
    .event-subtype-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .schedule-mode-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .schedule-mode { display: inline-flex; align-items: center; gap: 8px; padding: 10px 13px; border-radius: 999px; border: 1px solid var(--border); background: rgba(255,255,255,.035); color: var(--text-2); cursor: pointer; font-size: 13px; font-weight: 700; }
    .schedule-mode input { accent-color: #7c8cff; }
    .schedule-mode.active { border-color: rgba(124,140,255,.55); background: rgba(124,140,255,.12); color: var(--text); }
    .event-dashboard-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .event-kpi { padding: 14px; }
    .event-kpi span { display: block; color: var(--text-3); font-size: 12px; margin-bottom: 8px; }
    .event-kpi b { display: block; font-size: 20px; letter-spacing: -.03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .scheduled-events-list { display: grid; gap: 10px; margin-top: 14px; }
    .scheduled-event-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 14px; border-radius: 14px; border: 1px solid var(--border); background: rgba(255,255,255,.03); }
    .scheduled-event-main { min-width: 0; display: grid; gap: 6px; }
    .scheduled-event-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 800; }
    .scheduled-event-meta { color: var(--text-3); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
    .scheduled-event-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .status-chip { border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 800; background: rgba(255,255,255,.06); color: var(--text-2); border: 1px solid var(--border); }
    .status-chip.active, .status-chip.scheduled { color: #8befad; border-color: rgba(91,214,138,.25); background: rgba(91,214,138,.10); }
    .status-chip.failed { color: #ff9a9f; border-color: rgba(255,107,114,.28); background: rgba(255,107,114,.10); }
    .status-chip.paused { color: #f2d27c; border-color: rgba(242,210,124,.28); background: rgba(242,210,124,.10); }
    @media (max-width: 760px) { .event-type-grid, .event-subtype-grid, .event-dashboard-grid { grid-template-columns: 1fr; } .scheduled-event-card { grid-template-columns: 1fr; } .scheduled-event-actions { justify-content: flex-start; } }
    @media (max-width: 920px) { .map-events-grid { grid-template-columns: 1fr; } }
    @media (max-width: 520px) { .preset-card { grid-template-columns: 58px minmax(0,1fr); } .preset-card-image { width: 58px; height: 58px; } }


    .overview-hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      margin-bottom: 14px;
      background: radial-gradient(circle at 16% 0%, rgba(124,140,255,.12), transparent 32%), linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.024));
    }
    .overview-hero h1 { margin: 0; font-size: 22px; line-height: 1.1; letter-spacing: -.045em; }
    .overview-hero p { margin: 8px 0 0; color: var(--text-2); font-size: 13px; }
    .overview-hero-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .inline-dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; display: inline-block; margin-right: 6px; box-shadow: 0 0 16px currentColor; }
    .operation-kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); margin-bottom: 14px; }
    .kpi-card { display: flex; align-items: flex-start; gap: 14px; min-height: 126px; }
    .kpi-icon, .ops-icon {
      width: 38px;
      height: 38px;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #dfe3ff;
      background: rgba(124,140,255,.14);
      border: 1px solid rgba(124,140,255,.18);
      flex: 0 0 auto;
    }
    .kpi-icon .icon, .ops-icon .icon { width: 20px; height: 20px; }
    .kpi-purple { background: rgba(124,92,255,.14); border-color: rgba(124,92,255,.20); color: #a89dff; }
    .kpi-red { background: rgba(255,107,114,.12); border-color: rgba(255,107,114,.18); color: #ff9a9f; }
    .kpi-orange { background: rgba(255,168,84,.12); border-color: rgba(255,168,84,.18); color: #ffb56c; }
    .kpi-green { background: rgba(91,214,138,.12); border-color: rgba(91,214,138,.18); color: #8befad; }
    .kpi-blue { background: rgba(76,169,255,.12); border-color: rgba(76,169,255,.18); color: #8bc9ff; }
    .operation-charts-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
    .operation-card { padding: 20px; }
    .section-subtitle { color: var(--text-3); font-size: 12px; margin-top: 5px; font-weight: 450; }
    .horizontal-bars { display: grid; gap: 12px; }
    .hbar-row { display: grid; grid-template-columns: 52px minmax(0, 1fr) 58px; gap: 12px; align-items: center; min-height: 26px; }
    .hbar-label { color: var(--text); font-weight: 600; font-size: 13px; white-space: nowrap; }
    .hbar-track { height: 20px; border-radius: 7px; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.045); overflow: hidden; box-shadow: 0 1px 0 rgba(255,255,255,.03) inset; }
    .hbar-fill { height: 100%; width: 0%; border-radius: 7px; background: linear-gradient(90deg, #6571f5, #8892ff); box-shadow: 0 0 24px rgba(124,140,255,.18); transition: width .35s ease; }
    .hbar-value { text-align: right; color: var(--text); font-weight: 650; font-size: 13px; font-variant-numeric: tabular-nums; }
    .hbar-meta { color: var(--text-3); font-size: 11px; }
    .insight-row { margin-top: 16px; padding: 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.06); background: rgba(255,255,255,.035); color: var(--text-2); font-size: 13px; display: flex; gap: 9px; align-items: center; }
    .insight-row:empty { display: none; }
    .insight-row .icon { width: 16px; height: 16px; color: #ffd66e; }
    .operations-summary-card { margin-top: 0; }
    .ops-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
    .ops-card { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; align-items: center; padding: 12px; border-radius: 13px; background: rgba(255,255,255,.035); border: 1px solid var(--border); min-width: 0; }
    .ops-card b { font-size: 13px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ops-card small { grid-column: 1 / -1; color: var(--text-3); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status-line { display: block; color: var(--text-3); font-size: 12px; margin-top: 4px; }
    .status-line.success { color: #7be99f; }
    .status-line.warning { color: #f2d27c; }
    .status-line.danger { color: #ff9da3; }
    .alerts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
    .alert-pill { min-height: 42px; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: rgba(242,204,90,.10); color: #f7dfa0; border: 1px solid rgba(242,204,90,.16); }
    .alert-pill.success { background: rgba(91,214,138,.10); color: #aaf2c0; border-color: rgba(91,214,138,.16); }
    .alert-pill .icon { width: 17px; height: 17px; }

    .player-map-shell { display:grid; gap:14px; }
    .player-map-layout { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr); gap:14px; align-items:start; }
    .player-map-card { padding:0; overflow:hidden; }
    .player-map-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px; border-bottom:1px solid var(--border); }
    .player-map-toolbar-copy { min-width:0; }
    .player-map-toolbar-copy b { display:block; font-size:14px; }
    .player-map-toolbar-copy span { color:var(--text-3); font-size:11px; }
    .player-map-actions { display:flex; gap:7px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .player-map-viewport { width:100%; aspect-ratio:1 / 1; overflow:auto; background:#10131b; position:relative; overscroll-behavior:contain; scrollbar-width:thin; }
    .player-map-inner { position:relative; width:calc(100% * var(--player-map-zoom, 1)); min-width:100%; aspect-ratio:1 / 1; overflow:hidden; }
    .player-map-inner > img { position:absolute; inset:0; width:100%; height:100%; object-fit:fill; display:block; user-select:none; -webkit-user-drag:none; }
    .player-map-marker-layer { position:absolute; inset:0; z-index:3; pointer-events:none; }
    .player-map-marker { position:absolute; transform:translate(-50%,-50%); display:flex; align-items:center; gap:5px; pointer-events:auto; }
    .player-map-dot { width:12px; height:12px; border-radius:999px; background:#5be58a; border:2px solid #fff; box-shadow:0 0 0 4px rgba(91,229,138,.18),0 5px 18px rgba(0,0,0,.45); flex:none; }
    .player-map-marker.stale .player-map-dot { background:#f2c45a; box-shadow:0 0 0 4px rgba(242,196,90,.18),0 5px 18px rgba(0,0,0,.45); }
    .player-map-marker.old .player-map-dot { background:#f27d86; box-shadow:0 0 0 4px rgba(242,125,134,.18),0 5px 18px rgba(0,0,0,.45); }
    .player-map-label { max-width:160px; padding:4px 7px; border-radius:8px; background:rgba(13,16,24,.88); border:1px solid rgba(255,255,255,.12); color:#fff; font-size:11px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; backdrop-filter:blur(4px); }
    .player-map-footer { display:flex; justify-content:space-between; gap:10px; padding:9px 12px; border-top:1px solid var(--border); color:var(--text-3); font-size:11px; }
    .player-map-side { display:grid; gap:12px; }
    .player-map-search { width:100%; }
    .player-map-list { display:grid; gap:7px; max-height:620px; overflow:auto; padding-right:2px; }
    .player-map-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:10px; border:1px solid var(--border); border-radius:11px; background:rgba(255,255,255,.025); }
    .player-map-row b { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .player-map-row small { color:var(--text-3); font-size:10px; display:block; margin-top:3px; }
    .player-map-row-coords { font-size:11px; color:var(--text-2); font-variant-numeric:tabular-nums; text-align:right; }
    .player-map-empty { padding:18px; border:1px dashed var(--border); border-radius:11px; color:var(--text-3); font-size:12px; text-align:center; }
    @media (max-width: 980px) { .player-map-layout { grid-template-columns:1fr; } .player-map-list { max-height:320px; } }

    @media (max-width: 1180px) { .operation-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .operation-charts-grid, .alerts-row { grid-template-columns: 1fr; } .ops-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 720px) { .overview-hero { flex-direction: column; } .operation-kpis, .ops-grid { grid-template-columns: 1fr; } .hbar-row { grid-template-columns: 44px minmax(0, 1fr) 48px; gap: 8px; } .operation-card { padding: 14px; } }

  </style>
</head>
<body>

  <svg aria-hidden="true" width="0" height="0" style="position:absolute;overflow:hidden">
    <symbol id="icon-cube" viewBox="0 0 24 24"><path d="M12 2.75 20 7.25v9.5l-8 4.5-8-4.5v-9.5l8-4.5Z"/><path d="M4.5 7.5 12 12l7.5-4.5"/><path d="M12 12v8.5"/></symbol>
    <symbol id="icon-house" viewBox="0 0 24 24"><path d="M3.5 11.25 12 4l8.5 7.25"/><path d="M5.5 10.25v9.25h13v-9.25"/><path d="M9.5 19.5v-5h5v5"/></symbol>
    <symbol id="icon-users" viewBox="0 0 24 24"><path d="M15.5 19.25c-.85-2.1-2.1-3.25-5.5-3.25s-4.65 1.15-5.5 3.25"/><path d="M10 12.25a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z"/><path d="M19.5 18.75c-.55-1.55-1.5-2.45-3.75-2.75"/><path d="M15.25 5.25a3.25 3.25 0 0 1 0 6.25"/></symbol>
    <symbol id="icon-shopping-cart" viewBox="0 0 24 24"><path d="M3.5 5h2.2l1.8 10.25h10.75L20.5 8H7"/><path d="M9 20a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 9 20Z"/><path d="M17 20a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 17 20Z"/></symbol>
    <symbol id="icon-package" viewBox="0 0 24 24"><path d="M4 7.25 12 3l8 4.25v9.5L12 21l-8-4.25v-9.5Z"/><path d="M4.5 7.5 12 11.75 19.5 7.5"/><path d="M12 11.75V21"/><path d="M8 5.25 16 9.5"/></symbol>
    <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-13.65 5.65"/><path d="M4 12A8 8 0 0 1 17.65 6.35"/><path d="M17.75 3.75v3h-3"/><path d="M6.25 20.25v-3h3"/></symbol>
    <symbol id="icon-clock" viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"/><path d="M12 7.5v5l3.25 2"/></symbol>
    <symbol id="icon-coins" viewBox="0 0 24 24"><path d="M12 7c4.15 0 7.5-1.12 7.5-2.5S16.15 2 12 2 4.5 3.12 4.5 4.5 7.85 7 12 7Z"/><path d="M4.5 4.5v5c0 1.38 3.35 2.5 7.5 2.5s7.5-1.12 7.5-2.5v-5"/><path d="M4.5 9.5v5c0 1.38 3.35 2.5 7.5 2.5s7.5-1.12 7.5-2.5v-5"/><path d="M4.5 14.5v5c0 1.38 3.35 2.5 7.5 2.5s7.5-1.12 7.5-2.5v-5"/></symbol>
    <symbol id="icon-database" viewBox="0 0 24 24"><path d="M12 7c4.15 0 7.5-1.12 7.5-2.5S16.15 2 12 2 4.5 3.12 4.5 4.5 7.85 7 12 7Z"/><path d="M4.5 4.5v6c0 1.38 3.35 2.5 7.5 2.5s7.5-1.12 7.5-2.5v-6"/><path d="M4.5 10.5v6c0 1.38 3.35 2.5 7.5 2.5s7.5-1.12 7.5-2.5v-6"/></symbol>
    <symbol id="icon-arrow-left" viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/><path d="M8.5 12H21"/></symbol>
    <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></symbol>
    <symbol id="icon-check" viewBox="0 0 24 24"><path d="m5 12.5 4.25 4.25L19.5 6.5"/></symbol>
    <symbol id="icon-warning" viewBox="0 0 24 24"><path d="M12 3.25 21 19H3l9-15.75Z"/><path d="M12 8.5v5"/><path d="M12 17.25h.01"/></symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></symbol>
  </svg>

  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo"><svg class="icon"><use href="#icon-cube"></use></svg></div>
        <div style="min-width:0">
          <div id="serverName" class="brand-title">DayZ Server</div>
          <div class="status"><span class="dot"></span><span>Online</span></div>
        </div>
      </div>
      <div class="nav-label">Navegação</div>
      <nav class="nav">
        <button class="active" data-view="general"><svg class="nav-icon"><use href="#icon-house"></use></svg><span>Geral</span></button>
        <button data-view="members"><svg class="nav-icon"><use href="#icon-users"></use></svg><span>Membros</span></button>
        <button data-view="catalog"><svg class="nav-icon"><use href="#icon-shopping-cart"></use></svg><span>Shop</span></button>
        <button data-view="items"><svg class="nav-icon"><use href="#icon-package"></use></svg><span>Itens</span></button>
        <button data-view="map-events"><svg class="nav-icon"><use href="#icon-clock"></use></svg><span>Eventos do Mapa</span></button>
        <button data-view="spawn-zones"><svg class="nav-icon"><use href="#icon-clock"></use></svg><span>Spawn Zones</span></button>
        <button data-view="player-map"><svg class="nav-icon"><use href="#icon-users"></use></svg><span>Player Map</span></button>
        <button data-view="settings"><svg class="nav-icon"><use href="#icon-database"></use></svg><span>Settings</span></button>
      </nav>
      <div class="sidebar-footer"><div class="avatar">A</div><div class="sidebar-footer-user"><b>Admin</b><div class="member-meta">Painel seguro</div></div><form class="logout-form" method="post" action="/admin-panel/auth/logout"><button class="logout-button" type="submit">Sair</button></form></div>
    </aside>
    <div id="mobileNavBackdrop" class="mobile-nav-backdrop" aria-hidden="true"></div>
    <section class="main">
      <header class="topbar">
        <button class="mobile-menu-btn icon-btn" id="mobileMenuButton" aria-label="Abrir menu" type="button"><svg class="icon"><use href="#icon-menu"></use></svg></button>
        <div class="page-title" id="pageTitle">Geral</div>
        <div class="global-search"><input id="globalSearch" placeholder="Buscar membros, gamertags ou Discord ID..." /></div>
        <div class="top-actions">
          <select id="languageSelect" aria-label="Idioma"><option value="pt-BR">Português</option><option value="en-US">English</option></select>
          <button class="icon-btn" id="refreshButton"><svg class="icon"><use href="#icon-refresh"></use></svg><span>Atualizar</span></button>
          <div class="avatar">PZ</div>
        </div>
      </header>
      <main class="content">
        <section id="view-general" class="view active">
          <div class="overview-hero card">
            <div>
              <h1>Visão geral do servidor</h1>
              <p>Acompanhe desempenho, atividade e operação do servidor em tempo real.</p>
            </div>
            <div class="overview-hero-actions">
              <span class="chip success"><span class="inline-dot"></span>Dados reais</span>
              <span class="chip" id="overviewUpdatedAt">Atualizando...</span>
            </div>
          </div>

          <div class="metric-grid operation-kpis">
            <div class="card kpi-card"><div class="kpi-icon kpi-purple"><svg class="icon"><use href="#icon-users"></use></svg></div><div><div class="metric-label">Online agora</div><div class="metric-value" id="metricOnline">—</div><div class="metric-hint" id="metricOnlineHint">Capacidade do servidor</div></div></div>
            <div class="card kpi-card"><div class="kpi-icon kpi-blue"><svg class="icon"><use href="#icon-database"></use></svg></div><div><div class="metric-label">Total de players</div><div class="metric-value" id="metricTotalPlayers">—</div><div class="metric-hint" id="metricTotalPlayersHint">Registrados no parser</div></div></div>
            <div class="card kpi-card"><div class="kpi-icon kpi-red"><svg class="icon"><use href="#icon-warning"></use></svg></div><div><div class="metric-label">Kills hoje</div><div class="metric-value" id="metricKillsToday">—</div><div class="metric-hint" id="metricKillsTodayHint">Dados reais do ADM</div></div></div>
            <div class="card kpi-card"><div class="kpi-icon kpi-orange"><svg class="icon"><use href="#icon-clock"></use></svg></div><div><div class="metric-label">Kills (7 dias)</div><div class="metric-value" id="metricWeeklyKills">—</div><div class="metric-hint" id="metricWeeklyKillsHint">Média semanal</div></div></div>
            <div class="card kpi-card"><div class="kpi-icon kpi-green"><svg class="icon"><use href="#icon-shopping-cart"></use></svg></div><div><div class="metric-label">Fila da loja</div><div class="metric-value" id="metricShopQueue">—</div><div class="metric-hint" id="metricShopQueueHint">Pedidos aguardando reset</div></div></div>
            <div class="card kpi-card"><div class="kpi-icon kpi-blue"><svg class="icon"><use href="#icon-coins"></use></svg></div><div><div class="metric-label">Coins em circulação</div><div class="metric-value" id="metricCoinsBalance">—</div><div class="metric-hint" id="metricCoinsBalanceHint">Saldo total das carteiras</div></div></div>
          </div>

          <div class="operation-charts-grid">
            <div class="card operation-card">
              <div class="section-title"><div><h2>Horários de pico</h2><div class="section-subtitle">Média de jogadores online por horário nos últimos 7 dias.</div></div><span class="chip">últimos 7 dias</span></div>
              <div id="peakHoursChart" class="horizontal-bars"></div>
              <div id="peakHoursInsight" class="insight-row"></div>
            </div>
            <div class="card operation-card">
              <div class="section-title"><div><h2>Atividade por dia da semana</h2><div class="section-subtitle">Kills registradas por dia nos últimos 7 dias.</div></div><span class="chip">ADM</span></div>
              <div id="weekdayActivityChart" class="horizontal-bars"></div>
              <div id="weekdayActivityInsight" class="insight-row"></div>
            </div>
          </div>

          <div class="card operation-card operations-summary-card">
            <div class="section-title"><h2>Resumo operacional</h2><span class="chip">live</span></div>
            <div class="ops-grid">
              <div class="ops-card"><div class="ops-icon kpi-blue"><svg class="icon"><use href="#icon-cube"></use></svg></div><div><b>Discord Bot</b><span class="status-line success">Online</span></div><small>Conectado ao gateway</small></div>
              <div class="ops-card"><div class="ops-icon"><svg class="icon"><use href="#icon-package"></use></svg></div><div><b>Parser ADM</b><span class="status-line" id="opsParserStatus">—</span></div><small id="opsParserMeta">Última leitura</small></div>
              <div class="ops-card"><div class="ops-icon"><svg class="icon"><use href="#icon-database"></use></svg></div><div><b>Neon DB</b><span class="status-line success">Conectado</span></div><small>Fonte de catálogo/economia</small></div>
              <div class="ops-card"><div class="ops-icon kpi-green"><svg class="icon"><use href="#icon-shopping-cart"></use></svg></div><div><b>Shop Worker</b><span class="status-line" id="opsShopStatus">—</span></div><small id="opsShopMeta">Fila da loja</small></div>
              <div class="ops-card"><div class="ops-icon kpi-red"><svg class="icon"><use href="#icon-clock"></use></svg></div><div><b>Map Events</b><span class="status-line success">Manual</span></div><small id="opsMapEventsMeta">Eventos pelo painel</small></div>
            </div>
            <div class="alerts-row">
              <div class="alert-pill"><svg class="icon"><use href="#icon-warning"></use></svg><span id="opsQueueAlert">Aguardando dados da fila</span></div>
              <div class="alert-pill success"><svg class="icon"><use href="#icon-check"></use></svg><span id="opsCleanupAlert">Nenhum alerta de limpeza detectado</span></div>
            </div>
          </div>
        </section>
        <section id="view-members" class="view">
          <div class="members-stats">
            <div class="card"><div class="metric-label">Membros</div><div id="membersTotal" class="metric-value">—</div><div class="metric-hint">total no Discord</div></div>
            <div class="card"><div class="metric-label">Vinculados</div><div id="membersLinked" class="metric-value">—</div><div class="metric-hint">com gamertag</div></div>
            <div class="card"><div class="metric-label">Sem gamertag</div><div id="membersUnlinked" class="metric-value">—</div><div class="metric-hint">pendentes de vínculo</div></div>
            <div class="card"><div class="metric-label">Online</div><div id="membersOnline" class="metric-value">—</div><div id="membersOnlineHint" class="metric-hint">agora</div></div>
          </div>
          <div class="members-toolbar">
            <div class="search"><input id="memberSearch" placeholder="Buscar por Discord, ID ou gamertag..." /></div>
            <select id="memberFilter"><option value="">Todos</option><option value="online">Online</option><option value="offline">Offline</option><option value="linked">Com gamertag</option><option value="unlinked">Sem gamertag</option></select>
            <button class="ghost-btn" id="membersRefresh">Refresh</button>
          </div>
          <div id="memberList" class="member-list"></div>
          <div id="memberLoading" class="member-list" style="display:none"><div class="skeleton"></div><div class="skeleton"></div></div>
          <div id="memberEmpty" class="empty" style="display:none">Nenhum membro encontrado.</div>
          <div id="memberSentinel" class="sentinel"></div>
        </section>
        <section id="view-catalog" class="view">
          <div class="catalog-shell">
            <div id="catalogCategoryView" class="catalog-shell">
              <div class="card">
                <div class="section-title">
                  <h2>Categorias</h2>
                  <div style="display:flex;align-items:center;gap:8px"><span class="chip">Neon</span><button id="shopQueueOpen" class="ghost-btn">Queue</button><button id="shopHistoryOpen" class="ghost-btn">Transactions</button><button id="catalogCategoryCreate" class="primary-btn"><svg class="icon"><use href="#icon-plus"></use></svg>Nova categoria</button><button id="catalogRefresh" class="ghost-btn">Refresh</button></div>
                </div>
                <div class="catalog-breadcrumb">Escolha uma categoria para gerenciar os itens vendidos no shop.</div>
              </div>
              <div id="catalogCategoryGrid" class="catalog-category-grid"></div>
            </div>
            <div id="catalogItemsView" class="catalog-shell" style="display:none">
              <div class="card">
                <div class="section-title">
                  <h2 id="catalogCurrentCategoryTitle">Itens</h2>
                  <div style="display:flex;align-items:center;gap:8px"><button id="catalogBack" class="ghost-btn"><svg class="icon"><use href="#icon-arrow-left"></use></svg>Categorias</button><button id="shopQueueOpenFromItems" class="ghost-btn">Queue</button><button id="shopHistoryOpenFromItems" class="ghost-btn">Transactions</button><button id="catalogCreate" class="primary-btn"><svg class="icon"><use href="#icon-plus"></use></svg>Novo item</button></div>
                </div>
                <div class="catalog-breadcrumb"><span>Shop</span><span>›</span><b id="catalogCurrentCategoryLabel">Categoria</b></div>
                <div class="catalog-toolbar" style="margin-top:12px">
                  <div class="search"><input id="catalogSearch" placeholder="Buscar por item ou classe" /></div>
                  <button id="catalogItemsRefresh" class="ghost-btn">Refresh</button>
                </div>
              </div>
              <div id="catalogLoading" class="catalog-grid" style="display:none"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
              <div id="catalogGrid" class="catalog-grid"></div>
              <div id="catalogEmpty" class="catalog-empty" style="display:none">Nenhum item encontrado nessa categoria.</div>
            </div>
            <div id="shopQueueView" class="shop-queue-shell" style="display:none">
              <div class="card shop-queue-header">
                <div>
                  <h2>Shop Queue</h2>
                  <p>Visão operacional dos pedidos criados pelo /shop e organizados como no /shop-queue.</p>
                </div>
                <div style="display:flex;align-items:center;gap:8px"><button id="shopQueueBack" class="ghost-btn"><svg class="icon"><use href="#icon-arrow-left"></use></svg>Shop</button><button id="shopHistoryOpenFromQueue" class="ghost-btn">Transactions</button><button id="shopQueueRefresh" class="primary-btn">Refresh</button></div>
              </div>
              <div id="shopQueueStats" class="shop-queue-status"></div>
              <div class="card">
                <div class="section-title"><h2>Pedidos recentes</h2><span id="shopQueueRuntime" class="chip">Carregando</span></div>
                <div id="shopQueueList" class="shop-queue-list"></div>
                <div id="shopQueueEmpty" class="catalog-empty" style="display:none">Nenhum pedido de shop encontrado.</div>
              </div>
            </div>
          </div>
        </section>
        <section id="view-map-events" class="view">
          <div class="items-shell">
            <div class="card">
              <div class="section-title">
                <div>
                  <h2>Eventos do Mapa</h2>
                  <div class="member-meta">Gerencie eventos instantâneos, agendados e recorrentes do servidor.</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <button id="mapEventsNewToggle" class="primary-btn"><svg class="icon"><use href="#icon-plus"></use></svg>Novo evento</button>
                  <button id="mapEventsRefresh" class="ghost-btn">Refresh</button>
                  <button id="mapEventsCleanup" class="danger-btn">Limpar eventos ativos</button>
                </div>
              </div>
              <div class="catalog-breadcrumb">A página abre com os eventos agendados. Use + Novo evento para abrir o builder acima da lista. O suporte estrutural fica em Settings > Eventos.</div>
            </div>

            <div id="mapEventBuilder" class="event-builder" style="display:none">
              <div class="card">
                <div class="section-title">
                  <div><h2>Novo evento</h2><div class="member-meta">Escolha o tipo, subtipo, localização e execução.</div></div>
                  <button id="mapEventsBuilderClose" class="ghost-btn">Fechar criação</button>
                </div>
                <div class="event-builder-layout">
                  <div class="event-builder-step">
                    <div class="step-kicker">1. Tipo do evento</div>
                    <div class="event-type-grid">
                      <button class="event-type-card active" type="button" data-event-type="locked_container">
                        <b>Locked Container</b>
                        <span>Containers trancados com loot temático.</span>
                      </button>
                      <button class="event-type-card" type="button" data-event-type="airdrop"><b>Airdrop</b><span>Drop militar com fumaça.</span></button>
                      <button class="event-type-card disabled" type="button" disabled><b>Zona PvP</b><span>Em breve</span></button>
                    </div>
                  </div>

                  <div class="event-builder-step">
                    <div class="step-kicker">2. Subtipo do evento</div>
                    <div id="mapEventPresetGrid" class="preset-grid event-subtype-grid"></div>
                  </div>

                  <div class="event-builder-step">
                    <div class="step-kicker">3. Localização</div>
                    <div class="form-grid two">
                      <label class="full">Nome do evento<input id="mapEventName" placeholder="Ex: Container militar Pavlovo" /></label>
                      <label class="full">Coordenadas<input id="mapEventCoordinates" inputmode="decimal" placeholder="5008.21 / 7418.99" /><small class="field-hint">Clique no mapa abaixo ou cole no formato X / Z. Ex: 5008.21 / 7418.99</small></label>
                    </div>
                    <div class="map-picker">
                      <div class="map-picker-toolbar">
                        <span>Mapa de Chernarus — clique para selecionar a posição</span>
                        <div class="map-picker-actions">
                          <button id="mapEventMapZoomOut" type="button" class="ghost-btn">−</button>
                          <span id="mapEventMapZoomLabel" class="chip">100%</span>
                          <button id="mapEventMapZoomIn" type="button" class="ghost-btn">+</button>
                        </div>
                      </div>
                      <div id="mapEventMapViewport" class="map-picker-viewport">
                        <div id="mapEventMapInner" class="map-picker-inner">
                          <img id="mapEventMapImage" src="/admin-panel/api/map-events/chernarus-map" alt="Mapa de Chernarus" draggable="false" />
                          <div id="mapEventMapPin" class="map-picker-pin" aria-hidden="true"></div>
                        </div>
                      </div>
                      <div class="map-picker-footer">O primeiro valor é X e o segundo é Z. O pin e o input são atualizados a cada clique.</div>
                    </div>
                  </div>

                  <div class="event-builder-step">
                    <div class="step-kicker">4. Execução</div>
                    <div class="schedule-mode-row">
                      <label class="schedule-mode active"><input type="radio" name="mapEventExecutionMode" value="now" checked />Agora</label>
                      <label class="schedule-mode"><input type="radio" name="mapEventExecutionMode" value="scheduled" />Agendar</label>
                    </div>
                    <div id="mapEventScheduleFields" class="form-grid two" style="display:none; margin-top:12px">
                      <label>Data do evento<input id="mapEventDate" type="date" /></label>
                      <label>Horário<select id="mapEventTime"><option value="now">Agora</option><option value="next_reset">Próximo reset</option><option value="00:00">00:00 reset</option><option value="06:00">06:00 reset</option><option value="12:00">12:00 reset</option><option value="18:00">18:00 reset</option><option value="custom">Personalizado</option></select></label>
                      <label id="mapEventCustomTimeWrap" style="display:none">Horário personalizado<input id="mapEventCustomTime" type="time" /></label>
                      <label>Recorrência<select id="mapEventRecurrence"><option value="none" selected>Sem recorrência</option><option value="daily">Diário</option><option value="weekly">Semanal</option><option value="monthly">Mensal</option></select></label>
                    </div>
                    <div class="field-hint">Para eventos agendados, o painel prepara o XML no horário definido. O spawn fica visível após o próximo restart/CE reload do servidor.</div>
                  </div>
                </div>

                <input id="mapEventSafeRadius" type="hidden" value="500" />
                <input id="mapEventDistanceRadius" type="hidden" value="500" />
                <input id="mapEventCleanupRadius" type="hidden" value="250" />
                <input id="mapEventAngle" type="hidden" value="0" />
                <input id="mapEventQuantity" type="hidden" value="1" />
                <input id="mapEventLifetime" type="hidden" value="2400" />
                <input id="mapEventX" type="hidden" />
                <input id="mapEventZ" type="hidden" />
                <select id="mapEventLootMode" style="display:none"><option value="rng">Tema/cor</option></select>
                <input id="mapEventRewardStorage" type="hidden" value="" />
                <input id="mapEventRewardStorageSearch" type="hidden" value="" />
                <div id="mapEventRewardStorageAutocomplete" style="display:none"></div>
                <div id="mapEventRewardStorageSelected" style="display:none"></div>
                <div id="mapEventRewardStorageWrap" style="display:none"></div>
                <input id="mapEventGuaranteedItemSearch" type="hidden" value="" />
                <div id="mapEventGuaranteedItemAutocomplete" style="display:none"></div>
                <div id="mapEventGuaranteedItemsList" style="display:none"></div>
                <div id="mapEventGuaranteedItemsWrap" style="display:none"></div>

                <div class="modal-actions" style="padding:14px 0 0"><button id="mapEventsInject" class="primary-btn">Criar evento agora</button><button id="mapEventsSchedule" class="primary-btn" style="display:none">Agendar evento</button></div>
                <div id="mapEventStatus" class="map-event-status" style="margin-top:14px"></div>
              </div>
            </div>

            <div class="event-dashboard-grid">
              <div class="event-kpi card"><span>Agendados</span><b id="mapEventsScheduledCount">0</b></div>
              <div class="event-kpi card"><span>Recorrentes</span><b id="mapEventsRecurringCount">0</b></div>
              <div class="event-kpi card"><span>Próximo evento</span><b id="mapEventsNextRun">—</b></div>
            </div>

            <div class="card">
              <div class="section-title">
                <div><h2>Eventos agendados</h2><div class="member-meta">Acompanhe próximos eventos e recorrências.</div></div>
                <span id="mapEventsScheduleRuntime" class="chip">Carregando</span>
              </div>
              <div id="mapEventsScheduledList" class="scheduled-events-list"></div>
              <div id="mapEventsScheduledEmpty" class="catalog-empty" style="display:none">Nenhum evento agendado. Clique em + Novo evento para começar.</div>
            </div>
          </div>
        </section>

        <section id="view-spawn-zones" class="view">
          <div class="spawn-zones-shell">
            <div class="card">
              <div class="section-title">
                <div>
                  <h2>Spawn Zones</h2>
                  <div class="member-meta">Gerencie zonas de spawn, pontos e a base visual para a rotação por votação.</div>
                </div>
                <div class="segmented-control" role="tablist" aria-label="Spawn Zones">
                  <button class="active" type="button" data-spawn-zone-tab="rotation">Map Rotation</button>
                  <button type="button" data-spawn-zone-tab="points">Spawn Points</button>
                  <button type="button" data-spawn-zone-tab="settings">Settings</button>
                </div>
              </div>
              <div class="catalog-breadcrumb">Iteração 5: automação semanal, fechamento de votação, aplicação do vencedor e histórico completo.</div>
            </div>

            <div id="spawnZonesTabRotation" class="spawn-zone-tab active">
              <div class="spawn-zone-summary-grid">
                <div class="card"><div class="metric-label">Zona atual</div><div id="spawnZonesCurrentZone" class="metric-value">—</div><div class="metric-hint">Zona marcada como ativa no painel</div></div>
                <div class="card"><div class="metric-label">Próxima zona</div><div id="spawnZonesNextZone" class="metric-value">—</div><div class="metric-hint">Preparada para a próxima rotação</div></div>
                <div class="card"><div class="metric-label">Zonas habilitadas</div><div id="spawnZonesEnabledCount" class="metric-value">0</div><div class="metric-hint">Entrarão na votação quando habilitada</div></div>
              </div>
              <div class="spawn-zone-rotation-grid">
                <div class="card">
                  <div class="section-title"><div><h2>Controle de rotação</h2><div class="member-meta">Escolha uma zona, aplique os pontos no servidor, crie/finalize a enquete e rode a automação semanal.</div></div><span class="chip">iteração 5</span></div>
                  <div class="spawn-zone-control-row">
                    <select id="spawnZonesNextSelect"></select>
                    <button id="spawnZonesSetNext" type="button" class="secondary-btn">Programar próxima</button>
                    <button id="spawnZonesApplyNext" type="button" class="secondary-btn">Aplicar no painel</button><button id="spawnZonesApplyServer" type="button" class="primary-btn">Aplicar no servidor</button><button id="spawnZonesCreatePoll" type="button" class="secondary-btn">Criar enquete</button><button id="spawnZonesRefreshPoll" type="button" class="ghost-btn">Atualizar votos</button><button id="spawnZonesFinalizePoll" type="button" class="ghost-btn">Finalizar votação</button><button id="spawnZonesRunAutomation" type="button" class="ghost-btn">Rodar automação</button>
                  </div>
                  <div class="member-meta" style="margin-top:10px">Aplicar no servidor substitui apenas o bloco <generator_posbubbles> dentro de <fresh>, preservando spawn_params, generator_params, hop e travel.</div><div id="spawnZonesAutomationStatus" class="settings-empty-note" style="margin-top:12px">Automação ainda não executada.</div><div id="spawnZonesActivePoll" class="settings-empty-note" style="margin-top:12px">Nenhuma enquete ativa.</div>
                </div>
                <div class="card">
                  <div class="section-title"><div><h2>Histórico de rotações</h2><div class="member-meta">Aplicações manuais e futuros resultados de votação ficam aqui.</div></div></div>
                  <div id="spawnZonesVoteHistory" class="settings-empty-note">Nenhuma rotação registrada ainda.</div>
                </div>
              </div>
            </div>

            <div id="spawnZonesTabPoints" class="spawn-zone-tab">
              <div class="spawn-zones-editor">
                <div class="card spawn-zone-map-card">
                  <div class="spawn-zone-map-toolbar">
                    <div class="spawn-zone-map-title"><b id="spawnZonesMapTitle">Selecione uma zona</b><span id="spawnZonesMapHint">Clique para adicionar · botão direito remove · scroll dá zoom · arraste para mover</span></div>
                    <div class="spawn-zone-map-actions"><button id="spawnZonesMapZoomOut" type="button" class="ghost-btn" title="Diminuir zoom">−</button><span id="spawnZonesMapZoomLabel" class="chip">100%</span><button id="spawnZonesMapZoomIn" type="button" class="ghost-btn" title="Aumentar zoom">+</button><span id="spawnZonesAutosaveStatus" class="chip">salvo</span></div>
                  </div>
                  <div id="spawnZonesMapViewport" class="spawn-zone-map-viewport">
                    <div id="spawnZonesMapInner" class="spawn-zone-map-inner">
                      <img src="/admin-panel/api/map-events/chernarus-map" alt="Mapa de Chernarus" draggable="false" />
                      <div id="spawnZonesMapTiles" class="spawn-zone-map-tile-layer"></div>
                      <div id="spawnZonesMarkers"></div>
                    </div>
                  </div>
                  <div class="spawn-zone-map-footer"><span id="spawnZonesCursor">X: — | Z: —</span><span>Mapa Chernarus · 15360 x 15360</span></div>
                </div>
                <aside class="spawn-zone-sidebar">
                  <button id="spawnZoneCreate" class="primary-btn spawn-zone-create"><svg class="icon"><use href="#icon-plus"></use></svg>Nova zona</button>
                  <button id="spawnZoneImport" class="secondary-btn spawn-zone-create" type="button"><svg class="icon"><use href="#icon-upload"></use></svg>Importar cfgplayerspawnpoints.xml</button>
                  <input id="spawnZoneImportFile" type="file" accept=".xml,text/xml" style="display:none" />
                  <div id="spawnZoneList" class="spawn-zone-list"></div>
                </aside>
              </div>
            </div>

            <div id="spawnZonesTabSettings" class="spawn-zone-tab">
              <div class="spawn-zone-setting-grid">
                <div class="card spawn-zone-settings-card">
                  <div class="section-title">
                    <div>
                      <h2>Canal e boas-vindas</h2>
                      <div class="member-meta">Define onde a votação aparece e cria a mensagem de entrada com escolha de idioma.</div>
                    </div>
                    <span class="chip">Discord</span>
                  </div>
                  <div class="form-grid">
                    <label>Canal da enquete<input id="spawnZonesPollChannel" placeholder="ID do canal 🗺️│map-vote" /></label>
                    <label>Categoria Map Rotation<input id="spawnZonesPollCategory" placeholder="1515944927257825341" /></label>
                    <label>Enunciado da enquete<input id="spawnZonesPollQuestion" placeholder="Which arena do you want to play next week?" /></label>
                  </div>
                  <div class="spawn-zone-setting-help">Use o ID do canal do Discord. As zonas habilitadas em <strong>Spawn Points</strong> viram as opções da enquete; a zona atual recebe <strong>[Actual]</strong>.</div>
                  <div class="spawn-zone-settings-actions">
                    <button id="spawnZonesWelcomeMessage" type="button" class="secondary-btn">Criar/atualizar boas-vindas</button>
                    <span id="spawnZonesWelcomeStatus" class="spawn-zone-settings-status">Mensagem de entrada ainda não criada.</span>
                  </div>
                  <div class="spawn-zone-setting-help">A mensagem começa como onboarding e, quando o player escolhe idioma, mostra a explicação da votação em EN/PT/ES.</div>
                </div>

                <div class="card spawn-zone-settings-card">
                  <div class="section-title">
                    <div>
                      <h2>Agenda da votação</h2>
                      <div class="member-meta">Quando a enquete deve abrir e quando o sistema deve avaliar o resultado.</div>
                    </div>
                    <span class="chip">weekly</span>
                  </div>
                  <div class="form-grid">
                    <label>Abertura<select id="spawnZonesPollOpenDay"><option value="monday">Segunda</option><option value="tuesday">Terça</option><option value="wednesday">Quarta</option><option value="thursday">Quinta</option><option value="friday">Sexta</option><option value="saturday">Sábado</option><option value="sunday">Domingo</option></select></label>
                    <label>Horário abertura<input id="spawnZonesPollOpenTime" type="time" /></label>
                    <label>Fechamento<select id="spawnZonesPollCloseDay"><option value="monday">Segunda</option><option value="tuesday">Terça</option><option value="wednesday">Quarta</option><option value="thursday">Quinta</option><option value="friday">Sexta</option><option value="saturday">Sábado</option><option value="sunday">Domingo</option></select></label>
                    <label>Horário fechamento<input id="spawnZonesPollCloseTime" type="time" /></label>
                    <label>Timezone<input id="spawnZonesPollTimezone" type="text" placeholder="America/Sao_Paulo" /></label>
                  </div>
                  <div class="spawn-zone-setting-stack">
                    <div class="spawn-zone-switch-row">
                      <div><b>Criar enquete automaticamente</b><span>O bot cria a enquete semanal no canal configurado usando as zonas habilitadas.</span></div>
                      <label class="switch"><input id="spawnZonesAutoCreatePoll" type="checkbox" /><span class="switch-slider"></span></label>
                    </div>
                    <div class="spawn-zone-switch-row">
                      <div><b>Recorrência após finalizar</b><span>Quando a enquete for encerrada e aplicada no servidor, cria uma nova enquete 10 minutos depois com a mesma duração da anterior.</span></div>
                      <label class="switch"><input id="spawnZonesRecurringPollAfterFinish" type="checkbox" /><span class="switch-slider"></span></label>
                    </div>
                  </div>
                </div>

                <div class="card spawn-zone-settings-card">
                  <div class="section-title">
                    <div>
                      <h2>Regras do resultado</h2>
                      <div class="member-meta">Controla quando um vencedor é aceito e o que fazer em caso de empate.</div>
                    </div>
                    <span class="chip">rules</span>
                  </div>
                  <div class="form-grid">
                    <label>Mínimo de votos<input id="spawnZonesMinVotes" type="number" min="0" step="1" /></label>
                    <label>Empate<select id="spawnZonesTiePolicy"><option value="manual">Resolver manualmente</option><option value="keep_current">Manter zona atual</option><option value="random">Sortear entre empatadas</option></select></label>
                  </div>
                  <div id="spawnZonesTiePolicyHelp" class="spawn-zone-setting-help">Se houver empate, a rotação fica aguardando decisão manual.</div>
                  <div class="spawn-zone-setting-stack">
                    <div class="spawn-zone-switch-row">
                      <div><b>Aplicar vencedor automaticamente</b><span>Quando ligado, o vencedor da votação pode virar a próxima rotação sem ação manual.</span></div>
                      <label class="switch"><input id="spawnZonesAutoApplyWinner" type="checkbox" /><span class="switch-slider"></span></label>
                    </div>
                    <div id="spawnZonesApplyOnNextRestartRow" class="spawn-zone-switch-row">
                      <div><b>Aplicar no próximo restart</b><span>Mais seguro: agenda o vencedor para o reset, em vez de trocar o arquivo imediatamente.</span></div>
                      <label class="switch"><input id="spawnZonesApplyOnNextRestart" type="checkbox" /><span class="switch-slider"></span></label>
                    </div>
                  </div>
                </div>

                <div class="card spawn-zone-settings-card">
                  <div class="section-title">
                    <div>
                      <h2>Aplicação no servidor</h2>
                      <div class="member-meta">Arquivo ativo de spawn e nome usado no onboarding público do Discord.</div>
                    </div>
                    <span class="chip">server</span>
                  </div>
                  <div class="form-grid">
                    <label>Arquivo ativo de spawn<input id="spawnZonesSpawnFilePath" placeholder="dayzps_missions/dayzOffline.chernarusplus/cfgplayerspawnpoints.xml" /></label>
                    <label>Nome do servidor<input id="spawnZonesServerName" placeholder="Nome do servidor" /></label>
                  </div>
                  <div class="spawn-zone-setting-help">A aplicação troca somente os <strong>&lt;pos&gt;</strong> dentro de <strong>fresh/generator_posbubbles</strong> e preserva spawn_params, generator_params, hop e travel.</div>
                  <div id="spawnZonesSettingsStatus" class="spawn-zone-settings-status saved">Configurações salvas automaticamente.</div>
                </div>
              </div>
            </div>
          </div>
        </section>


        <section id="view-player-map" class="view">
          <div class="player-map-shell">
            <div class="card">
              <div class="section-title">
                <div><h2>Player Map</h2><div class="member-meta">Última posição conhecida dos jogadores online, usando somente dados já capturados pelo parser.</div></div>
                <div class="player-map-actions"><span id="playerMapUpdatedAt" class="chip">Ainda não carregado</span><button id="playerMapRefresh" class="primary-btn" type="button">Atualizar mapa</button></div>
              </div>
              <div class="catalog-breadcrumb">Manual por design: abrir ou atualizar esta tela faz apenas uma leitura pequena do histórico de posições. Nenhuma chamada extra é feita à Nitrado.</div>
            </div>
            <div class="player-map-layout">
              <div class="card player-map-card">
                <div class="player-map-toolbar">
                  <div class="player-map-toolbar-copy"><b>Chernarus</b><span id="playerMapSummary">Aguardando snapshot...</span></div>
                  <div class="player-map-actions"><button id="playerMapZoomOut" class="ghost-btn" type="button">−</button><span id="playerMapZoomLabel" class="chip">100%</span><button id="playerMapZoomIn" class="ghost-btn" type="button">+</button></div>
                </div>
                <div id="playerMapViewport" class="player-map-viewport">
                  <div id="playerMapInner" class="player-map-inner">
                    <img src="/admin-panel/api/map-events/chernarus-map" alt="Mapa de Chernarus" draggable="false" />
                    <div id="playerMapMarkers" class="player-map-marker-layer"></div>
                  </div>
                </div>
                <div class="player-map-footer"><span>Verde: ≤5 min · amarelo: 5–10 min · vermelho: &gt;10 min</span><span>15360 × 15360</span></div>
              </div>
              <div class="player-map-side">
                <div class="card">
                  <div class="section-title"><div><h2>Jogadores</h2><div class="member-meta">Filtre os pins sem consultar o servidor novamente.</div></div><span id="playerMapVisibleCount" class="chip">0</span></div>
                  <input id="playerMapSearch" class="player-map-search" placeholder="Buscar gamertag..." />
                  <div id="playerMapList" class="player-map-list" style="margin-top:12px"></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="view-settings" class="view">
          <div class="items-shell">
            <div class="card">
              <div class="section-title">
                <div>
                  <h2>Settings</h2>
                  <div class="member-meta">Configure recursos estruturais do servidor antes de usar no painel.</div>
                </div>
              </div>
              <div class="settings-tabs" role="tablist" aria-label="Settings sections">
                <button class="settings-tab" type="button" data-settings-tab="servers">Servers</button>
                <button class="settings-tab active" type="button" data-settings-tab="server">Server Settings</button>
                <button class="settings-tab" type="button" data-settings-tab="events">Events Settings</button>
                <button class="settings-tab" type="button" data-settings-tab="discord">Discord Commands</button>
                <button class="settings-tab" type="button" data-settings-tab="integrations">Integrações</button>
              </div>
            </div>

            <div id="settingsPanelServers" class="settings-panel">
              <div class="card">
                <div class="section-title">
                  <div><h2>Server onboarding</h2><div class="member-meta">Valide integrações e execute um preflight completo antes da ativação manual de qualquer servidor adicional.</div></div>
                  <span class="chip online">Phase 16 · Self-service & isolation</span>
                </div>
                <div class="server-onboarding-notice">A Fase 16 mantém ownership/RBAC e adiciona credencial Nitrado por organização, catálogo/settings por servidor e um onboarding SaaS separado. O workspace atual continua compatível com o token Nitrado legado enquanto você migra.</div>
              </div>

              <div class="card" style="margin-top:16px">
                <div class="section-title">
                  <div><h2>SaaS workspace</h2><div class="member-meta">Ownership e autorização da organização que contém os servidores atuais.</div></div>
                  <div class="server-onboarding-actions"><a class="ghost-btn" href="/admin-panel/setup" style="text-decoration:none">Configurar servidor</a><button id="organizationRefresh" class="ghost-btn" type="button">Atualizar</button></div>
                </div>
                <div id="organizationSummary" class="command-settings-summary" style="margin-top:12px"><span class="chip">Carregando...</span></div>
                <div class="form-grid" style="margin-top:14px">
                  <label>Discord User ID<input id="organizationMemberDiscordId" maxlength="32" placeholder="123456789..." autocomplete="off" /></label>
                  <label>Role<select id="organizationMemberRole"><option value="viewer">Viewer</option><option value="moderator">Moderator</option><option value="admin">Admin</option><option value="owner">Owner</option></select></label>
                </div>
                <div class="server-onboarding-actions"><button id="organizationMemberSave" class="ghost-btn" type="button">Adicionar / atualizar membro</button></div>
                <div id="organizationMembers" class="settings-list" style="margin-top:12px"><div class="skeleton"></div></div>
              </div>

              <div class="server-onboarding-grid">
                <div class="card">
                  <div class="section-title">
                    <div><h2>Servers</h2><div class="member-meta">Gerencie os servidores cadastrados e acompanhe o progresso de configuração.</div></div>
                    <div class="server-onboarding-actions">
                      <button id="managedServersRefresh" class="ghost-btn" type="button">Atualizar</button>
                      <button id="managedServerCreateNew" class="primary-btn" type="button">Adicionar servidor</button>
                    </div>
                  </div>
                  <div id="managedServersSummary" class="command-settings-summary"><span class="chip">Carregando...</span></div>
                  <div id="managedServersList" class="server-onboarding-list" style="margin-top:14px"><div class="skeleton"></div></div>
                </div>

                <div>
                  <div id="managedServerCreatePanel" class="card">
                    <div class="section-title">
                      <div><h2>Adicionar servidor</h2><div class="member-meta">Comece só com a identidade do servidor. As integrações ficam para as próximas etapas.</div></div>
                      <span class="chip pending">Draft</span>
                    </div>
                    <div class="server-onboarding-form">
                      <div class="server-create-copy">Dê um nome ao servidor. O Server ID é gerado automaticamente e será o namespace usado para isolar os dados desse servidor.</div>
                      <div class="form-grid">
                        <label>Nome<input id="managedServerName" maxlength="80" placeholder="Ex.: PZ Vanilla" autocomplete="off" /></label>
                        <label>Server ID<input id="managedServerId" maxlength="64" placeholder="pz-vanilla" autocomplete="off" /></label>
                      </div>
                      <div class="member-meta">O Server ID fica imutável depois da criação. Nenhuma integração é obrigatória para criar o draft.</div>
                      <div class="server-onboarding-actions">
                        <button id="managedServerSave" class="primary-btn" type="button">Criar servidor</button>
                      </div>
                    </div>
                  </div>

                  <div id="managedServerSetupPanel" class="card" style="display:none">
                    <div class="server-setup-hero">
                      <div>
                        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
                          <h2 id="managedServerFormTitle">Server setup</h2>
                          <span id="managedServerFormStatus" class="chip pending">Draft</span>
                        </div>
                        <p>Server ID: <code id="managedServerSetupId">-</code></p>
                      </div>
                      <button id="managedServerCancel" class="ghost-btn" type="button">Voltar</button>
                    </div>

                    <div class="server-setup-progress">
                      <div class="server-setup-progress-head"><span>Activation readiness</span><strong id="managedServerSetupProgressText">1 de 3 etapas</strong></div>
                      <div class="server-setup-progress-track"><span id="managedServerSetupProgressBar" style="width:33.33%"></span></div>
                    </div>

                    <div class="server-setup-tabs" role="tablist" aria-label="Server setup sections">
                      <button class="server-setup-tab active" type="button" data-managed-server-tab="overview">Overview</button>
                      <button class="server-setup-tab" type="button" data-managed-server-tab="nitrado">Nitrado</button>
                      <button class="server-setup-tab" type="button" data-managed-server-tab="discord">Discord <span style="opacity:.65">· opcional</span></button>
                      <button class="server-setup-tab" type="button" data-managed-server-tab="preflight">Preflight</button>
                    </div>

                    <div id="managedServerSetupOverview" class="server-setup-panel active">
                      <div class="server-setup-status-grid">
                        <div id="managedServerOverviewNitrado" class="server-setup-status-card"><span>Nitrado</span><strong>Não configurado</strong><p>Obrigatório para completar o core setup.</p></div>
                        <div id="managedServerOverviewDiscord" class="server-setup-status-card"><span>Discord</span><strong>Opcional</strong><p>Pode ser conectado agora ou depois.</p></div>
                        <div id="managedServerOverviewPreflight" class="server-setup-status-card"><span>Preflight</span><strong>Pendente</strong><p>Disponível depois da validação Nitrado.</p></div>
                        <div id="managedServerOverviewRuntime" class="server-setup-status-card"><span>Runtime</span><strong>Desligado</strong><p>Disponível somente depois do preflight.</p></div>
                      </div>
                      <div class="server-onboarding-info">Configure primeiro o Nitrado. Depois execute o <strong>Preflight</strong>. Quando chegar a <strong>Ready</strong>, o runtime poderá ser ativado manualmente; nada inicia automaticamente. Discord continua opcional.</div>
                    </div>

                    <div id="managedServerSetupNitrado" class="server-setup-panel">
                      <div class="server-integration-head">
                        <div><h3>Nitrado</h3><p>Use a conexão Nitrado já protegida no backend para localizar e validar o serviço DayZ sem copiar o token para o navegador.</p></div>
                        <span id="managedServerNitradoState" class="chip pending">Obrigatório</span>
                      </div>
                      <div class="server-onboarding-form">
                        <div id="managedServerNitradoConnection" class="server-onboarding-info">Verificando conexão Nitrado...</div>
                        <div class="server-onboarding-actions">
                          <button id="managedServerNitradoDiscover" class="ghost-btn" type="button">Carregar meus servidores Nitrado</button>
                        </div>
                        <div class="form-grid">
                          <label class="full">Servidor Nitrado
                            <select id="managedServerNitradoServiceSelect"><option value="">Carregue os servidores da conta</option></select>
                          </label>
                          <label class="full">Nitrado base dir<input id="managedServerNitradoBaseDir" maxlength="512" placeholder="Detectado automaticamente quando possível" autocomplete="off" /></label>
                        </div>
                        <details class="server-advanced-details">
                          <summary>Configuração manual / fallback</summary>
                          <div class="form-grid">
                            <label class="full">Nitrado Service ID<input id="managedServerNitradoServiceId" maxlength="64" placeholder="12345678" autocomplete="off" /></label>
                          </div>
                        </details>
                        <div id="managedServerNitradoValidationMeta" class="member-meta">Configured só é liberado depois de uma validação manual bem-sucedida do Service ID + base dir.</div>
                        <div class="server-onboarding-actions"><button id="managedServerNitradoSave" class="primary-btn" type="button">Validar e salvar</button></div>
                      </div>
                    </div>

                    <div id="managedServerSetupDiscord" class="server-setup-panel">
                      <div class="server-integration-head">
                        <div><h3>Discord</h3><p>Opcional. O ADM pode descobrir as guilds onde o bot já está presente e carregar os canais para você selecionar.</p></div>
                        <span id="managedServerDiscordState" class="chip">Opcional</span>
                      </div>
                      <div class="server-onboarding-form">
                        <div id="managedServerDiscordConnection" class="server-onboarding-info">A descoberta acontece somente quando você clicar em carregar.</div>
                        <div class="server-onboarding-actions"><button id="managedServerDiscordDiscover" class="ghost-btn" type="button">Carregar servidores Discord</button></div>
                        <div class="form-grid">
                          <label class="full">Servidor Discord
                            <select id="managedServerDiscordGuildSelect"><option value="">Nenhum · opcional</option></select>
                          </label>
                        </div>
                        <div class="server-onboarding-info">Depois de escolher a guild, os canais disponíveis são carregados sob demanda. Nenhum loop do Discord é iniciado para este servidor.</div>
                        <div class="form-grid">
                          <label>Global ranking<select id="managedServerDiscordGlobal"><option value="">Não configurado</option></select></label>
                          <label>Daily ranking<select id="managedServerDiscordDaily"><option value="">Não configurado</option></select></label>
                          <label>Weekly ranking<select id="managedServerDiscordWeekly"><option value="">Não configurado</option></select></label>
                          <label>Online category<select id="managedServerDiscordOnlineCategory"><option value="">Não configurado</option></select></label>
                        </div>
                        <details class="server-advanced-details">
                          <summary>Guild ID manual / fallback</summary>
                          <div class="form-grid"><label class="full">Discord Guild ID<input id="managedServerDiscordGuildId" maxlength="64" placeholder="123456789..." autocomplete="off" /></label></div>
                        </details>
                        <div class="server-onboarding-actions"><button id="managedServerDiscordSave" class="primary-btn" type="button">Salvar Discord</button></div>
                      </div>
                    </div>

                    <div id="managedServerSetupPreflight" class="server-setup-panel">
                      <div class="server-integration-head">
                        <div><h3>Activation preflight</h3><p>Cheque novamente quando precisar; a ativação real só é liberada para uma configuração Ready e aprovada.</p></div>
                        <span id="managedServerPreflightState" class="chip pending">Pendente</span>
                      </div>
                      <div class="server-onboarding-form">
                        <div id="managedServerPreflightIntro" class="server-onboarding-info">Valide o Nitrado primeiro. O preflight não inicia runtime nem baixa ADM.</div>
                        <div class="server-onboarding-actions"><button id="managedServerPreflightRun" class="ghost-btn" type="button">Executar preflight</button><button id="managedServerRuntimeToggle" class="primary-btn" type="button" style="display:none">Ativar runtime</button></div>
                        <div class="server-onboarding-actions"><button id="managedServerRuntimePauseToggle" class="ghost-btn" type="button" style="display:none">Pausar processamento</button><button id="managedServerRuntimeRetry" class="ghost-btn" type="button" style="display:none">Executar ciclo agora</button></div>
                        <div id="managedServerRuntimeActivationMeta" class="member-meta">O runtime só pode ser ativado depois de um preflight aprovado.</div>
                        <div id="managedServerRuntimeHealthMeta" class="member-meta">Health operacional disponível depois da ativação.</div>
                        <div id="managedServerPreflightSummary" class="member-meta">Ainda não executado nesta sessão.</div>
                        <div id="managedServerPreflightChecks" class="server-preflight-list"><div class="server-preflight-empty">As verificações aparecerão aqui depois de executar o preflight.</div></div>
                        <div class="server-onboarding-info"><strong>Importante:</strong> a ativação é explícita. No primeiro ciclo o novo servidor cria somente o próprio namespace e baixa seus próprios arquivos ADM. O PZ permanece em <code>adm_logs/</code> e <code>state.json</code>.</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div id="settingsPanelServer" class="settings-panel active">
              <div class="card">
                <div class="section-title">
                  <div><h2>Services & Performance</h2><div class="member-meta">Pause serviços opcionais e reduza atividade desnecessária no Neon sem afetar estatísticas críticas.</div></div>
                  <div id="serviceSettingsSummary" class="command-settings-summary"><span class="chip">Carregando...</span></div>
                </div>
                <div class="settings-empty-note" style="margin-top:14px">Kills, deaths, K/D, rankings, streaks, longshots e killfeed permanecem sempre ativos e não podem ser desabilitados.</div>
                <div id="serviceSettingsList" class="command-settings-list"></div>
              </div>
              <div class="card">
                <div class="section-title">
                  <div><h2>Performance diagnostics</h2><div class="member-meta">Neon persistence, payload composition, ADM bandwidth and main loop timing. Metrics reset after deploy.</div></div>
                  <button id="performanceMetricsRefresh" class="ghost-btn" type="button">Refresh metrics</button>
                </div>
                <div id="neonPersistenceMetrics" class="settings-list"><div class="skeleton"></div></div>
              </div>
            </div>

            <div id="settingsPanelEvents" class="settings-panel">
              <div class="card">
                <div class="section-title">
                  <div>
                    <h2>Events Settings</h2>
                    <div class="member-meta">Instale recursos disponíveis para criação de eventos no mapa.</div>
                  </div>
                  <button id="lockedContainerCheck" class="ghost-btn">Verificar instalação</button>
                </div>
                <div id="lockedContainerSetupStatus" class="settings-list" style="margin-top:14px"></div>
              </div>

              <div class="card" id="lockedContainerInstalledSection" style="display:none">
                <div class="section-title">
                  <div><h2>Instalados</h2><div class="member-meta">Recursos já configurados neste servidor.</div></div>
                </div>
                <div id="lockedContainerInstalledGrid" class="integration-grid"></div>
              </div>

              <div class="card">
                <div class="section-title">
                  <div><h2>Eventos disponíveis</h2><div class="member-meta">Clique em um card para ver detalhes, instalar, verificar ou remover suporte.</div></div>
                </div>
                <div id="lockedContainerAvailableGrid" class="integration-grid"></div>
              </div>
            </div>


            <div id="settingsPanelDiscord" class="settings-panel">
              <div class="card">
                <div class="section-title">
                  <div>
                    <h2>Discord Commands</h2>
                    <div class="member-meta">Ative ou pause comandos instantaneamente, sem removê-los do Discord ou reiniciar o bot.</div>
                  </div>
                  <div id="discordCommandsSummary" class="command-settings-summary"><span class="chip">Carregando...</span></div>
                </div>
                <div class="settings-empty-note" style="margin-top:14px">Desativar um comando bloqueia apenas novas execuções. Processos automáticos, entregas pendentes e interações já abertas continuam funcionando.</div>
                <div id="discordCommandsList" class="command-settings-list"></div>
              </div>
            </div>

            <div id="settingsPanelIntegrations" class="settings-panel">
              <div class="card">
                <div class="section-title">
                  <div><h2>Integrações</h2><div class="member-meta">Conexões externas aparecerão aqui futuramente.</div></div>
                </div>
                <div class="settings-empty-note">Nenhuma integração disponível no momento.</div>
              </div>
            </div>
          </div>
        </section>
        <section id="view-items" class="view">
          <div class="items-shell">
            <div class="card">
              <div class="section-title">
                <div>
                  <h2>Base de itens</h2>
                  <div class="member-meta">Gerencie nomes, imagens e disponibilidade dos itens que podem entrar no catálogo.</div>
                </div>
                <button id="itemsRefresh" class="ghost-btn">Refresh</button>
              </div>
              <div class="items-toolbar">
                <div class="search"><input id="itemsSearch" placeholder="Buscar por nome popular ou className..." /></div>
                <select id="itemsFilter"><option value="all">Todos</option><option value="enabled">Habilitados</option><option value="disabled">Desabilitados</option><option value="missing_image">Sem imagem</option></select>
                <span class="chip">Neon</span>
              </div>
            </div>
            <div id="itemsList" class="items-list"></div>
            <div id="itemsLoading" class="member-list" style="display:none"><div class="skeleton"></div><div class="skeleton"></div></div>
            <div id="itemsEmpty" class="items-empty" style="display:none">Nenhum item encontrado.</div>
            <div id="itemsSentinel" class="sentinel"></div>
          </div>
        </section>
      </main>
    </section>
  </div>

  <aside id="detailDrawer" class="detail-drawer" aria-live="polite">
    <div class="drawer-header">
      <div class="drawer-profile">
        <div id="drawerAvatar" class="avatar">--</div>
        <div style="min-width:0">
          <div id="drawerName" class="drawer-title">Selecione um membro</div>
          <div id="drawerMeta" class="drawer-subtitle">Histórico e carteira</div>
        </div>
      </div>
      <button id="drawerClose" class="icon-btn" style="height:34px;padding:0 10px">Close</button>
    </div>
    <div id="drawerBody" class="drawer-body">
      <div class="drawer-empty">Clique em um membro para ver os detalhes.</div>
    </div>
  </aside>

  <div id="modalBackdrop" class="modal-backdrop">
    <div class="modal">
      <h2 id="modalTitle">Ajustar moedas</h2>
      <p id="modalSubtitle">Confirme a ação administrativa.</p>
      <div class="form-grid">
        <label>Quantidade<input id="coinAmount" type="number" min="0" step="1" /></label>
        <label>Motivo<textarea id="coinReason" placeholder="Ex: recompensa de evento, correção manual..."></textarea></label>
      </div>
      <div class="modal-actions"><button class="ghost-btn" id="modalCancel">Cancelar</button><button class="primary-btn" id="modalConfirm">Confirmar</button></div>
    </div>
  </div>
  <div id="catalogModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <h2 id="catalogModalTitle">Item do shop</h2>
      <p id="catalogModalSubtitle">Gerencie o item do shop diretamente no Neon.</p>
      <div class="form-grid two">
        <label class="full autocomplete-wrap">ID / Item base
          <input id="catalogItemId" autocomplete="off" placeholder="Digite para buscar na base DayZ" />
          <div id="catalogItemAutocomplete" class="autocomplete-menu"></div>
        </label>
        <label class="full">Nome na loja<input id="catalogItemName" placeholder="Nome exibido no shop" /></label>
        <label>Categoria<select id="catalogItemCategory"></select></label>
        <label>Preço<input id="catalogItemPrice" type="number" min="0" step="1" /></label>
        <label class="full">URL da imagem<input id="catalogItemImage" placeholder="https://..." /></label>
        <label class="full">Descrição<textarea id="catalogItemDescription" placeholder="Descrição exibida no painel e no shop..."></textarea></label>
        <label class="toggle-row full"><span><b>Disponível no shop</b><small style="display:block;color:var(--text-3);margin-top:4px">Itens desativados ficam ocultos no /shop.</small></span><input id="catalogItemEnabled" type="checkbox" checked /></label>
      </div>
      <div class="modal-actions"><button class="ghost-btn" id="catalogModalCancel">Cancelar</button><button class="primary-btn" id="catalogModalConfirm">Salvar item</button></div>
    </div>
  </div>
  <div id="itemModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <h2 id="itemModalTitle">Item DayZ</h2>
      <p id="itemModalSubtitle">Atualize a base mestre usada pelo autocomplete do catálogo.</p>
      <div class="item-preview-card">
        <div id="itemModalPreviewImage" class="dayz-item-image"><svg class="entity-icon"><use href="#icon-package"></use></svg></div>
        <div class="dayz-item-copy">
          <div id="itemModalPreviewName" class="dayz-item-title">Item</div>
          <div id="itemModalPreviewClass" class="dayz-item-subtitle">ClassName</div>
        </div>
      </div>
      <div class="form-grid" style="margin-top:14px">
        <label>Nome popular<input id="itemModalPopularName" placeholder="Nome exibido na base" /></label>
        <label>URL da imagem<input id="itemModalImageUrl" placeholder="https://..." /></label>
        <label>Spawn event name<input id="itemModalSpawnEventName" placeholder="Opcional" /></label>
        <label class="toggle-row"><span><b>Habilitado</b><small style="display:block;color:var(--text-3);margin-top:4px">Itens desabilitados não aparecem no autocomplete do catálogo.</small></span><input id="itemModalEnabled" type="checkbox" checked /></label>
      </div>
      <div class="modal-actions"><button class="ghost-btn" id="itemModalRemoveImage">Remover imagem</button><button class="ghost-btn" id="itemModalCancel">Cancelar</button><button class="primary-btn" id="itemModalConfirm">Salvar item</button></div>
    </div>
  </div>

  <div id="catalogCategoryModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <h2>Nova categoria</h2>
      <p>Crie uma pasta para organizar os itens do catálogo.</p>
      <div class="form-grid">
        <label>Nome da categoria<input id="catalogCategoryName" placeholder="Ex: Weapons" /></label>
        <label>ID opcional<input id="catalogCategoryId" placeholder="Gerado automaticamente se vazio" /></label>
        <label>Descrição<textarea id="catalogCategoryDescription" placeholder="Descrição interna opcional..."></textarea></label>
        <label class="toggle-row"><span><b>Categoria ativa</b><small style="display:block;color:var(--text-3);margin-top:4px">Categorias inativas ficam ocultas no /shop.</small></span><input id="catalogCategoryEnabled" type="checkbox" checked /></label>
      </div>
      <div class="modal-actions"><button class="ghost-btn" id="catalogCategoryModalCancel">Cancelar</button><button class="primary-btn" id="catalogCategoryModalConfirm">Criar categoria</button></div>
    </div>
  </div>

  <div id="eventIntegrationModalBackdrop" class="modal-backdrop integration-modal">
    <div class="modal">
      <div class="integration-modal-header">
        <div class="integration-modal-title">
          <div class="integration-icon"><img src="https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Blue_DE.png" alt="" /></div>
          <div>
            <h2>Locked Containers</h2>
            <p>Suporte base para containers trancados com loot temático por cor.</p>
          </div>
        </div>
        <button id="eventIntegrationModalClose" class="ghost-btn">Fechar</button>
      </div>
      <div class="integration-modal-body">
        <div class="integration-modal-section">
          <h3>O que essa instalação configura</h3>
          <ul class="integration-feature-list">
            <li>✓ Registra <b>custom/locked-container-types.xml</b> no cfgeconomycore.xml.</li>
            <li>✓ Cria pools exclusivos por tema: Militar, Médico, Construção e Raid.</li>
            <li>✓ Configura mapgroupproto.xml para as quatro cores de container.</li>
            <li>✓ Mantém a tela Eventos do Mapa focada só na criação/agendamento dos spawns.</li>
          </ul>
          <div class="settings-empty-note" style="margin-top:16px">Recomendado fazer backup dos XMLs antes de instalar ou reparar. A operação pode levar até 1 minuto se o FTP estiver lento.</div>
        </div>
        <div class="integration-modal-section">
          <h3>Status da instalação</h3>
          <div id="lockedContainerModalStatus" class="settings-list"></div>
        </div>
      </div>
      <div class="integration-modal-footer">
        <button id="lockedContainerUninstall" class="danger-btn">Desinstalar suporte</button>
        <div class="modal-actions" style="margin:0"><button id="lockedContainerInstall" class="primary-btn">Instalar suporte</button></div>
      </div>
    </div>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    const adminToken = ${tokenJson};
    if (adminToken) document.cookie = "${TOKEN_COOKIE}=" + encodeURIComponent(adminToken) + "; path=/admin-panel; SameSite=Lax";
    const state = { view: "general", cursor: 0, hasMore: true, loadingMembers: false, memberForceRefresh: false, search: "", filter: "", modal: null, catalogModal: null, selectedDiscordId: null, catalog: null, catalogSearch: "", catalogCategory: "", catalogMode: "categories", catalogDrag: null, catalogJustDragged: false, shopQueue: null, shopTransactions: null, shopHistorySearch: "", shopQueueModeBefore: "categories", itemsCursor: 0, itemsHasMore: true, itemsLoading: false, itemsSearch: "", itemsFilter: "all", dayzItems: [], itemsStats: null, itemModal: null, mapEventPresets: [], selectedMapEventPresetId: "locked_container_red_military", mapEventRewardStorageItem: null, mapEventLootItems: [], scheduledMapEvents: [], mapEventBuilderOpen: false, settingsTab: "server", managedServers: null, managedServersLoading: false, selectedManagedServerId: null, managedServerSetupTab: "overview", managedServerIntegrationSetup: null, managedServerNitradoServices: [], managedServerDiscordGuilds: [], managedServerDiscordChannels: [], managedServerPreflightResult: null, organization: null, serviceSettings: null, serviceSettingsLoading: false, discordCommands: null, discordCommandsLoading: false, lockedContainerSetup: null, spawnZonesTab: "rotation", spawnZones: null, selectedSpawnZoneId: null, highlightedSpawnPointId: null, spawnZoneMapZoom: 1, spawnZoneMapDragging: false, spawnZoneEditingNameId: null, playerMap: null, playerMapZoom: 1, playerMapSearch: "" };
    const els = {
      pageTitle: document.getElementById("pageTitle"), serverName: document.getElementById("serverName"),
      mapEventPresetGrid: document.getElementById("mapEventPresetGrid"), mapEventSelectedPreset: document.getElementById("mapEventSelectedPreset"), mapEventName: document.getElementById("mapEventName"), mapEventCoordinates: document.getElementById("mapEventCoordinates"), mapEventX: document.getElementById("mapEventX"), mapEventZ: document.getElementById("mapEventZ"), mapEventAngle: document.getElementById("mapEventAngle"), mapEventQuantity: document.getElementById("mapEventQuantity"), mapEventLifetime: document.getElementById("mapEventLifetime"), mapEventSafeRadius: document.getElementById("mapEventSafeRadius"), mapEventDistanceRadius: document.getElementById("mapEventDistanceRadius"), mapEventCleanupRadius: document.getElementById("mapEventCleanupRadius"), mapEventLootMode: document.getElementById("mapEventLootMode"), mapEventRewardStorage: document.getElementById("mapEventRewardStorage"), mapEventRewardStorageSearch: document.getElementById("mapEventRewardStorageSearch"), mapEventRewardStorageSelected: document.getElementById("mapEventRewardStorageSelected"), mapEventRewardStorageAutocomplete: document.getElementById("mapEventRewardStorageAutocomplete"), mapEventRewardStorageWrap: document.getElementById("mapEventRewardStorageWrap"), mapEventGuaranteedItemSearch: document.getElementById("mapEventGuaranteedItemSearch"), mapEventGuaranteedItemAutocomplete: document.getElementById("mapEventGuaranteedItemAutocomplete"), mapEventGuaranteedItemsList: document.getElementById("mapEventGuaranteedItemsList"), mapEventGuaranteedItemsWrap: document.getElementById("mapEventGuaranteedItemsWrap"), mapEventMapViewport: document.getElementById("mapEventMapViewport"), mapEventMapInner: document.getElementById("mapEventMapInner"), mapEventMapImage: document.getElementById("mapEventMapImage"), mapEventMapPin: document.getElementById("mapEventMapPin"), mapEventMapZoomIn: document.getElementById("mapEventMapZoomIn"), mapEventMapZoomOut: document.getElementById("mapEventMapZoomOut"), mapEventMapZoomLabel: document.getElementById("mapEventMapZoomLabel"), mapEventStatus: document.getElementById("mapEventStatus"), mapEventBuilder: document.getElementById("mapEventBuilder"), mapEventsNewToggle: document.getElementById("mapEventsNewToggle"), mapEventsBuilderClose: document.getElementById("mapEventsBuilderClose"), mapEventsSchedule: document.getElementById("mapEventsSchedule"), mapEventScheduleFields: document.getElementById("mapEventScheduleFields"), mapEventDate: document.getElementById("mapEventDate"), mapEventTime: document.getElementById("mapEventTime"), mapEventCustomTimeWrap: document.getElementById("mapEventCustomTimeWrap"), mapEventCustomTime: document.getElementById("mapEventCustomTime"), mapEventRecurrence: document.getElementById("mapEventRecurrence"), mapEventsScheduledList: document.getElementById("mapEventsScheduledList"), mapEventsScheduledEmpty: document.getElementById("mapEventsScheduledEmpty"), mapEventsScheduledCount: document.getElementById("mapEventsScheduledCount"), mapEventsRecurringCount: document.getElementById("mapEventsRecurringCount"), mapEventsNextRun: document.getElementById("mapEventsNextRun"), mapEventsScheduleRuntime: document.getElementById("mapEventsScheduleRuntime"),
      memberList: document.getElementById("memberList"), memberLoading: document.getElementById("memberLoading"), memberEmpty: document.getElementById("memberEmpty"),
      modalBackdrop: document.getElementById("modalBackdrop"), modalTitle: document.getElementById("modalTitle"), modalSubtitle: document.getElementById("modalSubtitle"),
      coinAmount: document.getElementById("coinAmount"), coinReason: document.getElementById("coinReason"), toast: document.getElementById("toast"),
      detailDrawer: document.getElementById("detailDrawer"), drawerBody: document.getElementById("drawerBody"), drawerAvatar: document.getElementById("drawerAvatar"), drawerName: document.getElementById("drawerName"), drawerMeta: document.getElementById("drawerMeta"),
      catalogGrid: document.getElementById("catalogGrid"), catalogLoading: document.getElementById("catalogLoading"), catalogEmpty: document.getElementById("catalogEmpty"), catalogSearch: document.getElementById("catalogSearch"), catalogCategoryView: document.getElementById("catalogCategoryView"), catalogItemsView: document.getElementById("catalogItemsView"), catalogCategoryGrid: document.getElementById("catalogCategoryGrid"), catalogCurrentCategoryTitle: document.getElementById("catalogCurrentCategoryTitle"), catalogCurrentCategoryLabel: document.getElementById("catalogCurrentCategoryLabel"), shopQueueView: document.getElementById("shopQueueView"), shopQueueStats: document.getElementById("shopQueueStats"), shopQueueList: document.getElementById("shopQueueList"), shopQueueEmpty: document.getElementById("shopQueueEmpty"), shopQueueRuntime: document.getElementById("shopQueueRuntime"),
      catalogModalBackdrop: document.getElementById("catalogModalBackdrop"), catalogModalTitle: document.getElementById("catalogModalTitle"), catalogModalSubtitle: document.getElementById("catalogModalSubtitle"), catalogItemId: document.getElementById("catalogItemId"), catalogItemAutocomplete: document.getElementById("catalogItemAutocomplete"), catalogItemCategory: document.getElementById("catalogItemCategory"), catalogItemName: document.getElementById("catalogItemName"), catalogItemPrice: document.getElementById("catalogItemPrice"), catalogItemImage: document.getElementById("catalogItemImage"), catalogItemDescription: document.getElementById("catalogItemDescription"), catalogItemEnabled: document.getElementById("catalogItemEnabled"), catalogCategoryModalBackdrop: document.getElementById("catalogCategoryModalBackdrop"), catalogCategoryName: document.getElementById("catalogCategoryName"), catalogCategoryId: document.getElementById("catalogCategoryId"), catalogCategoryDescription: document.getElementById("catalogCategoryDescription"), catalogCategoryEnabled: document.getElementById("catalogCategoryEnabled"),
      itemsList: document.getElementById("itemsList"), itemsLoading: document.getElementById("itemsLoading"), itemsEmpty: document.getElementById("itemsEmpty"), itemsSearch: document.getElementById("itemsSearch"), itemsFilter: document.getElementById("itemsFilter"), itemsRefresh: document.getElementById("itemsRefresh"), itemsSentinel: document.getElementById("itemsSentinel"),
      lockedContainerSetupStatus: document.getElementById("lockedContainerSetupStatus"), lockedContainerModalStatus: document.getElementById("lockedContainerModalStatus"), lockedContainerInstalledSection: document.getElementById("lockedContainerInstalledSection"), lockedContainerInstalledGrid: document.getElementById("lockedContainerInstalledGrid"), lockedContainerAvailableGrid: document.getElementById("lockedContainerAvailableGrid"), eventIntegrationModalBackdrop: document.getElementById("eventIntegrationModalBackdrop"), eventIntegrationModalClose: document.getElementById("eventIntegrationModalClose"),
      itemModalBackdrop: document.getElementById("itemModalBackdrop"), itemModalTitle: document.getElementById("itemModalTitle"), itemModalSubtitle: document.getElementById("itemModalSubtitle"), itemModalPreviewImage: document.getElementById("itemModalPreviewImage"), itemModalPreviewName: document.getElementById("itemModalPreviewName"), itemModalPreviewClass: document.getElementById("itemModalPreviewClass"), itemModalPopularName: document.getElementById("itemModalPopularName"), itemModalImageUrl: document.getElementById("itemModalImageUrl"), itemModalSpawnEventName: document.getElementById("itemModalSpawnEventName"), itemModalEnabled: document.getElementById("itemModalEnabled"),
      spawnZonesCurrentZone: document.getElementById("spawnZonesCurrentZone"), spawnZonesNextZone: document.getElementById("spawnZonesNextZone"), spawnZonesEnabledCount: document.getElementById("spawnZonesEnabledCount"), spawnZonesVoteHistory: document.getElementById("spawnZonesVoteHistory"), spawnZonesActivePoll: document.getElementById("spawnZonesActivePoll"), spawnZonesNextSelect: document.getElementById("spawnZonesNextSelect"), spawnZonesSetNext: document.getElementById("spawnZonesSetNext"), spawnZonesApplyNext: document.getElementById("spawnZonesApplyNext"), spawnZonesApplyServer: document.getElementById("spawnZonesApplyServer"), spawnZonesCreatePoll: document.getElementById("spawnZonesCreatePoll"), spawnZonesRefreshPoll: document.getElementById("spawnZonesRefreshPoll"), spawnZonesFinalizePoll: document.getElementById("spawnZonesFinalizePoll"), spawnZonesRunAutomation: document.getElementById("spawnZonesRunAutomation"), spawnZonesAutomationStatus: document.getElementById("spawnZonesAutomationStatus"), spawnZonesWelcomeMessage: document.getElementById("spawnZonesWelcomeMessage"), spawnZonesWelcomeStatus: document.getElementById("spawnZonesWelcomeStatus"),
      spawnZonesMapTitle: document.getElementById("spawnZonesMapTitle"), spawnZonesMapHint: document.getElementById("spawnZonesMapHint"), spawnZonesAutosaveStatus: document.getElementById("spawnZonesAutosaveStatus"), spawnZonesMapViewport: document.getElementById("spawnZonesMapViewport"), spawnZonesMapInner: document.getElementById("spawnZonesMapInner"), spawnZonesMarkers: document.getElementById("spawnZonesMarkers"), spawnZonesMapTiles: document.getElementById("spawnZonesMapTiles"), spawnZonesMapZoomIn: document.getElementById("spawnZonesMapZoomIn"), spawnZonesMapZoomOut: document.getElementById("spawnZonesMapZoomOut"), spawnZonesMapZoomLabel: document.getElementById("spawnZonesMapZoomLabel"), spawnZonesCursor: document.getElementById("spawnZonesCursor"), spawnZoneCreate: document.getElementById("spawnZoneCreate"), spawnZoneImport: document.getElementById("spawnZoneImport"), spawnZoneImportFile: document.getElementById("spawnZoneImportFile"), spawnZoneList: document.getElementById("spawnZoneList"), spawnZonesPollChannel: document.getElementById("spawnZonesPollChannel"), spawnZonesPollCategory: document.getElementById("spawnZonesPollCategory"), spawnZonesPollQuestion: document.getElementById("spawnZonesPollQuestion"), spawnZonesPollOpenDay: document.getElementById("spawnZonesPollOpenDay"), spawnZonesPollOpenTime: document.getElementById("spawnZonesPollOpenTime"), spawnZonesPollCloseDay: document.getElementById("spawnZonesPollCloseDay"), spawnZonesPollCloseTime: document.getElementById("spawnZonesPollCloseTime"), spawnZonesPollTimezone: document.getElementById("spawnZonesPollTimezone"), spawnZonesMinVotes: document.getElementById("spawnZonesMinVotes"), spawnZonesTiePolicy: document.getElementById("spawnZonesTiePolicy"), spawnZonesAutoCreatePoll: document.getElementById("spawnZonesAutoCreatePoll"), spawnZonesRecurringPollAfterFinish: document.getElementById("spawnZonesRecurringPollAfterFinish"), spawnZonesAutoApplyWinner: document.getElementById("spawnZonesAutoApplyWinner"), spawnZonesApplyOnNextRestart: document.getElementById("spawnZonesApplyOnNextRestart"), spawnZonesSpawnFilePath: document.getElementById("spawnZonesSpawnFilePath"), spawnZonesServerName: document.getElementById("spawnZonesServerName"), spawnZonesSettingsStatus: document.getElementById("spawnZonesSettingsStatus"), spawnZonesTiePolicyHelp: document.getElementById("spawnZonesTiePolicyHelp"), spawnZonesApplyOnNextRestartRow: document.getElementById("spawnZonesApplyOnNextRestartRow"),
      organizationSummary: document.getElementById("organizationSummary"), organizationMembers: document.getElementById("organizationMembers"), organizationRefresh: document.getElementById("organizationRefresh"), organizationMemberDiscordId: document.getElementById("organizationMemberDiscordId"), organizationMemberRole: document.getElementById("organizationMemberRole"), organizationMemberSave: document.getElementById("organizationMemberSave"),
      managedServersSummary: document.getElementById("managedServersSummary"), managedServersList: document.getElementById("managedServersList"), managedServersRefresh: document.getElementById("managedServersRefresh"), managedServerCreateNew: document.getElementById("managedServerCreateNew"), managedServerCreatePanel: document.getElementById("managedServerCreatePanel"), managedServerSetupPanel: document.getElementById("managedServerSetupPanel"), managedServerFormTitle: document.getElementById("managedServerFormTitle"), managedServerFormStatus: document.getElementById("managedServerFormStatus"), managedServerSetupId: document.getElementById("managedServerSetupId"), managedServerSetupProgressText: document.getElementById("managedServerSetupProgressText"), managedServerSetupProgressBar: document.getElementById("managedServerSetupProgressBar"), managedServerOverviewNitrado: document.getElementById("managedServerOverviewNitrado"), managedServerOverviewDiscord: document.getElementById("managedServerOverviewDiscord"), managedServerOverviewPreflight: document.getElementById("managedServerOverviewPreflight"), managedServerOverviewRuntime: document.getElementById("managedServerOverviewRuntime"), managedServerNitradoState: document.getElementById("managedServerNitradoState"), managedServerDiscordState: document.getElementById("managedServerDiscordState"), managedServerPreflightState: document.getElementById("managedServerPreflightState"), managedServerPreflightIntro: document.getElementById("managedServerPreflightIntro"), managedServerPreflightRun: document.getElementById("managedServerPreflightRun"), managedServerRuntimeToggle: document.getElementById("managedServerRuntimeToggle"), managedServerRuntimePauseToggle: document.getElementById("managedServerRuntimePauseToggle"), managedServerRuntimeRetry: document.getElementById("managedServerRuntimeRetry"), managedServerRuntimeActivationMeta: document.getElementById("managedServerRuntimeActivationMeta"), managedServerRuntimeHealthMeta: document.getElementById("managedServerRuntimeHealthMeta"), managedServerPreflightSummary: document.getElementById("managedServerPreflightSummary"), managedServerPreflightChecks: document.getElementById("managedServerPreflightChecks"), managedServerName: document.getElementById("managedServerName"), managedServerId: document.getElementById("managedServerId"), managedServerNitradoConnection: document.getElementById("managedServerNitradoConnection"), managedServerNitradoDiscover: document.getElementById("managedServerNitradoDiscover"), managedServerNitradoServiceSelect: document.getElementById("managedServerNitradoServiceSelect"), managedServerNitradoServiceId: document.getElementById("managedServerNitradoServiceId"), managedServerNitradoBaseDir: document.getElementById("managedServerNitradoBaseDir"), managedServerNitradoValidationMeta: document.getElementById("managedServerNitradoValidationMeta"), managedServerDiscordConnection: document.getElementById("managedServerDiscordConnection"), managedServerDiscordDiscover: document.getElementById("managedServerDiscordDiscover"), managedServerDiscordGuildSelect: document.getElementById("managedServerDiscordGuildSelect"), managedServerDiscordGuildId: document.getElementById("managedServerDiscordGuildId"), managedServerDiscordGlobal: document.getElementById("managedServerDiscordGlobal"), managedServerDiscordDaily: document.getElementById("managedServerDiscordDaily"), managedServerDiscordWeekly: document.getElementById("managedServerDiscordWeekly"), managedServerDiscordOnlineCategory: document.getElementById("managedServerDiscordOnlineCategory"), managedServerSave: document.getElementById("managedServerSave"), managedServerNitradoSave: document.getElementById("managedServerNitradoSave"), managedServerDiscordSave: document.getElementById("managedServerDiscordSave"), managedServerCancel: document.getElementById("managedServerCancel"),
      playerMapUpdatedAt: document.getElementById("playerMapUpdatedAt"), playerMapSummary: document.getElementById("playerMapSummary"), playerMapRefresh: document.getElementById("playerMapRefresh"), playerMapZoomOut: document.getElementById("playerMapZoomOut"), playerMapZoomIn: document.getElementById("playerMapZoomIn"), playerMapZoomLabel: document.getElementById("playerMapZoomLabel"), playerMapViewport: document.getElementById("playerMapViewport"), playerMapInner: document.getElementById("playerMapInner"), playerMapMarkers: document.getElementById("playerMapMarkers"), playerMapSearch: document.getElementById("playerMapSearch"), playerMapList: document.getElementById("playerMapList"), playerMapVisibleCount: document.getElementById("playerMapVisibleCount")
    };
    function apiUrl(path) { const separator = path.includes("?") ? "&" : "?"; return adminToken ? path + separator + "token=" + encodeURIComponent(adminToken) : path; }
    async function apiFetch(path, options) { const headers = Object.assign({ "Content-Type": "application/json" }, (options && options.headers) || {}); if (adminToken) headers["x-admin-token"] = adminToken; return fetch(apiUrl(path), Object.assign({}, options || {}, { headers, credentials: "same-origin" })); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[char] || char)); }
    function icon(name, className) { return '<svg class="icon ' + escapeHtml(className || '') + '"><use href="#icon-' + escapeHtml(name) + '"></use></svg>'; }
    function formatNumber(value) { return new Intl.NumberFormat("pt-BR").format(Number(value || 0)); }
    function formatCoins(value) { return new Intl.NumberFormat("pt-BR").format(Number(value || 0)); }
    function formatBytes(value) { const bytes = Math.max(0, Number(value || 0)); if (bytes < 1024) return bytes + " B"; if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"; return (bytes / (1024 * 1024)).toFixed(2) + " MB"; }
    function relativeDate(value) { if (!value) return "Nunca"; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value); return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }
    function showToast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 3200); }
    const mobileMenuButton = document.getElementById("mobileMenuButton");
    const mobileNavBackdrop = document.getElementById("mobileNavBackdrop");
    const sidebar = document.querySelector(".sidebar");
    function setMobileMenuOpen(open) {
      if (!sidebar || !mobileNavBackdrop) return;
      sidebar.classList.toggle("open", open);
      mobileNavBackdrop.classList.toggle("open", open);
      document.body.classList.toggle("nav-open", open);
    }
    function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
    function renderHorizontalBars(containerId, rows, options) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const list = Array.isArray(rows) ? rows : [];
      const valueKey = options?.valueKey || "value";
      const labelKey = options?.labelKey || "label";
      const suffix = options?.suffix || "";
      const decimals = Number(options?.decimals || 0);
      const max = Math.max(1, ...list.map((row) => Number(row[valueKey] || 0)));

      if (!list.length) {
        container.innerHTML = '<div class="empty" style="padding:18px">Ainda não há histórico suficiente.</div>';
        return;
      }

      container.innerHTML = list.map((row) => {
        const value = Number(row[valueKey] || 0);
        const percent = Math.max(3, Math.min(100, (value / max) * 100));
        const valueLabel = value.toLocaleString("pt-BR", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }) + suffix;
        const meta = row.max ? '<div class="hbar-meta">máx. ' + escapeHtml(row.max) + '</div>' : '';
        return '<div class="hbar-row" title="' + escapeHtml(String(row[labelKey] || "—") + ': ' + valueLabel) + '">' +
          '<div class="hbar-label">' + escapeHtml(row[labelKey] || "—") + '</div>' +
          '<div class="hbar-track"><div class="hbar-fill" style="width:' + percent.toFixed(2) + '%"></div></div>' +
          '<div class="hbar-value">' + escapeHtml(valueLabel) + meta + '</div>' +
        '</div>';
      }).join("");
    }

    function renderPeakHours(rows) {
      renderHorizontalBars("peakHoursChart", rows, { valueKey: "average", labelKey: "label", decimals: 1 });
      const top = Array.isArray(rows) && rows.length ? rows[0] : null;
      const insight = document.getElementById("peakHoursInsight");
      if (!insight) return;
      insight.innerHTML = top
        ? icon("warning") + '<span>Pico estimado: <b>' + escapeHtml(top.label) + '</b> com média de <b>' + Number(top.average || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + '</b> jogadores online.</span>'
        : '';
    }

    function renderWeekdayActivity(rows) {
      const ordered = Array.isArray(rows) ? rows.slice().sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
      renderHorizontalBars("weekdayActivityChart", ordered, { valueKey: "kills", labelKey: "label", decimals: 0 });
      const top = ordered.slice().sort((a, b) => Number(b.kills || 0) - Number(a.kills || 0))[0];
      const insight = document.getElementById("weekdayActivityInsight");
      if (!insight) return;
      insight.innerHTML = top && Number(top.kills || 0) > 0
        ? icon("warning") + '<span>Dia mais ativo: <b>' + escapeHtml(top.label) + '</b> com <b>' + formatNumber(top.kills) + '</b> kills registradas.</span>'
        : icon("warning") + '<span>Aguardando histórico de kills para montar o ranking semanal.</span>';
    }
    async function loadOverview() {
      const response = await apiFetch("/admin-panel/api/overview");
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      els.serverName.textContent = payload.server.name;
      setText("metricOnline", payload.server.onlinePlayers + " / " + payload.server.maxPlayers);
      setText("metricOnlineHint", payload.server.onlinePlayers === 1 ? "1 jogador online agora" : payload.server.onlinePlayers + " jogadores online agora");
      setText("metricTotalPlayers", formatNumber(payload.server.totalPlayers));
      setText("metricTotalPlayersHint", payload.server.linkedMembers + " membros vinculados");
      setText("metricKillsToday", formatNumber(payload.combat.dailyKills));
      setText("metricKillsTodayHint", formatNumber(payload.combat.weeklyKills) + " kills na semana");
      setText("metricWeeklyKills", formatNumber(payload.combat.weeklyKills));
      setText("metricWeeklyKillsHint", "Média: " + Math.round(Number(payload.combat.weeklyKills || 0) / 7) + "/dia");
      setText("metricShopQueue", formatNumber(payload.shop.pending));
      setText("metricShopQueueHint", payload.shop.included + " incluídos · " + payload.shop.failed + " falhas");
      setText("metricCoinsBalance", formatCoins(payload.economy.totalCoins));
      setText("metricCoinsBalanceHint", payload.economy.wallets + " carteiras registradas");
      setText("overviewUpdatedAt", "Atualizado " + new Date(payload.generatedAt || Date.now()).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
      setText("opsParserStatus", payload.parser.lastProcessedAt ? "Online" : "Aguardando");
      const parserStatus = document.getElementById("opsParserStatus");
      if (parserStatus) parserStatus.className = "status-line " + (payload.parser.lastProcessedAt ? "success" : "warning");
      setText("opsParserMeta", payload.parser.lastProcessedAt ? "Última leitura " + relativeDate(payload.parser.lastProcessedAt) : "Sem leitura recente");
      setText("opsShopStatus", payload.shop.canAcceptPurchase ? "Online" : "Pausado");
      const shopStatus = document.getElementById("opsShopStatus");
      if (shopStatus) shopStatus.className = "status-line " + (payload.shop.canAcceptPurchase ? "success" : "warning");
      setText("opsShopMeta", payload.shop.pending + " pedidos pendentes");
      setText("opsMapEventsMeta", payload.mapEvents.mode || "Manual pelo painel");
      setText("opsQueueAlert", payload.shop.pending > 0 ? payload.shop.pending + " pedidos aguardando próximo reset" : "Nenhum pedido pendente na loja");
      renderPeakHours(payload.activity?.peakHours || []);
      renderWeekdayActivity(payload.activity?.weekdayActivity || []);
    }
    function memberAvatarHtml(member) {
      const initials = (member.discordName || member.gamertag || "?").slice(0, 2).toUpperCase();
      const image = member.avatarUrl
        ? '<img class="member-avatar-img" src="' + escapeHtml(member.avatarUrl) + '" alt="" loading="lazy" />'
        : '<div class="member-avatar-fallback">' + escapeHtml(initials) + '</div>';
      return '<div class="member-avatar-wrap">' + image + '<span class="presence-dot ' + (member.isOnline ? "online" : "") + '"></span></div>';
    }
    function memberCard(member) {
      const gamertagLabel = member.gamertag ? member.gamertag : "Sem gamertag vinculada";
      const economyDisabled = member.isLinked ? "" : " disabled";
      return '<article class="member-card" data-discord-id="' + escapeHtml(member.discordId) + '">' +
        memberAvatarHtml(member) +
        '<div><div class="member-name">' + escapeHtml(member.discordName) + '</div><div class="member-gamertag">' + escapeHtml(gamertagLabel) + '</div></div>' +
        '<div class="member-economy"><div class="wallet-number">' + formatCoins(member.balance) + ' coins</div><div class="member-meta">Earned ' + formatCoins(member.totalEarned) + ' · Spent ' + formatCoins(member.totalSpent) + '</div></div>' +
        '<div class="actions"><button class="mini-btn' + economyDisabled + '" data-action="add">Add</button><button class="mini-btn' + economyDisabled + '" data-action="remove">Remove</button><button class="mini-btn' + economyDisabled + '" data-action="set">Set</button></div>' +
      '</article>';
    }

    function transactionVisual(transaction) {
      const type = String(transaction.type || "UNKNOWN");
      const isPositive = ["ADMIN_ADD", "PLAYTIME_REWARD", "EVENT_REWARD", "DONATION_REWARD"].includes(type);
      const isNegative = ["ADMIN_REMOVE", "SHOP_PURCHASE"].includes(type);
      const icon = isPositive ? "+" : isNegative ? "−" : "=";
      const label = type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
      return { isPositive, isNegative, icon, label };
    }
    function transactionItem(transaction) {
      const visual = transactionVisual(transaction);
      const amountClass = visual.isPositive ? "positive" : visual.isNegative ? "negative" : "";
      const sign = visual.isPositive ? "+" : visual.isNegative ? "−" : "";
      const reason = transaction.reason ? escapeHtml(transaction.reason) : "Sem motivo informado";
      return '<div class="transaction-item">' +
        '<div class="tx-icon ' + amountClass + '">' + visual.icon + '</div>' +
        '<div><div class="tx-title">' + escapeHtml(visual.label) + '</div><div class="tx-meta">' + reason + '</div><div class="tx-meta">' + escapeHtml(relativeDate(transaction.createdAt)) + ' · ' + escapeHtml(transaction.createdBy || "system") + '</div><div class="tx-meta">' + formatCoins(transaction.balanceBefore) + ' → ' + formatCoins(transaction.balanceAfter) + '</div></div>' +
        '<div class="tx-amount ' + amountClass + '">' + sign + formatCoins(transaction.amount) + '</div>' +
      '</div>';
    }
    function renderDrawer(payload) {
      const member = payload.member;
      const drawerInitials = (member.discordName || member.gamertag || "??").slice(0, 2).toUpperCase();
      els.drawerAvatar.className = "member-avatar-wrap";
      els.drawerAvatar.innerHTML = (member.avatarUrl
        ? '<img class="member-avatar-img" src="' + escapeHtml(member.avatarUrl) + '" alt="" loading="lazy" />'
        : '<div class="member-avatar-fallback">' + escapeHtml(drawerInitials) + '</div>') + '<span class="presence-dot ' + (member.isOnline ? "online" : "") + '"></span>';
      els.drawerName.textContent = member.discordName || member.gamertag;
      els.drawerMeta.textContent = member.gamertag || "Sem gamertag vinculada";
      const transactions = payload.transactions || [];
      els.drawerBody.innerHTML =
        '<div class="drawer-card"><div class="drawer-stats">' +
          '<div class="drawer-stat"><span>Balance</span><b>' + formatCoins(member.balance) + '</b></div>' +
          '<div class="drawer-stat"><span>Earned</span><b>' + formatCoins(member.totalEarned) + '</b></div>' +
          '<div class="drawer-stat"><span>Spent</span><b>' + formatCoins(member.totalSpent) + '</b></div>' +
        '</div></div>' +
        '<div class="drawer-card"><div class="section-title"><h2>Perfil</h2><span class="chip ' + (member.status === "online" ? "online" : "") + '">' + (member.status === "online" ? "● Online" : "○ Offline") + '</span></div>' +
          '<div class="settings-list">' +
            '<div class="setting-row"><div><b>Gamertag</b><span>' + escapeHtml(member.gamertag || "Sem gamertag vinculada") + '</span></div></div>' +
            '<div class="setting-row"><div><b>Idioma</b><span>' + escapeHtml(member.locale.toUpperCase()) + '</span></div></div>' +
            '<div class="setting-row"><div><b>Reward progress</b><span>' + escapeHtml(String(member.onlineRewardMinutes || 0)) + ' minutos acumulados</span></div></div>' +
            '<div class="setting-row"><div><b>Último acesso</b><span>' + escapeHtml(relativeDate(member.lastSeenAt)) + '</span></div></div>' +
          '</div></div>' +
        '<div class="drawer-card"><div class="section-title"><h2>Histórico de transações</h2><span class="chip">últimas ' + transactions.length + '</span></div>' +
          (transactions.length ? '<div class="transaction-list">' + transactions.map(transactionItem).join("") + '</div>' : '<div class="drawer-empty">Nenhuma transação encontrada para este membro.</div>') +
        '</div>';
    }
    async function openMemberDrawer(discordId) {
      if (!discordId) return;
      state.selectedDiscordId = discordId;
      document.querySelectorAll(".member-card").forEach((card) => card.classList.toggle("selected", card.getAttribute("data-discord-id") === discordId));
      els.detailDrawer.classList.add("open");
      els.drawerBody.innerHTML = '<div class="drawer-skeleton"></div><div class="drawer-skeleton"></div><div class="drawer-skeleton"></div>';
      const response = await apiFetch("/admin-panel/api/members/" + encodeURIComponent(discordId));
      if (!response.ok) { showToast(await response.text()); return; }
      renderDrawer(await response.json());
    }
    function closeMemberDrawer() {
      state.selectedDiscordId = null;
      els.detailDrawer.classList.remove("open");
      document.querySelectorAll(".member-card").forEach((card) => card.classList.remove("selected"));
    }

    async function loadMembers(reset) {
      if (state.loadingMembers || (!state.hasMore && !reset)) return;
      if (reset) { state.cursor = 0; state.hasMore = true; els.memberList.innerHTML = ""; els.memberEmpty.style.display = "none"; }
      state.loadingMembers = true; els.memberLoading.style.display = "grid";
      const params = new URLSearchParams({ cursor: String(state.cursor), limit: "20", search: state.search, filter: state.filter, refresh: state.memberForceRefresh ? "true" : "false" });
      const response = await apiFetch("/admin-panel/api/members?" + params.toString());
      els.memberLoading.style.display = "none"; state.loadingMembers = false;
      if (!response.ok) { state.memberForceRefresh = false; showToast(await response.text()); return; }
      const payload = await response.json();
      state.memberForceRefresh = false;
      state.cursor = payload.nextCursor || state.cursor; state.hasMore = Boolean(payload.hasMore);
      const memberStats = payload.stats || {};
      setText("membersTotal", formatNumber(memberStats.totalMembers || 0));
      setText("membersLinked", formatNumber(memberStats.linkedMembers || 0));
      setText("membersUnlinked", formatNumber(memberStats.unlinkedMembers || 0));
      setText("membersOnline", formatNumber(memberStats.onlineMembers || 0));
      setText("membersOnlineHint", memberStats.discordError ? "fallback ativo" : "agora");
      els.memberList.insertAdjacentHTML("beforeend", payload.members.map(memberCard).join(""));
      els.memberEmpty.style.display = els.memberList.children.length ? "none" : "block";
    }

    function findCatalogCategory(categoryId) {
      return (state.catalog?.categories || []).find((category) => category.id === categoryId) || null;
    }
    function categoryIcon(category) {
      return category.emoji || "📁";
    }
    function showShopQueueView() {
      state.shopQueueModeBefore = state.catalogMode || "categories";
      state.catalogMode = "queue";
      els.catalogCategoryView.style.display = "none";
      els.catalogItemsView.style.display = "none";
      els.shopQueueView.style.display = "grid";
      loadShopQueue();
    }
    function hideShopQueueView() {
      state.catalogMode = state.catalogCategory ? "items" : "categories";
      els.shopQueueView.style.display = "none";
      renderCatalog();
    }
    function shopQueueMetric(label, value, hint) {
      return '<div class="card"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(String(value ?? '—')) + '</div><div class="metric-hint">' + escapeHtml(hint || '') + '</div></div>';
    }
    function shopQueueOrderHtml(order) {
      const thumb = order.imageUrl ? '<img src="' + escapeHtml(order.imageUrl) + '" alt="" loading="lazy" />' : icon("shopping-cart", "entity-icon");
      const statusClass = order.status === 'failed' ? 'danger' : order.status === 'spawned' ? 'success' : '';
      return '<article class="shop-queue-order">' +
        '<div class="shop-queue-thumb">' + thumb + '</div>' +
        '<div style="min-width:0"><div class="shop-queue-title">' + escapeHtml(order.itemName || order.itemClass) + '</div>' +
        '<div class="shop-queue-subtitle">' + escapeHtml(order.gamertag || 'Unlinked Discord user') + ' · ' + escapeHtml(order.itemClass || '') + '</div>' +
        '<div class="shop-queue-subtitle">Spawn: ' + escapeHtml([order.x, order.y, order.z].join(', ')) + '</div></div>' +
        '<div class="shop-queue-meta"><span class="chip ' + statusClass + '">' + escapeHtml(order.statusLabel || order.status) + '</span><br />' + escapeHtml(order.createdAt ? new Date(order.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—') + '</div>' +
        '</article>';
    }
    function renderShopQueue() {
      const payload = state.shopQueue;
      if (!payload) return;
      const counts = payload.counts || {};
      const runtime = payload.runtime || {};
      els.shopQueueStats.innerHTML = [
        shopQueueMetric('Total', counts.total || 0, 'pedidos registrados'),
        shopQueueMetric('Pending', counts.pending || 0, 'aguardando spawn'),
        shopQueueMetric('Next restart', counts.included || 0, 'incluídos no restart'),
        shopQueueMetric('Spawned', counts.spawned || 0, 'entregues'),
        shopQueueMetric('Failed', counts.failed || 0, 'falhas'),
      ].join('');
      els.shopQueueRuntime.textContent = runtime.canAcceptPurchase ? 'Checkout aberto' : 'Checkout fechado';
      const orders = payload.latest || [];
      if (!orders.length) {
        els.shopQueueList.innerHTML = '';
        els.shopQueueEmpty.style.display = 'block';
        return;
      }
      els.shopQueueEmpty.style.display = 'none';
      let lastDate = '';
      els.shopQueueList.innerHTML = orders.map((order) => {
        const date = order.dateLabel || 'Unknown date';
        const separator = date !== lastDate ? '<div class="shop-date-separator">' + escapeHtml(date) + '</div>' : '';
        lastDate = date;
        return separator + shopQueueOrderHtml(order);
      }).join('');
    }
    async function loadShopQueue() {
      if (els.shopQueueList) els.shopQueueList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
      const response = await apiFetch('/admin-panel/api/shop-queue');
      if (!response.ok) { showToast(await response.text()); return; }
      state.shopQueue = await response.json();
      renderShopQueue();
    }
    function shopHistoryItemHtml(transaction) {
      const thumb = transaction.imageUrl ? '<img src="' + escapeHtml(transaction.imageUrl) + '" alt="" loading="lazy" />' : icon("shopping-cart", "entity-icon");
      const statusClass = transaction.status === 'failed' ? 'danger' : transaction.status === 'spawned' ? 'success' : '';
      const amount = Number(transaction.amount || 0) > 0 ? formatCoins(transaction.amount) + ' coins' : '—';
      return '<article class="shop-history-item">' +
        '<div class="shop-history-thumb">' + thumb + '</div>' +
        '<div style="min-width:0"><div class="shop-history-title">' + escapeHtml(transaction.itemName || transaction.itemClass) + '</div>' +
        '<div class="shop-history-meta">' + escapeHtml(transaction.gamertag || 'Unlinked Discord user') + ' · ' + escapeHtml(transaction.itemClass || '') + '</div>' +
        '<div class="shop-history-meta">Spawn: ' + escapeHtml([transaction.x, transaction.y, transaction.z].join(', ')) + '</div></div>' +
        '<div class="shop-history-side"><span class="chip ' + statusClass + '">' + escapeHtml(transaction.statusLabel || transaction.status) + '</span><br />' + amount + '<br />' + escapeHtml(transaction.createdAt ? new Date(transaction.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—') + '</div>' +
      '</article>';
    }
    function renderShopHistoryDrawer(payload) {
      const transactions = payload.transactions || [];
      els.drawerAvatar.className = "avatar";
      els.drawerAvatar.innerHTML = icon("shopping-cart", "entity-icon");
      els.drawerName.textContent = "Shop transactions";
      els.drawerMeta.textContent = "Compras realizadas via /shop";
      let lastDate = '';
      const listHtml = transactions.length ? transactions.map((transaction) => {
        const date = transaction.dateLabel || 'Unknown date';
        const separator = date !== lastDate ? '<div class="shop-date-separator">' + escapeHtml(date) + '</div>' : '';
        lastDate = date;
        return separator + shopHistoryItemHtml(transaction);
      }).join('') : '<div class="drawer-empty">Nenhuma compra encontrada.</div>';
      els.drawerBody.innerHTML =
        '<div class="drawer-card shop-history-toolbar"><div class="section-title"><h2>Histórico de compras</h2><span class="chip">' + formatCoins(transactions.length) + ' registros</span></div>' +
        '<div class="search"><input id="shopHistorySearchInput" placeholder="Buscar por gamertag, item ou status" value="' + escapeHtml(state.shopHistorySearch || '') + '" /></div></div>' +
        '<div class="shop-history-list">' + listHtml + '</div>';
      const input = document.getElementById('shopHistorySearchInput');
      if (input) {
        let timer = null;
        input.addEventListener('input', (event) => {
          state.shopHistorySearch = event.target.value || '';
          clearTimeout(timer);
          timer = setTimeout(() => loadShopTransactions(state.shopHistorySearch), 260);
        });
        setTimeout(() => input.focus(), 80);
      }
    }
    async function loadShopTransactions(search) {
      els.drawerBody.innerHTML = '<div class="drawer-skeleton"></div><div class="drawer-skeleton"></div><div class="drawer-skeleton"></div>';
      const params = new URLSearchParams({ limit: '250', search: search || '' });
      const response = await apiFetch('/admin-panel/api/shop-transactions?' + params.toString());
      if (!response.ok) { showToast(await response.text()); return; }
      state.shopTransactions = await response.json();
      renderShopHistoryDrawer(state.shopTransactions);
    }
    function openShopHistoryDrawer() {
      state.selectedDiscordId = null;
      document.querySelectorAll(".member-card").forEach((card) => card.classList.remove("selected"));
      els.detailDrawer.classList.add("open");
      loadShopTransactions(state.shopHistorySearch || '');
    }
    function catalogCategoryCard(category) {
      const countLabel = formatCoins(category.itemCount || 0) + " item" + (Number(category.itemCount || 0) === 1 ? "" : "s");
      const deleteButton = Number(category.itemCount || 0) > 0
        ? ""
        : '<button class="mini-btn danger category-delete" data-category-action="delete" title="Excluir categoria">🗑</button>';
      return '<article class="catalog-category-card" data-category-id="' + escapeHtml(category.id) + '">' +
        '<button type="button" class="drag-handle" draggable="true" data-drag-type="category" title="Reordenar categoria">⋮⋮</button>' +
        deleteButton +
        '<div class="category-icon">' + escapeHtml(categoryIcon(category)) + '</div>' +
        '<div class="category-title">' + escapeHtml(category.label) + '</div>' +
        '<div class="category-subtitle">' + countLabel + '</div>' +
      '</article>';
    }
    function catalogNewCategoryCard() {
      return '<article class="catalog-category-card new" id="catalogNewCategoryCard"><div class="category-icon">＋</div><div class="category-title">Nova categoria</div><div class="category-subtitle">Criar uma nova pasta</div></article>';
    }
    function renderCatalogCategoryOptions(catalog) {
      const options = (catalog.categories || []).map((category) => '<option value="' + escapeHtml(category.id) + '">' + escapeHtml((category.emoji ? category.emoji + ' ' : '') + category.label) + '</option>');
      els.catalogItemCategory.innerHTML = options.join("");
    }
    function enterCatalogCategory(categoryId) {
      const category = findCatalogCategory(categoryId);
      if (!category) return;
      state.catalogCategory = category.id;
      state.catalogMode = "items";
      state.catalogSearch = "";
      if (els.catalogSearch) els.catalogSearch.value = "";
      renderCatalog();
    }
    function leaveCatalogCategory() {
      state.catalogCategory = "";
      state.catalogMode = "categories";
      state.catalogSearch = "";
      if (els.catalogSearch) els.catalogSearch.value = "";
      renderCatalog();
    }
    function catalogItemCard(item) {
      const thumb = item.imageUrl
        ? '<img src="' + escapeHtml(item.imageUrl) + '" alt="" loading="lazy" />'
        : icon("shopping-cart", "entity-icon");
      const enabledChip = item.enabled
        ? '<span class="chip online">● Active</span>'
        : '<span class="chip">○ Disabled</span>';
      const maxChip = item.maxPerRestart === null || item.maxPerRestart === undefined
        ? ''
        : '<span class="chip">Max ' + escapeHtml(String(item.maxPerRestart)) + '/restart</span>';
      const toggleLabel = item.enabled ? 'Desativar' : 'Ativar';
      return '<article class="catalog-item" data-item-id="' + escapeHtml(item.id) + '">' +
        '<button type="button" class="drag-handle" draggable="true" data-drag-type="item" title="Reordenar item">⋮⋮</button>' +
        '<div class="catalog-item-top"><div class="catalog-thumb">' + thumb + '</div>' +
        '<div><div class="catalog-name">' + escapeHtml(item.name) + '</div><div class="catalog-class">' + escapeHtml(item.className) + '</div></div>' +
        '<div class="catalog-price">' + formatCoins(item.price) + '</div></div>' +
        '<div class="catalog-description">' + escapeHtml(item.description || item.popularName || 'Sem descrição cadastrada.') + '</div>' +
        '<div class="catalog-meta"><span class="chip">' + escapeHtml(item.categoryLabel || item.category) + '</span>' + enabledChip + maxChip + '</div>' +
        '<div class="catalog-actions"><button class="mini-btn" data-catalog-action="edit">Editar</button><button class="mini-btn" data-catalog-action="toggle">' + toggleLabel + '</button><button class="mini-btn danger" data-catalog-action="delete">Excluir</button></div>' +
      '</article>';
    }
    function renderCatalog() {
      if (!state.catalog) return;
      renderCatalogCategoryOptions(state.catalog);

      const isQueue = state.catalogMode === "queue";
      const isItems = !isQueue && state.catalogMode === "items" && state.catalogCategory;
      els.shopQueueView.style.display = isQueue ? "grid" : "none";
      els.catalogCategoryView.style.display = (!isQueue && !isItems) ? "grid" : "none";
      els.catalogItemsView.style.display = isItems ? "grid" : "none";
      if (isQueue) { renderShopQueue(); return; }

      if (!isItems) {
        els.catalogCategoryGrid.innerHTML = (state.catalog.categories || []).map(catalogCategoryCard).join("") + catalogNewCategoryCard();
        els.catalogEmpty.style.display = "none";
        return;
      }

      const selectedCategory = state.catalogCategory;
      const category = findCatalogCategory(selectedCategory);
      els.catalogCurrentCategoryTitle.textContent = category ? category.label : "Itens";
      els.catalogCurrentCategoryLabel.textContent = category ? category.label : selectedCategory;
      const search = String(state.catalogSearch || "").trim().toLowerCase();
      const filtered = (state.catalog.items || []).filter((item) => {
        if (selectedCategory && item.category !== selectedCategory) return false;
        if (!search) return true;
        return [item.name, item.className, item.popularName, item.categoryLabel, item.category]
          .some((value) => String(value || "").toLowerCase().includes(search));
      });

      els.catalogGrid.innerHTML = filtered.map(catalogItemCard).join("");
      els.catalogEmpty.style.display = filtered.length ? "none" : "block";
    }
    async function loadCatalog() {
      els.catalogLoading.style.display = state.catalogMode === "items" ? "grid" : "none";
      const response = await apiFetch("/admin-panel/api/catalog");
      els.catalogLoading.style.display = "none";
      if (!response.ok) { showToast(await response.text()); return; }
      state.catalog = await response.json();
      if (state.catalogCategory && !findCatalogCategory(state.catalogCategory)) state.catalogCategory = "";
      renderCatalog();
    }
    function findCatalogItem(itemId) {
      return (state.catalog?.items || []).find((item) => item.id === itemId) || null;
    }
    function setCatalogAutocompleteOpen(open) {
      if (!els.catalogItemAutocomplete) return;
      els.catalogItemAutocomplete.classList.toggle("open", Boolean(open));
    }
    function renderCatalogAutocomplete(items) {
      if (!els.catalogItemAutocomplete) return;
      if (!items.length) {
        els.catalogItemAutocomplete.innerHTML = '<div class="autocomplete-subtitle" style="padding:12px">Nenhum item encontrado na base DayZ.</div>';
        setCatalogAutocompleteOpen(true);
        return;
      }
      els.catalogItemAutocomplete.innerHTML = items.map((item) => {
        const thumb = item.imageUrl
          ? '<img src="' + escapeHtml(item.imageUrl) + '" alt="" loading="lazy" />'
          : '<div class="autocomplete-fallback">' + icon("package", "entity-icon") + '</div>';
        return '<button type="button" class="autocomplete-option" data-class-name="' + escapeHtml(item.className) + '" data-popular-name="' + escapeHtml(item.popularName || item.className) + '" data-image-url="' + escapeHtml(item.imageUrl || '') + '">' +
          thumb + '<span><div class="autocomplete-title">' + escapeHtml(item.popularName || item.className) + '</div><div class="autocomplete-subtitle">' + escapeHtml(item.className) + '</div></span></button>';
      }).join("");
      setCatalogAutocompleteOpen(true);
    }
    let catalogAutocompleteTimer = null;
    async function searchCatalogBaseItems(query) {
      clearTimeout(catalogAutocompleteTimer);
      catalogAutocompleteTimer = setTimeout(async () => {
        const response = await apiFetch("/admin-panel/api/dayz-items?query=" + encodeURIComponent(query || "") + "&limit=12");
        if (!response.ok) return;
        const payload = await response.json();
        renderCatalogAutocomplete(payload.items || []);
      }, 180);
    }
    function applyCatalogBaseItem(item) {
      if (!item) return;
      els.catalogItemId.value = item.className || "";
      if (!els.catalogItemName.value.trim()) els.catalogItemName.value = item.popularName || item.className || "";
      if (!els.catalogItemImage.value.trim() && item.imageUrl) els.catalogItemImage.value = item.imageUrl;
      setCatalogAutocompleteOpen(false);
    }
    function openCatalogModal(mode, item) {
      const activeCategory = state.catalogCategory || (state.catalog?.categories?.[0]?.id || "misc");
      state.catalogModal = { mode, itemId: item?.id || null };
      els.catalogModalTitle.textContent = mode === "create" ? "Novo item" : "Editar item";
      els.catalogModalSubtitle.textContent = mode === "create" ? "Escolha um item da base DayZ e publique no shop." : "Atualize os dados exibidos no shop.";
      els.catalogItemId.disabled = mode !== "create";
      els.catalogItemId.value = item?.className || item?.id || "";
      renderCatalogCategoryOptions(state.catalog || { categories: [] });
      els.catalogItemCategory.value = item?.category || activeCategory;
      els.catalogItemName.value = item?.name || "";
      els.catalogItemPrice.value = item?.price ?? 0;
      els.catalogItemImage.value = item?.imageUrl || "";
      els.catalogItemDescription.value = item?.description || item?.popularName || "";
      els.catalogItemEnabled.checked = item?.enabled !== false;
      els.catalogItemAutocomplete.innerHTML = "";
      setCatalogAutocompleteOpen(false);
      els.catalogModalBackdrop.classList.add("open");
      setTimeout(() => (mode === "create" ? els.catalogItemId : els.catalogItemName).focus(), 80);
    }
    function closeCatalogModal() {
      state.catalogModal = null;
      setCatalogAutocompleteOpen(false);
      els.catalogModalBackdrop.classList.remove("open");
    }
    function readCatalogForm() {
      const selectedClassName = els.catalogItemId.value;
      return {
        id: state.catalogModal?.mode === "edit" ? state.catalogModal.itemId : selectedClassName,
        category: els.catalogItemCategory.value || state.catalogCategory || "misc",
        name: els.catalogItemName.value,
        className: selectedClassName,
        price: Number(els.catalogItemPrice.value || 0),
        imageUrl: els.catalogItemImage.value,
        description: els.catalogItemDescription.value,
        enabled: Boolean(els.catalogItemEnabled.checked),
      };
    }
    async function saveCatalogItem() {
      if (!state.catalogModal) return;
      const payload = readCatalogForm();
      const isCreate = state.catalogModal.mode === "create";
      const path = isCreate
        ? "/admin-panel/api/catalog/items"
        : "/admin-panel/api/catalog/items/" + encodeURIComponent(state.catalogModal.itemId);
      const response = await apiFetch(path, { method: isCreate ? "POST" : "PATCH", body: JSON.stringify(payload) });
      if (!response.ok) { showToast(await response.text()); return; }
      closeCatalogModal();
      showToast(isCreate ? "Item criado com sucesso." : "Item atualizado com sucesso.");
      await loadCatalog();
    }
    async function toggleCatalogItem(itemId) {
      const item = findCatalogItem(itemId);
      if (!item) return;
      const response = await apiFetch("/admin-panel/api/catalog/items/" + encodeURIComponent(itemId) + "/toggle", { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) });
      if (!response.ok) { showToast(await response.text()); return; }
      showToast(item.enabled ? "Item desativado." : "Item ativado.");
      await loadCatalog();
    }
    async function deleteCatalogItemAction(itemId) {
      const item = findCatalogItem(itemId);
      if (!item) return;
      if (!confirm("Excluir definitivamente o item " + item.name + "?")) return;
      const response = await apiFetch("/admin-panel/api/catalog/items/" + encodeURIComponent(itemId), { method: "DELETE" });
      if (!response.ok) { showToast(await response.text()); return; }
      showToast("Item excluído do catálogo.");
      await loadCatalog();
    }
    function openCatalogCategoryModal() {
      els.catalogCategoryName.value = "";
      els.catalogCategoryId.value = "";
      els.catalogCategoryDescription.value = "";
      els.catalogCategoryEnabled.checked = true;
      els.catalogCategoryModalBackdrop.classList.add("open");
      setTimeout(() => els.catalogCategoryName.focus(), 80);
    }
    function closeCatalogCategoryModal() {
      els.catalogCategoryModalBackdrop.classList.remove("open");
    }
    async function saveCatalogCategory() {
      const payload = {
        label: els.catalogCategoryName.value,
        id: els.catalogCategoryId.value,
        description: els.catalogCategoryDescription.value,
        enabled: Boolean(els.catalogCategoryEnabled.checked),
      };
      const response = await apiFetch("/admin-panel/api/catalog/categories", { method: "POST", body: JSON.stringify(payload) });
      if (!response.ok) { showToast(await response.text()); return; }
      const result = await response.json();
      closeCatalogCategoryModal();
      showToast("Categoria criada com sucesso.");
      await loadCatalog();
      if (result.category?.id) enterCatalogCategory(result.category.id);
    }
    async function deleteCatalogCategory(categoryId) {
      const category = findCatalogCategory(categoryId);
      if (!category) return;
      if (!confirm("Excluir a categoria " + category.label + "?")) return;
      const response = await apiFetch("/admin-panel/api/catalog/categories/" + encodeURIComponent(categoryId), { method: "DELETE" });
      if (!response.ok) { showToast(await response.text()); return; }
      showToast("Categoria excluída.");
      if (state.catalogCategory === categoryId) leaveCatalogCategory();
      await loadCatalog();
    }


    function dayzItemImageHtml(item) {
      const imageUrl = item?.imageUrl || item?.urlImg || "";
      return imageUrl ? '<img src="' + escapeHtml(imageUrl) + '" alt="" loading="lazy" />' : icon("package", "entity-icon");
    }
    function dayzItemRow(item) {
      const checked = item.enabled !== false ? "checked" : "";
      return '<article class="dayz-item-row" data-class-name="' + escapeHtml(item.className) + '">' +
        '<div class="dayz-item-main">' +
          '<div class="dayz-item-image">' + dayzItemImageHtml(item) + '</div>' +
          '<div class="dayz-item-copy"><div class="dayz-item-title">' + escapeHtml(item.popularName || item.className) + '</div><div class="dayz-item-subtitle">' + escapeHtml(item.className) + '</div></div>' +
        '</div>' +
        '<label class="switch" title="Habilitar/desabilitar item"><input data-item-switch="true" type="checkbox" ' + checked + ' /><span class="switch-slider"></span></label>' +
      '</article>';
    }
    function renderDayzItems(append) {
      const html = state.dayzItems.map(dayzItemRow).join("");
      els.itemsList.innerHTML = html;
      els.itemsEmpty.style.display = state.dayzItems.length ? "none" : "block";
    }
    async function loadDayzItems(reset) {
      if (state.itemsLoading) return;
      if (reset) {
        state.itemsCursor = 0;
        state.itemsHasMore = true;
        state.dayzItems = [];
        els.itemsList.innerHTML = "";
      }
      if (!state.itemsHasMore) return;
      state.itemsLoading = true;
      els.itemsLoading.style.display = "grid";
      const params = new URLSearchParams({ query: state.itemsSearch || "", filter: state.itemsFilter || "all", cursor: String(state.itemsCursor), limit: "30" });
      const response = await apiFetch("/admin-panel/api/items?" + params.toString());
      els.itemsLoading.style.display = "none";
      state.itemsLoading = false;
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      state.itemsStats = payload.stats || state.itemsStats;
      const incoming = payload.items || [];
      state.dayzItems = reset ? incoming : state.dayzItems.concat(incoming);
      state.itemsCursor = payload.nextCursor ?? (state.itemsCursor + incoming.length);
      state.itemsHasMore = Boolean(payload.hasMore);
      renderDayzItems(Boolean(!reset));
    }
    function findDayzItem(className) {
      return state.dayzItems.find((item) => item.className === className) || null;
    }
    function updateItemModalPreview() {
      const item = state.itemModal?.item;
      if (!item) return;
      const previewItem = { ...item, popularName: els.itemModalPopularName.value || item.popularName, imageUrl: els.itemModalImageUrl.value || "" };
      els.itemModalPreviewImage.innerHTML = dayzItemImageHtml(previewItem);
      els.itemModalPreviewName.textContent = previewItem.popularName || item.className;
      els.itemModalPreviewClass.textContent = item.className;
    }
    function openDayzItemModal(item) {
      if (!item) return;
      state.itemModal = { className: item.className, item };
      els.itemModalPreviewName.textContent = item.popularName || item.className;
      els.itemModalPreviewClass.textContent = item.className;
      els.itemModalPreviewImage.innerHTML = dayzItemImageHtml(item);
      els.itemModalPopularName.value = item.popularName || item.className;
      els.itemModalImageUrl.value = item.imageUrl || "";
      els.itemModalSpawnEventName.value = item.spawnEventName || "";
      els.itemModalEnabled.checked = item.enabled !== false;
      els.itemModalBackdrop.classList.add("open");
      setTimeout(() => els.itemModalPopularName.focus(), 80);
    }
    function closeDayzItemModal() {
      state.itemModal = null;
      els.itemModalBackdrop.classList.remove("open");
    }
    async function saveDayzItem() {
      if (!state.itemModal) return;
      const className = state.itemModal.className;
      const response = await apiFetch("/admin-panel/api/items/" + encodeURIComponent(className), {
        method: "PATCH",
        body: JSON.stringify({
          popularName: els.itemModalPopularName.value,
          imageUrl: els.itemModalImageUrl.value,
          spawnEventName: els.itemModalSpawnEventName.value,
          enabled: Boolean(els.itemModalEnabled.checked),
        }),
      });
      if (!response.ok) { showToast(await response.text()); return; }
      closeDayzItemModal();
      showToast("Item atualizado.");
      await loadDayzItems(true);
    }
    async function toggleDayzItem(className, enabled) {
      const response = await apiFetch("/admin-panel/api/items/" + encodeURIComponent(className) + "/toggle", { method: "PATCH", body: JSON.stringify({ enabled }) });
      if (!response.ok) { showToast(await response.text()); await loadDayzItems(true); return; }
      const payload = await response.json();
      const index = state.dayzItems.findIndex((item) => item.className === className);
      if (index >= 0 && payload.item) state.dayzItems[index] = payload.item;
      showToast(enabled ? "Item habilitado." : "Item desabilitado.");
      renderDayzItems(true);
    }

    function orderedCatalogCategoryIdsFromDom() {
      return Array.from(els.catalogCategoryGrid.querySelectorAll('.catalog-category-card[data-category-id]'))
        .map((card) => card.getAttribute('data-category-id'))
        .filter(Boolean);
    }
    function orderedCatalogItemIdsFromDom() {
      return Array.from(els.catalogGrid.querySelectorAll('.catalog-item[data-item-id]'))
        .map((card) => card.getAttribute('data-item-id'))
        .filter(Boolean);
    }
    function moveDragElement(container, selector, dragging, event) {
      const target = event.target.closest(selector);
      if (!target || target === dragging || target.id === 'catalogNewCategoryCard') return;
      const rect = target.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      container.insertBefore(dragging, before ? target : target.nextSibling);
    }
    function startCatalogDrag(event, type) {
      const card = event.target.closest(type === 'category' ? '.catalog-category-card[data-category-id]' : '.catalog-item[data-item-id]');
      if (!card || card.id === 'catalogNewCategoryCard') return;
      const id = card.getAttribute(type === 'category' ? 'data-category-id' : 'data-item-id');
      if (!id) return;
      state.catalogDrag = { type, id, element: card };
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
    }
    async function finishCatalogDrag() {
      const drag = state.catalogDrag;
      if (!drag) return;
      drag.element?.classList.remove('dragging');
      state.catalogDrag = null;
      state.catalogJustDragged = true;
      setTimeout(() => { state.catalogJustDragged = false; }, 120);

      try {
        if (drag.type === 'category') {
          const categoryIds = orderedCatalogCategoryIdsFromDom();
          const response = await apiFetch('/admin-panel/api/catalog/categories/reorder', {
            method: 'PATCH',
            body: JSON.stringify({ categoryIds }),
          });
          if (!response.ok) { showToast(await response.text()); await loadCatalog(); return; }
          const payload = await response.json();
          if (payload.catalog) state.catalog = payload.catalog;
          renderCatalog();
          showToast('Ordem das categorias atualizada.');
          return;
        }

        const categoryId = state.catalogCategory;
        const itemIds = orderedCatalogItemIdsFromDom();
        const response = await apiFetch('/admin-panel/api/catalog/categories/' + encodeURIComponent(categoryId) + '/items/reorder', {
          method: 'PATCH',
          body: JSON.stringify({ itemIds }),
        });
        if (!response.ok) { showToast(await response.text()); await loadCatalog(); return; }
        const payload = await response.json();
        if (payload.catalog) state.catalog = payload.catalog;
        renderCatalog();
        showToast('Ordem dos itens atualizada.');
      } catch (err) {
        showToast(String(err));
        await loadCatalog();
      }
    }


    function selectedMapEventPreset() {
      return (state.mapEventPresets || []).find((preset) => preset.id === state.selectedMapEventPresetId) || (state.mapEventPresets || [])[0] || null;
    }
    function applyMapEventPresetDefaults(preset) {
      if (!preset) return;
      state.selectedMapEventPresetId = preset.id;
      if (els.mapEventSelectedPreset) els.mapEventSelectedPreset.textContent = preset.name;
      if (els.mapEventName && !els.mapEventName.value) els.mapEventName.value = preset.name;
      if (els.mapEventQuantity) els.mapEventQuantity.value = preset.nominal || 1;
      if (els.mapEventLifetime) els.mapEventLifetime.value = preset.lifetime || 2400;
      if (els.mapEventSafeRadius) els.mapEventSafeRadius.value = preset.saferadius ?? 50;
      if (els.mapEventDistanceRadius) els.mapEventDistanceRadius.value = preset.distanceradius ?? 50;
      if (els.mapEventCleanupRadius) els.mapEventCleanupRadius.value = preset.cleanupradius ?? 250;
      renderMapEventPresets();
    }
    function renderMapEventPresets() {
      if (!els.mapEventPresetGrid) return;
      const presets = state.mapEventPresets || [];
      els.mapEventPresetGrid.innerHTML = presets.map((preset) => {
        const children = (preset.children || []).map((child) => '<span class="chip">' + escapeHtml(child.type) + '</span>').join('');
        const thumb = preset.imageUrl
          ? '<div class="preset-card-image"><img src="' + escapeHtml(preset.imageUrl) + '" alt="" loading="lazy" /></div>'
          : '<div class="preset-card-image">' + icon("package", "entity-icon") + '</div>';
        return '<button class="preset-card ' + (preset.id === state.selectedMapEventPresetId ? 'active' : '') + '" data-map-event-preset="' + escapeHtml(preset.id) + '">' +
          thumb +
          '<div class="preset-card-body">' +
            '<b>' + escapeHtml(preset.eventTypeLabel || preset.name) + '</b>' +
            '<p>' + escapeHtml(preset.description || '') + '</p>' +
            '<div class="preset-children"><span class="chip">Loot: ' + escapeHtml(preset.lootTypeLabel || 'Militar') + '</span>' + children + '</div>' +
          '</div>' +
        '</button>';
      }).join('') || '<div class="empty">Nenhum preset carregado.</div>';
    }
    async function loadMapEventPresets() {
      if (!els.mapEventPresetGrid) return;
      const response = await apiFetch('/admin-panel/api/map-events/presets');
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      state.mapEventPresets = payload.presets || [];
      if ((!state.selectedMapEventPresetId || !state.mapEventPresets.some((preset) => preset.id === state.selectedMapEventPresetId)) && state.mapEventPresets[0]) state.selectedMapEventPresetId = state.mapEventPresets[0].id;
      applyMapEventPresetDefaults(selectedMapEventPreset());
    }
    function setMapEventBuilderOpen(open) {
      state.mapEventBuilderOpen = Boolean(open);
      if (els.mapEventBuilder) els.mapEventBuilder.style.display = open ? '' : 'none';
      if (els.mapEventsNewToggle) els.mapEventsNewToggle.innerHTML = open ? 'Fechar criação' : '<svg class="icon"><use href="#icon-plus"></use></svg>Novo evento';
      if (open && els.mapEventDate && !els.mapEventDate.value) els.mapEventDate.value = new Date().toISOString().slice(0, 10);
      if (open && els.mapEventBuilder) setTimeout(() => els.mapEventBuilder.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
    }
    function formatScheduleDate(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    }
    function scheduledStatusLabel(status) {
      return ({ scheduled: 'Agendado', active: 'Ativo', paused: 'Pausado', completed: 'Executado', cancelled: 'Cancelado', failed: 'Falhou' })[status] || status || '—';
    }
    function recurrenceLabel(value) {
      return ({ none: 'Sem recorrência', daily: 'Diário', weekly: 'Semanal', monthly: 'Mensal' })[value] || 'Sem recorrência';
    }
    function renderScheduledMapEvents() {
      const events = state.scheduledMapEvents || [];
      if (els.mapEventsScheduledCount) els.mapEventsScheduledCount.textContent = String(events.filter((event) => ['scheduled','active'].includes(event.status)).length);
      if (els.mapEventsRecurringCount) els.mapEventsRecurringCount.textContent = String(events.filter((event) => event.recurrence && event.recurrence !== 'none' && event.status !== 'cancelled').length);
      const next = events.filter((event) => ['scheduled','active'].includes(event.status) && event.nextRunAt).sort((a,b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())[0];
      if (els.mapEventsNextRun) els.mapEventsNextRun.textContent = next ? formatScheduleDate(next.nextRunAt) : '—';
      if (els.mapEventsScheduleRuntime) els.mapEventsScheduleRuntime.textContent = events.length + ' evento(s)';
      if (els.mapEventsScheduledEmpty) els.mapEventsScheduledEmpty.style.display = events.length ? 'none' : '';
      if (!els.mapEventsScheduledList) return;
      els.mapEventsScheduledList.innerHTML = events.map((event) => {
        const preset = (state.mapEventPresets || []).find((item) => item.id === event.presetId) || {};
        const canPause = event.status === 'active' || event.status === 'scheduled';
        const canResume = event.status === 'paused' || event.status === 'failed';
        return '<div class="scheduled-event-card" data-scheduled-event-id="' + escapeHtml(event.id) + '">' +
          '<div class="scheduled-event-main">' +
            '<div class="scheduled-event-title"><span>' + escapeHtml(preset.eventTypeLabel || (event.eventType === 'airdrop' ? 'Airdrop' : 'Locked Container')) + ' · ' + escapeHtml(preset.lootTypeLabel || event.presetId) + '</span><span class="status-chip ' + escapeHtml(event.status || '') + '">' + escapeHtml(scheduledStatusLabel(event.status)) + '</span></div>' +
            '<div class="scheduled-event-meta"><span>' + escapeHtml(event.name || 'Evento') + '</span><span>' + escapeHtml(Number(event.x).toFixed(2) + ' / ' + Number(event.z).toFixed(2)) + '</span><span>Próxima: ' + escapeHtml(formatScheduleDate(event.nextRunAt || event.executeAt)) + '</span><span>' + escapeHtml(recurrenceLabel(event.recurrence)) + '</span></div>' +
            (event.lastError ? '<div class="scheduled-event-meta" style="color:#ff9a9f">Erro: ' + escapeHtml(event.lastError) + '</div>' : '') +
          '</div>' +
          '<div class="scheduled-event-actions">' +
            '<button class="ghost-btn" data-scheduled-action="run">Executar agora</button>' +
            (canPause ? '<button class="ghost-btn" data-scheduled-action="pause">Pausar</button>' : '') +
            (canResume ? '<button class="ghost-btn" data-scheduled-action="resume">Ativar</button>' : '') +
            '<button class="danger-btn" data-scheduled-action="delete">Cancelar</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    async function loadScheduledMapEvents() {
      if (!els.mapEventsScheduledList) return;
      const response = await apiFetch('/admin-panel/api/map-events/scheduled');
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      state.scheduledMapEvents = payload.events || [];
      renderScheduledMapEvents();
    }
    function getScheduledExecuteAt() {
      const date = els.mapEventDate?.value || new Date().toISOString().slice(0, 10);
      let time = els.mapEventTime?.value || 'now';
      if (time === 'now') return new Date().toISOString();
      if (time === 'next_reset') time = '00:00';
      if (time === 'custom') time = els.mapEventCustomTime?.value || '';
      if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('Informe um horário válido.');
      return new Date(date + 'T' + time + ':00').toISOString();
    }
    function updateMapEventExecutionUi() {
      const mode = document.querySelector('input[name="mapEventExecutionMode"]:checked')?.value || 'now';
      document.querySelectorAll('.schedule-mode').forEach((label) => label.classList.toggle('active', label.querySelector('input')?.checked));
      if (els.mapEventScheduleFields) els.mapEventScheduleFields.style.display = mode === 'scheduled' ? '' : 'none';
      if (els.mapEventsInject) els.mapEventsInject.style.display = mode === 'now' ? '' : 'none';
      if (els.mapEventsSchedule) els.mapEventsSchedule.style.display = mode === 'scheduled' ? '' : 'none';
      if (els.mapEventCustomTimeWrap) els.mapEventCustomTimeWrap.style.display = els.mapEventTime?.value === 'custom' ? '' : 'none';
    }
    async function scheduleMapEventAction() {
      const payload = readMapEventForm();
      if (!Number.isFinite(payload.x) || !Number.isFinite(payload.z) || !payload.x || !payload.z) { showToast('Informe coordenadas no formato X / Z.'); return; }
      try {
        const body = { ...payload, executeAt: getScheduledExecuteAt(), recurrence: els.mapEventRecurrence?.value || 'none' };
        const response = await apiFetch('/admin-panel/api/map-events/scheduled', { method: 'POST', body: JSON.stringify(body) });
        if (!response.ok) { const text = await response.text(); showToast(text); return; }
        await response.json();
        showToast('Evento agendado.');
        setMapEventBuilderOpen(false);
        await loadScheduledMapEvents();
      } catch (err) { showToast(String(err)); }
    }
    async function handleScheduledEventAction(eventId, action) {
      if (!eventId || !action) return;
      let response;
      if (action === 'run') response = await apiFetch('/admin-panel/api/map-events/scheduled/' + encodeURIComponent(eventId) + '/run', { method: 'POST', body: JSON.stringify({}) });
      if (action === 'pause') response = await apiFetch('/admin-panel/api/map-events/scheduled/' + encodeURIComponent(eventId) + '/status', { method: 'PATCH', body: JSON.stringify({ status: 'paused' }) });
      if (action === 'resume') response = await apiFetch('/admin-panel/api/map-events/scheduled/' + encodeURIComponent(eventId) + '/status', { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
      if (action === 'delete') {
        if (!confirm('Cancelar/remover este evento agendado?')) return;
        response = await apiFetch('/admin-panel/api/map-events/scheduled/' + encodeURIComponent(eventId), { method: 'DELETE' });
      }
      if (!response) return;
      if (!response.ok) { showToast(await response.text()); return; }
      showToast(action === 'run' ? 'Evento executado/injetado.' : 'Evento atualizado.');
      await loadScheduledMapEvents();
    }
    function mapEventItemThumb(item) {
      if (item && item.imageUrl) return '<div class="map-loot-thumb"><img src="' + escapeHtml(item.imageUrl) + '" alt="" loading="lazy" /></div>';
      return '<div class="map-loot-thumb">' + icon("package", "entity-icon") + '</div>';
    }
    function mapEventAutocompleteOption(item, target) {
      const thumb = item && item.imageUrl
        ? '<img src="' + escapeHtml(item.imageUrl) + '" alt="" loading="lazy" />'
        : '<div class="autocomplete-fallback">' + icon("package", "entity-icon") + '</div>';
      return '<button type="button" class="autocomplete-option" data-map-event-target="' + target + '" data-class-name="' + escapeHtml(item.className || '') + '" data-popular-name="' + escapeHtml(item.popularName || item.className || '') + '" data-image-url="' + escapeHtml(item.imageUrl || '') + '">' +
        thumb + '<span><div class="autocomplete-title">' + escapeHtml(item.popularName || item.className || '') + '</div><div class="autocomplete-subtitle">' + escapeHtml(item.className || '') + '</div></span></button>';
    }
    function setMapEventAutocompleteOpen(target, open) {
      const menu = target === 'storage' ? els.mapEventRewardStorageAutocomplete : els.mapEventGuaranteedItemAutocomplete;
      if (menu) menu.classList.toggle('open', Boolean(open));
    }
    function renderMapEventAutocomplete(target, items) {
      const menu = target === 'storage' ? els.mapEventRewardStorageAutocomplete : els.mapEventGuaranteedItemAutocomplete;
      if (!menu) return;
      if (!items.length) {
        menu.innerHTML = '<div class="autocomplete-subtitle" style="padding:12px">Nenhum item encontrado na base DayZ.</div>';
        setMapEventAutocompleteOpen(target, true);
        return;
      }
      menu.innerHTML = items.map((item) => mapEventAutocompleteOption(item, target)).join('');
      setMapEventAutocompleteOpen(target, true);
    }
    const mapEventSearchTimers = { storage: null, item: null };
    async function searchMapEventBaseItems(target, query) {
      clearTimeout(mapEventSearchTimers[target]);
      mapEventSearchTimers[target] = setTimeout(async () => {
        const response = await apiFetch('/admin-panel/api/dayz-items?query=' + encodeURIComponent(query || '') + '&limit=12');
        if (!response.ok) return;
        const payload = await response.json();
        renderMapEventAutocomplete(target, payload.items || []);
      }, 160);
    }
    function selectMapEventStorage(item) {
      if (!item || !item.className) return;
      state.mapEventRewardStorageItem = item;
      if (els.mapEventRewardStorage) els.mapEventRewardStorage.value = item.className;
      if (els.mapEventRewardStorageSearch) els.mapEventRewardStorageSearch.value = item.popularName || item.className;
      renderMapEventRewardStorage();
      setMapEventAutocompleteOpen('storage', false);
    }
    function addMapEventLootItem(item) {
      if (!item || !item.className) return;
      const existing = state.mapEventLootItems.find((entry) => entry.type === item.className);
      if (existing) existing.quantity = Math.min(50, Number(existing.quantity || 1) + 1);
      else state.mapEventLootItems.push({ type: item.className, quantity: 1, item });
      if (els.mapEventGuaranteedItemSearch) els.mapEventGuaranteedItemSearch.value = '';
      renderMapEventLootItems();
      setMapEventAutocompleteOpen('item', false);
    }
    function renderMapEventRewardStorage() {
      if (!els.mapEventRewardStorageSelected) return;
      const item = state.mapEventRewardStorageItem;
      const className = (els.mapEventRewardStorage && els.mapEventRewardStorage.value) || (item && item.className) || '';
      if (!className) {
        els.mapEventRewardStorageSelected.className = 'map-loot-selected is-empty';
        els.mapEventRewardStorageSelected.innerHTML = 'Nenhum storage selecionado.';
        return;
      }
      els.mapEventRewardStorageSelected.className = 'map-loot-selected';
      els.mapEventRewardStorageSelected.innerHTML = mapEventItemThumb(item) + '<div><div class="map-loot-title">' + escapeHtml((item && (item.popularName || item.className)) || className) + '</div><div class="map-loot-subtitle">' + escapeHtml(className) + '</div></div><button type="button" class="mini-btn" id="mapEventClearStorage">Limpar</button>';
      const clearButton = document.getElementById('mapEventClearStorage');
      if (clearButton) clearButton.addEventListener('click', () => { state.mapEventRewardStorageItem = null; if (els.mapEventRewardStorage) els.mapEventRewardStorage.value = ''; if (els.mapEventRewardStorageSearch) els.mapEventRewardStorageSearch.value = ''; renderMapEventRewardStorage(); });
    }
    function renderMapEventLootItems() {
      if (!els.mapEventGuaranteedItemsList) return;
      if (!state.mapEventLootItems.length) {
        els.mapEventGuaranteedItemsList.innerHTML = '<div class="map-loot-empty">Nenhum item adicionado. Use a busca acima para selecionar itens da base DayZ.</div>';
        return;
      }
      els.mapEventGuaranteedItemsList.innerHTML = state.mapEventLootItems.map((entry, index) => {
        const item = entry.item || { className: entry.type };
        return '<div class="map-loot-row" data-loot-index="' + index + '">' +
          mapEventItemThumb(item) +
          '<div><div class="map-loot-title">' + escapeHtml((item && (item.popularName || item.className)) || entry.type) + '</div><div class="map-loot-subtitle">' + escapeHtml(entry.type) + '</div></div>' +
          '<input type="number" min="1" max="50" step="1" value="' + escapeHtml(String(entry.quantity || 1)) + '" data-loot-quantity="' + index + '" />' +
          '<button type="button" class="mini-btn danger" data-loot-remove="' + index + '">Remover</button>' +
          '</div>';
      }).join('');
    }
    function updateMapEventLootModeUi() {
      const mode = els.mapEventLootMode?.value || 'rng';
      if (els.mapEventRewardStorageWrap) els.mapEventRewardStorageWrap.style.display = mode === 'guaranteed_container' ? '' : 'none';
      if (els.mapEventGuaranteedItemsWrap) els.mapEventGuaranteedItemsWrap.style.display = mode === 'guaranteed_container' || mode === 'guaranteed_items' ? '' : 'none';
      renderMapEventRewardStorage();
      renderMapEventLootItems();
    }

    const SPAWN_ZONE_WORLD_SIZE = 15360;
    function spawnZoneList() { return state.spawnZones?.zones || []; }
    function selectedSpawnZone() { return spawnZoneList().find((zone) => zone.id === state.selectedSpawnZoneId) || spawnZoneList()[0] || null; }
    function spawnZoneCoord(value) { return Number(value || 0).toFixed(1); }
    function setSpawnZonesAutosaveStatus(text) { if (els.spawnZonesAutosaveStatus) els.spawnZonesAutosaveStatus.textContent = text || 'auto-save'; }
    const SPAWN_ZONE_TILE_SIZE = 512;
    const SPAWN_ZONE_TILE_MAX_Z = 5;
    function spawnZoneTileLevel() {
      const zoom = Math.max(1, Number(state.spawnZoneMapZoom || 1));
      return Math.max(2, Math.min(SPAWN_ZONE_TILE_MAX_Z, Math.ceil(Math.log2(zoom)) + 2));
    }
    function spawnZoneTileSrc(z, x, y) {
      return '/admin-panel/api/spawn-zones/chernarus-map-tile/' + z + '/' + x + '/' + y + '.webp';
    }
    function scheduleSpawnZoneTileRender() {
      if (state.spawnZoneTileRenderFrame) return;
      state.spawnZoneTileRenderFrame = requestAnimationFrame(() => {
        state.spawnZoneTileRenderFrame = null;
        renderSpawnZoneTiles();
      });
    }
    function renderSpawnZoneTiles() {
      if (!els.spawnZonesMapTiles || !els.spawnZonesMapViewport || !els.spawnZonesMapInner) return;
      const innerWidth = els.spawnZonesMapInner.clientWidth || els.spawnZonesMapInner.getBoundingClientRect().width;
      if (!innerWidth) return;
      const z = spawnZoneTileLevel();
      const tileCount = Math.pow(2, z);
      const tileSize = innerWidth / tileCount;
      const scrollLeft = els.spawnZonesMapViewport.scrollLeft || 0;
      const scrollTop = els.spawnZonesMapViewport.scrollTop || 0;
      const viewWidth = els.spawnZonesMapViewport.clientWidth || innerWidth;
      const viewHeight = els.spawnZonesMapViewport.clientHeight || innerWidth;
      const pad = 1;
      const startX = Math.max(0, Math.floor(scrollLeft / tileSize) - pad);
      const endX = Math.min(tileCount - 1, Math.floor((scrollLeft + viewWidth) / tileSize) + pad);
      const startY = Math.max(0, Math.floor(scrollTop / tileSize) - pad);
      const endY = Math.min(tileCount - 1, Math.floor((scrollTop + viewHeight) / tileSize) + pad);
      const tiles = [];
      for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const left = x * tileSize;
          const top = y * tileSize;
          tiles.push('<img class="spawn-zone-map-tile" src="' + spawnZoneTileSrc(z, x, y) + '" draggable="false" loading="lazy" style="left:' + left + 'px;top:' + top + 'px;width:' + Math.ceil(tileSize + 1) + 'px;height:' + Math.ceil(tileSize + 1) + 'px" />');
        }
      }
      els.spawnZonesMapTiles.innerHTML = tiles.join('');
    }
    function setSpawnZoneMapZoom(value) {
      state.spawnZoneMapZoom = Math.max(1, Math.min(20, Number(value || 1)));
      if (els.spawnZonesMapInner) els.spawnZonesMapInner.style.setProperty('--spawn-map-zoom', String(state.spawnZoneMapZoom));
      if (els.spawnZonesMapZoomLabel) els.spawnZonesMapZoomLabel.textContent = Math.round(state.spawnZoneMapZoom * 100) + '%';
      scheduleSpawnZoneTileRender();
    }
    function spawnZoneEventCoords(event) {
      if (!els.spawnZonesMapInner) return null;
      const rect = els.spawnZonesMapInner.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const relativeX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const relativeY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      return { x: Number((relativeX * SPAWN_ZONE_WORLD_SIZE).toFixed(2)), z: Number(((1 - relativeY) * SPAWN_ZONE_WORLD_SIZE).toFixed(2)), relativeX, relativeY };
    }
    function switchSpawnZonesTab(tab) {
      state.spawnZonesTab = tab || 'rotation';
      document.querySelectorAll('[data-spawn-zone-tab]').forEach((button) => button.classList.toggle('active', button.dataset.spawnZoneTab === state.spawnZonesTab));
      ['rotation','points','settings'].forEach((key) => {
        const panel = document.getElementById('spawnZonesTab' + key.charAt(0).toUpperCase() + key.slice(1));
        if (panel) panel.classList.toggle('active', key === state.spawnZonesTab);
      });
      if (state.spawnZonesTab === 'points') renderSpawnZones();
    }
    function renderSpawnZonesSummary() {
      const zones = spawnZoneList();
      const current = zones.find((zone) => zone.id === state.spawnZones?.currentZoneId) || zones[0] || null;
      const next = zones.find((zone) => zone.id === state.spawnZones?.nextZoneId) || null;
      if (els.spawnZonesCurrentZone) els.spawnZonesCurrentZone.textContent = current ? current.name : '—';
      if (els.spawnZonesNextZone) els.spawnZonesNextZone.textContent = next ? next.name : '—';
      if (els.spawnZonesEnabledCount) els.spawnZonesEnabledCount.textContent = String(zones.filter((zone) => zone.enabled !== false).length);
      if (els.spawnZonesNextSelect) {
        const currentValue = els.spawnZonesNextSelect.value || state.spawnZones?.nextZoneId || selectedSpawnZone()?.id || '';
        els.spawnZonesNextSelect.innerHTML = zones.map((zone) => '<option value="' + escapeHtml(zone.id) + '" ' + (zone.enabled === false ? 'disabled' : '') + '>' + escapeHtml(zone.name || 'Zona') + ' (' + String((zone.points || []).length) + ' pts)' + (zone.enabled === false ? ' · desabilitada' : '') + '</option>').join('');
        if (zones.some((zone) => zone.id === currentValue)) els.spawnZonesNextSelect.value = currentValue;
        else if (state.spawnZones?.nextZoneId) els.spawnZonesNextSelect.value = state.spawnZones.nextZoneId;
      }
      const automation = state.spawnZones?.automation || {};
      if (els.spawnZonesAutomationStatus) {
        const intervalMinutes = automation.schedulerIntervalMs ? Math.round(Number(automation.schedulerIntervalMs || 0) / 60000) : 5;
        const lastChecked = automation.lastCheckedAt ? ('Último scheduler: ' + relativeDate(automation.lastCheckedAt) + ' (' + automation.lastCheckedAt + ')') : 'Automação ainda não executada.';
        const currentWindow = automation.currentWindowOpenAt && automation.currentWindowCloseAt ? (' · janela atual: ' + automation.currentWindowOpenAt + ' → ' + automation.currentWindowCloseAt) : '';
        const nextWindow = automation.nextWindowOpenAt && automation.nextWindowCloseAt ? (' · próxima: ' + automation.nextWindowOpenAt + ' → ' + automation.nextWindowCloseAt) : '';
        const activePollClose = automation.activePollClosesAt ? (' · enquete fecha: ' + automation.activePollClosesAt) : '';
        const activePollOverdue = Number(automation.activePollOverdueByMs || 0) > 0 ? (' · atraso fechamento: ' + Math.round(Number(automation.activePollOverdueByMs || 0) / 60000) + ' min') : '';
        const recurring = automation.nextRecurringPollAt ? (' · próxima recorrência: ' + automation.nextRecurringPollAt) : '';
        const category = automation.lastCategoryName ? (' · categoria: ' + automation.lastCategoryName) : '';
        const action = automation.lastAction ? (' · ação: ' + automation.lastAction) : '';
        const interval = ' · intervalo: ' + String(intervalMinutes) + ' min';
        const error = automation.lastError ? (' · erro: ' + automation.lastError) : '';
        els.spawnZonesAutomationStatus.textContent = lastChecked + interval + currentWindow + nextWindow + activePollClose + activePollOverdue + recurring + category + action + error;
      }
      const activePoll = state.spawnZones?.activePoll;
      if (els.spawnZonesActivePoll) {
        if (!activePoll) {
          els.spawnZonesActivePoll.className = 'settings-empty-note';
          els.spawnZonesActivePoll.innerHTML = 'Nenhuma enquete ativa.';
        } else {
          const rows = (activePoll.options || []).map((option) => '<div class="spawn-zone-poll-row"><div><b>' + escapeHtml(option.name || 'Zona') + '</b><span>' + escapeHtml(option.zoneId || '') + '</span></div><strong>' + String(Number(option.votes || 0)) + '</strong></div>').join('');
          const link = activePoll.rawUrl ? '<a class="chip" href="' + escapeHtml(activePoll.rawUrl) + '" target="_blank" rel="noreferrer">Abrir no Discord</a>' : '';
          els.spawnZonesActivePoll.className = 'spawn-zone-poll-result';
          els.spawnZonesActivePoll.innerHTML = '<div class="member-meta"><b>Enquete ' + escapeHtml(activePoll.status === 'closed' ? 'fechada' : 'ativa') + ':</b> ' + escapeHtml(activePoll.question || 'Map vote') + ' · ' + String(Number(activePoll.totalVotes || 0)) + ' votos ' + link + '</div>' + rows + (activePoll.winnerName ? '<div class="member-meta">Vencedor: <b>' + escapeHtml(activePoll.winnerName) + '</b></div>' : '') + (activePoll.finalReason ? '<div class="member-meta">' + escapeHtml(activePoll.finalReason) + '</div>' : '');
        }
      }
      const history = state.spawnZones?.voteHistory || [];
      if (els.spawnZonesVoteHistory) {
        els.spawnZonesVoteHistory.classList.toggle('settings-empty-note', !history.length);
        els.spawnZonesVoteHistory.classList.toggle('spawn-zone-history-list', history.length > 0);
        els.spawnZonesVoteHistory.innerHTML = history.length ? history.slice().reverse().map((item) => '<div class="spawn-zone-history-item"><div><b>' + escapeHtml(item.winnerName || item.winnerZoneId || 'Zona') + '</b><span class="member-meta">' + escapeHtml(item.appliedAt || item.closedAt || '') + '</span></div><span class="chip">' + escapeHtml(item.source || 'manual') + '</span></div>').join('') : 'Nenhuma rotação registrada ainda.';
      }
    }
    function setFormElementValue(element, value) {
      if (!element) return;
      if (document.activeElement === element) return;
      element.value = value == null ? '' : String(value);
    }
    function setSpawnZoneSettingsStatus(text, mode) {
      if (!els.spawnZonesSettingsStatus) return;
      els.spawnZonesSettingsStatus.textContent = text;
      els.spawnZonesSettingsStatus.className = 'spawn-zone-settings-status ' + (mode || '');
    }
    function readSpawnZoneSettingsForm() {
      const current = state.spawnZones?.settings || {};
      return {
        pollChannelId: els.spawnZonesPollChannel ? String(els.spawnZonesPollChannel.value || '').trim() : (current.pollChannelId || ''),
        pollCategoryId: els.spawnZonesPollCategory ? String(els.spawnZonesPollCategory.value || '').trim() : (current.pollCategoryId || ''),
        pollQuestion: els.spawnZonesPollQuestion ? String(els.spawnZonesPollQuestion.value || '').trim() : (current.pollQuestion || ''),
        pollOpenDay: els.spawnZonesPollOpenDay ? els.spawnZonesPollOpenDay.value : (current.pollOpenDay || 'monday'),
        pollOpenTime: els.spawnZonesPollOpenTime ? els.spawnZonesPollOpenTime.value : (current.pollOpenTime || '12:00'),
        pollCloseDay: els.spawnZonesPollCloseDay ? els.spawnZonesPollCloseDay.value : (current.pollCloseDay || 'sunday'),
        pollCloseTime: els.spawnZonesPollCloseTime ? els.spawnZonesPollCloseTime.value : (current.pollCloseTime || '23:59'),
        pollTimezone: els.spawnZonesPollTimezone ? String(els.spawnZonesPollTimezone.value || '').trim() : (current.pollTimezone || 'America/Sao_Paulo'),
        minVotes: els.spawnZonesMinVotes ? Number(els.spawnZonesMinVotes.value || 0) : Number(current.minVotes || 0),
        tiePolicy: els.spawnZonesTiePolicy ? els.spawnZonesTiePolicy.value : (current.tiePolicy || 'manual'),
        autoCreatePoll: els.spawnZonesAutoCreatePoll ? Boolean(els.spawnZonesAutoCreatePoll.checked) : Boolean(current.autoCreatePoll),
        recurringPollAfterFinish: els.spawnZonesRecurringPollAfterFinish ? Boolean(els.spawnZonesRecurringPollAfterFinish.checked) : Boolean(current.recurringPollAfterFinish),
        autoApplyWinner: els.spawnZonesAutoApplyWinner ? Boolean(els.spawnZonesAutoApplyWinner.checked) : Boolean(current.autoApplyWinner),
        applyOnNextRestart: els.spawnZonesApplyOnNextRestart ? Boolean(els.spawnZonesApplyOnNextRestart.checked) : current.applyOnNextRestart === true,
        spawnFilePath: els.spawnZonesSpawnFilePath ? String(els.spawnZonesSpawnFilePath.value || '').trim() : (current.spawnFilePath || ''),
        serverName: els.spawnZonesServerName ? String(els.spawnZonesServerName.value || '').trim() : (current.serverName || 'DayZ Server'),
        mapVoteWelcomeMessageId: current.mapVoteWelcomeMessageId || '',
      };
    }
    function buildSpawnZonesClientSnapshot() {
      const current = state.spawnZones || {};
      return {
        zones: Array.isArray(current.zones) ? current.zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          color: zone.color,
          enabled: zone.enabled !== false,
          points: Array.isArray(zone.points) ? zone.points.map((point) => ({ id: point.id, x: Number(point.x || 0), z: Number(point.z || 0), createdAt: point.createdAt, updatedAt: point.updatedAt })) : [],
          createdAt: zone.createdAt,
          updatedAt: zone.updatedAt,
        })) : [],
        currentZoneId: current.currentZoneId,
        nextZoneId: current.nextZoneId,
        voteHistory: current.voteHistory || [],
        activePoll: current.activePoll,
        automation: current.automation,
        settings: readSpawnZoneSettingsForm(),
        updatedAt: current.updatedAt,
      };
    }
    function updateSpawnZoneSettingsUx() {
      const tiePolicy = els.spawnZonesTiePolicy ? els.spawnZonesTiePolicy.value : (state.spawnZones?.settings?.tiePolicy || 'manual');
      const tieHelp = {
        manual: 'Se houver empate, a rotação fica aguardando decisão manual no painel.',
        keep_current: 'Se houver empate, o sistema mantém a zona atual e registra o resultado no histórico.',
        random: 'Se houver empate, o sistema sorteia automaticamente uma das zonas empatadas.',
      };
      if (els.spawnZonesTiePolicyHelp) els.spawnZonesTiePolicyHelp.textContent = tieHelp[tiePolicy] || tieHelp.manual;
      const autoApply = els.spawnZonesAutoApplyWinner ? Boolean(els.spawnZonesAutoApplyWinner.checked) : Boolean(state.spawnZones?.settings?.autoApplyWinner);
      if (els.spawnZonesApplyOnNextRestart) els.spawnZonesApplyOnNextRestart.disabled = !autoApply;
      if (els.spawnZonesApplyOnNextRestartRow) els.spawnZonesApplyOnNextRestartRow.classList.toggle('disabled', !autoApply);
    }
    function renderSpawnZonesSettings() {
      const settings = state.spawnZones?.settings || {};
      setFormElementValue(els.spawnZonesPollChannel, settings.pollChannelId || '');
      setFormElementValue(els.spawnZonesPollCategory, settings.pollCategoryId || '1515944927257825341');
      setFormElementValue(els.spawnZonesPollQuestion, settings.pollQuestion || 'Which arena do you want to play next week?');
      if (els.spawnZonesWelcomeStatus) els.spawnZonesWelcomeStatus.textContent = settings.mapVoteWelcomeMessageId ? ('Mensagem criada: ' + settings.mapVoteWelcomeMessageId) : 'Mensagem de entrada ainda não criada.';
      setFormElementValue(els.spawnZonesPollOpenDay, settings.pollOpenDay || 'monday');
      setFormElementValue(els.spawnZonesPollOpenTime, settings.pollOpenTime || '12:00');
      setFormElementValue(els.spawnZonesPollCloseDay, settings.pollCloseDay || 'sunday');
      setFormElementValue(els.spawnZonesPollCloseTime, settings.pollCloseTime || '23:59');
      setFormElementValue(els.spawnZonesPollTimezone, settings.pollTimezone || 'America/Sao_Paulo');
      setFormElementValue(els.spawnZonesMinVotes, String(settings.minVotes || 0));
      setFormElementValue(els.spawnZonesTiePolicy, settings.tiePolicy || 'manual');
      if (els.spawnZonesAutoCreatePoll && document.activeElement !== els.spawnZonesAutoCreatePoll) els.spawnZonesAutoCreatePoll.checked = Boolean(settings.autoCreatePoll);
      if (els.spawnZonesRecurringPollAfterFinish && document.activeElement !== els.spawnZonesRecurringPollAfterFinish) els.spawnZonesRecurringPollAfterFinish.checked = Boolean(settings.recurringPollAfterFinish);
      if (els.spawnZonesAutoApplyWinner && document.activeElement !== els.spawnZonesAutoApplyWinner) els.spawnZonesAutoApplyWinner.checked = Boolean(settings.autoApplyWinner);
      if (els.spawnZonesApplyOnNextRestart && document.activeElement !== els.spawnZonesApplyOnNextRestart) els.spawnZonesApplyOnNextRestart.checked = settings.applyOnNextRestart === true;
      setFormElementValue(els.spawnZonesSpawnFilePath, settings.spawnFilePath || '');
      setFormElementValue(els.spawnZonesServerName, settings.serverName || 'DayZ Server');
      updateSpawnZoneSettingsUx();
    }
    function renderSpawnZones() {
      renderSpawnZonesSummary();
      renderSpawnZonesSettings();
      const zones = spawnZoneList();
      if (!state.selectedSpawnZoneId && zones[0]) state.selectedSpawnZoneId = zones[0].id;
      const selected = selectedSpawnZone();
      if (els.spawnZonesMapTitle) els.spawnZonesMapTitle.textContent = selected ? selected.name : 'Selecione uma zona';
      if (els.spawnZonesMapHint) els.spawnZonesMapHint.textContent = selected ? 'Clique para adicionar em ' + selected.name + ' · scroll dá zoom · arraste para mover' : 'Crie uma zona para começar.';
      if (els.spawnZoneList) {
        els.spawnZoneList.innerHTML = zones.length ? zones.map((zone) => {
          const selectedClass = zone.id === state.selectedSpawnZoneId ? ' selected' : '';
          const checked = zone.enabled !== false ? 'checked' : '';
          const points = (zone.points || []).map((point) => '<div class="spawn-zone-point-row" data-spawn-point-id="' + escapeHtml(point.id) + '"><button type="button" data-spawn-point-focus="' + escapeHtml(point.id) + '">' + spawnZoneCoord(point.x) + ', ' + spawnZoneCoord(point.z) + '</button><button type="button" class="spawn-zone-mini-btn" data-spawn-point-delete="' + escapeHtml(point.id) + '" data-spawn-point-zone="' + escapeHtml(zone.id) + '">×</button></div>').join('');
          return '<article class="spawn-zone-card' + selectedClass + '" data-spawn-zone-id="' + escapeHtml(zone.id) + '">' +
            '<div class="spawn-zone-card-header">' +
              '<span class="spawn-zone-color" style="background:' + escapeHtml(zone.color || '#e11d48') + '"></span>' +
              '<div style="display:flex;align-items:center;gap:8px;min-width:0">' + (state.spawnZoneEditingNameId === zone.id ? '<input class="spawn-zone-name-input" value="' + escapeHtml(zone.name || 'Zona') + '" data-spawn-zone-name="' + escapeHtml(zone.id) + '" />' : '<div class="spawn-zone-name-label">' + escapeHtml(zone.name || 'Zona') + '</div>') + '<button type="button" class="ghost-btn spawn-zone-edit-name" data-spawn-zone-edit="' + escapeHtml(zone.id) + '" title="Editar nome">✎</button></div>' +
              '<span class="spawn-zone-count">(' + String((zone.points || []).length) + ')</span>' +
              '<div class="spawn-zone-actions"><label class="switch" title="Habilitar na votação"><input type="checkbox" data-spawn-zone-enabled="' + escapeHtml(zone.id) + '" ' + checked + ' /><span class="switch-slider"></span></label><button type="button" class="spawn-zone-mini-btn" data-spawn-zone-delete="' + escapeHtml(zone.id) + '">×</button></div>' +
            '</div>' +
            '<div class="spawn-zone-points">' + (points || '<div class="member-meta">Clique no mapa para adicionar pontos.</div>') + '</div>' +
          '</article>';
        }).join('') : '<div class="spawn-zone-empty">Nenhuma zona criada ainda.</div>';
      }
      setSpawnZoneMapZoom(state.spawnZoneMapZoom || 1);
      renderSpawnZoneMarkers();
      scheduleSpawnZoneTileRender();
    }
    function renderSpawnZoneMarkers() {
      if (!els.spawnZonesMarkers) return;
      const selected = selectedSpawnZone();
      const markers = [];
      spawnZoneList().forEach((zone) => {
        (zone.points || []).forEach((point) => {
          const left = Math.max(0, Math.min(100, (Number(point.x || 0) / SPAWN_ZONE_WORLD_SIZE) * 100));
          const top = Math.max(0, Math.min(100, (1 - Number(point.z || 0) / SPAWN_ZONE_WORLD_SIZE) * 100));
          const classes = ['spawn-zone-marker'];
          if (zone.id !== selected?.id) classes.push('other');
          if (zone.enabled === false) classes.push('disabled');
          if (point.id === state.highlightedSpawnPointId) classes.push('highlight');
          markers.push('<button type="button" class="' + classes.join(' ') + '" data-spawn-marker="' + escapeHtml(point.id) + '" data-spawn-marker-zone="' + escapeHtml(zone.id) + '" title="' + escapeHtml(zone.name || 'Zona') + ' · ' + spawnZoneCoord(point.x) + ', ' + spawnZoneCoord(point.z) + '" style="left:' + left + '%;top:' + top + '%;background:' + escapeHtml(zone.color || '#e11d48') + '"></button>');
        });
      });
      els.spawnZonesMarkers.innerHTML = markers.join('');
    }
    async function loadSpawnZones() {
      const response = await apiFetch('/admin-panel/api/spawn-zones');
      if (!response.ok) { showToast(await response.text()); return; }
      state.spawnZones = await response.json();
      if (!state.selectedSpawnZoneId || !spawnZoneList().some((zone) => zone.id === state.selectedSpawnZoneId)) state.selectedSpawnZoneId = spawnZoneList()[0]?.id || null;
      renderSpawnZones();
    }
    async function createSpawnZone() {
      setSpawnZonesAutosaveStatus('criando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones', { method: 'POST', body: JSON.stringify({ name: 'Nova zona' }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      state.selectedSpawnZoneId = spawnZoneList()[spawnZoneList().length - 1]?.id || state.selectedSpawnZoneId;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    async function importSpawnZoneXmlFile(file) {
      if (!file) return;
      const suggestedName = String(file.name || 'Spawn importado').replace(/\.xml$/i, '').replace(/[_-]+/g, ' ').trim() || 'Spawn importado';
      const zoneName = prompt('Nome da nova zona importada:', suggestedName);
      if (zoneName === null) { if (els.spawnZoneImportFile) els.spawnZoneImportFile.value = ''; return; }
      setSpawnZonesAutosaveStatus('importando...');
      try {
        const xml = await file.text();
        const response = await apiFetch('/admin-panel/api/spawn-zones/import', { method: 'POST', body: JSON.stringify({ name: zoneName, xml }) });
        if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
        state.spawnZones = await response.json();
        state.selectedSpawnZoneId = spawnZoneList()[spawnZoneList().length - 1]?.id || state.selectedSpawnZoneId;
        setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
        showToast('Zona importada do cfgplayerspawnpoints.xml.');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err));
        setSpawnZonesAutosaveStatus('erro');
      } finally {
        if (els.spawnZoneImportFile) els.spawnZoneImportFile.value = '';
      }
    }
    async function patchSpawnZone(zoneId, patch) {
      setSpawnZonesAutosaveStatus('salvando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones/' + encodeURIComponent(zoneId), { method: 'PATCH', body: JSON.stringify(patch || {}) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    async function deleteSpawnZone(zoneId) {
      const zone = spawnZoneList().find((item) => item.id === zoneId);
      if (!zone || !confirm('Excluir a zona ' + zone.name + '?')) return;
      setSpawnZonesAutosaveStatus('excluindo...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones/' + encodeURIComponent(zoneId), { method: 'DELETE' });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json(); state.selectedSpawnZoneId = spawnZoneList()[0]?.id || null;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    async function addSpawnZonePointFromEvent(event) {
      const zone = selectedSpawnZone();
      if (!zone || !els.spawnZonesMapInner) { showToast('Crie ou selecione uma zona primeiro.'); return; }
      state.selectedSpawnZoneId = zone.id;
      const coords = spawnZoneEventCoords(event);
      if (!coords) return;
      const { x, z } = coords;
      setSpawnZonesAutosaveStatus('salvando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones/' + encodeURIComponent(zone.id) + '/points', { method: 'POST', body: JSON.stringify({ x, z }) });
      if (!response.ok) {
        const message = await response.text();
        if (response.status === 404) await loadSpawnZones();
        showToast(message || 'Zona não encontrada. Recarreguei a lista de zonas.');
        setSpawnZonesAutosaveStatus('erro');
        return;
      }
      state.spawnZones = await response.json();
      if (!state.selectedSpawnZoneId || !spawnZoneList().some((item) => item.id === state.selectedSpawnZoneId)) state.selectedSpawnZoneId = zone.id;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    async function deleteSpawnZonePoint(zoneId, pointId) {
      setSpawnZonesAutosaveStatus('salvando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones/' + encodeURIComponent(zoneId) + '/points/' + encodeURIComponent(pointId), { method: 'DELETE' });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json(); state.highlightedSpawnPointId = null;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    async function setNextSpawnZone(zoneId) {
      if (!zoneId) return;
      setSpawnZonesAutosaveStatus('salvando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/rotation/next', { method: 'POST', body: JSON.stringify({ zoneId }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
      showToast('Próxima zona programada.');
    }
    async function applySpawnZone(zoneId) {
      if (!zoneId) return;
      if (!confirm('Aplicar esta zona como atual no painel?')) return;
      setSpawnZonesAutosaveStatus('aplicando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/rotation/apply', { method: 'POST', body: JSON.stringify({ zoneId }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      state.selectedSpawnZoneId = zoneId;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
      showToast('Zona aplicada no painel.');
    }
    function focusSpawnZonePoint(pointId) {
      let foundZone = null;
      let point = null;
      spawnZoneList().some((zone) => {
        const match = (zone.points || []).find((item) => item.id === pointId);
        if (match) { foundZone = zone; point = match; return true; }
        return false;
      });
      if (!point || !els.spawnZonesMapViewport) return;
      if (foundZone) state.selectedSpawnZoneId = foundZone.id;
      state.highlightedSpawnPointId = pointId;
      renderSpawnZones();
      if (els.spawnZonesCursor) els.spawnZonesCursor.textContent = 'X: ' + spawnZoneCoord(point.x) + ' | Z: ' + spawnZoneCoord(point.z);
      setTimeout(() => { state.highlightedSpawnPointId = null; renderSpawnZoneMarkers(); }, 1600);
    }

    function parseMapEventCoordinates(value) {
      const text = String(value || '').trim();
      const matches = text.match(/-?[0-9]+(?:[.,][0-9]+)?/g) || [];
      if (matches.length < 2) return { x: NaN, z: NaN };
      const x = Number(String(matches[0]).replace(',', '.'));
      const z = Number(String(matches[1]).replace(',', '.'));
      return { x, z };
    }
    function syncMapEventCoordinatesHiddenFields() {
      const parsed = parseMapEventCoordinates(els.mapEventCoordinates?.value || '');
      if (els.mapEventX) els.mapEventX.value = Number.isFinite(parsed.x) ? String(parsed.x) : '';
      if (els.mapEventZ) els.mapEventZ.value = Number.isFinite(parsed.z) ? String(parsed.z) : '';
      updateMapEventPinFromCoordinates(parsed.x, parsed.z);
      return parsed;
    }
    const MAP_EVENT_WORLD_SIZE = 15360;
    let mapEventMapZoom = 1;
    function clampMapEventValue(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
    function formatMapEventCoord(value) {
      return Number(value).toFixed(2);
    }
    function setMapEventCoordinateValue(x, z) {
      const safeX = clampMapEventValue(Number(x), 0, MAP_EVENT_WORLD_SIZE);
      const safeZ = clampMapEventValue(Number(z), 0, MAP_EVENT_WORLD_SIZE);
      if (els.mapEventCoordinates) els.mapEventCoordinates.value = formatMapEventCoord(safeX) + ' / ' + formatMapEventCoord(safeZ);
      if (els.mapEventX) els.mapEventX.value = String(Number(formatMapEventCoord(safeX)));
      if (els.mapEventZ) els.mapEventZ.value = String(Number(formatMapEventCoord(safeZ)));
      updateMapEventPinFromCoordinates(safeX, safeZ);
    }
    function updateMapEventPinFromCoordinates(x, z) {
      if (!els.mapEventMapPin) return;
      if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) {
        els.mapEventMapPin.style.display = 'none';
        return;
      }
      const safeX = clampMapEventValue(Number(x), 0, MAP_EVENT_WORLD_SIZE);
      const safeZ = clampMapEventValue(Number(z), 0, MAP_EVENT_WORLD_SIZE);
      els.mapEventMapPin.style.left = ((safeX / MAP_EVENT_WORLD_SIZE) * 100) + '%';
      els.mapEventMapPin.style.top = ((1 - safeZ / MAP_EVENT_WORLD_SIZE) * 100) + '%';
      els.mapEventMapPin.style.display = 'block';
    }
    let mapEventIsDragging = false;
    let mapEventDragMoved = false;
    let mapEventDragStartX = 0;
    let mapEventDragStartY = 0;
    let mapEventDragStartScrollLeft = 0;
    let mapEventDragStartScrollTop = 0;
    function setMapEventMapZoom(nextZoom, anchorEvent = null) {
      const previousZoom = mapEventMapZoom;
      const viewport = els.mapEventMapViewport;
      const beforeRect = viewport?.getBoundingClientRect();
      const anchorX = anchorEvent && beforeRect ? anchorEvent.clientX - beforeRect.left : beforeRect ? beforeRect.width / 2 : 0;
      const anchorY = anchorEvent && beforeRect ? anchorEvent.clientY - beforeRect.top : beforeRect ? beforeRect.height / 2 : 0;
      const scrollRatioX = viewport && previousZoom > 0 ? (viewport.scrollLeft + anchorX) / previousZoom : 0;
      const scrollRatioY = viewport && previousZoom > 0 ? (viewport.scrollTop + anchorY) / previousZoom : 0;

      mapEventMapZoom = clampMapEventValue(Number(nextZoom) || 1, 1, 12);
      if (els.mapEventMapInner) els.mapEventMapInner.style.setProperty('--map-zoom', String(mapEventMapZoom));
      if (els.mapEventMapZoomLabel) els.mapEventMapZoomLabel.textContent = Math.round(mapEventMapZoom * 100) + '%';
      if (viewport) viewport.classList.toggle('zoomed', mapEventMapZoom > 1.01);
      if (viewport && mapEventMapZoom !== previousZoom) {
        requestAnimationFrame(() => {
          if (mapEventMapZoom <= 1.01) {
            viewport.scrollLeft = 0;
            viewport.scrollTop = 0;
            return;
          }
          viewport.scrollLeft = Math.max(0, scrollRatioX * mapEventMapZoom - anchorX);
          viewport.scrollTop = Math.max(0, scrollRatioY * mapEventMapZoom - anchorY);
        });
      }
    }
    function handleMapEventMapWheel(event) {
      if (!els.mapEventMapViewport) return;
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const step = event.ctrlKey || event.metaKey ? 0.15 : 0.25;
      setMapEventMapZoom(mapEventMapZoom + direction * step, event);
    }
    function selectMapEventCoordinateFromPoint(event) {
      if (!els.mapEventMapInner) return;
      const rect = els.mapEventMapInner.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const relativeX = clampMapEventValue((event.clientX - rect.left) / rect.width, 0, 1);
      const relativeY = clampMapEventValue((event.clientY - rect.top) / rect.height, 0, 1);
      const x = relativeX * MAP_EVENT_WORLD_SIZE;
      const z = (1 - relativeY) * MAP_EVENT_WORLD_SIZE;
      setMapEventCoordinateValue(x, z);
    }
    function handleMapEventMapClick(event) {
      if (mapEventDragMoved) {
        mapEventDragMoved = false;
        return;
      }
      selectMapEventCoordinateFromPoint(event);
    }
    function handleMapEventMapPointerDown(event) {
      if (!els.mapEventMapViewport || mapEventMapZoom <= 1.01) return;
      if (event.button !== undefined && event.button !== 0) return;
      mapEventIsDragging = true;
      mapEventDragMoved = false;
      mapEventDragStartX = event.clientX;
      mapEventDragStartY = event.clientY;
      mapEventDragStartScrollLeft = els.mapEventMapViewport.scrollLeft;
      mapEventDragStartScrollTop = els.mapEventMapViewport.scrollTop;
      els.mapEventMapViewport.classList.add('dragging');
      try { els.mapEventMapViewport.setPointerCapture(event.pointerId); } catch (_) {}
    }
    function handleMapEventMapPointerMove(event) {
      if (!mapEventIsDragging || !els.mapEventMapViewport) return;
      const deltaX = event.clientX - mapEventDragStartX;
      const deltaY = event.clientY - mapEventDragStartY;
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) mapEventDragMoved = true;
      els.mapEventMapViewport.scrollLeft = mapEventDragStartScrollLeft - deltaX;
      els.mapEventMapViewport.scrollTop = mapEventDragStartScrollTop - deltaY;
      event.preventDefault();
    }
    function finishMapEventMapDrag(event) {
      if (!mapEventIsDragging) return;
      const shouldSelectPoint = !mapEventDragMoved && event.type === 'pointerup';
      mapEventIsDragging = false;
      if (els.mapEventMapViewport) {
        els.mapEventMapViewport.classList.remove('dragging');
        try { els.mapEventMapViewport.releasePointerCapture(event.pointerId); } catch (_) {}
      }
      if (shouldSelectPoint) {
        selectMapEventCoordinateFromPoint(event);
      }
      if (mapEventDragMoved) {
        setTimeout(() => { mapEventDragMoved = false; }, 0);
      }
    }
    function readMapEventForm() {
      const lootMode = 'rng';
      const coords = syncMapEventCoordinatesHiddenFields();
      return {
        presetId: state.selectedMapEventPresetId || 'locked_container_red_military',
        name: els.mapEventName?.value || '',
        x: coords.x,
        z: coords.z,
        angle: Number(els.mapEventAngle?.value || 0),
        quantity: 1,
        lifetime: 2400,
        safeRadius: Number(els.mapEventSafeRadius?.value || 500),
        distanceRadius: Number(els.mapEventDistanceRadius?.value || 500),
        cleanupRadius: Number(els.mapEventCleanupRadius?.value || 250),
        lootMode,
        rewardStorageClass: '',
        guaranteedItems: [],
      };
    }
    function setMapEventStatus(html) {
      if (els.mapEventStatus) els.mapEventStatus.innerHTML = html;
    }
    const eventIntegrations = {
      'locked-containers': {
        title: 'Locked Containers',
        description: 'Containers trancados com temas por cor: vermelho militar, azul médico, amarelo construção e laranja raid.',
        imageUrl: 'https://www.dayztools.de/itemdb2/icons/Land_ContainerLocked_Blue_DE.png',
        stateKey: 'lockedContainerSetup',
        checkUrl: '/admin-panel/api/settings/locked-containers/check',
        installUrl: '/admin-panel/api/settings/locked-containers/install',
        uninstallUrl: '/admin-panel/api/settings/locked-containers/uninstall',
        installText: 'Registra custom types, configura mapgroupproto e prepara as quatro cores de containers.',
      },
      'airdrop-military': {
        title: 'Super Airdrop Militar',
        description: 'Drop militar físico com container, fumaça de helicrash, loot posicionado por grupo e infected army.',
        imageUrl: 'https://www.dayztools.de/itemdb2/icons/Land_Container_1Moh_DE.png',
        stateKey: 'airdropMilitarySetup',
        checkUrl: '/admin-panel/api/settings/airdrops/military/check',
        installUrl: '/admin-panel/api/settings/airdrops/military/install',
        uninstallUrl: '/admin-panel/api/settings/airdrops/military/uninstall',
        installText: 'Adiciona/atualiza o grupo Panel_Airdrop_Military no cfgeventgroups.xml com três Wreck_UH1Y em triângulo e loot físico central.',
      },
    };
    function integrationStatus(integrationId) {
      const integration = eventIntegrations[integrationId] || eventIntegrations['locked-containers'];
      const status = state[integration.stateKey]?.status || 'unknown';
      return {
        status,
        installed: status === 'installed',
        label: status === 'installed' ? 'Instalado' : status === 'partial' ? 'Parcial' : status === 'not_installed' ? 'Não instalado' : 'Não verificado',
      };
    }
    function lockedContainerAppStatus() { return integrationStatus('locked-containers'); }
    function integrationCardHtml(integrationId, location) {
      const integration = eventIntegrations[integrationId] || eventIntegrations['locked-containers'];
      const current = integrationStatus(integrationId);
      const installed = current.installed;
      const action = installed ? icon('check') + ' Instalado' : 'Instalar';
      return '<button class="integration-card" type="button" data-integration="' + escapeHtml(integrationId) + '" data-location="' + location + '">' +
        '<div class="integration-card-head"><div class="integration-icon"><img src="' + escapeHtml(integration.imageUrl) + '" alt="" /></div>' +
        '<span class="integration-action ' + (installed ? 'installed' : '') + '">' + action + '</span></div>' +
        '<div><h3>' + escapeHtml(integration.title) + '</h3><p>' + escapeHtml(integration.description) + '</p></div>' +
        '<div class="integration-card-footer"><span class="member-meta">Events Settings</span><span class="chip ' + (installed ? 'success' : '') + '">' + escapeHtml(current.label) + '</span></div>' +
        '</button>';
    }
    function renderLockedContainerCards() {
      const ids = Object.keys(eventIntegrations);
      const installedIds = ids.filter((id) => integrationStatus(id).installed);
      const availableIds = ids.filter((id) => !integrationStatus(id).installed);
      if (els.lockedContainerInstalledSection) els.lockedContainerInstalledSection.style.display = installedIds.length ? '' : 'none';
      if (els.lockedContainerInstalledGrid) els.lockedContainerInstalledGrid.innerHTML = installedIds.map((id) => integrationCardHtml(id, 'installed')).join('');
      if (els.lockedContainerAvailableGrid) els.lockedContainerAvailableGrid.innerHTML = availableIds.length ? availableIds.map((id) => integrationCardHtml(id, 'available')).join('') : '<div class="settings-empty-note">Nenhum evento disponível para instalar agora.</div>';
    }
    function setupChecksHtml(result) {
      const checks = Array.isArray(result?.checks) ? result.checks : [];
      if (!result) return '<div class="settings-empty-note">Clique em Verificar instalação para ler os XMLs do servidor, ou abra o card para instalar o suporte.</div>';
      const status = result?.status || 'unknown';
      const label = status === 'installed' ? 'Instalado' : status === 'partial' ? 'Parcial' : status === 'not_installed' ? 'Não instalado' : 'Indisponível';
      return '<div class="alert-pill ' + (status === 'installed' ? 'success' : status === 'partial' ? 'warning' : '') + '">' + icon(status === 'installed' ? 'check' : 'warning') + '<span><b>Status: ' + escapeHtml(label) + '</b><br><span class="member-meta">' + escapeHtml(String((result?.total || 0) - (result?.missing || 0))) + '/' + escapeHtml(String(result?.total || 0)) + ' verificações OK</span></span></div>' +
        checks.map((check) => '<div class="ops-card"><div class="ops-icon ' + (check.ok ? 'kpi-green' : 'kpi-red') + '">' + icon(check.ok ? 'check' : 'warning') + '</div><div><b>' + escapeHtml(check.label) + '</b><span class="status-line ' + (check.ok ? 'success' : 'danger') + '">' + (check.ok ? 'OK' : 'Pendente') + '</span></div><small>' + escapeHtml(check.path || '') + '</small></div>').join('');
    }
    function activeIntegrationId() { return state.activeEventIntegrationId || 'locked-containers'; }
    function activeIntegration() { return eventIntegrations[activeIntegrationId()] || eventIntegrations['locked-containers']; }
    function renderLockedContainerSetupStatus(result) {
      const integration = activeIntegration();
      if (result) state[integration.stateKey] = result;
      const html = setupChecksHtml(state[integration.stateKey]);
      if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html;
      if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html;
      renderLockedContainerCards();
    }
    function renderLockedContainerLoading(label, detail) {
      const html = '<div class="settings-loader"><div class="settings-loader-title"><span class="spinner"></span><span><b>' + escapeHtml(label) + '</b><br><span class="member-meta">' + escapeHtml(detail || 'Isso pode levar até 1 minuto se o FTP da Nitrado estiver lento.') + '</span></span></div><div class="progress-bar"><span></span></div></div>';
      if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html;
      if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html;
    }
    let lockedContainerSetupBusy = false;
    function setLockedContainerButtonsDisabled(disabled) {
      ['lockedContainerCheck', 'lockedContainerInstall', 'lockedContainerUninstall'].forEach((key) => {
        if (els[key]) els[key].disabled = Boolean(disabled);
      });
    }
    async function readApiError(response) {
      try { const data = await response.json(); return data?.error || JSON.stringify(data); }
      catch (_) { return await response.text(); }
    }
    async function checkLockedContainerSetupAction(showDoneToast = true) {
      if (lockedContainerSetupBusy) return;
      lockedContainerSetupBusy = true;
      setLockedContainerButtonsDisabled(true);
      try {
        renderLockedContainerLoading('Verificando instalação...', 'Lendo cfgeconomycore.xml, mapgroupproto.xml e locked-container-types.xml.');
        const response = await apiFetch(activeIntegration().checkUrl);
        if (!response.ok) { const text = await readApiError(response); const html = '<div class="map-event-result"><b>Erro:</b> ' + escapeHtml(text) + '</div>'; if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html; if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html; showToast(text); return; }
        const result = await response.json(); renderLockedContainerSetupStatus(result); if (showDoneToast) showToast('Instalação verificada.');
      } finally { lockedContainerSetupBusy = false; setLockedContainerButtonsDisabled(false); }
    }
    async function installLockedContainerSetupAction() {
      if (lockedContainerSetupBusy) return;
      if (!confirm('Instalar/reparar ' + activeIntegration().title + '? Faça backup dos XMLs antes.')) return;
      lockedContainerSetupBusy = true; setLockedContainerButtonsDisabled(true);
      try {
        renderLockedContainerLoading('Instalando suporte...', 'Atualizando XMLs base do servidor. Não feche esta tela até terminar.');
        const response = await apiFetch(activeIntegration().installUrl, { method: 'POST', body: JSON.stringify({}) });
        if (!response.ok) { const text = await readApiError(response); const html = '<div class="map-event-result"><b>Erro:</b> ' + escapeHtml(text) + '</div>'; if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html; if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html; showToast(text); return; }
        state[activeIntegration().stateKey] = { status: 'installed', total: 0, missing: 0, checks: [] };
        renderLockedContainerSetupStatus(state[activeIntegration().stateKey]);
        const html = '<div class="map-event-result success"><b>Suporte instalado/reparado.</b><br>Clique em Verificar instalação para conferir os arquivos.</div>';
        if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html;
        if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html;
        renderLockedContainerCards(); showToast(activeIntegration().title + ' instalado/reparado.');
      } finally { lockedContainerSetupBusy = false; setLockedContainerButtonsDisabled(false); }
    }
    async function uninstallLockedContainerSetupAction() {
      if (lockedContainerSetupBusy) return;
      if (!confirm('Desinstalar ' + activeIntegration().title + '? Eventos existentes podem parar de funcionar após o próximo restart.')) return;
      if (!confirm('Confirma mesmo assim? Essa ação remove os blocos gerenciados do mapgroupproto.xml e desregistra o arquivo custom.')) return;
      lockedContainerSetupBusy = true; setLockedContainerButtonsDisabled(true);
      try {
        renderLockedContainerLoading('Desinstalando suporte...', 'Removendo blocos gerenciados dos XMLs base.');
        const response = await apiFetch(activeIntegration().uninstallUrl, { method: 'POST', body: JSON.stringify({}) });
        if (!response.ok) { const text = await readApiError(response); const html = '<div class="map-event-result"><b>Erro:</b> ' + escapeHtml(text) + '</div>'; if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html; if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html; showToast(text); return; }
        state[activeIntegration().stateKey] = { status: 'not_installed', total: 0, missing: 0, checks: [] };
        const html = '<div class="map-event-result success"><b>Suporte desinstalado.</b><br>Use Verificar instalação para conferir os arquivos.</div>';
        if (els.lockedContainerSetupStatus) els.lockedContainerSetupStatus.innerHTML = html;
        if (els.lockedContainerModalStatus) els.lockedContainerModalStatus.innerHTML = html;
        renderLockedContainerCards(); showToast(activeIntegration().title + ' desinstalado.');
      } finally { lockedContainerSetupBusy = false; setLockedContainerButtonsDisabled(false); }
    }
    function openLockedContainerIntegrationModal(integrationId = 'locked-containers') { state.activeEventIntegrationId = integrationId; const integration = activeIntegration(); const title = document.querySelector('.integration-modal-title h2'); const desc = document.querySelector('.integration-modal-title p'); const img = document.querySelector('.integration-modal-title img'); const feature = document.querySelector('.integration-feature-list'); if (title) title.textContent = integration.title; if (desc) desc.textContent = integration.description; if (img) img.src = integration.imageUrl; if (feature) feature.innerHTML = '<li>✓ ' + escapeHtml(integration.installText) + '</li><li>✓ Mantém a criação/agendamento dentro da tela Eventos do Mapa.</li><li>✓ Pode ser verificado, reparado ou desinstalado por esta tela.</li>'; renderLockedContainerSetupStatus(); if (els.eventIntegrationModalBackdrop) els.eventIntegrationModalBackdrop.classList.add('open'); }
    function renderServiceSettings() {
      const list = document.getElementById('serviceSettingsList');
      const summary = document.getElementById('serviceSettingsSummary');
      const metrics = document.getElementById('neonPersistenceMetrics');
      if (!list || !summary) return;
      const settings = state.serviceSettings || { shopEnabled:true, livePresenceEnabled:true, storePresenceHistory:true };
      const rows = [
        { key:'shopEnabled', title:'Shop service', description:'Pauses purchases, automatic delivery monitoring, shop commands and the Player Portal store. Catalog and history are preserved.', warning:'Existing orders remain stored and can continue when the service is re-enabled.' },
        { key:'livePresenceEnabled', title:'Live presence', description:'Keeps the current online player list and Discord online category active.', locked:true },
        { key:'storePresenceHistory', title:'Store presence history', description:'Stores 15-minute online player samples for future charts and historical analysis.' },
      ];
      const active = rows.filter((row) => settings[row.key] !== false).length;
      summary.innerHTML = '<span class="chip online">' + active + ' ativos</span><span class="chip">' + (rows.length - active) + ' pausados</span>';
      list.innerHTML = rows.map((row) => {
        const enabled = settings[row.key] !== false;
        const disabled = Boolean(row.locked);
        return '<div class="command-setting-row ' + (enabled ? '' : 'is-disabled') + '">' +
          '<div><div class="command-setting-name"><strong>' + escapeHtml(row.title) + '</strong>' + (row.locked ? '<span class="chip">Core</span>' : '<span class="chip">Optional</span>') + '</div>' +
          '<div class="command-setting-description">' + escapeHtml(row.description) + (row.warning ? '<br><span style="color:var(--text-3)">' + escapeHtml(row.warning) + '</span>' : '') + '</div></div>' +
          '<button class="ios-switch" type="button" role="switch" aria-checked="' + (enabled ? 'true' : 'false') + '" data-service-toggle="' + row.key + '" ' + (disabled ? 'disabled title="Always active"' : '') + '></button>' +
        '</div>';
      }).join('');
      if (metrics && state.persistenceMetrics) {
        const m = state.persistenceMetrics;
        const discordRuntime = state.discordRuntimeMetrics || {};
        const domainV2 = state.domainPersistenceMetrics || {};
        const granularPlayers = state.granularPlayerStatsMetrics || {};
        const domainRows = domainV2.domains || {};
        const positionHistory = state.playerPositionHistoryMetrics || {};
        const adm = state.admDownloadMetrics || {};
        const runtime = state.runtimeMetrics || {};
        const serverRuntimeObservability = Array.isArray(state.serverRuntimeObservability) ? state.serverRuntimeObservability : [];
        const network = state.networkMetrics || {};
        const reasons = Object.entries(m.reasons || {})
          .map(([reason, value]) => ({ reason, ...(value || {}) }))
          .sort((a, b) => Number(b.contributedWrites || 0) - Number(a.contributedWrites || 0) || Number(b.saveRequests || 0) - Number(a.saveRequests || 0));
        const sections = Array.isArray(m.lastPayloadSections) ? m.lastPayloadSections : [];
        const detailed = Array.isArray(m.detailedSections) ? m.detailedSections : [];
        const recentWrites = Array.isArray(m.recentWrites) ? m.recentWrites.slice(-20).reverse() : [];
        const admFiles = Array.isArray(adm.files) ? adm.files : [];
        const admServers = Array.isArray(adm.servers) ? adm.servers : [];
        const admShadow = adm.shadow || {};
        const admStrategy = adm.strategy || {};
        const shadowDecisions = Array.isArray(admShadow.recentDecisions) ? admShadow.recentDecisions.slice(-20).reverse() : [];
        const recentCycles = Array.isArray(runtime.recentCycles) ? runtime.recentCycles.slice(-12).reverse() : [];
        const networkServices = Array.isArray(network.services) ? network.services : [];
        const networkTransfers = Array.isArray(network.recentTransfers) ? network.recentTransfers.slice(-20).reverse() : [];
        const httpRoutes = Array.isArray(network.httpRoutes) ? network.httpRoutes.slice(0, 30) : [];
        const largeHttpResponses = Array.isArray(network.recentLargeHttpResponses) ? network.recentLargeHttpResponses.slice(-20).reverse() : [];
        const positionSamples = Array.isArray(positionHistory.recentSamples) ? positionHistory.recentSamples.slice(-20).reverse() : [];
        const positionSampleRows = positionSamples.length ? positionSamples.map((item) =>
          '<tr><td>' + escapeHtml(item.observedAt ? relativeDate(item.observedAt) : '-') + '</td>' +
          '<td>' + escapeHtml(item.playerName || '-') + '</td>' +
          '<td>' + escapeHtml(item.eventType || '-') + '</td>' +
          '<td>' + (item.x == null ? '-' : Number(item.x).toFixed(1)) + '</td>' +
          '<td>' + (item.z == null ? '-' : Number(item.z).toFixed(1)) + '</td>' +
          '<td><code>' + escapeHtml(item.sourceFile ? String(item.sourceFile).split('/').pop() : '-') + '</code></td></tr>'
        ).join('') : '<tr><td colspan="6" class="member-meta">No player position observations captured yet.</td></tr>';
        const networkServiceRows = networkServices.length ? networkServices.map((item) =>
          '<tr><td><code>' + escapeHtml(item.service || '-') + '</code></td>' +
          '<td>' + Number(item.requests || 0).toLocaleString() + '</td>' +
          '<td>' + formatBytes(Number(item.outboundBytes || 0)) + '</td>' +
          '<td>' + formatBytes(Number(item.inboundBytes || 0)) + '</td>' +
          '<td>' + formatBytes(Number(item.httpResponseBytes || 0)) + '</td>' +
          '<td>' + Number(item.failures || 0).toLocaleString() + '</td></tr>'
        ).join('') : '<tr><td colspan="6" class="member-meta">No measured network activity yet.</td></tr>';
        const networkTransferRows = networkTransfers.length ? networkTransfers.map((item) =>
          '<tr><td>' + escapeHtml(item.at ? relativeDate(item.at) : '-') + '</td>' +
          '<td><code>' + escapeHtml(item.service || '-') + '</code></td>' +
          '<td>' + escapeHtml(item.direction || '-') + '</td>' +
          '<td>' + formatBytes(Number(item.bytes || 0)) + '</td>' +
          '<td>' + escapeHtml(item.operation || '-') + '</td>' +
          '<td>' + (item.ok === false ? 'Error' : 'OK') + '</td></tr>'
        ).join('') : '<tr><td colspan="6" class="member-meta">No recent transfers yet.</td></tr>';
        const httpRouteRows = httpRoutes.length ? httpRoutes.map((item) =>
          '<tr><td><code>' + escapeHtml(item.operation || '-') + '</code></td>' +
          '<td>' + Number(item.requests || 0).toLocaleString() + '</td>' +
          '<td>' + formatBytes(Number(item.totalBytes || 0)) + '</td>' +
          '<td>' + formatBytes(Number(item.averageBytes || 0)) + '</td>' +
          '<td>' + formatBytes(Number(item.maxBytes || 0)) + '</td>' +
          '<td>' + formatBytes(Number(item.projected30DayBytes || 0)) + '</td>' +
          '<td>' + Number(item.failures || 0).toLocaleString() + '</td>' +
          '<td>' + escapeHtml(item.lastAt ? relativeDate(item.lastAt) : '-') + '</td></tr>'
        ).join('') : '<tr><td colspan="8" class="member-meta">No HTTP response activity yet.</td></tr>';
        const largeHttpResponseRows = largeHttpResponses.length ? largeHttpResponses.map((item) =>
          '<tr><td>' + escapeHtml(item.at ? relativeDate(item.at) : '-') + '</td>' +
          '<td><code>' + escapeHtml(item.operation || '-') + '</code></td>' +
          '<td>' + formatBytes(Number(item.bytes || 0)) + '</td>' +
          '<td>' + (item.ok === false ? 'Error' : 'OK') + '</td></tr>'
        ).join('') : '<tr><td colspan="4" class="member-meta">No HTTP response above 256 KB yet.</td></tr>';
        const lastReasons = Array.isArray(m.lastWriteReasons) && m.lastWriteReasons.length ? m.lastWriteReasons.join(', ') : 'unknown';
        const lastChanged = Array.isArray(m.lastChangedSections) && m.lastChangedSections.length ? m.lastChangedSections.join(', ') : 'none';
        const reasonRows = reasons.length ? reasons.map((item) =>
          '<tr><td><code>' + escapeHtml(item.reason) + '</code></td>' +
          '<td>' + Number(item.saveRequests || 0).toLocaleString() + '</td>' +
          '<td>' + Number(item.skippedRequests || 0).toLocaleString() + '</td>' +
          '<td>' + Number(item.contributedWrites || 0).toLocaleString() + '</td>' +
          '<td>' + formatBytes(Number(item.estimatedBytesWritten || 0)) + '</td></tr>'
        ).join('') : '<tr><td colspan="5" class="member-meta">No save requests recorded yet.</td></tr>';
        const sectionRows = sections.length ? sections.map((item) => {
          const sectionMetric = (m.sections || {})[item.key] || {};
          return '<tr><td><code>' + escapeHtml(item.key) + '</code></td>' +
            '<td>' + Number(item.entries || 0).toLocaleString() + '</td>' +
            '<td>' + formatBytes(Number(item.bytes || 0)) + '</td>' +
            '<td>' + (Number(m.lastPayloadBytes || 0) > 0 ? ((Number(item.bytes || 0) / Number(m.lastPayloadBytes || 1)) * 100).toFixed(1) + '%' : '0%') + '</td>' +
            '<td>' + Number(sectionMetric.changedWrites || 0).toLocaleString() + '</td>' +
            '<td>' + formatBytes(Number(sectionMetric.cumulativeBytesWritten || 0)) + '</td></tr>';
        }).join('') : '<tr><td colspan="6" class="member-meta">Available after the first write in this process.</td></tr>';
        const detailCards = detailed.length ? detailed.map((section) => {
          const fieldRows = Array.isArray(section.topFields) && section.topFields.length ? section.topFields.map((field) =>
            '<tr><td><code>' + escapeHtml(field.field) + '</code></td><td>' + Number(field.presentIn || 0).toLocaleString() + '</td><td>' + formatBytes(Number(field.bytes || 0)) + '</td></tr>'
          ).join('') : '<tr><td colspan="3" class="member-meta">No object fields available.</td></tr>';
          return '<div class="settings-card"><div class="settings-card-head"><div><h3>' + escapeHtml(section.key) + '</h3><p>' + Number(section.entries || 0).toLocaleString() + ' entries · ' + formatBytes(Number(section.bytes || 0)) + ' · avg ' + formatBytes(Number(section.averageEntryBytes || 0)) + ' · max ' + formatBytes(Number(section.maxEntryBytes || 0)) + '</p></div></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Field</th><th>Present in</th><th>Estimated size</th></tr></thead><tbody>' + fieldRows + '</tbody></table></div></div>';
        }).join('') : '<div class="settings-card"><div class="member-meta">Detailed analysis becomes available after the first write.</div></div>';
        const writeRows = recentWrites.length ? recentWrites.map((item) =>
          '<tr><td>' + escapeHtml(item.at ? relativeDate(item.at) : '-') + '</td><td>' + formatBytes(Number(item.bytes || 0)) + '</td><td>' + formatBytes(Number(item.changedBytes || 0)) + '</td><td>' + Number(item.durationMs || 0).toLocaleString() + ' ms</td><td><code>' + escapeHtml((item.reasons || []).join(', ')) + '</code></td><td>' + escapeHtml((item.changedSections || []).join(', ')) + '</td></tr>'
        ).join('') : '<tr><td colspan="6" class="member-meta">No persisted writes yet.</td></tr>';
        const admFileRows = admFiles.length ? admFiles.map((item) =>
          '<tr><td><code>' + escapeHtml(item.file || '-') + '</code></td><td>' + Number(item.downloads || 0).toLocaleString() + '</td><td>' + formatBytes(Number(item.bytes || 0)) + '</td><td>' + formatBytes(Number(item.lastBytes || 0)) + '</td><td>' + Number(item.failures || 0).toLocaleString() + '</td></tr>'
        ).join('') : '<tr><td colspan="5" class="member-meta">No ADM downloads recorded yet.</td></tr>';
        const admServerRows = admServers.length ? admServers.map((item) =>
          '<tr><td><code>' + escapeHtml(item.serverId || '-') + '</code></td><td>' + Number(item.cycles || 0).toLocaleString() + '</td><td>' + Number(item.downloads || 0).toLocaleString() + '</td><td>' + formatBytes(Number(item.bytesDownloaded || 0)) + '</td><td>' + formatBytes(Number(item.averageBytesPerCycle || 0)) + '</td><td>' + formatBytes(Number(item.projected30DayBytes || 0)) + '</td><td>' + Number(item.downloadFailures || 0).toLocaleString() + '</td></tr>'
        ).join('') : '<tr><td colspan="7" class="member-meta">Per-server ADM metrics become available after each runtime completes a download cycle.</td></tr>';
        const shadowRows = shadowDecisions.length ? shadowDecisions.map((item) =>
          '<tr><td>' + escapeHtml(item.at ? relativeDate(item.at) : '-') + '</td>' +
          '<td><code>' + escapeHtml(item.file || '-') + '</code></td>' +
          '<td>' + escapeHtml(item.decision || '-') + '</td>' +
          '<td>' + escapeHtml(item.reason || '-') + '</td>' +
          '<td>' + (item.remoteSize == null ? '-' : formatBytes(Number(item.remoteSize || 0))) + '</td>' +
          '<td>' + (item.localSize == null ? '-' : formatBytes(Number(item.localSize || 0))) + '</td>' +
          '<td>' + (item.contentChanged == null ? (item.decision === 'skip' ? 'Reused local copy' : 'New/local missing') : (item.contentChanged ? 'Changed' : 'Same')) + '</td>' +
          '<td>' + (item.mismatch ? '<span class="chip" style="color:#ff7b7b">Mismatch</span>' : '<span class="chip online">OK</span>') + '</td></tr>'
        ).join('') : '<tr><td colspan="8" class="member-meta">Shadow decisions become available after ADM downloads.</td></tr>';
        const cycleRows = recentCycles.length ? recentCycles.map((item) =>
          '<tr><td>' + escapeHtml(item.finishedAt ? relativeDate(item.finishedAt) : '-') + '</td><td>' + Number(item.durationMs || 0).toLocaleString() + ' ms</td><td>' + Number(item.downloadDurationMs || 0).toLocaleString() + ' ms</td><td>' + Number(item.parserDurationMs || 0).toLocaleString() + ' ms</td><td>' + (item.downloadOk ? 'OK' : 'Error') + '</td><td>' + (item.parserOk ? 'OK' : 'Error') + '</td></tr>'
        ).join('') : '<tr><td colspan="6" class="member-meta">No main cycles recorded yet.</td></tr>';
        const serverObservabilityRows = serverRuntimeObservability.length ? serverRuntimeObservability.map((item) => {
          const stateMetrics = item.state || {};
          const runtimeMetrics = item.runtime || {};
          const admMetrics = item.adm || {};
          const failureCount = Number(stateMetrics.failedWrites || 0) + Number(stateMetrics.granularFailedBatches || 0) + Number(stateMetrics.positionFailedBatches || 0) + Number(stateMetrics.discordRuntimeFailedWrites || 0) + Number(runtimeMetrics.cycleFailures || 0) + Number(admMetrics.downloadFailures || 0);
          return '<tr>' +
            '<td><strong>' + escapeHtml(item.serverName || item.serverId || '-') + '</strong><br><code>' + escapeHtml(item.serverId || '-') + '</code></td>' +
            '<td>' + (() => { const health = String(runtimeMetrics.health || (item.runtimeEnabled ? 'starting' : item.onboardingStatus || 'inactive')); const cls = health === 'healthy' || health === 'starting' ? 'online' : (health === 'circuit-open' ? 'danger' : 'pending'); return '<span class="chip ' + cls + '">' + escapeHtml(health) + '</span>' + (runtimeMetrics.paused ? '<br><span class="member-meta">manual pause</span>' : ''); })() + '</td>' +
            '<td><code>' + escapeHtml(stateMetrics.bootSource || 'pending') + '</code></td>' +
            '<td>' + Number(stateMetrics.domainFlushes || 0).toLocaleString() + ' / ' + Number(stateMetrics.domainRowsWritten || 0).toLocaleString() + '<br><span class="member-meta">' + formatBytes(Number(stateMetrics.domainBytesWritten || 0)) + '</span></td>' +
            '<td>' + Number(stateMetrics.granularRowsWritten || 0).toLocaleString() + '<br><span class="member-meta">boot ' + Number(stateMetrics.granularRowsAppliedAtBoot || 0).toLocaleString() + ' · pending ' + Number(stateMetrics.granularPendingPlayers || 0).toLocaleString() + '</span></td>' +
            '<td>' + Number(stateMetrics.positionRowsWritten || 0).toLocaleString() + '<br><span class="member-meta">' + Number(stateMetrics.positionPlayers || 0).toLocaleString() + ' players · ' + Number(stateMetrics.positionObservations || 0).toLocaleString() + ' obs</span></td>' +
            '<td>' + Number(admMetrics.cycles || 0).toLocaleString() + ' / ' + Number(admMetrics.downloads || 0).toLocaleString() + '<br><span class="member-meta">' + formatBytes(Number(admMetrics.bytesDownloaded || 0)) + '</span></td>' +
            '<td>' + Number(runtimeMetrics.cyclesCompleted || 0).toLocaleString() + '<br><span class="member-meta">avg ' + Number(runtimeMetrics.averageCycleDurationMs || 0).toLocaleString() + ' ms · circuit ' + escapeHtml(String(runtimeMetrics.circuitState || 'closed')) + '</span></td>' +
            '<td>' + (failureCount ? '<span class="chip" style="color:#ff7b7b">' + failureCount.toLocaleString() + '</span>' : '<span class="chip online">0</span>') + '<br><span class="member-meta">consecutive ' + Number(runtimeMetrics.consecutiveFailures || 0).toLocaleString() + ' · skipped ' + Number(runtimeMetrics.circuitSkips || 0).toLocaleString() + '</span>' + (runtimeMetrics.lastError ? '<br><span class="member-meta">' + escapeHtml(runtimeMetrics.lastError) + '</span>' : '') + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="9" class="member-meta">Per-server runtime diagnostics become available after the server registry is loaded.</td></tr>';
        metrics.innerHTML = '<div class="settings-card" style="margin-bottom:16px"><div class="settings-card-head"><div><h3>Runtime diagnostics by server</h3><p>Phase 16 keeps the operational guards and adds tenant credentials, per-server catalog/settings and self-service without creating new pollers.</p></div></div>' +
          '<div class="table-wrap"><table><thead><tr><th>Server</th><th>Runtime</th><th>Boot source</th><th>V2 flushes / rows</th><th>Player stats rows</th><th>Position rows</th><th>ADM cycles / downloads</th><th>Main cycles</th><th>Failures</th></tr></thead><tbody>' + serverObservabilityRows + '</tbody></table></div>' +
          '<div class="member-meta" style="margin-top:10px">The detailed persistence sections below are scoped to <strong>' + escapeHtml(state.serverFoundation?.currentServerName || 'the primary server') + '</strong>. Network & Render bandwidth remains process-wide by design.</div></div>' +
        '<div class="overview-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))">' +
          '<div class="stat-card"><span>Reads</span><strong>' + Number(m.reads || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>Save requests</span><strong>' + Number(m.saveRequests || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>Writes</span><strong>' + Number(m.writes || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>Skipped</span><strong>' + Number(m.skippedWrites || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>Write rate</span><strong>' + Number(m.writeRatePerHour || 0).toLocaleString() + '/h</strong></div>' +
          '<div class="stat-card"><span>Failed writes</span><strong>' + Number(m.failedWrites || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>Last payload</span><strong>' + formatBytes(Number(m.lastPayloadBytes || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>Average payload</span><strong>' + formatBytes(Number(m.averagePayloadBytes || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>Changed last write</span><strong>' + formatBytes(Number(m.lastChangedBytes || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>Total written</span><strong>' + formatBytes(Number(m.totalPayloadBytesWritten || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>Projected 30d</span><strong>' + formatBytes(Number(m.projected30DayPayloadBytes || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>Avg write time</span><strong>' + Number(m.averageWriteDurationMs || 0).toLocaleString() + ' ms</strong></div>' +
        '</div>' +
        '<div class="member-meta" style="margin-top:10px">Profiler started: ' + escapeHtml(m.startedAt ? relativeDate(m.startedAt) : '-') + ' · Last write: ' + escapeHtml(m.lastWriteAt ? relativeDate(m.lastWriteAt) : 'none') + ' · Reasons: ' + escapeHtml(lastReasons) + ' · Changed: ' + escapeHtml(lastChanged) + '</div>' +
        '<div class="settings-grid" style="margin-top:16px;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr)">' +
          '<div class="settings-card"><div class="settings-card-head"><div><h3>Writes by source</h3><p>Sources that requested saves and participated in persisted writes.</p></div></div><div class="table-wrap"><table><thead><tr><th>Source</th><th>Requests</th><th>Skipped</th><th>Writes involved</th><th>Estimated bytes</th></tr></thead><tbody>' + reasonRows + '</tbody></table></div></div>' +
          '<div class="settings-card"><div class="settings-card-head"><div><h3>Payload sections</h3><p>Current size, entry count and how often each top-level section changed.</p></div></div><div class="table-wrap"><table><thead><tr><th>Section</th><th>Entries</th><th>Size</th><th>Share</th><th>Changed writes</th><th>Cumulative</th></tr></thead><tbody>' + sectionRows + '</tbody></table></div></div>' +
        '</div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Recent persisted writes</h3><p>Last 20 writes with payload, effective changed bytes, source and changed sections.</p></div></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Payload</th><th>Changed</th><th>Duration</th><th>Sources</th><th>Sections</th></tr></thead><tbody>' + writeRows + '</tbody></table></div></div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Persistence V2 domains</h3><p>Core state is split by responsibility. Background game/runtime changes are coalesced to reduce Neon wake-ups; social, commerce and config remain immediate.</p></div></div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(10,minmax(0,1fr))">' +
            '<div class="stat-card"><span>Status</span><strong>' + (domainV2.enabled ? 'Active' : 'Legacy') + '</strong></div>' +
            '<div class="stat-card"><span>Boot source</span><strong>' + escapeHtml(domainV2.bootSource || 'unknown') + '</strong></div>' +
            '<div class="stat-card"><span>V2 rows at boot</span><strong>' + Number(domainV2.domainRowsFoundAtBoot || 0).toLocaleString() + ' / ' + Number(domainV2.domainRowsAppliedAtBoot || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Flushes</span><strong>' + Number(domainV2.flushes || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Rows written</span><strong>' + Number(domainV2.rowsWritten || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Pending domains</span><strong>' + Number(domainV2.pendingDomains || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Avg flush</span><strong>' + formatBytes(Number(domainV2.averageFlushPayloadBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Total domain sent</span><strong>' + formatBytes(Number(domainV2.totalPayloadBytesWritten || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Projected 30d</span><strong>' + formatBytes(Number(domainV2.projected30DayPayloadBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Compat snapshots</span><strong>' + Number(domainV2.compatibilitySnapshots || 0).toLocaleString() + '</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-top:10px">Policy: ' + escapeHtml(String(domainV2.schedulerPolicyVersion || 'unknown')) + ' · Processing: ' + Number(domainV2.processingCadenceMinutes || 10).toLocaleString() + ' min · Stats: ' + Number(domainV2.statsCadenceMinutes || 20).toLocaleString() + ' min · Runtime alignment: ' + Number(domainV2.backgroundCadenceMinutes || 10).toLocaleString() + ' min · Compatibility snapshot: ' + Number(domainV2.compatibilitySnapshotMinutes || 360).toLocaleString() + ' min · Immediate flushes: ' + Number(domainV2.immediateFlushes || 0).toLocaleString() + ' · Background flushes: ' + Number(domainV2.backgroundFlushes || 0).toLocaleString() + ' · Last trigger: ' + escapeHtml(String(domainV2.lastFlushTrigger || 'none')) + ' · Failed: ' + Number(domainV2.failedFlushes || 0).toLocaleString() + '</div>' +
          '<div class="member-meta" style="margin-top:6px">Last domain flush: ' + escapeHtml(domainV2.lastWriteAt ? relativeDate(domainV2.lastWriteAt) : 'none') + ' · Last runtime write: ' + escapeHtml(discordRuntime.lastWriteAt ? relativeDate(discordRuntime.lastWriteAt) : 'none') + ' · Last main/compat write: ' + escapeHtml(m.lastWriteAt ? relativeDate(m.lastWriteAt) : 'none') + '</div>' +
          '<div class="member-meta" style="margin-top:6px">Boot main: ' + escapeHtml(domainV2.mainUpdatedAtAtBoot ? relativeDate(domainV2.mainUpdatedAtAtBoot) : 'none') + ' · Boot newest V2: ' + escapeHtml(domainV2.newestDomainUpdatedAtAtBoot ? relativeDate(domainV2.newestDomainUpdatedAtAtBoot) : 'none') + '</div>' +
          '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Domain</th><th>Current</th><th>Changes</th><th>Writes</th><th>Written</th></tr></thead><tbody>' +
            ['stats','processing','social','commerce','config'].map((key) => { const d = domainRows[key] || {}; return '<tr><td><code>' + escapeHtml(key) + '</code></td><td>' + formatBytes(Number(d.currentBytes || 0)) + '</td><td>' + Number(d.changes || 0).toLocaleString() + '</td><td>' + Number(d.writes || 0).toLocaleString() + '</td><td>' + formatBytes(Number(d.bytesWritten || 0)) + '</td></tr>'; }).join('') +
          '</tbody></table></div>' +
        '</div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Multi-server foundation</h3><p>Phase 16 extends organization ownership/RBAC with encrypted tenant Nitrado credentials, per-server commerce settings/catalog and self-service while preserving the centralized scheduler.</p></div></div>' +
        '<div class="diag-grid"><div><span>Phase</span><strong>' + Number(state.serverFoundation?.phase || 1).toLocaleString() + '</strong></div><div><span>Mode</span><strong>' + escapeHtml(String(state.serverFoundation?.mode || 'single-server-compat')) + '</strong></div><div><span>Current server</span><strong>' + escapeHtml(String(state.serverFoundation?.currentServerName || 'PZ Deathmatch')) + '</strong></div><div><span>Server ID</span><strong>' + escapeHtml(String(state.serverFoundation?.currentServerId || 'pz-deathmatch')) + '</strong></div><div><span>Registry persisted</span><strong>' + (state.serverFoundation?.registryPersisted ? 'Yes' : 'No') + '</strong></div><div><span>Rows tagged</span><strong>' + (state.serverFoundation?.persistenceTaggedWithServerId ? 'Yes' : 'No') + '</strong></div><div><span>bot_state PK</span><strong>' + (state.serverFoundation?.namespace?.botStatePrimaryKeyReady ? 'server + id' : 'Legacy') + '</strong></div><div><span>Player stats PK</span><strong>' + (state.serverFoundation?.namespace?.playerStatsPrimaryKeyReady ? 'server + player' : 'Legacy') + '</strong></div><div><span>Scoped reads</span><strong>' + (state.serverFoundation?.persistenceNamespaced ? 'Enabled' : 'Fallback') + '</strong></div><div><span>Nitrado routing</span><strong>' + (state.serverFoundation?.runtimeIsolation?.nitradoRoutingNamespaced ? 'Server-scoped' : 'Legacy') + '</strong></div><div><span>Discord routing</span><strong>' + (state.serverFoundation?.runtimeIsolation?.discordRoutingNamespaced ? 'Server-scoped' : 'Legacy') + '</strong></div><div><span>Processing lock</span><strong>' + (state.serverFoundation?.runtimeIsolation?.processingLockNamespaced ? 'Per server' : 'Global') + '</strong></div><div><span>ADM storage</span><strong>' + (state.serverFoundation?.runtimeIsolation?.primaryLegacyAdmStoragePreserved ? 'Primary preserved' : 'Namespaced') + '</strong></div><div><span>Execution context</span><strong>' + (state.serverFoundation?.runtimeIsolation?.executionContextNamespaced ? 'Per server' : 'Legacy') + '</strong></div><div><span>State cache</span><strong>' + (state.serverFoundation?.runtimeIsolation?.stateCacheNamespaced ? 'Per server' : 'Legacy') + '</strong></div><div><span>ADM strategy</span><strong>' + (state.serverFoundation?.runtimeIsolation?.admStrategyNamespaced ? 'Per server' : 'Global') + '</strong></div><div><span>ADM parser storage</span><strong>' + (state.serverFoundation?.runtimeIsolation?.admParserStorageNamespaced ? 'Per server' : 'Legacy') + '</strong></div><div><span>Persistence runtime</span><strong>' + (state.serverFoundation?.runtimeIsolation?.persistenceRuntimeNamespaced ? 'Per server' : 'Global') + '</strong></div><div><span>Position history</span><strong>' + (state.serverFoundation?.runtimeIsolation?.positionHistoryNamespaced ? 'Server-scoped' : 'Global') + '</strong></div><div><span>HTTP context</span><strong>' + (state.serverFoundation?.runtimeIsolation?.httpContextNamespaced ? 'Explicit primary' : 'Fallback') + '</strong></div><div><span>Player portal context</span><strong>' + (state.serverFoundation?.runtimeIsolation?.playerPortalContextNamespaced ? 'Per server' : 'Primary only') + '</strong></div><div><span>FTP safety</span><strong>' + (state.serverFoundation?.runtimeIsolation?.ftpPrimaryGuarded ? 'Primary guarded' : 'Global credentials') + '</strong></div><div><span>Discord loop guards</span><strong>' + (state.serverFoundation?.runtimeIsolation?.discordLoopGuardsNamespaced ? 'Per server' : 'Global') + '</strong></div><div><span>Scheduler</span><strong>' + (state.serverFoundation?.runtimeIsolation?.schedulerCentralized ? 'Centralized' : 'Unknown') + '</strong></div><div><span>Activation readiness</span><strong>' + (state.serverFoundation?.runtimeIsolation?.activationReadiness ? 'Prepared' : 'Pending') + '</strong></div><div><span>Context runs</span><strong>' + Number(state.serverFoundation?.runtimeIsolation?.contextRuns || 0).toLocaleString() + '</strong></div><div><span>Context fallbacks</span><strong>' + Number(state.serverFoundation?.runtimeIsolation?.contextFallbacks || 0).toLocaleString() + '</strong></div><div><span>Managed servers</span><strong>' + Number(state.serverFoundation?.managedServers || 1).toLocaleString() + '</strong></div><div><span>Server onboarding</span><strong>' + (state.serverFoundation?.onboarding?.canCreateDrafts ? 'Drafts enabled' : 'Unavailable') + '</strong></div><div><span>Draft servers</span><strong>' + Number(state.serverFoundation?.onboarding?.draftServers || 0).toLocaleString() + '</strong></div><div><span>Configured servers</span><strong>' + Number(state.serverFoundation?.onboarding?.configuredServers || 0).toLocaleString() + '</strong></div><div><span>Ready servers</span><strong>' + Number(state.serverFoundation?.onboarding?.readyServers || 0).toLocaleString() + '</strong></div><div><span>Preflight gate</span><strong>' + (state.serverFoundation?.onboarding?.activationPreflightEnabled ? 'On-demand' : 'Unavailable') + '</strong></div><div><span>Activation endpoint</span><strong>' + (state.serverFoundation?.onboarding?.activationEndpointEnabled ? 'Enabled' : 'None') + '</strong></div><div><span>Runtime policy</span><strong>' + escapeHtml(String(state.serverFoundation?.onboarding?.activationPolicy || 'primary-only')) + '</strong></div><div><span>Secrets in registry</span><strong>' + (state.serverFoundation?.onboarding?.secretsStoredInRegistry ? 'Yes' : 'No') + '</strong></div><div><span>Integration setup</span><strong>' + escapeHtml(String(state.serverFoundation?.onboarding?.integrationValidationMode || 'on-demand')) + '</strong></div><div><span>Nitrado credential</span><strong>' + escapeHtml(String(state.serverFoundation?.onboarding?.nitradoCredentialSource || 'missing')) + '</strong></div><div><span>Integration polling</span><strong>' + (state.serverFoundation?.onboarding?.backgroundPollingAdded ? 'Added' : 'None') + '</strong></div><div><span>Additional servers</span><strong>' + (state.serverFoundation?.additionalServersEnabled ? 'Enabled' : 'Blocked') + '</strong></div><div><span>Active runtimes</span><strong>' + Number(state.runtimeCoordinator?.activeRuntimes || state.serverFoundation?.onboarding?.runtimeEnabledServers || 1).toLocaleString() + '</strong></div><div><span>Operational health</span><strong>' + (state.serverFoundation?.onboarding?.operationalHardeningEnabled ? 'Per server' : 'Legacy') + '</strong></div><div><span>Circuit breaker</span><strong>' + escapeHtml(String(state.serverFoundation?.onboarding?.circuitBreakerMode || 'off')) + '</strong></div><div><span>Organizations</span><strong>' + Number(state.serverFoundation?.tenancy?.organizations || 0).toLocaleString() + '</strong></div><div><span>Memberships</span><strong>' + Number(state.serverFoundation?.tenancy?.memberships || 0).toLocaleString() + '</strong></div><div><span>Server ownership</span><strong>' + (state.serverFoundation?.tenancy?.ownershipColumnReady && Number(state.serverFoundation?.tenancy?.serversWithoutOrganization || 0) === 0 ? 'Required' : 'Pending') + '</strong></div><div><span>Tenant auth</span><strong>' + escapeHtml(String(state.serverFoundation?.tenancy?.authorizationModel || 'legacy')) + '</strong></div><div><span>Tenant credentials</span><strong>' + escapeHtml(String(state.serverFoundation?.tenancy?.credentialIsolation || 'pending')) + '</strong></div><div><span>Secret encryption</span><strong>' + (state.serverFoundation?.tenancy?.integrations?.encryptionConfigured ? 'Ready' : 'Missing key') + '</strong></div><div><span>Self-service</span><strong>' + (state.serverFoundation?.tenancy?.selfServiceEnabled ? 'Enabled' : 'Private / disabled') + '</strong></div><div><span>Shop catalog</span><strong>' + (state.serverFoundation?.onboarding?.serverScopedShopCatalogEnabled ? 'Per server' : 'Shared') + '</strong></div><div><span>Commerce settings</span><strong>' + (state.serverFoundation?.onboarding?.serverScopedCommerceSettingsEnabled ? 'Per server' : 'Shared') + '</strong></div></div>' +
        '<div class="member-meta" style="margin-top:10px">Registry table: ' + (state.serverFoundation?.registry?.tableReady ? 'ready' : 'not ready') + ' · Primary seeded: ' + (state.serverFoundation?.registry?.primarySeeded ? 'yes' : 'no') + ' · bot_state tagged/untagged: ' + Number(state.serverFoundation?.namespace?.botStateTaggedRows || 0).toLocaleString() + '/' + Number(state.serverFoundation?.namespace?.botStateUntaggedRows || 0).toLocaleString() + ' · player stats tagged/untagged: ' + Number(state.serverFoundation?.namespace?.playerStatsTaggedRows || 0).toLocaleString() + '/' + Number(state.serverFoundation?.namespace?.playerStatsUntaggedRows || 0).toLocaleString() + ' · PK cutover: ' + (state.serverFoundation?.namespace?.primaryKeyCutoverComplete ? 'complete' : 'pending') + ' · Scoped read source: ' + escapeHtml(String(state.serverFoundation?.namespace?.lastScopedReadSource || 'legacy')) + ' · Fallbacks: ' + Number(state.serverFoundation?.namespace?.scopedReadFallbacks || 0).toLocaleString() + ' · Registry drafts/configured: ' + Number(state.serverFoundation?.registry?.draftRows || 0).toLocaleString() + '/' + Number(state.serverFoundation?.registry?.configuredRows || 0).toLocaleString() + ' · Runtime rows: ' + Number(state.serverFoundation?.registry?.runtimeEnabledRows || 0).toLocaleString() + ' · Portal resolutions/switches: ' + Number(state.playerPortalContext?.contextResolutions || 0).toLocaleString() + '/' + Number(state.playerPortalContext?.contextSwitches || 0).toLocaleString() + ' · Invalid portal selections: ' + Number(state.playerPortalContext?.invalidSelections || 0).toLocaleString() + (state.serverFoundation?.namespace?.lastError ? ' · Namespace error: ' + escapeHtml(String(state.serverFoundation.namespace.lastError)) : '') + '</div>' +
        '<div class="settings-note" style="margin-top:12px">Safety: Phase 16 does not move or rewrite gameplay data. The default organization may keep the legacy Nitrado environment token as a compatibility fallback; other organizations can only use their own encrypted credential. Catalog and runtime settings are server-scoped.</div></div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Granular player stats</h3><p>Global K/D and current streaks are upserted only for players that changed, instead of retransmitting the full historical player map.</p></div></div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(8,minmax(0,1fr))">' +
            '<div class="stat-card"><span>Status</span><strong>' + (granularPlayers.enabled === false ? 'Fallback' : 'Active') + '</strong></div>' +
            '<div class="stat-card"><span>Changed players</span><strong>' + Number(granularPlayers.changes || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Pending</span><strong>' + Number(granularPlayers.pendingPlayers || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Batches</span><strong>' + Number(granularPlayers.batchesWritten || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Rows written</span><strong>' + Number(granularPlayers.rowsWritten || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Avg batch</span><strong>' + formatBytes(Number(granularPlayers.averageBatchBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Total written</span><strong>' + formatBytes(Number(granularPlayers.totalPayloadBytesWritten || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Projected 30d</span><strong>' + formatBytes(Number(granularPlayers.projected30DayPayloadBytes || 0)) + '</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-top:10px">Cadence: ' + Number(granularPlayers.cadenceMinutes || 20).toLocaleString() + ' min · Avg rows/batch: ' + Number(granularPlayers.averageRowsPerBatch || 0).toLocaleString() + ' · Boot rows applied: ' + Number(granularPlayers.rowsAppliedAtBoot || 0).toLocaleString() + ' · Failed: ' + Number(granularPlayers.failedBatches || 0).toLocaleString() + ' · Last write: ' + escapeHtml(granularPlayers.lastWriteAt ? relativeDate(granularPlayers.lastWriteAt) : 'none') + '</div>' +
        '</div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Discord runtime domain</h3><p>Small Neon row used for feed/message/map runtime updates when no core state changed.</p></div></div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(8,minmax(0,1fr))">' +
            '<div class="stat-card"><span>Requests</span><strong>' + Number(discordRuntime.saveRequests || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Runtime-only</span><strong>' + Number(discordRuntime.explicitRuntimeRequests || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Fallback to core</span><strong>' + Number(discordRuntime.fallbackToCore || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Writes</span><strong>' + Number(discordRuntime.writes || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Skipped</span><strong>' + Number(discordRuntime.skippedWrites || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Avg payload</span><strong>' + formatBytes(Number(discordRuntime.averagePayloadBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Total written</span><strong>' + formatBytes(Number(discordRuntime.totalPayloadBytesWritten || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Projected 30d</span><strong>' + formatBytes(Number(discordRuntime.projected30DayPayloadBytes || 0)) + '</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-top:10px">Write rate: ' + Number(discordRuntime.writeRatePerHour || 0).toLocaleString() + '/h · Failed: ' + Number(discordRuntime.failedWrites || 0).toLocaleString() + ' · Last write: ' + escapeHtml(discordRuntime.lastWriteAt ? relativeDate(discordRuntime.lastWriteAt) : 'none') + '</div>' +
        '</div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Player position history diagnostics</h3><p>24-hour forensic location foundation. Positions are extracted only from ADM lines already processed; no extra Nitrado downloads or polling.</p></div></div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))">' +
            '<div class="stat-card"><span>Observations</span><strong>' + Number(positionHistory.observationsReceived || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Players seen</span><strong>' + Number(positionHistory.uniquePlayersObserved || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Positions observed</span><strong>' + Number(positionHistory.positionEvents || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Positions retained</span><strong>' + Number(positionHistory.queuedPositionEvents || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Positions suppressed</span><strong>' + Number(positionHistory.suppressedPositionEvents || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Position reduction</span><strong>' + Number(positionHistory.positionReductionPercent || 0).toLocaleString() + '%</strong></div>' +
            '<div class="stat-card"><span>Connect / disconnect</span><strong>' + Number(positionHistory.connectEvents || 0).toLocaleString() + ' / ' + Number(positionHistory.disconnectEvents || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Pending batch</span><strong>' + Number(positionHistory.pendingObservations || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Invalid positions</span><strong>' + Number(positionHistory.invalidPositions || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>DB batches</span><strong>' + Number(positionHistory.batchesWritten || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Rows written</span><strong>' + Number(positionHistory.rowsWritten || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Avg batch</span><strong>' + formatBytes(Number(positionHistory.averageBatchPayloadBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Total sent</span><strong>' + formatBytes(Number(positionHistory.totalPayloadBytesWritten || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Projected 30d</span><strong>' + formatBytes(Number(positionHistory.projected30DayPayloadBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Failed batches</span><strong>' + Number(positionHistory.failedBatches || 0).toLocaleString() + '</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-top:10px">Retention: ' + Number(positionHistory.retentionHours || 24).toLocaleString() + 'h · Sampling: first point, movement ≥ ' + Number(positionHistory.minMovementMeters || 25).toLocaleString() + 'm, or max ' + Number(positionHistory.maxSampleIntervalMinutes || 2).toLocaleString() + ' min between retained positions · Flush cadence: up to ' + Number(positionHistory.flushIntervalMinutes || 10).toLocaleString() + ' min · Last DB write: ' + escapeHtml(positionHistory.lastWriteAt ? relativeDate(positionHistory.lastWriteAt) : 'none') + '. Connect/disconnect events are always retained. A position-history failure never blocks kills, rankings or ADM cursors.</div>' +
          '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>When</th><th>Player</th><th>Event</th><th>X</th><th>Z</th><th>ADM</th></tr></thead><tbody>' + positionSampleRows + '</tbody></table></div>' +
        '</div>' +
        '<div class="settings-grid" style="margin-top:16px;grid-template-columns:repeat(2,minmax(0,1fr))">' + detailCards + '</div>' +
        '<div class="overview-grid" style="margin-top:20px;grid-template-columns:repeat(6,minmax(0,1fr))">' +
          '<div class="stat-card"><span>ADM cycles</span><strong>' + Number(adm.cycles || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>ADM downloads</span><strong>' + Number(adm.fileDownloads || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>ADM downloaded</span><strong>' + formatBytes(Number(adm.bytesDownloaded || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>ADM projected 30d</span><strong>' + formatBytes(Number(adm.projected30DayBytes || 0)) + '</strong></div>' +
          '<div class="stat-card"><span>Main cycles</span><strong>' + Number(runtime.cyclesCompleted || 0).toLocaleString() + '</strong></div>' +
          '<div class="stat-card"><span>Avg cycle</span><strong>' + Number(runtime.averageCycleDurationMs || 0).toLocaleString() + ' ms</strong></div>' +
        '</div>' +
        '<div class="settings-card" style="margin-top:16px">' +
          '<div class="settings-card-head"><div><h3>ADM downloader strategy</h3><p>Legacy downloads every candidate. Shadow validates optimized decisions without skipping. Optimized always downloads the active ADM; the previous ADM stays conservative until it is unchanged for 30 minutes, then stable files are reused.</p></div><div style="display:flex;gap:10px;align-items:center"><select id="admDownloadModeSelect" class="field" style="min-width:150px"><option value="legacy"' + ((state.serviceSettings?.admDownloadMode || admStrategy.mode) === 'legacy' ? ' selected' : '') + '>Legacy</option><option value="shadow"' + ((state.serviceSettings?.admDownloadMode || admStrategy.mode) === 'shadow' ? ' selected' : '') + '>Shadow</option><option value="optimized"' + ((state.serviceSettings?.admDownloadMode || admStrategy.mode) === 'optimized' ? ' selected' : '') + '>Optimized</option></select><span class="chip ' + (Number(admStrategy.auditMismatches || 0) === 0 ? 'online' : '') + '">' + escapeHtml(String(admStrategy.mode || 'shadow')) + '</span></div></div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:12px">' +
            '<div class="stat-card"><span>Optimized skips</span><strong>' + Number(admStrategy.optimizedSkips || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Optimized downloads</span><strong>' + Number(admStrategy.optimizedDownloads || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Actual saved</span><strong>' + formatBytes(Number(admStrategy.optimizedSavedBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Audit downloads</span><strong>' + Number(admStrategy.auditDownloads || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Audit mismatches</span><strong>' + Number(admStrategy.auditMismatches || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Auto fallbacks</span><strong>' + Number(admStrategy.automaticFallbacks || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Previous grace downloads</span><strong>' + Number(admStrategy.previousGraceDownloads || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Previous stable skips</span><strong>' + Number(admStrategy.previousStableSkips || 0).toLocaleString() + '</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-bottom:12px">Optimized mode always downloads the active ADM. When rotation happens, the previous ADM is downloaded conservatively until its size remains unchanged for 30 minutes; after that it can be reused like older stable files. One skipped file is force-audited every hour and any mismatch automatically falls back to Legacy.</div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))">' +
            '<div class="stat-card"><span>Would download</span><strong>' + Number(admShadow.wouldDownload || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Would skip</span><strong>' + Number(admShadow.wouldSkip || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Safe skips</span><strong>' + Number(admShadow.safeSkips || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Dangerous skips</span><strong>' + Number(admShadow.dangerousSkips || 0).toLocaleString() + '</strong></div>' +
            '<div class="stat-card"><span>Estimated saved</span><strong>' + formatBytes(Number(admShadow.estimatedSavedBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Estimated reduction</span><strong>' + Number(admShadow.estimatedReductionPercent || 0).toLocaleString() + '%</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-top:12px">Remote metadata unavailable: ' + Number(admShadow.metadataUnavailable || 0).toLocaleString() + ' · Local missing: ' + Number(admShadow.localMissing || 0).toLocaleString() + ' · Size changed: ' + Number(admShadow.sizeMismatch || 0).toLocaleString() + '. Any uncertainty is treated as download.</div>' +
          '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>When</th><th>File</th><th>Decision</th><th>Reason</th><th>Remote</th><th>Local</th><th>Actual content</th><th>Validation</th></tr></thead><tbody>' + shadowRows + '</tbody></table></div>' +
        '</div>' +
        '<div class="settings-grid" style="margin-top:16px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)">' +
          '<div class="settings-card"><div class="settings-card-head"><div><h3>ADM bandwidth by server</h3><p>Phase 12 isolates the observed Nitrado download cost of each active runtime.</p></div></div><div class="table-wrap"><table><thead><tr><th>Server</th><th>Cycles</th><th>Downloads</th><th>Total</th><th>Avg/cycle</th><th>Projected 30d</th><th>Failures</th></tr></thead><tbody>' + admServerRows + '</tbody></table></div></div>' +
          '<div class="settings-card"><div class="settings-card-head"><div><h3>ADM bandwidth by file</h3><p>Actual bytes downloaded from Nitrado during this process and a 30-day projection.</p></div></div><div class="table-wrap"><table><thead><tr><th>File</th><th>Downloads</th><th>Total</th><th>Last</th><th>Failures</th></tr></thead><tbody>' + admFileRows + '</tbody></table></div></div>' +
          '<div class="settings-card"><div class="settings-card-head"><div><h3>Main loop timing</h3><p>Recent download and parser durations. Useful for Render CPU/runtime diagnosis.</p></div></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Total</th><th>Download</th><th>Parser</th><th>Download</th><th>Parser</th></tr></thead><tbody>' + cycleRows + '</tbody></table></div></div>' +
        '</div>' +
        '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Network & Render bandwidth diagnostics</h3><p>Measured application payloads by destination. Use this to compare Neon/service-initiated traffic with Render billing.</p></div></div>' +
          '<div class="overview-grid" style="grid-template-columns:repeat(6,minmax(0,1fr));margin-bottom:12px">' +
            '<div class="stat-card"><span>Measured outbound</span><strong>' + formatBytes(Number(network.outboundBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Projected outbound 30d</span><strong>' + formatBytes(Number(network.projected30DayOutboundBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Measured inbound</span><strong>' + formatBytes(Number(network.inboundBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>HTTP responses</span><strong>' + formatBytes(Number(network.httpResponseBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Projected HTTP 30d</span><strong>' + formatBytes(Number(network.projected30DayHttpResponseBytes || 0)) + '</strong></div>' +
            '<div class="stat-card"><span>Largest HTTP response</span><strong>' + formatBytes(Number(network.largestHttpResponseBytes || 0)) + '</strong></div>' +
          '</div>' +
          '<div class="member-meta" style="margin-bottom:12px">' + escapeHtml(network.coverageNote || 'Metrics start after deploy and are application-level estimates.') + '</div>' +
          '<div class="settings-grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">' +
            '<div class="settings-card"><div class="settings-card-head"><div><h3>Traffic by service</h3><p>Outbound service calls are the closest in-app counterpart to Render Service-Initiated bandwidth.</p></div></div><div class="table-wrap"><table><thead><tr><th>Service</th><th>Events</th><th>Outbound</th><th>Inbound</th><th>HTTP response</th><th>Failures</th></tr></thead><tbody>' + networkServiceRows + '</tbody></table></div></div>' +
            '<div class="settings-card"><div class="settings-card-head"><div><h3>Recent network samples</h3><p>Last measured application transfers.</p></div></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Service</th><th>Direction</th><th>Bytes</th><th>Operation</th><th>Status</th></tr></thead><tbody>' + networkTransferRows + '</tbody></table></div></div>' +
          '</div>' +
          '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>HTTP response bandwidth by route</h3><p>Routes are normalized so dynamic IDs do not create separate rows. Sorted by total bytes sent to browsers.</p></div></div><div class="table-wrap"><table><thead><tr><th>Route</th><th>Requests</th><th>Total</th><th>Average</th><th>Max</th><th>Projected 30d</th><th>Failures</th><th>Last</th></tr></thead><tbody>' + httpRouteRows + '</tbody></table></div></div>' +
          '<div class="settings-card" style="margin-top:16px"><div class="settings-card-head"><div><h3>Large HTTP response samples</h3><p>Recent responses at or above 256 KB. Useful for spotting maps, images or JSON payloads that can dominate browser bandwidth.</p></div></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Route</th><th>Bytes</th><th>Status</th></tr></thead><tbody>' + largeHttpResponseRows + '</tbody></table></div></div>' +
        '</div>';
      }

    }
    async function loadServiceSettings() {
      if (state.serviceSettingsLoading) return;
      state.serviceSettingsLoading = true;
      try {
        const response = await apiFetch('/admin-panel/api/service-settings');
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.serviceSettings = payload.settings;
        state.persistenceMetrics = payload.persistenceMetrics;
        state.domainPersistenceMetrics = payload.domainPersistenceMetrics;
        state.granularPlayerStatsMetrics = payload.granularPlayerStatsMetrics;
        state.serverFoundation = payload.serverFoundation;
        state.discordRuntimeMetrics = payload.discordRuntimeMetrics;
        state.playerPositionHistoryMetrics = payload.playerPositionHistoryMetrics;
        state.admDownloadMetrics = payload.admDownloadMetrics;
        state.runtimeMetrics = payload.runtimeMetrics;
        state.runtimeCoordinator = payload.runtimeCoordinator;
        state.serverRuntimeObservability = payload.serverRuntimeObservability || [];
        state.playerPortalContext = payload.playerPortalContext || null;
        state.networkMetrics = payload.networkMetrics;
        renderServiceSettings();
      } finally { state.serviceSettingsLoading = false; }
    }
    async function toggleServiceSetting(key, button) {
      if (!state.serviceSettings || !button) return;
      const nextValue = state.serviceSettings[key] === false;
      button.disabled = true;
      try {
        const response = await apiFetch('/admin-panel/api/service-settings', { method:'PATCH', body:JSON.stringify({ [key]:nextValue }) });
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.serviceSettings = payload.settings;
        state.persistenceMetrics = payload.persistenceMetrics;
        state.domainPersistenceMetrics = payload.domainPersistenceMetrics;
        state.granularPlayerStatsMetrics = payload.granularPlayerStatsMetrics;
        state.serverFoundation = payload.serverFoundation;
        state.discordRuntimeMetrics = payload.discordRuntimeMetrics;
        state.playerPositionHistoryMetrics = payload.playerPositionHistoryMetrics;
        state.admDownloadMetrics = payload.admDownloadMetrics;
        state.runtimeMetrics = payload.runtimeMetrics;
        state.runtimeCoordinator = payload.runtimeCoordinator;
        state.networkMetrics = payload.networkMetrics;
        state.discordCommands = payload.commands || state.discordCommands;
        renderServiceSettings();
        if (state.discordCommands) renderDiscordCommands();
        showToast((key === 'shopEnabled' ? 'Shop service' : 'Presence history') + (nextValue ? ' ativado.' : ' desativado.'));
      } finally { button.disabled = false; }
    }

    async function updateAdmDownloadMode(mode, select) {
      if (!['legacy','shadow','optimized'].includes(mode)) return;
      if (select) select.disabled = true;
      try {
        const response = await apiFetch('/admin-panel/api/service-settings', { method:'PATCH', body:JSON.stringify({ admDownloadMode:mode }) });
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.serviceSettings = payload.settings;
        state.persistenceMetrics = payload.persistenceMetrics;
        state.domainPersistenceMetrics = payload.domainPersistenceMetrics;
        state.granularPlayerStatsMetrics = payload.granularPlayerStatsMetrics;
        state.serverFoundation = payload.serverFoundation;
        state.discordRuntimeMetrics = payload.discordRuntimeMetrics;
        state.playerPositionHistoryMetrics = payload.playerPositionHistoryMetrics;
        state.admDownloadMetrics = payload.admDownloadMetrics;
        state.runtimeMetrics = payload.runtimeMetrics;
        state.runtimeCoordinator = payload.runtimeCoordinator;
        state.networkMetrics = payload.networkMetrics;
        renderServiceSettings();
        showToast('ADM downloader mode: ' + mode + '.');
      } finally { if (select) select.disabled = false; }
    }

    function renderDiscordCommands() {
      const list = document.getElementById('discordCommandsList');
      const summary = document.getElementById('discordCommandsSummary');
      if (!list || !summary) return;
      const commands = Array.isArray(state.discordCommands) ? state.discordCommands : [];
      const enabled = commands.filter((command) => command.enabled).length;
      summary.innerHTML = '<span class="chip online">' + enabled + ' ativos</span><span class="chip">' + (commands.length - enabled) + ' pausados</span>';
      if (!commands.length) {
        list.innerHTML = '<div class="empty" style="padding:24px">Nenhum comando registrado.</div>';
        return;
      }
      const group = (category, title) => {
        const rows = commands.filter((command) => command.category === category).map((command) =>
          '<div class="command-setting-row ' + (command.enabled ? '' : 'is-disabled') + '" data-command-name="' + escapeHtml(command.name) + '">' +
            '<div><div class="command-setting-name"><code>/' + escapeHtml(command.name) + '</code><span class="chip">' + (category === 'admin' ? 'Admin' : 'Player') + '</span></div>' +
            '<div class="command-setting-description">' + escapeHtml(command.description || 'Discord command') + '</div></div>' +
            '<button class="ios-switch" type="button" role="switch" aria-label="' + (command.enabled ? 'Desativar ' : 'Ativar ') + escapeHtml(command.name) + '" aria-checked="' + (command.enabled ? 'true' : 'false') + '" data-command-toggle="' + escapeHtml(command.name) + '"></button>' +
          '</div>'
        ).join('');
        return rows ? '<div class="command-settings-group"><div class="command-settings-group-title">' + title + '</div>' + rows + '</div>' : '';
      };
      list.innerHTML = group('player', 'Comandos dos jogadores') + group('admin', 'Comandos administrativos');
    }
    async function loadDiscordCommands() {
      if (state.discordCommandsLoading) return;
      state.discordCommandsLoading = true;
      const list = document.getElementById('discordCommandsList');
      if (list) list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
      try {
        const response = await apiFetch('/admin-panel/api/discord-commands');
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.discordCommands = payload.commands || [];
        renderDiscordCommands();
      } finally { state.discordCommandsLoading = false; }
    }
    async function toggleDiscordCommand(commandName, button) {
      const current = (state.discordCommands || []).find((command) => command.name === commandName);
      if (!current || !button) return;
      button.disabled = true;
      const nextEnabled = !current.enabled;
      try {
        const response = await apiFetch('/admin-panel/api/discord-commands/' + encodeURIComponent(commandName), { method:'PATCH', body:JSON.stringify({ enabled:nextEnabled }) });
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.discordCommands = payload.commands || [];
        renderDiscordCommands();
        showToast('/' + commandName + (nextEnabled ? ' ativado.' : ' desativado.'));
      } finally { button.disabled = false; }
    }
    function managedServerRuntimeStatus(serverId) {
      return (state.runtimeCoordinator?.servers || []).find((item) => item.serverId === serverId) || null;
    }
    function managedServerStatusChip(server) {
      if (server.primary) {
        const runtimeStatus = managedServerRuntimeStatus(server.id);
        return '<span class="chip ' + (runtimeStatus?.health === 'degraded' || runtimeStatus?.health === 'stale' ? 'pending' : 'success') + '">Active · primary</span>';
      }
      if (server.runtime?.operations?.paused === true) return '<span class="chip pending">Paused</span>';
      if (server.runtimeEnabled) {
        const runtimeStatus = managedServerRuntimeStatus(server.id);
        const health = String(runtimeStatus?.health || 'running');
        if (health === 'circuit-open') return '<span class="chip danger">Circuit open</span>';
        if (health === 'degraded' || health === 'stale') return '<span class="chip pending">' + escapeHtml(health === 'stale' ? 'Stale' : 'Degraded') + '</span>';
        return '<span class="chip success">Running</span>';
      }
      const status = String(server.onboardingStatus || 'draft');
      const cls = status === 'configured' || status === 'ready' ? 'online' : 'pending';
      return '<span class="chip ' + cls + '">' + escapeHtml(status.charAt(0).toUpperCase() + status.slice(1)) + '</span>';
    }
    function managedServerIntegrationState(server) {
      const serviceId = String(server?.integrations?.nitradoServiceId || '');
      const baseDir = String(server?.runtime?.nitradoBaseDir || '');
      const validation = server?.runtime?.nitradoValidation;
      const nitradoValidationPersisted = Boolean(serviceId && baseDir && validation && validation.serviceId === serviceId && validation.baseDir === baseDir && validation.validatedAt);
      const onboardingStatus = String(server?.onboardingStatus || 'draft');
      const statusConfirmsConfigured = onboardingStatus === 'configured' || onboardingStatus === 'ready';
      // The backend is the source of truth. If the registry already says Configured
      // but an older/stale payload missed the nested validation object, keep the UI
      // usable; Phase 12 preflight will revalidate and repair that exact routing.
      const nitradoConfigured = nitradoValidationPersisted || Boolean(serviceId && baseDir && statusConfirmsConfigured);
      const preflight = server?.runtime?.activationPreflight;
      const preflightReady = Boolean(onboardingStatus === 'ready' && preflight?.passed && preflight?.checkedAt);
      return {
        nitradoConfigured,
        nitradoValidationPersisted,
        nitradoMetadataPresent: Boolean(serviceId && baseDir),
        nitradoValidatedAt: nitradoValidationPersisted ? validation.validatedAt : null,
        discordConfigured: Boolean(server?.integrations?.discordGuildId),
        preflightReady,
        preflightCheckedAt: preflightReady ? preflight.checkedAt : null,
        preflightWarningCount: preflightReady ? Number(preflight.warningCount || 0) : 0,
      };
    }
    function renderManagedServers() {
      if (!els.managedServersList || !els.managedServersSummary) return;
      const servers = Array.isArray(state.managedServers) ? state.managedServers : [];
      const additional = servers.filter((server) => !server.primary);
      els.managedServersSummary.innerHTML =
        '<span class="chip success">' + servers.filter((server) => server.primary).length + ' primary</span>' +
        '<span class="chip">' + additional.length + ' additional</span>' +
        '<span class="chip ' + (Number(state.runtimeCoordinator?.activeRuntimes || 0) > 1 ? 'success' : 'pending') + '">active: ' + Number(state.runtimeCoordinator?.activeRuntimes || servers.filter((server) => server.runtimeEnabled && server.runtime?.operations?.paused !== true).length) + '</span>' +
        '<span class="chip">paused: ' + servers.filter((server) => server.runtime?.operations?.paused === true).length + '</span>';
      if (!servers.length) {
        els.managedServersList.innerHTML = '<div class="settings-empty-note">Nenhum servidor carregado.</div>';
        return;
      }
      els.managedServersList.innerHTML = servers.map((server) => {
        const integration = managedServerIntegrationState(server);
        const selected = state.selectedManagedServerId === server.id ? ' selected' : '';
        const nitradoLabel = integration.nitradoConfigured ? 'validated' : (integration.nitradoMetadataPresent ? 'needs validation' : 'required');
        return '<div class="server-onboarding-row' + selected + '">' +
          '<div class="server-onboarding-row-head"><div><h3>' + escapeHtml(server.name || server.id) + '</h3><p><code>' + escapeHtml(server.id) + '</code></p></div>' + managedServerStatusChip(server) + '</div>' +
          '<div class="server-onboarding-meta">' +
            '<span class="chip ' + (integration.nitradoConfigured ? 'success' : 'pending') + '">Nitrado ' + nitradoLabel + '</span>' +
            '<span class="chip ' + (integration.discordConfigured ? 'success' : '') + '">Discord ' + (integration.discordConfigured ? 'configured' : 'optional') + '</span>' +
            '<span class="chip ' + (integration.preflightReady ? 'success' : 'pending') + '">Preflight ' + (integration.preflightReady ? 'passed' : 'pending') + '</span>' +
            '<span class="chip ' + (server.runtime?.operations?.paused === true ? 'pending' : (server.runtimeEnabled ? 'success' : 'pending')) + '">Runtime ' + (server.runtime?.operations?.paused === true ? 'paused' : (server.runtimeEnabled ? 'enabled' : 'blocked')) + '</span>' +
          '</div>' +
          (!server.primary ? '<div class="server-onboarding-actions"><button class="ghost-btn" type="button" data-managed-server-edit="' + escapeHtml(server.id) + '">Configurar</button></div>' : '') +
        '</div>';
      }).join('');
    }
    function switchManagedServerSetupTab(tab) {
      const next = ['overview', 'nitrado', 'discord', 'preflight'].includes(tab) ? tab : 'overview';
      state.managedServerSetupTab = next;
      document.querySelectorAll('[data-managed-server-tab]').forEach((button) => button.classList.toggle('active', button.dataset.managedServerTab === next));
      ['overview', 'nitrado', 'discord', 'preflight'].forEach((key) => {
        const panel = document.getElementById('managedServerSetup' + key.charAt(0).toUpperCase() + key.slice(1));
        if (panel) panel.classList.toggle('active', key === next);
      });
    }
    function setManagedServerSelectOptions(select, options, currentValue, placeholder) {
      if (!select) return;
      const selected = String(currentValue || '');
      const rows = ['<option value="">' + escapeHtml(placeholder || 'Não configurado') + '</option>'];
      (options || []).forEach((option) => {
        const value = String(option.value || option.id || '');
        if (!value) return;
        rows.push('<option value="' + escapeHtml(value) + '"' + (selected === value ? ' selected' : '') + (option.disabled && selected !== value ? ' disabled' : '') + '>' + escapeHtml(option.label || option.name || value) + '</option>');
      });
      if (selected && !(options || []).some((option) => String(option.value || option.id || '') === selected)) {
        rows.push('<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected + ' · salvo') + '</option>');
      }
      select.innerHTML = rows.join('');
      select.value = selected;
    }
    function renderManagedServerNitradoServices(currentValue) {
      const options = (state.managedServerNitradoServices || []).map((service) => ({
        value: service.id,
        label: (service.name || ('Service ' + service.id)) + ' · #' + service.id + (service.game ? ' · ' + service.game : '') + (service.status ? ' · ' + service.status : '') + (service.assignedServerName ? ' · em uso por ' + service.assignedServerName : ''),
        disabled: Boolean(service.assignedServerId),
      }));
      setManagedServerSelectOptions(els.managedServerNitradoServiceSelect, options, currentValue, options.length ? 'Selecione um servidor Nitrado' : 'Carregue os servidores da conta');
    }
    function renderManagedServerDiscordGuilds(currentValue) {
      const options = (state.managedServerDiscordGuilds || []).map((guild) => ({ value: guild.id, label: guild.name + (guild.memberCount ? ' · ' + guild.memberCount + ' membros' : '') }));
      setManagedServerSelectOptions(els.managedServerDiscordGuildSelect, options, currentValue, 'Nenhum · opcional');
    }
    function renderManagedServerDiscordChannels(server) {
      const channels = state.managedServerDiscordChannels || [];
      const textOptions = channels.filter((channel) => channel.type === 'text').map((channel) => ({ value: channel.id, label: '#' + channel.name }));
      const categoryOptions = channels.filter((channel) => channel.type === 'category').map((channel) => ({ value: channel.id, label: channel.name }));
      setManagedServerSelectOptions(els.managedServerDiscordGlobal, textOptions, server?.runtime?.discord?.globalChannelId || '', 'Não configurado');
      setManagedServerSelectOptions(els.managedServerDiscordDaily, textOptions, server?.runtime?.discord?.dailyChannelId || '', 'Não configurado');
      setManagedServerSelectOptions(els.managedServerDiscordWeekly, textOptions, server?.runtime?.discord?.weeklyChannelId || '', 'Não configurado');
      setManagedServerSelectOptions(els.managedServerDiscordOnlineCategory, categoryOptions, server?.runtime?.discord?.onlineCategoryId || '', 'Não configurado');
    }
    function renderManagedServerPreflight(server) {
      if (!server || server.primary) return;
      const integration = managedServerIntegrationState(server);
      const result = state.managedServerPreflightResult?.serverId === server.id ? state.managedServerPreflightResult : null;
      if (els.managedServerPreflightState) {
        const failed = Boolean(result && !result.passed);
        els.managedServerPreflightState.textContent = integration.preflightReady ? 'Ready' : (failed ? 'Bloqueado' : 'Pendente');
        els.managedServerPreflightState.className = 'chip ' + (integration.preflightReady ? 'success' : (failed ? 'danger' : 'pending'));
      }
      if (els.managedServerPreflightRun) {
        // A running server must be stopped before its activation configuration
        // can be revalidated or changed.
        els.managedServerPreflightRun.disabled = Boolean(server.runtimeEnabled);
        els.managedServerPreflightRun.textContent = server.runtimeEnabled
          ? 'Desative para revalidar'
          : (integration.preflightReady ? 'Executar preflight novamente' : 'Executar preflight');
      }
      if (els.managedServerRuntimeToggle) {
        const canShow = integration.preflightReady || Boolean(server.runtimeEnabled);
        els.managedServerRuntimeToggle.style.display = canShow ? '' : 'none';
        els.managedServerRuntimeToggle.disabled = false;
        els.managedServerRuntimeToggle.textContent = server.runtimeEnabled ? 'Desativar runtime' : 'Ativar runtime';
        els.managedServerRuntimeToggle.className = server.runtimeEnabled ? 'danger-btn' : 'primary-btn';
      }
      const paused = server?.runtime?.operations?.paused === true;
      const runtimeStatus = managedServerRuntimeStatus(server.id);
      if (els.managedServerRuntimePauseToggle) {
        els.managedServerRuntimePauseToggle.style.display = server.runtimeEnabled ? '' : 'none';
        els.managedServerRuntimePauseToggle.disabled = false;
        els.managedServerRuntimePauseToggle.textContent = paused ? 'Retomar processamento' : 'Pausar processamento';
        els.managedServerRuntimePauseToggle.className = paused ? 'primary-btn' : 'ghost-btn';
      }
      if (els.managedServerRuntimeRetry) {
        els.managedServerRuntimeRetry.style.display = server.runtimeEnabled && !paused ? '' : 'none';
        els.managedServerRuntimeRetry.disabled = false;
        els.managedServerRuntimeRetry.textContent = runtimeStatus?.circuitState === 'open' ? 'Tentar recuperação agora' : 'Executar ciclo agora';
      }
      if (els.managedServerRuntimeActivationMeta) {
        const activation = server?.runtime?.activation;
        els.managedServerRuntimeActivationMeta.textContent = paused
          ? 'Runtime pausado manualmente. State, configuração e namespace permanecem intactos; o scheduler não processará este servidor até retomar.'
          : (server.runtimeEnabled
            ? 'Runtime ativo. O scheduler central processa este servidor no mesmo ciclo coordenado do PZ.'
            : (activation?.everActivated
              ? 'Runtime desligado. O namespace existente deste servidor será reutilizado numa reativação.'
              : (integration.preflightReady ? 'Ready para a primeira ativação. O primeiro ciclo será solicitado uma única vez após ativar.' : 'O runtime só pode ser ativado depois de um preflight aprovado.')));
      }
      if (els.managedServerRuntimeHealthMeta) {
        if (!server.runtimeEnabled) {
          els.managedServerRuntimeHealthMeta.textContent = 'Health: stopped · nenhum ciclo agendado.';
        } else if (paused) {
          els.managedServerRuntimeHealthMeta.textContent = 'Health: paused · pausa persistida no registry; nenhum polling extra foi criado.';
        } else {
          const health = String(runtimeStatus?.health || 'starting');
          const failures = Number(runtimeStatus?.consecutiveFailures || 0);
          const retryAt = runtimeStatus?.circuitRetryAt ? new Date(runtimeStatus.circuitRetryAt).toLocaleString('pt-BR') : null;
          els.managedServerRuntimeHealthMeta.textContent = 'Health: ' + health + ' · falhas consecutivas: ' + failures + (retryAt ? ' · próximo probe: ' + retryAt : '') + (runtimeStatus?.lastHealthyAt ? ' · último saudável: ' + new Date(runtimeStatus.lastHealthyAt).toLocaleString('pt-BR') : '');
        }
      }
      if (els.managedServerPreflightIntro) {
        els.managedServerPreflightIntro.innerHTML = integration.nitradoValidationPersisted
          ? '<strong>Pronto para verificar.</strong><br>Serão feitas somente leituras/validações sob demanda. Nenhum ADM será baixado e nenhum runtime será iniciado.'
          : (integration.nitradoMetadataPresent
            ? '<strong>Nitrado configurado.</strong><br>A marca de validação precisa ser reconciliada. O próprio preflight revalidará Service ID + base dir antes de continuar, sem iniciar runtime nem baixar ADM.'
            : '<strong>Nitrado ainda não configurado.</strong><br>Conclua a etapa Nitrado antes de executar o activation preflight.');
      }
      if (els.managedServerPreflightSummary) {
        if (result) {
          els.managedServerPreflightSummary.textContent = result.passed
            ? 'Preflight aprovado em ' + new Date(result.checkedAt).toLocaleString('pt-BR') + ' · ' + Number(result.warningCount || 0) + ' aviso(s).'
            : 'Preflight bloqueado em ' + new Date(result.checkedAt).toLocaleString('pt-BR') + ' · ' + Number(result.failureCount || 0) + ' falha(s).';
        } else if (integration.preflightReady) {
          els.managedServerPreflightSummary.textContent = 'Último preflight aprovado em ' + new Date(integration.preflightCheckedAt).toLocaleString('pt-BR') + ' · ' + integration.preflightWarningCount + ' aviso(s).';
        } else {
          els.managedServerPreflightSummary.textContent = 'Ainda não executado nesta sessão.';
        }
      }
      if (els.managedServerPreflightChecks) {
        const checks = Array.isArray(result?.checks) ? result.checks : [];
        if (!checks.length) {
          els.managedServerPreflightChecks.innerHTML = '<div class="server-preflight-empty">' + (integration.preflightReady ? 'O último resultado aprovado está persistido. Execute novamente para revalidar e ver os checks detalhados.' : 'As verificações aparecerão aqui depois de executar o preflight.') + '</div>';
        } else {
          const label = { pass:'OK', warning:'Aviso', fail:'Falha', skipped:'Ignorado' };
          const cls = { pass:'success', warning:'warning', fail:'danger', skipped:'' };
          els.managedServerPreflightChecks.innerHTML = checks.map((check) => '<div class="server-preflight-row"><div><strong>' + escapeHtml(check.label || check.id || 'Check') + '</strong><div style="margin-top:6px"><span class="chip ' + (cls[check.status] || '') + '">' + escapeHtml(label[check.status] || check.status || '-') + '</span></div></div><div><p>' + escapeHtml(check.message || '') + '</p></div></div>').join('');
        }
      }
    }

    function renderManagedServerSetup(server) {
      if (!server || server.primary) return;
      const integration = managedServerIntegrationState(server);
      const configured = integration.nitradoConfigured;
      const ready = integration.preflightReady;
      if (els.managedServerFormTitle) els.managedServerFormTitle.textContent = server.name || server.id;
      if (els.managedServerFormStatus) {
        els.managedServerFormStatus.textContent = server.runtimeEnabled ? 'Running' : (ready ? 'Ready' : (configured ? 'Configured' : 'Draft'));
        els.managedServerFormStatus.className = 'chip ' + (server.runtimeEnabled ? 'success' : (ready || configured ? 'online' : 'pending'));
      }
      if (els.managedServerSetupId) els.managedServerSetupId.textContent = server.id || '-';
      if (els.managedServerSetupProgressText) els.managedServerSetupProgressText.textContent = ready ? '3 de 3 etapas' : (configured ? '2 de 3 etapas' : '1 de 3 etapas');
      if (els.managedServerSetupProgressBar) els.managedServerSetupProgressBar.style.width = ready ? '100%' : (configured ? '66.67%' : '33.33%');
      if (els.managedServerNitradoState) {
        els.managedServerNitradoState.textContent = configured ? 'Validated' : (integration.nitradoMetadataPresent ? 'Validar' : 'Obrigatório');
        els.managedServerNitradoState.className = 'chip ' + (configured ? 'success' : 'pending');
      }
      if (els.managedServerDiscordState) {
        els.managedServerDiscordState.textContent = integration.discordConfigured ? 'Configured · opcional' : 'Opcional';
        els.managedServerDiscordState.className = 'chip ' + (integration.discordConfigured ? 'success' : '');
      }
      const nitradoConnection = state.managedServerIntegrationSetup?.nitrado;
      if (els.managedServerNitradoConnection) {
        els.managedServerNitradoConnection.innerHTML = nitradoConnection?.tokenConfigured
          ? '<strong>Conta Nitrado disponível</strong><br>Usando a credencial protegida no backend. O token não é retornado para esta página.'
          : '<strong>Conexão Nitrado indisponível</strong><br>Conecte uma credencial Nitrado para a organização deste servidor.';
      }
      if (els.managedServerNitradoValidationMeta) {
        els.managedServerNitradoValidationMeta.textContent = integration.nitradoValidationPersisted
          ? 'Validado em ' + new Date(integration.nitradoValidatedAt).toLocaleString('pt-BR') + '. Alterar Service ID ou base dir exige validar novamente.'
          : (configured
            ? 'Servidor marcado como Configured. O preflight fará uma revalidação segura para reconciliar a marca persistida antes de liberar Ready.'
            : 'Configured só é liberado depois de uma validação manual bem-sucedida do Service ID + base dir.');
      }
      if (els.managedServerOverviewNitrado) {
        els.managedServerOverviewNitrado.innerHTML = '<span>Nitrado</span><strong>' + (configured ? 'Validated' : (integration.nitradoMetadataPresent ? 'Needs validation' : 'Não configurado')) + '</strong><p>' + (configured ? 'Service ID e base dir validados sob demanda.' : 'Obrigatório para completar o core setup.') + '</p>';
      }
      if (els.managedServerOverviewDiscord) {
        els.managedServerOverviewDiscord.innerHTML = '<span>Discord</span><strong>' + (integration.discordConfigured ? 'Configured' : 'Opcional') + '</strong><p>' + (integration.discordConfigured ? 'Guild vinculada ao cadastro.' : 'Pode ser conectado agora ou depois.') + '</p>';
      }
      if (els.managedServerOverviewPreflight) {
        els.managedServerOverviewPreflight.innerHTML = '<span>Preflight</span><strong>' + (ready ? 'Passed' : (configured ? 'Pendente' : 'Bloqueado')) + '</strong><p>' + (ready ? 'Isolation + integrations aprovados. Runtime ainda desligado.' : (configured ? 'Execute a checagem antes da futura ativação.' : 'Disponível depois da validação Nitrado.')) + '</p>';
      }
      if (els.managedServerOverviewRuntime) {
        const paused = server.runtime?.operations?.paused === true;
        const runtimeStatus = managedServerRuntimeStatus(server.id);
        const runtimeLabel = paused ? 'Paused' : (server.runtimeEnabled ? (runtimeStatus?.health === 'circuit-open' ? 'Circuit open' : 'Running') : (ready ? 'Ready to activate' : 'Desligado'));
        const runtimeCopy = paused ? 'Processamento pausado sem apagar state ou desativar a configuração.' : (server.runtimeEnabled ? 'ADM + parser executam no scheduler central com namespace próprio.' : (ready ? 'Ative manualmente na aba Preflight.' : 'Nenhum processo será iniciado durante o setup.'));
        els.managedServerOverviewRuntime.innerHTML = '<span>Runtime</span><strong>' + escapeHtml(runtimeLabel) + '</strong><p>' + escapeHtml(runtimeCopy) + '</p>';
      }
      if (els.managedServerNitradoSave) els.managedServerNitradoSave.disabled = Boolean(server.runtimeEnabled);
      if (els.managedServerDiscordSave) els.managedServerDiscordSave.disabled = Boolean(server.runtimeEnabled);
      if (els.managedServerNitradoDiscover) els.managedServerNitradoDiscover.disabled = Boolean(server.runtimeEnabled);
      if (els.managedServerDiscordDiscover) els.managedServerDiscordDiscover.disabled = Boolean(server.runtimeEnabled);
      renderManagedServerNitradoServices(server.integrations?.nitradoServiceId || '');
      renderManagedServerDiscordGuilds(server.integrations?.discordGuildId || '');
      renderManagedServerDiscordChannels(server);
      renderManagedServerPreflight(server);
    }
    function renderOrganization() {
      if (!state.organization) return;
      const payload = state.organization;
      const organization = payload.organization || {};
      const diagnostics = payload.diagnostics || {};
      const members = Array.isArray(payload.members) ? payload.members : [];
      const servers = Array.isArray(payload.servers) ? payload.servers : [];
      if (els.organizationSummary) {
        els.organizationSummary.innerHTML =
          '<span class="chip online">Organization ' + escapeHtml(organization.name || organization.id || 'Workspace') + '</span>' +
          '<span class="chip">ID ' + escapeHtml(organization.id || '—') + '</span>' +
          '<span class="chip">' + formatNumber(servers.length) + ' server(s)</span>' +
          '<span class="chip">' + formatNumber(members.length) + ' member(s)</span>' +
          '<span class="chip ' + (Number(diagnostics.serversWithoutOrganization || 0) === 0 ? 'online' : 'pending') + '">Unowned ' + formatNumber(diagnostics.serversWithoutOrganization || 0) + '</span>';
      }
      if (els.organizationMembers) {
        els.organizationMembers.innerHTML = members.length
          ? members.map((member) => '<div class="settings-row"><div><strong>' + escapeHtml(member.discordId) + '</strong><div class="member-meta">Organization member · Discord ID</div></div><div class="server-onboarding-actions"><span class="chip">' + escapeHtml(member.role || 'viewer') + '</span><button class="ghost-btn" type="button" data-org-remove="' + escapeHtml(member.discordId) + '">Remover</button></div></div>').join('')
          : '<div class="settings-empty-note">Nenhum membership persistido ainda. Os IDs de <code>DISCORD_ADMIN_USER_IDS</code> são seedados como owner no primeiro boot da Fase 15; o token legado continua apenas como bootstrap da plataforma.</div>';
      }
    }
    async function loadOrganization() {
      try {
        const response = await apiFetch('/admin-panel/api/organization');
        if (!response.ok) { showToast(await response.text()); return; }
        state.organization = await response.json();
        renderOrganization();
      } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    }

    async function saveOrganizationMember() {
      const discordId = String(els.organizationMemberDiscordId?.value || '').trim();
      const role = String(els.organizationMemberRole?.value || 'viewer');
      if (!discordId) { showToast('Informe o Discord User ID.'); return; }
      if (els.organizationMemberSave) els.organizationMemberSave.disabled = true;
      try {
        const response = await apiFetch('/admin-panel/api/organization/members', { method:'POST', body:JSON.stringify({ discordId, role }) });
        if (!response.ok) { showToast(await response.text()); return; }
        await loadOrganization();
        if (els.organizationMemberDiscordId) els.organizationMemberDiscordId.value = '';
        showToast('Membership atualizado.');
      } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
      finally { if (els.organizationMemberSave) els.organizationMemberSave.disabled = false; }
    }
    async function removeOrganizationMember(discordId) {
      if (!discordId || !window.confirm('Remover este membro da organização?')) return;
      const response = await apiFetch('/admin-panel/api/organization/members/' + encodeURIComponent(discordId), { method:'DELETE' });
      if (!response.ok) { showToast(await response.text()); return; }
      await loadOrganization();
      showToast('Membership removido.');
    }

    async function loadManagedServers() {
      if (state.managedServersLoading) return;
      state.managedServersLoading = true;
      if (els.managedServersList) els.managedServersList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
      try {
        const response = await apiFetch('/admin-panel/api/servers');
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.managedServers = payload.servers || [];
        state.managedServerIntegrationSetup = payload.integrationSetup || null;
        state.serverFoundation = payload.foundation || state.serverFoundation;
        state.runtimeCoordinator = payload.runtimeCoordinator || state.runtimeCoordinator;
        renderManagedServers();
        const selected = (state.managedServers || []).find((server) => server.id === state.selectedManagedServerId && !server.primary);
        if (selected) renderManagedServerSetup(selected);
      } finally { state.managedServersLoading = false; }
    }
    function resetManagedServerForm() {
      state.selectedManagedServerId = null;
      state.managedServerSetupTab = 'overview';
      state.managedServerNitradoServices = [];
      state.managedServerDiscordGuilds = [];
      state.managedServerDiscordChannels = [];
      state.managedServerPreflightResult = null;
      [els.managedServerName, els.managedServerId, els.managedServerNitradoServiceId, els.managedServerNitradoBaseDir, els.managedServerDiscordGuildId].forEach((input) => { if (input) input.value = ''; });
      renderManagedServerNitradoServices('');
      renderManagedServerDiscordGuilds('');
      renderManagedServerDiscordChannels(null);
      if (els.managedServerId) els.managedServerId.dataset.autoId = 'true';
      if (els.managedServerCreatePanel) els.managedServerCreatePanel.style.display = '';
      if (els.managedServerSetupPanel) els.managedServerSetupPanel.style.display = 'none';
      switchManagedServerSetupTab('overview');
      renderManagedServers();
    }
    function editManagedServer(serverId) {
      const server = (state.managedServers || []).find((candidate) => candidate.id === serverId && !candidate.primary);
      if (!server) return;
      state.selectedManagedServerId = server.id;
      state.managedServerNitradoServices = [];
      state.managedServerDiscordGuilds = [];
      state.managedServerDiscordChannels = [];
      state.managedServerPreflightResult = null;
      if (els.managedServerCreatePanel) els.managedServerCreatePanel.style.display = 'none';
      if (els.managedServerSetupPanel) els.managedServerSetupPanel.style.display = '';
      if (els.managedServerNitradoServiceId) els.managedServerNitradoServiceId.value = server.integrations?.nitradoServiceId || '';
      if (els.managedServerNitradoBaseDir) els.managedServerNitradoBaseDir.value = server.runtime?.nitradoBaseDir || '';
      if (els.managedServerDiscordGuildId) els.managedServerDiscordGuildId.value = server.integrations?.discordGuildId || '';
      renderManagedServerSetup(server);
      switchManagedServerSetupTab(state.managedServerSetupTab || 'overview');
      renderManagedServers();
    }
    function readManagedServerForm() {
      const editing = (state.managedServers || []).find((server) => server.id === state.selectedManagedServerId && !server.primary);
      return {
        id: editing?.id || els.managedServerId?.value || '',
        name: editing?.name || els.managedServerName?.value || '',
        nitradoServiceId: els.managedServerNitradoServiceSelect?.value || els.managedServerNitradoServiceId?.value || '',
        nitradoBaseDir: els.managedServerNitradoBaseDir?.value || '',
        discordGuildId: els.managedServerDiscordGuildSelect?.value || els.managedServerDiscordGuildId?.value || '',
        discord: {
          globalChannelId: els.managedServerDiscordGlobal?.value || '',
          dailyChannelId: els.managedServerDiscordDaily?.value || '',
          weeklyChannelId: els.managedServerDiscordWeekly?.value || '',
          onlineCategoryId: els.managedServerDiscordOnlineCategory?.value || '',
        },
      };
    }
    async function discoverManagedServerNitradoServices() {
      const serverId = state.selectedManagedServerId;
      if (!serverId || !els.managedServerNitradoDiscover) return;
      const button = els.managedServerNitradoDiscover;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Carregando...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/nitrado/services');
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.managedServerNitradoServices = payload.services || [];
        state.managedServerIntegrationSetup = { ...(state.managedServerIntegrationSetup || {}), nitrado: payload.connection || state.managedServerIntegrationSetup?.nitrado };
        const current = els.managedServerNitradoServiceId?.value || '';
        renderManagedServerNitradoServices(current);
        if (els.managedServerNitradoConnection) els.managedServerNitradoConnection.innerHTML = '<strong>Conta Nitrado conectada</strong><br>' + state.managedServerNitradoServices.length + ' serviço(s) encontrado(s). Escolha um e valide antes de continuar.';
        showToast(state.managedServerNitradoServices.length + ' serviço(s) Nitrado carregado(s).');
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    }
    async function validateManagedServerNitrado() {
      const serverId = state.selectedManagedServerId;
      const button = els.managedServerNitradoSave;
      if (!serverId || !button) return;
      const payload = readManagedServerForm();
      if (!String(payload.nitradoServiceId || '').trim()) { showToast('Selecione um servidor Nitrado ou informe o Service ID.'); return; }
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Validando...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/nitrado/validate', {
          method: 'POST',
          body: JSON.stringify({ serviceId: payload.nitradoServiceId, baseDir: payload.nitradoBaseDir }),
        });
        if (!response.ok) { showToast(await response.text()); return; }
        const result = await response.json();
        state.managedServers = result.servers || state.managedServers;
        state.serverFoundation = result.foundation || state.serverFoundation;
        state.managedServerPreflightResult = null;
        if (els.managedServerNitradoServiceId) els.managedServerNitradoServiceId.value = result.validation?.serviceId || payload.nitradoServiceId;
        if (els.managedServerNitradoBaseDir) els.managedServerNitradoBaseDir.value = result.validation?.baseDir || payload.nitradoBaseDir;
        renderManagedServers();
        const selected = (state.managedServers || []).find((server) => server.id === serverId);
        if (selected) renderManagedServerSetup(selected);
        showToast('Nitrado validado. O servidor agora está Configured, mas o runtime continua bloqueado.');
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    }
    async function loadManagedServerDiscordChannels(guildId) {
      const serverId = state.selectedManagedServerId;
      if (!serverId || !guildId) {
        state.managedServerDiscordChannels = [];
        renderManagedServerDiscordChannels(null);
        return;
      }
      const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/discord/guilds/' + encodeURIComponent(guildId) + '/channels');
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      state.managedServerDiscordChannels = payload.channels || [];
      const selected = (state.managedServers || []).find((server) => server.id === serverId);
      const preserveSavedChannels = selected?.integrations?.discordGuildId === guildId ? selected : null;
      renderManagedServerDiscordChannels(preserveSavedChannels);
      if (els.managedServerDiscordConnection) els.managedServerDiscordConnection.innerHTML = '<strong>' + escapeHtml(payload.guild?.name || 'Discord') + '</strong><br>' + state.managedServerDiscordChannels.length + ' canal(is)/categoria(s) carregado(s) sob demanda.';
    }
    async function discoverManagedServerDiscordGuilds() {
      const serverId = state.selectedManagedServerId;
      const button = els.managedServerDiscordDiscover;
      if (!serverId || !button) return;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Carregando...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/discord/options');
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.managedServerDiscordGuilds = payload.guilds || [];
        const currentServer = (state.managedServers || []).find((server) => server.id === serverId);
        const currentGuildId = currentServer?.integrations?.discordGuildId || els.managedServerDiscordGuildId?.value || '';
        renderManagedServerDiscordGuilds(currentGuildId);
        if (els.managedServerDiscordConnection) {
          els.managedServerDiscordConnection.innerHTML = payload.ready
            ? '<strong>Discord bot conectado</strong><br>' + state.managedServerDiscordGuilds.length + ' servidor(es) disponível(is).'
            : '<strong>Discord indisponível</strong><br>' + escapeHtml(payload.message || 'Bot não conectado.');
        }
        if (currentGuildId && payload.ready) await loadManagedServerDiscordChannels(currentGuildId);
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    }
    async function runManagedServerPreflight() {
      const serverId = state.selectedManagedServerId;
      const button = els.managedServerPreflightRun;
      if (!serverId || !button) {
        showToast('Selecione um servidor antes de executar o preflight.');
        return;
      }

      const selectedBeforeRun = (state.managedServers || []).find((server) => server.id === serverId && !server.primary);
      if (!selectedBeforeRun) {
        showToast('Servidor não encontrado no registry carregado. Atualize a lista e tente novamente.');
        return;
      }

      const integrationBeforeRun = managedServerIntegrationState(selectedBeforeRun);
      if (!integrationBeforeRun.nitradoMetadataPresent) {
        showToast('Configure Service ID + base dir do Nitrado antes de executar o preflight.');
        switchManagedServerSetupTab('nitrado');
        return;
      }

      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Verificando...';
      if (els.managedServerPreflightSummary) els.managedServerPreflightSummary.textContent = 'Executando preflight...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/preflight', { method:'POST', body:JSON.stringify({}) });
        if (!response.ok) {
          const message = await response.text();
          if (els.managedServerPreflightSummary) els.managedServerPreflightSummary.textContent = message || 'Falha ao executar o preflight.';
          showToast(message || 'Falha ao executar o preflight.');
          return;
        }
        const payload = await response.json();
        state.managedServerPreflightResult = payload;
        state.managedServers = payload.servers || state.managedServers;
        state.serverFoundation = payload.foundation || state.serverFoundation;
        renderManagedServers();
        const selected = (state.managedServers || []).find((server) => server.id === serverId);
        if (selected) renderManagedServerSetup(selected);
        showToast(payload.passed
          ? 'Preflight aprovado. Servidor Ready; o runtime continua desligado até você ativar manualmente.'
          : 'Preflight bloqueado. Revise os checks antes de continuar.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (els.managedServerPreflightSummary) els.managedServerPreflightSummary.textContent = 'Erro ao executar preflight: ' + message;
        showToast('Erro ao executar preflight: ' + message);
      } finally {
        button.disabled = false;
        button.textContent = previous;
        const selected = (state.managedServers || []).find((server) => server.id === serverId);
        if (selected) renderManagedServerPreflight(selected);
      }
    }

    async function toggleManagedServerRuntime() {
      const serverId = state.selectedManagedServerId;
      const button = els.managedServerRuntimeToggle;
      const server = (state.managedServers || []).find((candidate) => candidate.id === serverId && !candidate.primary);
      if (!serverId || !server || !button) return;
      const enabling = !server.runtimeEnabled;
      const integration = managedServerIntegrationState(server);
      if (enabling && !integration.preflightReady) {
        showToast('Execute e aprove o preflight antes de ativar o runtime.');
        return;
      }
      const confirmed = window.confirm(enabling
        ? 'Ativar este runtime agora? O ADM fará um primeiro ciclo isolado e poderá baixar os ADM existentes deste servidor. Isso aumenta consumo de Nitrado/Render/Neon somente para este servidor.'
        : 'Desativar este runtime? O ADM fará um flush final do namespace deste servidor e deixará de processar novos ciclos dele. O PZ continuará rodando.');
      if (!confirmed) return;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = enabling ? 'Ativando...' : 'Desativando...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/runtime/' + (enabling ? 'activate' : 'deactivate'), { method:'POST', body:JSON.stringify({}) });
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.managedServers = payload.servers || state.managedServers;
        state.serverFoundation = payload.foundation || state.serverFoundation;
        state.runtimeCoordinator = payload.runtimeCoordinator || state.runtimeCoordinator;
        renderManagedServers();
        const selected = (state.managedServers || []).find((candidate) => candidate.id === serverId);
        if (selected) renderManagedServerSetup(selected);
        showToast(enabling
          ? (payload.cycleRequested ? 'Runtime ativado. Primeiro ciclo isolado solicitado.' : 'Runtime ativado. O scheduler central fará o próximo ciclo.')
          : 'Runtime desativado. O PZ continua ativo.');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
        button.textContent = previous;
        const selected = (state.managedServers || []).find((candidate) => candidate.id === serverId);
        if (selected) renderManagedServerPreflight(selected);
      }
    }

    async function toggleManagedServerPause() {
      const serverId = state.selectedManagedServerId;
      const button = els.managedServerRuntimePauseToggle;
      const server = (state.managedServers || []).find((candidate) => candidate.id === serverId && !candidate.primary);
      if (!serverId || !server || !button || !server.runtimeEnabled) return;
      const paused = server.runtime?.operations?.paused === true;
      const confirmed = window.confirm(paused
        ? 'Retomar este runtime agora? Um ciclo isolado será solicitado imediatamente e o scheduler central voltará a processá-lo.'
        : 'Pausar o processamento deste runtime? O ADM fará um flush final do namespace e deixará de baixar/processar novos ADMs até você retomar. O PZ continua rodando.');
      if (!confirmed) return;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = paused ? 'Retomando...' : 'Pausando...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/runtime/' + (paused ? 'resume' : 'pause'), { method:'POST', body:JSON.stringify({ reason:'Manual admin pause' }) });
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.managedServers = payload.servers || state.managedServers;
        state.serverFoundation = payload.foundation || state.serverFoundation;
        state.runtimeCoordinator = payload.runtimeCoordinator || state.runtimeCoordinator;
        renderManagedServers();
        const selected = (state.managedServers || []).find((candidate) => candidate.id === serverId);
        if (selected) renderManagedServerSetup(selected);
        showToast(paused
          ? (payload.cycleRequested ? 'Runtime retomado. Ciclo de recuperação solicitado.' : 'Runtime retomado; o scheduler fará o próximo ciclo.')
          : 'Runtime pausado. State preservado e PZ continua ativo.');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
        button.textContent = previous;
        const selected = (state.managedServers || []).find((candidate) => candidate.id === serverId);
        if (selected) renderManagedServerPreflight(selected);
      }
    }

    async function retryManagedServerRuntime() {
      const serverId = state.selectedManagedServerId;
      const button = els.managedServerRuntimeRetry;
      const server = (state.managedServers || []).find((candidate) => candidate.id === serverId && !candidate.primary);
      if (!serverId || !server || !button || !server.runtimeEnabled || server.runtime?.operations?.paused === true) return;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Solicitando...';
      try {
        const response = await apiFetch('/admin-panel/api/servers/' + encodeURIComponent(serverId) + '/runtime/retry', { method:'POST', body:JSON.stringify({}) });
        if (!response.ok) { showToast(await response.text()); return; }
        const payload = await response.json();
        state.runtimeCoordinator = payload.runtimeCoordinator || state.runtimeCoordinator;
        state.serverFoundation = payload.foundation || state.serverFoundation;
        renderManagedServers();
        const selected = (state.managedServers || []).find((candidate) => candidate.id === serverId);
        if (selected) renderManagedServerPreflight(selected);
        showToast('Ciclo isolado solicitado. O resultado aparecerá no health operacional.');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    }

    async function saveManagedServerForm(section) {
      const editingId = state.selectedManagedServerId;
      if (editingId && section === 'nitrado') return validateManagedServerNitrado();
      const button = editingId ? els.managedServerDiscordSave : els.managedServerSave;
      if (!button) return;
      const form = readManagedServerForm();
      if (!editingId && !String(form.name || '').trim()) { showToast('Informe o nome do servidor.'); return; }
      if (!editingId && !String(form.id || '').trim()) { showToast('Informe o Server ID.'); return; }
      const payload = editingId
        ? { discordGuildId: form.discordGuildId, discord: form.discord }
        : { id: form.id, name: form.name };
      button.disabled = true;
      try {
        const path = editingId ? '/admin-panel/api/servers/' + encodeURIComponent(editingId) : '/admin-panel/api/servers';
        const response = await apiFetch(path, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
        if (!response.ok) { showToast(await response.text()); return; }
        const result = await response.json();
        state.managedServers = result.servers || [];
        state.serverFoundation = result.foundation || state.serverFoundation;
        state.managedServerPreflightResult = null;
        renderManagedServers();
        if (!editingId) {
          editManagedServer(result.server?.id || '');
          showToast('Servidor criado. Agora conecte e valide o Nitrado.');
        } else {
          const selected = (state.managedServers || []).find((server) => server.id === editingId);
          if (selected) renderManagedServerSetup(selected);
          showToast('Configuração do Discord salva.');
        }
      } finally { button.disabled = false; }
    }
    function buildManagedServerIdClient(value) {
      return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    }
    function switchSettingsTab(tab) {
      state.settingsTab = tab;
      document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
      ['servers', 'server', 'events', 'discord', 'integrations'].forEach((key) => {
        const panel = document.getElementById('settingsPanel' + key.charAt(0).toUpperCase() + key.slice(1));
        if (panel) panel.classList.toggle('active', key === tab);
      });
      if (tab === 'servers') { if (!state.managedServers) loadManagedServers(); if (!state.organization) loadOrganization(); }
      if (tab === 'server' && !state.serviceSettings) loadServiceSettings();
      if (tab === 'events') renderLockedContainerCards();
      if (tab === 'discord' && !state.discordCommands) loadDiscordCommands();
    }
    async function injectMapEventAction() {
      const preset = selectedMapEventPreset();
      if (!preset) { showToast('Selecione um preset.'); return; }
      const payload = readMapEventForm();
      if (!Number.isFinite(payload.x) || !Number.isFinite(payload.z) || !payload.x || !payload.z) { showToast('Informe coordenadas no formato X / Z.'); return; }
      setMapEventStatus('<div class="map-event-result">Injetando evento nos XMLs...</div>');
      const response = await apiFetch('/admin-panel/api/map-events/inject', { method: 'POST', body: JSON.stringify(payload) });
      if (!response.ok) { const text = await response.text(); setMapEventStatus('<div class="map-event-result"><b>Erro:</b> ' + escapeHtml(text) + '</div>'); showToast(text); return; }
      const result = await response.json();
      setMapEventStatus('<div class="map-event-result"><b>Locked container injetado:</b><br>' + escapeHtml(result.eventName) + '<br><span class="chip">' + escapeHtml(result.lootMode || 'rng') + '</span><br><span class="member-meta">Reinicie o servidor para spawnar. Path: ' + escapeHtml(result.path || '') + '</span></div>');
      showToast('Locked container injetado. Reinicie o servidor.');
      setMapEventBuilderOpen(false);
      await loadScheduledMapEvents();
    }
    async function cleanupMapEventsAction() {
      if (!confirm('Remover todos os blocos MAP_EVENT dos XMLs?')) return;
      setMapEventStatus('<div class="map-event-result">Limpando eventos do mapa...</div>');
      const response = await apiFetch('/admin-panel/api/map-events/cleanup', { method: 'POST', body: JSON.stringify({}) });
      if (!response.ok) { const text = await response.text(); setMapEventStatus('<div class="map-event-result"><b>Erro:</b> ' + escapeHtml(text) + '</div>'); showToast(text); return; }
      const result = await response.json();
      setMapEventStatus('<div class="map-event-result"><b>Cleanup concluído.</b><br>events.xml: ' + (result.clearedEventsXml ? 'limpo' : 'sem bloco') + '<br>cfgeventspawns.xml: ' + (result.clearedEventSpawnsXml ? 'limpo' : 'sem bloco') + '<br>cfgspawnabletypes.xml: ' + (result.clearedSpawnableTypesXml ? 'limpo' : 'sem bloco') + '</div>');
      showToast('Eventos do mapa limpos.');
    }
    const PLAYER_MAP_WORLD_SIZE = 15360;
    function playerMapAgeLabel(seconds) {
      const value = Math.max(0, Number(seconds || 0));
      if (value < 60) return Math.round(value) + 's';
      if (value < 3600) return Math.floor(value / 60) + ' min';
      return (value / 3600).toFixed(1) + 'h';
    }
    function setPlayerMapZoom(value) {
      state.playerMapZoom = Math.max(1, Math.min(5, Number(value || 1)));
      if (els.playerMapInner) els.playerMapInner.style.setProperty('--player-map-zoom', String(state.playerMapZoom));
      if (els.playerMapZoomLabel) els.playerMapZoomLabel.textContent = Math.round(state.playerMapZoom * 100) + '%';
    }
    function filteredPlayerMapPlayers() {
      const players = Array.isArray(state.playerMap?.players) ? state.playerMap.players : [];
      const search = String(state.playerMapSearch || '').trim().toLowerCase();
      return search ? players.filter((player) => String(player.name || '').toLowerCase().includes(search)) : players;
    }
    function renderPlayerMap() {
      const payload = state.playerMap || { players: [], onlineCount: 0, positionedCount: 0 };
      const players = filteredPlayerMapPlayers();
      const positioned = players.filter((player) => Number.isFinite(Number(player.x)) && Number.isFinite(Number(player.z)));
      if (els.playerMapVisibleCount) els.playerMapVisibleCount.textContent = String(players.length);
      if (els.playerMapSummary) els.playerMapSummary.textContent = Number(payload.onlineCount || 0) + ' online · ' + Number(payload.positionedCount || 0) + ' com posição';
      if (els.playerMapUpdatedAt) els.playerMapUpdatedAt.textContent = payload.generatedAt ? relativeDate(payload.generatedAt) : 'Ainda não carregado';
      if (els.playerMapMarkers) {
        els.playerMapMarkers.innerHTML = positioned.map((player) => {
          const left = Math.max(0, Math.min(100, (Number(player.x) / PLAYER_MAP_WORLD_SIZE) * 100));
          const top = Math.max(0, Math.min(100, (1 - (Number(player.z) / PLAYER_MAP_WORLD_SIZE)) * 100));
          const age = Number(player.ageSeconds || 0);
          const freshness = age > 600 ? ' old' : age > 300 ? ' stale' : '';
          const title = String(player.name || '') + ' · X ' + Number(player.x).toFixed(1) + ' / Z ' + Number(player.z).toFixed(1) + ' · ' + playerMapAgeLabel(age);
          return '<div class="player-map-marker' + freshness + '" style="left:' + left.toFixed(4) + '%;top:' + top.toFixed(4) + '%" title="' + escapeHtml(title) + '"><span class="player-map-dot"></span><span class="player-map-label">' + escapeHtml(player.name || 'Player') + '</span></div>';
        }).join('');
      }
      if (els.playerMapList) {
        if (!players.length) { els.playerMapList.innerHTML = '<div class="player-map-empty">Nenhum jogador encontrado.</div>'; return; }
        els.playerMapList.innerHTML = players.map((player) => {
          const hasPosition = Number.isFinite(Number(player.x)) && Number.isFinite(Number(player.z));
          const coords = hasPosition ? ('X ' + Number(player.x).toFixed(1) + '<br>Z ' + Number(player.z).toFixed(1)) : 'sem posição';
          const seen = hasPosition ? ('posição há ' + playerMapAgeLabel(player.ageSeconds)) : 'aguardando posição desta sessão';
          return '<div class="player-map-row"><div><b>' + escapeHtml(player.name || 'Player') + '</b><small>' + escapeHtml(seen) + '</small></div><div class="player-map-row-coords">' + coords + '</div></div>';
        }).join('');
      }
    }
    async function loadPlayerMap() {
      if (els.playerMapRefresh) els.playerMapRefresh.disabled = true;
      try {
        const response = await apiFetch('/admin-panel/api/player-map/snapshot');
        if (!response.ok) throw new Error(await response.text());
        state.playerMap = await response.json();
        renderPlayerMap();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Falha ao carregar Player Map.');
      } finally {
        if (els.playerMapRefresh) els.playerMapRefresh.disabled = false;
      }
    }

    function switchView(view) {
      state.view = view; document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + view));
    document.querySelectorAll(".nav button").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
      els.pageTitle.textContent = view === "general" ? "Geral" : view === "members" ? "Membros" : view === "catalog" ? "Shop" : view === "map-events" ? "Eventos do Mapa" : view === "spawn-zones" ? "Spawn Zones" : view === "player-map" ? "Player Map" : view === "settings" ? "Settings" : "Itens";
      if (view === "members" && !els.memberList.children.length) loadMembers(true);
      if (view === "catalog" && !state.catalog) loadCatalog();
      if (view === "items" && !state.dayzItems.length) loadDayzItems(true);
      if (view === "map-events") { if (!state.mapEventPresets.length) loadMapEventPresets(); loadScheduledMapEvents(); }
      if (view === "spawn-zones") { if (!state.spawnZones) loadSpawnZones(); else renderSpawnZones(); }
      if (view === "player-map") { if (!state.playerMap) loadPlayerMap(); else renderPlayerMap(); }
      if (view === "settings") renderLockedContainerCards();
    }
    function openCoinModal(action, memberCardEl) {
      const discordId = memberCardEl.getAttribute("data-discord-id");
      const gamertag = memberCardEl.querySelector(".member-gamertag")?.textContent?.trim() || discordId;
      state.modal = { action, discordId, gamertag };
      const labels = { add: "Adicionar moedas", remove: "Remover moedas", set: "Definir saldo" };
      els.modalTitle.textContent = labels[action] || "Ajustar moedas";
      els.modalSubtitle.textContent = "Jogador: " + gamertag;
      els.coinAmount.value = ""; els.coinReason.value = ""; els.modalBackdrop.classList.add("open"); setTimeout(() => els.coinAmount.focus(), 80);
    }
    async function confirmCoinAction() {
      if (!state.modal) return;
      const amount = Number(els.coinAmount.value || 0);
      if (amount < 0 || (state.modal.action !== "set" && amount <= 0)) { showToast("Informe uma quantidade válida."); return; }
      const response = await apiFetch("/admin-panel/api/members/" + encodeURIComponent(state.modal.discordId) + "/coins", { method: "POST", body: JSON.stringify({ action: state.modal.action, amount, reason: els.coinReason.value || "Admin panel" }) });
      if (!response.ok) { showToast(await response.text()); return; }
      els.modalBackdrop.classList.remove("open"); showToast("Carteira atualizada com sucesso."); await loadOverview(); await loadMembers(true); if (state.selectedDiscordId) await openMemberDrawer(state.selectedDiscordId);
    }
    async function createMapVoteWelcomeNow() {
      const settingsSnapshot = readSpawnZoneSettingsForm();
      if (!settingsSnapshot.pollChannelId) {
        showToast('Informe e salve o ID do canal da enquete antes de criar as boas-vindas.');
        if (els.spawnZonesPollChannel) els.spawnZonesPollChannel.focus();
        return;
      }
      if (!confirm('Criar ou atualizar a mensagem de boas-vindas no canal da enquete?')) return;
      setSpawnZonesAutosaveStatus('criando boas-vindas...');
      setSpawnZoneSettingsStatus('Salvando canal antes de criar boas-vindas...', 'saving');
      await saveSpawnZonesSettingsNow(settingsSnapshot, { render: false });
      const response = await apiFetch('/admin-panel/api/spawn-zones/welcome/create', { method: 'POST', body: JSON.stringify({ settings: settingsSnapshot, rotation: buildSpawnZonesClientSnapshot(), createPoll: true }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); setSpawnZoneSettingsStatus('Erro ao criar boas-vindas.', 'error'); return; }
      state.spawnZones = await response.json();
      setSpawnZoneSettingsStatus('Boas-vindas criada/atualizada.', 'saved');
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones(); switchSpawnZonesTab('settings');
      showToast(state.spawnZones?.activePoll ? 'Boas-vindas e enquete prontas no Discord.' : 'Mensagem de boas-vindas criada/atualizada.');
    }
    async function createSpawnZonePollNow() {
      const settingsSnapshot = readSpawnZoneSettingsForm();
      if (!settingsSnapshot.pollChannelId) {
        showToast('Informe e salve o ID do canal da enquete antes de criar a enquete.');
        if (els.spawnZonesPollChannel) els.spawnZonesPollChannel.focus();
        return;
      }
      if (!confirm('Criar uma enquete nativa do Discord com as zonas habilitadas?')) return;
      setSpawnZonesAutosaveStatus('criando enquete...');
      setSpawnZoneSettingsStatus('Salvando canal antes de criar enquete...', 'saving');
      await saveSpawnZonesSettingsNow(settingsSnapshot, { render: false });
      const response = await apiFetch('/admin-panel/api/spawn-zones/poll/create', { method: 'POST', body: JSON.stringify({ settings: settingsSnapshot, rotation: buildSpawnZonesClientSnapshot() }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); setSpawnZoneSettingsStatus('Erro ao criar enquete.', 'error'); return; }
      state.spawnZones = await response.json();
      setSpawnZoneSettingsStatus('Enquete criada.', 'saved');
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones(); switchSpawnZonesTab('rotation');
      showToast('Enquete criada no Discord.');
    }
    async function refreshSpawnZonePoll() {
      setSpawnZonesAutosaveStatus('atualizando votos...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/poll/refresh', { method: 'POST', body: JSON.stringify({}) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
      showToast('Votos atualizados.');
    }
    async function finalizeSpawnZonePollNow() {
      if (!confirm('Finalizar a votação atual e registrar o vencedor conforme as regras configuradas?')) return;
      setSpawnZonesAutosaveStatus('finalizando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/poll/finalize', { method: 'POST', body: JSON.stringify({ apply: true }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
      showToast('Votação finalizada.');
    }
    async function runSpawnZoneAutomationNow() {
      setSpawnZonesAutosaveStatus('rodando automação...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/automation/run', { method: 'POST', body: JSON.stringify({}) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
      showToast('Automação executada.');
    }
    async function applySpawnZoneOnServer(zoneId) {
      if (!zoneId) return;
      if (!confirm('Aplicar esta zona no arquivo de spawn do servidor? Isso substitui os pontos fresh/generator_posbubbles.')) return;
      setSpawnZonesAutosaveStatus('enviando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/rotation/apply-server', { method: 'POST', body: JSON.stringify({ zoneId }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      const payload = await response.json();
      state.spawnZones = payload.rotation || payload;
      state.selectedSpawnZoneId = zoneId;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
      showToast('Spawn points enviados para o servidor. Reinicie para aplicar.');
    }
    let spawnZoneSettingsSaveTimer = null;
    let spawnZoneSettingsSaveSeq = 0;
    async function saveSpawnZonesSettingsNow(extraPatch, options) {
      const snapshot = { ...readSpawnZoneSettingsForm(), ...(extraPatch || {}) };
      const shouldRender = !options || options.render !== false;
      clearTimeout(spawnZoneSettingsSaveTimer);
      state.spawnZones = state.spawnZones || {};
      state.spawnZones.settings = { ...(state.spawnZones.settings || {}), ...snapshot };
      updateSpawnZoneSettingsUx();
      setSpawnZoneSettingsStatus('Salvando configurações...', 'saving');
      setSpawnZonesAutosaveStatus('salvando...');
      const seq = ++spawnZoneSettingsSaveSeq;
      const response = await apiFetch('/admin-panel/api/spawn-zones/settings', { method: 'PATCH', body: JSON.stringify({ ...snapshot, settings: snapshot, rotation: buildSpawnZonesClientSnapshot() }) });
      if (!response.ok) {
        const message = await response.text();
        showToast(message);
        setSpawnZoneSettingsStatus('Erro ao salvar: ' + message, 'error');
        setSpawnZonesAutosaveStatus('erro');
        return;
      }
      const saved = await response.json();
      if (seq === spawnZoneSettingsSaveSeq) {
        state.spawnZones = saved;
        setSpawnZoneSettingsStatus('Configurações salvas automaticamente.', 'saved');
        setSpawnZonesAutosaveStatus('salvo');
        if (shouldRender) {
          renderSpawnZonesSummary();
          renderSpawnZonesSettings();
        }
      }
    }
    function scheduleSpawnZonesSettingsSave(delay) {
      clearTimeout(spawnZoneSettingsSaveTimer);
      spawnZoneSettingsSaveTimer = setTimeout(() => saveSpawnZonesSettingsNow(), delay == null ? 450 : delay);
    }
    async function patchSpawnZonesSettings(patch) {
      await saveSpawnZonesSettingsNow(patch);
    }
    function handlePanelNavigationClick(event) {
      const navButton = event.target && event.target.closest ? event.target.closest('.nav button[data-view]') : null;
      if (!navButton) return false;
      event.preventDefault();
      switchView(navButton.getAttribute('data-view') || 'general');
      setMobileMenuOpen(false);
      return true;
    }
    function handleSpawnZoneTabClick(event) {
      const tabButton = event.target && event.target.closest ? event.target.closest('[data-spawn-zone-tab]') : null;
      if (!tabButton) return false;
      event.preventDefault();
      switchSpawnZonesTab(tabButton.getAttribute('data-spawn-zone-tab') || 'rotation');
      return true;
    }
    document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", handlePanelNavigationClick));
    document.querySelectorAll('[data-spawn-zone-tab]').forEach((button) => button.addEventListener('click', handleSpawnZoneTabClick));
    document.addEventListener('click', (event) => {
      // Fallback delegated listeners keep the panel navigable even if a section is re-rendered later.
      if (handlePanelNavigationClick(event)) return;
      handleSpawnZoneTabClick(event);
    });
    if (els.spawnZoneCreate) els.spawnZoneCreate.addEventListener('click', createSpawnZone);
    if (els.spawnZoneImport) els.spawnZoneImport.addEventListener('click', () => els.spawnZoneImportFile?.click());
    if (els.spawnZoneImportFile) els.spawnZoneImportFile.addEventListener('change', (event) => importSpawnZoneXmlFile(event.target.files && event.target.files[0]));
    if (els.spawnZonesSetNext) els.spawnZonesSetNext.addEventListener('click', () => setNextSpawnZone(els.spawnZonesNextSelect?.value || selectedSpawnZone()?.id));
    if (els.spawnZonesApplyNext) els.spawnZonesApplyNext.addEventListener('click', () => applySpawnZone(els.spawnZonesNextSelect?.value || selectedSpawnZone()?.id));
    if (els.spawnZonesApplyServer) els.spawnZonesApplyServer.addEventListener('click', () => applySpawnZoneOnServer(els.spawnZonesNextSelect?.value || selectedSpawnZone()?.id));
    if (els.spawnZonesCreatePoll) els.spawnZonesCreatePoll.addEventListener('click', createSpawnZonePollNow);
    if (els.spawnZonesWelcomeMessage) els.spawnZonesWelcomeMessage.addEventListener('click', createMapVoteWelcomeNow);
    if (els.spawnZonesRefreshPoll) els.spawnZonesRefreshPoll.addEventListener('click', refreshSpawnZonePoll);
    if (els.spawnZonesFinalizePoll) els.spawnZonesFinalizePoll.addEventListener('click', finalizeSpawnZonePollNow);
    if (els.spawnZonesRunAutomation) els.spawnZonesRunAutomation.addEventListener('click', runSpawnZoneAutomationNow);
    if (els.spawnZonesMapZoomIn) els.spawnZonesMapZoomIn.addEventListener('click', () => setSpawnZoneMapZoom((state.spawnZoneMapZoom || 1) + 0.5));
    if (els.spawnZonesMapZoomOut) els.spawnZonesMapZoomOut.addEventListener('click', () => setSpawnZoneMapZoom((state.spawnZoneMapZoom || 1) - 0.5));
    if (els.spawnZonesMapInner) {
      els.spawnZonesMapInner.addEventListener('click', (event) => {
        if (state.spawnZoneMapSuppressClick) { state.spawnZoneMapSuppressClick = false; return; }
        const marker = event.target.closest('[data-spawn-marker]');
        if (marker) { focusSpawnZonePoint(marker.getAttribute('data-spawn-marker')); return; }
        addSpawnZonePointFromEvent(event);
      });
      els.spawnZonesMapViewport?.addEventListener('wheel', (event) => {
        if (!els.spawnZonesMapViewport || !els.spawnZonesMapInner) return;
        event.preventDefault();
        const previousZoom = state.spawnZoneMapZoom || 1;
        const rect = els.spawnZonesMapViewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const mapX = (els.spawnZonesMapViewport.scrollLeft + pointerX) / previousZoom;
        const mapY = (els.spawnZonesMapViewport.scrollTop + pointerY) / previousZoom;
        const zoomFactor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
        setSpawnZoneMapZoom(previousZoom * zoomFactor);
        const nextZoom = state.spawnZoneMapZoom || 1;
        els.spawnZonesMapViewport.scrollLeft = Math.max(0, (mapX * nextZoom) - pointerX);
        els.spawnZonesMapViewport.scrollTop = Math.max(0, (mapY * nextZoom) - pointerY);
        scheduleSpawnZoneTileRender();
      }, { passive: false });
      els.spawnZonesMapViewport?.addEventListener('scroll', scheduleSpawnZoneTileRender, { passive: true });
      els.spawnZonesMapInner.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || event.target.closest('[data-spawn-marker]')) return;
        if ((state.spawnZoneMapZoom || 1) <= 1) return;
        state.spawnZoneMapDragging = { x: event.clientX, y: event.clientY, left: els.spawnZonesMapViewport.scrollLeft, top: els.spawnZonesMapViewport.scrollTop };
        els.spawnZonesMapViewport.classList.add('is-dragging');
      });
      window.addEventListener('mousemove', (event) => {
        const coords = spawnZoneEventCoords(event);
        if (coords && els.spawnZonesCursor) els.spawnZonesCursor.textContent = 'X: ' + spawnZoneCoord(coords.x) + ' | Z: ' + spawnZoneCoord(coords.z);
        if (!state.spawnZoneMapDragging || !els.spawnZonesMapViewport) return;
        event.preventDefault();
        const dx = event.clientX - state.spawnZoneMapDragging.x;
        const dy = event.clientY - state.spawnZoneMapDragging.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.spawnZoneMapSuppressClick = true;
        els.spawnZonesMapViewport.scrollLeft = state.spawnZoneMapDragging.left - dx;
        els.spawnZonesMapViewport.scrollTop = state.spawnZoneMapDragging.top - dy;
        scheduleSpawnZoneTileRender();
      });
      window.addEventListener('mouseup', () => { state.spawnZoneMapDragging = null; if (els.spawnZonesMapViewport) els.spawnZonesMapViewport.classList.remove('is-dragging'); });
      els.spawnZonesMapInner.addEventListener('contextmenu', (event) => {
        const marker = event.target.closest('[data-spawn-marker]');
        if (!marker) return;
        event.preventDefault();
        const zoneId = marker.getAttribute('data-spawn-marker-zone') || selectedSpawnZone()?.id;
        if (zoneId) deleteSpawnZonePoint(zoneId, marker.getAttribute('data-spawn-marker'));
      });
    }
    if (els.spawnZoneList) {
      els.spawnZoneList.addEventListener('click', (event) => {
        const zoneSelect = event.target.closest('[data-spawn-zone-select]');
        const zoneDelete = event.target.closest('[data-spawn-zone-delete]');
        const pointFocus = event.target.closest('[data-spawn-point-focus]');
        const pointDelete = event.target.closest('[data-spawn-point-delete]');
        const editButton = event.target.closest('[data-spawn-zone-edit]');
        const nameInput = event.target.closest('[data-spawn-zone-name]');
        const card = event.target.closest('[data-spawn-zone-id]');
        if (editButton) { event.stopPropagation(); state.selectedSpawnZoneId = editButton.getAttribute('data-spawn-zone-edit'); state.spawnZoneEditingNameId = state.selectedSpawnZoneId; renderSpawnZones(); setTimeout(() => document.querySelector('[data-spawn-zone-name="' + CSS.escape(state.selectedSpawnZoneId) + '"]')?.focus(), 30); return; }
        if (nameInput) { event.stopPropagation(); return; }
        if (zoneSelect) { state.selectedSpawnZoneId = zoneSelect.getAttribute('data-spawn-zone-select'); renderSpawnZones(); return; }
        if (zoneDelete) { event.stopPropagation(); deleteSpawnZone(zoneDelete.getAttribute('data-spawn-zone-delete')); return; }
        if (pointFocus) { event.stopPropagation(); focusSpawnZonePoint(pointFocus.getAttribute('data-spawn-point-focus')); return; }
        if (pointDelete) { event.stopPropagation(); const zoneId = pointDelete.getAttribute('data-spawn-point-zone') || selectedSpawnZone()?.id; if (zoneId) deleteSpawnZonePoint(zoneId, pointDelete.getAttribute('data-spawn-point-delete')); return; }
        if (card && !event.target.closest('[data-spawn-zone-delete],[data-spawn-zone-edit],[data-spawn-point-delete],[data-spawn-point-focus],label,input')) { state.selectedSpawnZoneId = card.getAttribute('data-spawn-zone-id'); renderSpawnZones(); }
      });
      els.spawnZoneList.addEventListener('change', (event) => {
        const enabledInput = event.target.closest('[data-spawn-zone-enabled]');
        if (enabledInput) patchSpawnZone(enabledInput.getAttribute('data-spawn-zone-enabled'), { enabled: Boolean(enabledInput.checked) });
      });
      async function commitSpawnZoneNameInput(input) {
        if (!input) return;
        const zoneId = input.getAttribute('data-spawn-zone-name');
        const name = input.value;
        state.spawnZoneEditingNameId = null;
        if (zoneId) await patchSpawnZone(zoneId, { name });
      }
      els.spawnZoneList.addEventListener('keydown', (event) => {
        const nameInput = event.target.closest('[data-spawn-zone-name]');
        if (!nameInput) return;
        if (event.key === 'Enter') { event.preventDefault(); commitSpawnZoneNameInput(nameInput); }
        if (event.key === 'Escape') { state.spawnZoneEditingNameId = null; renderSpawnZones(); }
      });
      els.spawnZoneList.addEventListener('focusout', (event) => {
        const nameInput = event.target.closest('[data-spawn-zone-name]');
        if (!nameInput) return;
        setTimeout(() => { if (state.spawnZoneEditingNameId === nameInput.getAttribute('data-spawn-zone-name')) commitSpawnZoneNameInput(nameInput); }, 60);
      });
      els.spawnZoneList.addEventListener('focusin', (event) => {
        const nameInput = event.target.closest('[data-spawn-zone-name]');
        if (!nameInput) return;
        state.selectedSpawnZoneId = nameInput.getAttribute('data-spawn-zone-name');
        renderSpawnZoneMarkers();
      });
    }
    const spawnZoneTextSettingInputs = ['spawnZonesPollChannel', 'spawnZonesPollCategory', 'spawnZonesPollQuestion', 'spawnZonesMinVotes', 'spawnZonesSpawnFilePath', 'spawnZonesServerName'];
    spawnZoneTextSettingInputs.forEach((elementKey) => {
      const element = els[elementKey];
      if (!element) return;
      element.addEventListener('input', () => { setSpawnZoneSettingsStatus('Alterações pendentes...', 'saving'); scheduleSpawnZonesSettingsSave(500); });
      element.addEventListener('change', () => saveSpawnZonesSettingsNow());
      element.addEventListener('blur', () => saveSpawnZonesSettingsNow());
    });
    ['spawnZonesPollOpenDay', 'spawnZonesPollOpenTime', 'spawnZonesPollCloseDay', 'spawnZonesPollCloseTime', 'spawnZonesPollTimezone', 'spawnZonesTiePolicy'].forEach((elementKey) => {
      const element = els[elementKey];
      if (!element) return;
      element.addEventListener('change', () => { updateSpawnZoneSettingsUx(); saveSpawnZonesSettingsNow(); });
    });
    ['spawnZonesAutoCreatePoll', 'spawnZonesRecurringPollAfterFinish', 'spawnZonesAutoApplyWinner', 'spawnZonesApplyOnNextRestart'].forEach((elementKey) => {
      const element = els[elementKey];
      if (!element) return;
      element.addEventListener('change', () => { updateSpawnZoneSettingsUx(); saveSpawnZonesSettingsNow(); });
    });
    if (mobileMenuButton) mobileMenuButton.addEventListener("click", () => setMobileMenuOpen(!(sidebar && sidebar.classList.contains("open"))));
    if (mobileNavBackdrop) mobileNavBackdrop.addEventListener("click", () => setMobileMenuOpen(false));
    window.addEventListener("keydown", (event) => { if (event.key === "Escape") setMobileMenuOpen(false); });
    document.getElementById("refreshButton").addEventListener("click", async () => { await loadOverview(); if (state.view === "members") await loadMembers(true); if (state.view === "catalog") { if (state.catalogMode === "queue") await loadShopQueue(); else await loadCatalog(); } if (state.view === "items") await loadDayzItems(true); if (state.view === "map-events") { await loadMapEventPresets(); await loadScheduledMapEvents(); } if (state.view === "spawn-zones") await loadSpawnZones(); if (state.view === "player-map") await loadPlayerMap(); if (state.view === "settings") renderLockedContainerCards(); showToast("Dados atualizados."); });
    if (els.playerMapRefresh) els.playerMapRefresh.addEventListener('click', () => loadPlayerMap());
    if (els.playerMapZoomIn) els.playerMapZoomIn.addEventListener('click', () => setPlayerMapZoom(state.playerMapZoom + 0.5));
    if (els.playerMapZoomOut) els.playerMapZoomOut.addEventListener('click', () => setPlayerMapZoom(state.playerMapZoom - 0.5));
    if (els.playerMapSearch) els.playerMapSearch.addEventListener('input', (event) => { state.playerMapSearch = event.target.value || ''; renderPlayerMap(); });
    document.getElementById("membersRefresh").addEventListener("click", () => { state.memberForceRefresh = true; loadMembers(true); });
    let searchTimer = null;
    function updateSearch(value) { state.search = value; clearTimeout(searchTimer); searchTimer = setTimeout(() => loadMembers(true), 240); }
    document.getElementById("memberSearch").addEventListener("input", (event) => updateSearch(event.target.value));
    document.getElementById("globalSearch").addEventListener("input", (event) => { document.getElementById("memberSearch").value = event.target.value; updateSearch(event.target.value); if (state.view !== "members") switchView("members"); });
    document.getElementById("memberFilter").addEventListener("change", (event) => { state.filter = event.target.value; loadMembers(true); });

    if (els.mapEventPresetGrid) els.mapEventPresetGrid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-map-event-preset]");
      if (!card) return;
      const preset = (state.mapEventPresets || []).find((item) => item.id === card.getAttribute("data-map-event-preset"));
      if (preset) { if (els.mapEventName) els.mapEventName.value = preset.name; applyMapEventPresetDefaults(preset); }
    });
    const mapEventsRefresh = document.getElementById("mapEventsRefresh");
    if (mapEventsRefresh) mapEventsRefresh.addEventListener("click", async () => { await loadMapEventPresets(); await loadScheduledMapEvents(); });
    if (els.mapEventsNewToggle) els.mapEventsNewToggle.addEventListener("click", () => setMapEventBuilderOpen(!state.mapEventBuilderOpen));
    if (els.mapEventsBuilderClose) els.mapEventsBuilderClose.addEventListener("click", () => setMapEventBuilderOpen(false));
    if (els.mapEventsSchedule) els.mapEventsSchedule.addEventListener("click", scheduleMapEventAction);
    document.querySelectorAll('input[name="mapEventExecutionMode"]').forEach((input) => input.addEventListener('change', updateMapEventExecutionUi));
    if (els.mapEventTime) els.mapEventTime.addEventListener('change', updateMapEventExecutionUi);
    if (els.mapEventsScheduledList) els.mapEventsScheduledList.addEventListener('click', (event) => { const button = event.target.closest('[data-scheduled-action]'); if (!button) return; const card = button.closest('[data-scheduled-event-id]'); handleScheduledEventAction(card?.getAttribute('data-scheduled-event-id'), button.getAttribute('data-scheduled-action')); });
    updateMapEventExecutionUi();
    const mapEventsInject = document.getElementById("mapEventsInject");
    if (mapEventsInject) mapEventsInject.addEventListener("click", injectMapEventAction);
    const mapEventsCleanup = document.getElementById("mapEventsCleanup");
    if (mapEventsCleanup) mapEventsCleanup.addEventListener("click", cleanupMapEventsAction);
    const lockedContainerCheck = document.getElementById("lockedContainerCheck");
    const lockedContainerInstall = document.getElementById("lockedContainerInstall");
    const lockedContainerUninstall = document.getElementById("lockedContainerUninstall");
    if (lockedContainerCheck) lockedContainerCheck.addEventListener("click", () => checkLockedContainerSetupAction(true));
    if (lockedContainerInstall) lockedContainerInstall.addEventListener("click", installLockedContainerSetupAction);
    if (lockedContainerUninstall) lockedContainerUninstall.addEventListener("click", uninstallLockedContainerSetupAction);
    if (els.eventIntegrationModalClose) els.eventIntegrationModalClose.addEventListener("click", () => els.eventIntegrationModalBackdrop?.classList.remove("open"));
    if (els.eventIntegrationModalBackdrop) els.eventIntegrationModalBackdrop.addEventListener("click", (event) => { if (event.target === els.eventIntegrationModalBackdrop) els.eventIntegrationModalBackdrop.classList.remove("open"); });
    const discordCommandsList = document.getElementById('discordCommandsList');
    if (discordCommandsList) discordCommandsList.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-command-toggle]');
      if (button) toggleDiscordCommand(button.getAttribute('data-command-toggle') || '', button);
    });
    els.managedServersRefresh?.addEventListener("click", () => loadManagedServers());
    els.organizationRefresh?.addEventListener("click", () => loadOrganization());
    els.organizationMemberSave?.addEventListener("click", () => saveOrganizationMember());
    els.organizationMembers?.addEventListener("click", (event) => { const button = event.target.closest('[data-org-remove]'); if (button) removeOrganizationMember(button.getAttribute('data-org-remove')); });
    els.managedServerCreateNew?.addEventListener("click", () => resetManagedServerForm());
    els.managedServerSave?.addEventListener("click", () => saveManagedServerForm('create'));
    els.managedServerNitradoDiscover?.addEventListener("click", () => discoverManagedServerNitradoServices());
    els.managedServerNitradoSave?.addEventListener("click", () => saveManagedServerForm('nitrado'));
    els.managedServerDiscordDiscover?.addEventListener("click", () => discoverManagedServerDiscordGuilds());
    els.managedServerDiscordSave?.addEventListener("click", () => saveManagedServerForm('discord'));
    els.managedServerPreflightRun?.addEventListener("click", () => runManagedServerPreflight());
    els.managedServerRuntimeToggle?.addEventListener("click", () => toggleManagedServerRuntime());
    els.managedServerRuntimePauseToggle?.addEventListener("click", () => toggleManagedServerPause());
    els.managedServerRuntimeRetry?.addEventListener("click", () => retryManagedServerRuntime());
    els.managedServerNitradoServiceSelect?.addEventListener('change', () => {
      const serviceId = els.managedServerNitradoServiceSelect?.value || '';
      const previousServiceId = els.managedServerNitradoServiceId?.value || '';
      const service = (state.managedServerNitradoServices || []).find((candidate) => candidate.id === serviceId);
      if (els.managedServerNitradoServiceId) els.managedServerNitradoServiceId.value = serviceId;
      if (service?.detectedBaseDir && els.managedServerNitradoBaseDir && (previousServiceId !== serviceId || !els.managedServerNitradoBaseDir.value.trim())) els.managedServerNitradoBaseDir.value = service.detectedBaseDir;
    });
    els.managedServerDiscordGuildSelect?.addEventListener('change', async () => {
      const guildId = els.managedServerDiscordGuildSelect?.value || '';
      if (els.managedServerDiscordGuildId) els.managedServerDiscordGuildId.value = guildId;
      await loadManagedServerDiscordChannels(guildId);
    });
    els.managedServerCancel?.addEventListener("click", () => resetManagedServerForm());
    els.managedServersList?.addEventListener("click", (event) => { const button = event.target.closest("button[data-managed-server-edit]"); if (button) editManagedServer(button.dataset.managedServerEdit || ""); });
    document.querySelectorAll('[data-managed-server-tab]').forEach((button) => button.addEventListener('click', () => switchManagedServerSetupTab(button.dataset.managedServerTab || 'overview')));
    els.managedServerName?.addEventListener('input', () => {
      if (state.selectedManagedServerId || !els.managedServerId || els.managedServerId.dataset.autoId === 'false') return;
      els.managedServerId.value = buildManagedServerIdClient(els.managedServerName.value);
    });
    els.managedServerId?.addEventListener('input', () => { els.managedServerId.dataset.autoId = 'false'; });
    if (els.managedServerId) els.managedServerId.dataset.autoId = 'true';
    document.querySelectorAll(".settings-tab").forEach((button) => button.addEventListener("click", () => switchSettingsTab(button.dataset.settingsTab || "server")));
    document.getElementById("serviceSettingsList")?.addEventListener("click", (event) => { const button = event.target.closest("button[data-service-toggle]"); if (button) toggleServiceSetting(button.dataset.serviceToggle, button); });
    document.addEventListener("click", (event) => {
      const card = event.target.closest?.('[data-integration]');
      if (card) openLockedContainerIntegrationModal(card.getAttribute('data-integration') || 'locked-containers');
    });
    renderLockedContainerCards();
    if (els.mapEventLootMode) els.mapEventLootMode.addEventListener("change", updateMapEventLootModeUi);
    if (els.mapEventCoordinates) els.mapEventCoordinates.addEventListener("input", syncMapEventCoordinatesHiddenFields);
    if (els.mapEventMapInner) els.mapEventMapInner.addEventListener("click", handleMapEventMapClick);
    if (els.mapEventMapViewport) {
      els.mapEventMapViewport.addEventListener("wheel", handleMapEventMapWheel, { passive: false });
      els.mapEventMapViewport.addEventListener("pointerdown", handleMapEventMapPointerDown);
      els.mapEventMapViewport.addEventListener("pointermove", handleMapEventMapPointerMove);
      els.mapEventMapViewport.addEventListener("pointerup", finishMapEventMapDrag);
      els.mapEventMapViewport.addEventListener("pointercancel", finishMapEventMapDrag);
      els.mapEventMapViewport.addEventListener("pointerleave", finishMapEventMapDrag);
    }
    if (els.mapEventMapZoomIn) els.mapEventMapZoomIn.addEventListener("click", (event) => setMapEventMapZoom(mapEventMapZoom + 0.25, event));
    if (els.mapEventMapZoomOut) els.mapEventMapZoomOut.addEventListener("click", (event) => setMapEventMapZoom(mapEventMapZoom - 0.25, event));
    setMapEventMapZoom(1);
    if (els.mapEventRewardStorageSearch) els.mapEventRewardStorageSearch.addEventListener("input", (event) => searchMapEventBaseItems('storage', event.target.value));
    if (els.mapEventGuaranteedItemSearch) els.mapEventGuaranteedItemSearch.addEventListener("input", (event) => searchMapEventBaseItems('item', event.target.value));
    if (els.mapEventRewardStorageAutocomplete) els.mapEventRewardStorageAutocomplete.addEventListener("click", (event) => {
      const option = event.target.closest('[data-map-event-target="storage"]');
      if (!option) return;
      selectMapEventStorage({ className: option.getAttribute('data-class-name') || '', popularName: option.getAttribute('data-popular-name') || '', imageUrl: option.getAttribute('data-image-url') || '' });
    });
    if (els.mapEventGuaranteedItemAutocomplete) els.mapEventGuaranteedItemAutocomplete.addEventListener("click", (event) => {
      const option = event.target.closest('[data-map-event-target="item"]');
      if (!option) return;
      addMapEventLootItem({ className: option.getAttribute('data-class-name') || '', popularName: option.getAttribute('data-popular-name') || '', imageUrl: option.getAttribute('data-image-url') || '' });
    });
    if (els.mapEventGuaranteedItemsList) els.mapEventGuaranteedItemsList.addEventListener("input", (event) => {
      const input = event.target.closest('[data-loot-quantity]');
      if (!input) return;
      const index = Number(input.getAttribute('data-loot-quantity'));
      if (!Number.isFinite(index) || !state.mapEventLootItems[index]) return;
      state.mapEventLootItems[index].quantity = Math.max(1, Math.min(50, Number(input.value || 1)));
    });
    if (els.mapEventGuaranteedItemsList) els.mapEventGuaranteedItemsList.addEventListener("click", (event) => {
      const button = event.target.closest('[data-loot-remove]');
      if (!button) return;
      const index = Number(button.getAttribute('data-loot-remove'));
      if (!Number.isFinite(index)) return;
      state.mapEventLootItems.splice(index, 1);
      renderMapEventLootItems();
    });
    document.addEventListener("click", (event) => {
      if (els.mapEventRewardStorageWrap && !els.mapEventRewardStorageWrap.contains(event.target)) setMapEventAutocompleteOpen('storage', false);
      if (els.mapEventGuaranteedItemsWrap && !els.mapEventGuaranteedItemsWrap.contains(event.target)) setMapEventAutocompleteOpen('item', false);
    });
    if (els.mapEventRewardStorage) els.mapEventRewardStorage.value = 'SeaChest';
    if (els.mapEventRewardStorageSearch) els.mapEventRewardStorageSearch.value = 'SeaChest';
    state.mapEventRewardStorageItem = { className: 'SeaChest', popularName: 'SeaChest', imageUrl: '' };
    updateMapEventLootModeUi();
    document.getElementById("catalogSearch").addEventListener("input", (event) => { state.catalogSearch = event.target.value; renderCatalog(); });
    document.getElementById("catalogRefresh").addEventListener("click", loadCatalog);
    document.getElementById("catalogItemsRefresh").addEventListener("click", loadCatalog);
    document.getElementById("shopQueueOpen").addEventListener("click", showShopQueueView);
    document.getElementById("shopQueueOpenFromItems").addEventListener("click", showShopQueueView);
    document.getElementById("shopQueueBack").addEventListener("click", hideShopQueueView);
    document.getElementById("shopQueueRefresh").addEventListener("click", loadShopQueue);
    document.getElementById("shopHistoryOpen").addEventListener("click", openShopHistoryDrawer);
    document.getElementById("shopHistoryOpenFromItems").addEventListener("click", openShopHistoryDrawer);
    document.getElementById("shopHistoryOpenFromQueue").addEventListener("click", openShopHistoryDrawer);
    document.getElementById("catalogBack").addEventListener("click", leaveCatalogCategory);
    document.getElementById("catalogCategoryCreate").addEventListener("click", openCatalogCategoryModal);
    document.getElementById("catalogCreate").addEventListener("click", () => openCatalogModal("create", null));
    document.getElementById("catalogModalCancel").addEventListener("click", closeCatalogModal);
    document.getElementById("catalogModalConfirm").addEventListener("click", saveCatalogItem);
    document.getElementById("catalogCategoryModalCancel").addEventListener("click", closeCatalogCategoryModal);
    document.getElementById("catalogCategoryModalConfirm").addEventListener("click", saveCatalogCategory);
    els.catalogItemId.addEventListener("input", (event) => { if (state.catalogModal?.mode === "create") searchCatalogBaseItems(event.target.value); });
    els.catalogItemId.addEventListener("focus", (event) => { if (state.catalogModal?.mode === "create") searchCatalogBaseItems(event.target.value); });
    els.catalogItemAutocomplete.addEventListener("click", (event) => {
      const option = event.target.closest(".autocomplete-option");
      if (!option) return;
      applyCatalogBaseItem({ className: option.dataset.className, popularName: option.dataset.popularName, imageUrl: option.dataset.imageUrl });
    });
    document.addEventListener("click", (event) => {
      if (!els.catalogItemAutocomplete?.contains(event.target) && event.target !== els.catalogItemId) setCatalogAutocompleteOpen(false);
    });
    els.catalogCategoryGrid.addEventListener("dragstart", (event) => { if (event.target.closest('[data-drag-type="category"]')) startCatalogDrag(event, 'category'); });
    els.catalogCategoryGrid.addEventListener("dragover", (event) => { if (state.catalogDrag?.type !== 'category') return; event.preventDefault(); moveDragElement(els.catalogCategoryGrid, '.catalog-category-card[data-category-id]', state.catalogDrag.element, event); });
    els.catalogCategoryGrid.addEventListener("drop", (event) => { if (state.catalogDrag?.type === 'category') event.preventDefault(); });
    els.catalogCategoryGrid.addEventListener("dragend", () => { if (state.catalogDrag?.type === 'category') finishCatalogDrag(); });
    els.catalogGrid.addEventListener("dragstart", (event) => { if (event.target.closest('[data-drag-type="item"]')) startCatalogDrag(event, 'item'); });
    els.catalogGrid.addEventListener("dragover", (event) => { if (state.catalogDrag?.type !== 'item') return; event.preventDefault(); moveDragElement(els.catalogGrid, '.catalog-item[data-item-id]', state.catalogDrag.element, event); });
    els.catalogGrid.addEventListener("drop", (event) => { if (state.catalogDrag?.type === 'item') event.preventDefault(); });
    els.catalogGrid.addEventListener("dragend", () => { if (state.catalogDrag?.type === 'item') finishCatalogDrag(); });
    els.catalogCategoryGrid.addEventListener("click", (event) => {
      if (state.catalogJustDragged || event.target.closest('[data-drag-type="category"]')) return;
      const deleteButton = event.target.closest("button[data-category-action]");
      const card = event.target.closest(".catalog-category-card");
      if (!card) return;
      if (card.id === "catalogNewCategoryCard") { openCatalogCategoryModal(); return; }
      const categoryId = card.getAttribute("data-category-id");
      if (!categoryId) return;
      if (deleteButton?.dataset.categoryAction === "delete") {
        event.stopPropagation();
        deleteCatalogCategory(categoryId);
        return;
      }
      enterCatalogCategory(categoryId);
    });
    els.catalogGrid.addEventListener("click", (event) => {
      if (state.catalogJustDragged || event.target.closest('[data-drag-type="item"]')) return;
      const button = event.target.closest("button[data-catalog-action]");
      if (!button) return;
      const card = button.closest(".catalog-item");
      const itemId = card?.getAttribute("data-item-id");
      if (!itemId) return;
      const action = button.dataset.catalogAction;
      if (action === "edit") openCatalogModal("edit", findCatalogItem(itemId));
      if (action === "toggle") toggleCatalogItem(itemId);
      if (action === "delete") deleteCatalogItemAction(itemId);
    });
    let itemsSearchTimer = null;
    els.itemsSearch.addEventListener("input", (event) => {
      state.itemsSearch = event.target.value;
      clearTimeout(itemsSearchTimer);
      itemsSearchTimer = setTimeout(() => loadDayzItems(true), 240);
    });
    els.itemsFilter.addEventListener("change", (event) => { state.itemsFilter = event.target.value; loadDayzItems(true); });
    els.itemsRefresh.addEventListener("click", () => loadDayzItems(true));
    els.itemsList.addEventListener("click", (event) => {
      const row = event.target.closest(".dayz-item-row");
      if (!row) return;
      const className = row.getAttribute("data-class-name");
      const switchInput = event.target.closest("input[data-item-switch]");
      if (switchInput) {
        event.stopPropagation();
        toggleDayzItem(className, Boolean(switchInput.checked));
        return;
      }
      openDayzItemModal(findDayzItem(className));
    });
    document.getElementById("itemModalCancel").addEventListener("click", closeDayzItemModal);
    document.getElementById("itemModalConfirm").addEventListener("click", saveDayzItem);
    document.getElementById("itemModalRemoveImage").addEventListener("click", () => { els.itemModalImageUrl.value = ""; updateItemModalPreview(); });
    els.itemModalPopularName.addEventListener("input", updateItemModalPreview);
    els.itemModalImageUrl.addEventListener("input", updateItemModalPreview);

    els.memberList.addEventListener("click", (event) => {
      const card = event.target.closest(".member-card");
      if (!card) return;
      const button = event.target.closest("button[data-action]");
      if (button) {
        event.stopPropagation();
        openCoinModal(button.dataset.action, card);
        return;
      }
      openMemberDrawer(card.getAttribute("data-discord-id"));
    });
    document.getElementById("modalCancel").addEventListener("click", () => els.modalBackdrop.classList.remove("open"));
    document.getElementById("drawerClose").addEventListener("click", closeMemberDrawer);
    document.getElementById("modalConfirm").addEventListener("click", confirmCoinAction);
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting) && state.view === "members") loadMembers(false); }, { rootMargin: "420px" });
    observer.observe(document.getElementById("memberSentinel"));
    const itemsObserver = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting) && state.view === "items") loadDayzItems(false); }, { rootMargin: "520px" });
    itemsObserver.observe(document.getElementById("itemsSentinel"));
    document.getElementById("performanceMetricsRefresh")?.addEventListener("click", () => loadServiceSettings());
    document.addEventListener("change", (event) => { const select = event.target.closest("#admDownloadModeSelect"); if (select) updateAdmDownloadMode(select.value, select); });
    loadOverview();
    loadServiceSettings();
  </script>
</body>
</html>`;
}

// Database-backed ADM sessions are hard-bound to one managed server. Every
// downstream admin handler inherits that server through AsyncLocalStorage, so
// legacy admin APIs cannot silently fall back to the primary runtime.
router.use(async (req, res, next) => {
  const serverId = req.adminSession?.serverId;
  if (!serverId) { next(); return; }
  let server = getManagedServerById(serverId);
  if (!server) {
    try {
      await refreshManagedServerRegistryFromDb();
      server = getManagedServerById(serverId);
    } catch (error) {
      console.error(`[admin-panel] failed to refresh managed server registry for ${serverId}:`, error);
    }
  }
  if (!server) {
    const acceptsHtml = String(req.headers.accept || "").includes("text/html");
    if ((req.method === "GET" || req.method === "HEAD") && acceptsHtml) {
      res.redirect("/admin-panel/setup");
      return;
    }
    res.status(409).json({ error: "ADMIN_SERVER_NOT_FOUND", serverId });
    return;
  }
  runInServerMaintenanceContext(serverId, () => next());
});

// Phase 16 keeps legacy admin API gaps closed centrally. Server/organization routes
// have their own ownership-aware guards below; every other admin API is pinned
// to the primary organization and derives read/write capability from HTTP method.
router.use("/api", (req, res, next) => {
  const scopedPath = String(req.path || "").replace(/^\/api(?=\/|$)/, "");
  if (scopedPath === "/servers" || scopedPath.startsWith("/servers/") || scopedPath === "/organizations" || scopedPath.startsWith("/organizations/")) {
    next();
    return;
  }
  if (!requireAdmin(req, res)) return;
  next();
});

router.get("/", (req, res) => {
  if (!req.adminSession && !hasPlatformBootstrapAccess(req)) {
    res.redirect("/admin-panel/login");
    return;
  }
  if (req.adminSession && !req.adminSession.serverId) {
    res.redirect("/admin-panel/setup");
    return;
  }
  if (!requireAdmin(req, res)) return;
  setPanelCookie(req, res);
  res.type("html").send(renderAdminPanelHtml(getTokenFromRequest(req)));
});

router.get("/api/service-settings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const state = await getStateAsync();
    const settings = normalizeServiceSettings(state.serviceSettings);
    setAdmDownloadMode(settings.admDownloadMode);
    res.json({
      settings,
      serverFoundation: getServerFoundationDiagnostics(),
      persistenceMetrics: getStatePersistenceMetrics(),
      domainPersistenceMetrics: getStateDomainPersistenceMetrics(),
      granularPlayerStatsMetrics: getGranularPlayerStatsPersistenceMetrics(),
      discordRuntimeMetrics: getDiscordRuntimePersistenceMetrics(),
      playerPositionHistoryMetrics: getPlayerPositionHistoryMetrics(),
      admDownloadMetrics: getAdmDownloadMetrics(),
      runtimeMetrics: getRuntimePerformanceMetrics(),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
      serverRuntimeObservability: buildServerRuntimeObservability(),
      playerPortalContext: getPlayerPortalContextDiagnostics(),
      networkMetrics: getNetworkMetrics(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch("/api/service-settings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const input = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const state = await getStateAsync();
    const current = normalizeServiceSettings(state.serviceSettings);
    const next = normalizeServiceSettings({
      ...current,
      shopEnabled: typeof input.shopEnabled === "boolean" ? input.shopEnabled : current.shopEnabled,
      livePresenceEnabled: true,
      storePresenceHistory: typeof input.storePresenceHistory === "boolean" ? input.storePresenceHistory : current.storePresenceHistory,
      admDownloadMode: input.admDownloadMode === "legacy" || input.admDownloadMode === "shadow" || input.admDownloadMode === "optimized" ? input.admDownloadMode : current.admDownloadMode,
    });
    state.serviceSettings = next;
    setAdmDownloadMode(next.admDownloadMode);
    await saveStateAsync(state);
    await flushStateAsync();

    const effectiveCommandSettings = applyServiceSettingsToCommandSettings(state.discordCommandSettings, next);
    const client = getDiscordClient();
    if (client.isReady()) {
      await registerDiscordCommands(client, effectiveCommandSettings, getActiveServerId(), getActiveServerId() === getPrimaryServerId() ? "full" : "core");
    }

    res.json({
      settings: next,
      commands: listDiscordCommandDescriptors(effectiveCommandSettings),
      persistenceMetrics: getStatePersistenceMetrics(),
      domainPersistenceMetrics: getStateDomainPersistenceMetrics(),
      granularPlayerStatsMetrics: getGranularPlayerStatsPersistenceMetrics(),
      discordRuntimeMetrics: getDiscordRuntimePersistenceMetrics(),
      playerPositionHistoryMetrics: getPlayerPositionHistoryMetrics(),
      admDownloadMetrics: getAdmDownloadMetrics(),
      runtimeMetrics: getRuntimePerformanceMetrics(),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
      serverRuntimeObservability: buildServerRuntimeObservability(),
      playerPortalContext: getPlayerPortalContextDiagnostics(),
      networkMetrics: getNetworkMetrics(),
      serverFoundation: getServerFoundationDiagnostics(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/discord-commands", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const state = await getStateAsync();
    res.json({ commands: listDiscordCommandDescriptors(applyServiceSettingsToCommandSettings(state.discordCommandSettings, state.serviceSettings)) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch("/api/discord-commands/:commandName", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const commandName = String(req.params.commandName || "").trim().toLowerCase();
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).send("enabled must be a boolean");
      return;
    }
    const state = await getStateAsync();
    const available = listDiscordCommandDescriptors(applyServiceSettingsToCommandSettings(state.discordCommandSettings, state.serviceSettings));
    if (!available.some((command) => command.name === commandName)) {
      res.status(404).send("Discord command not found");
      return;
    }
    const settings = normalizeDiscordCommandSettings(state.discordCommandSettings);
    settings[commandName] = { enabled, updatedAt: new Date().toISOString() };
    state.discordCommandSettings = settings;
    await saveStateAsync(state);
    await flushStateAsync();

    const client = getDiscordClient();
    if (!client.isReady()) {
      res.status(503).json({
        error: "Discord bot is not connected. The setting was saved, but commands could not be synchronized yet.",
        commands: listDiscordCommandDescriptors(applyServiceSettingsToCommandSettings(state.discordCommandSettings, state.serviceSettings)),
      });
      return;
    }

    const effectiveCommandSettings = applyServiceSettingsToCommandSettings(state.discordCommandSettings, state.serviceSettings);
    await registerDiscordCommands(client, effectiveCommandSettings, getActiveServerId(), getActiveServerId() === getPrimaryServerId() ? "full" : "core");
    res.json({ commands: listDiscordCommandDescriptors(effectiveCommandSettings) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/organization", async (req, res) => {
  const organizationId = currentOrganizationIdForRequest(req);
  if (!requireOrganizationAccess(req, res, organizationId, "view")) return;
  const organization = getManagedOrganizationById(organizationId);
  res.json({
    organization,
    membership: req.portalSession ? getUserOrganizationMembership(req.portalSession.discordId, organizationId) || null : null,
    members: listOrganizationMemberships(organizationId),
    servers: listManagedServers().filter((server) => server.organizationId === organizationId),
    diagnostics: organizationDiagnosticsForRequest(req),
    platformBootstrap: hasPlatformBootstrapAccess(req),
  });
});

router.post("/api/organization/members", async (req, res) => {
  const organizationId = currentOrganizationIdForRequest(req);
  if (!requireOrganizationAccess(req, res, organizationId, "own")) return;
  try {
    const membership = await upsertOrganizationMembership(organizationId, req.body?.discordId, req.body?.role);
    res.json({ membership, members: listOrganizationMemberships(organizationId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.delete("/api/organization/members/:discordId", async (req, res) => {
  const organizationId = currentOrganizationIdForRequest(req);
  if (!requireOrganizationAccess(req, res, organizationId, "own")) return;
  try {
    await removeOrganizationMembership(organizationId, req.params.discordId);
    res.json({ members: listOrganizationMemberships(organizationId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.get("/api/organizations", async (req, res) => {
  if (hasPlatformBootstrapAccess(req)) {
    res.json({ organizations: listManagedOrganizations(), diagnostics: organizationDiagnosticsForRequest(req) });
    return;
  }
  if (req.adminSession?.serverId) {
    const organizationId = currentOrganizationIdForRequest(req);
    res.json({ organizations: listManagedOrganizations().filter((organization) => organization.id === organizationId), diagnostics: organizationDiagnosticsForRequest(req) });
    return;
  }
  if (!req.portalSession) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const allowedIds = new Set(listUserOrganizationMemberships(req.portalSession.discordId).map((membership) => membership.organizationId));
  res.json({
    organizations: listManagedOrganizations().filter((organization) => allowedIds.has(organization.id)),
    diagnostics: organizationDiagnosticsForRequest(req),
  });
});

router.post("/api/organizations/self-service", async (req, res) => {
  if (!req.portalSession) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const integrationDiagnostics = getOrganizationIntegrationsDiagnostics();
  if (!isSaasSelfServiceEnabled() || !integrationDiagnostics.encryptionConfigured) {
    res.status(403).json({
      error: "SELF_SERVICE_NOT_READY",
      message: !isSaasSelfServiceEnabled()
        ? "O onboarding SaaS esta fechado para novos clientes neste ambiente."
        : "Configure ADM_SECRETS_KEY com pelo menos 32 caracteres antes de abrir o self-service.",
    });
    return;
  }
  const existing = listUserOrganizationMemberships(req.portalSession.discordId);
  if (existing.length) {
    res.status(409).json({ error: "ORGANIZATION_ALREADY_EXISTS", organizationId: existing[0].organizationId });
    return;
  }
  try {
    const organization = await createManagedOrganizationForOwner(req.body || {}, req.portalSession.discordId);
    res.status(201).json({ organization, membership: getUserOrganizationMembership(req.portalSession.discordId, organization?.id) || null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/ja existe/i.test(message) ? 409 : 400).send(message);
  }
});

router.get("/api/organizations/:organizationId/integrations", async (req, res) => {
  const organizationId = buildOrganizationId(req.params.organizationId);
  if (!requireOrganizationAccess(req, res, organizationId, "view")) return;
  res.json({
    organizationId,
    nitrado: getOrganizationIntegrationStatus(organizationId),
    discord: {
      configured: Boolean(process.env.DISCORD_TOKEN),
      credentialModel: "platform-bot",
      tokenExposedToBrowser: false,
    },
    diagnostics: organizationIntegrationDiagnosticsForRequest(req),
  });
});

router.post("/api/organizations/:organizationId/integrations/nitrado", async (req, res) => {
  const organizationId = buildOrganizationId(req.params.organizationId);
  if (!requireOrganizationAccess(req, res, organizationId, "own")) return;
  try {
    const validation = await testOrganizationNitradoCredential(req.body?.token);
    await saveOrganizationNitradoCredential(organizationId, req.body?.token, validation);
    res.json({ organizationId, validation, nitrado: getOrganizationIntegrationStatus(organizationId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.delete("/api/organizations/:organizationId/integrations/nitrado", async (req, res) => {
  const organizationId = buildOrganizationId(req.params.organizationId);
  if (!requireOrganizationAccess(req, res, organizationId, "own")) return;
  try {
    const runningServers = listManagedServers().filter((server) => server.organizationId === organizationId && server.runtimeEnabled);
    if (runningServers.length) {
      res.status(409).json({
        error: "NITRADO_CREDENTIAL_IN_USE",
        message: `Desative os runtimes da organizacao antes de remover a credencial Nitrado (${runningServers.map((server) => server.name).join(", ")}).`,
      });
      return;
    }
    await removeOrganizationNitradoCredential(organizationId);
    res.json({ organizationId, nitrado: getOrganizationIntegrationStatus(organizationId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.post("/api/organizations", async (req, res) => {
  if (!requirePlatformBootstrap(req, res)) return;
  try {
    const organization = await createManagedOrganization(req.body || {});
    res.status(201).json({ organization, organizations: listManagedOrganizations() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/ja existe/i.test(message) ? 409 : 400).send(message);
  }
});

router.get("/api/organizations/:organizationId", async (req, res) => {
  const organizationId = buildOrganizationId(req.params.organizationId);
  if (!requireOrganizationAccess(req, res, organizationId, "view")) return;
  const organization = getManagedOrganizationById(organizationId);
  if (!organization) { res.status(404).json({ error: "ORGANIZATION_NOT_FOUND" }); return; }
  res.json({
    organization,
    membership: req.portalSession ? getUserOrganizationMembership(req.portalSession.discordId, organizationId) || null : null,
    members: listOrganizationMemberships(organizationId),
    servers: listManagedServers().filter((server) => server.organizationId === organizationId),
  });
});

router.post("/api/organizations/:organizationId/members", async (req, res) => {
  const organizationId = buildOrganizationId(req.params.organizationId);
  if (!requireOrganizationAccess(req, res, organizationId, "own")) return;
  try {
    const membership = await upsertOrganizationMembership(organizationId, req.body?.discordId, req.body?.role);
    res.json({ membership, members: listOrganizationMemberships(organizationId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.delete("/api/organizations/:organizationId/members/:discordId", async (req, res) => {
  const organizationId = buildOrganizationId(req.params.organizationId);
  if (!requireOrganizationAccess(req, res, organizationId, "own")) return;
  try {
    await removeOrganizationMembership(organizationId, req.params.discordId);
    res.json({ members: listOrganizationMemberships(organizationId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.get("/api/servers", async (req, res) => {
  if (!hasPlatformBootstrapAccess(req) && !req.portalSession && !req.adminSession) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const servers = authorizedServersForRequest(req);
  const foundation = foundationForRequest(req, servers);
  const currentServer = servers.find((server) => server.primary) || servers[0] || null;
  res.json({
    mode: hasPlatformBootstrapAccess(req) ? "single-server-compat" : "tenant-scoped",
    currentServer,
    servers,
    canCreateServer: Boolean(foundation.onboarding?.canCreateDrafts),
    runtimeActivationBlocked: false,
    activationEndpointAvailable: true,
    runtimeCoordinator: runtimeCoordinatorForRequest(req, servers),
    preflightEnabled: true,
    secretsAccepted: false,
    integrationSetup: currentServer ? getIntegrationOnboardingStatus(currentServer.id) : null,
    foundation,
  });
});

router.post("/api/servers", async (req, res) => {
  try {
    let organizationId: string;
    if (hasPlatformBootstrapAccess(req)) {
      organizationId = buildOrganizationId(req.body?.organizationId) || getDefaultOrganizationId();
    } else {
      if (!req.portalSession) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
      organizationId = buildOrganizationId(req.body?.organizationId)
        || listUserOrganizationMemberships(req.portalSession.discordId)[0]?.organizationId
        || "";
      if (!organizationId || !requireOrganizationAccess(req, res, organizationId, "manage")) return;
    }
    const server = await createManagedServerDraft({ ...(req.body || {}), organizationId });
    res.status(201).json({
      server,
      servers: authorizedServersForRequest(req),
      runtimeActivationBlocked: false,
      foundation: foundationForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/ja existe/i.test(message) ? 409 : 400).send(message);
  }
});

router.patch("/api/servers/:serverId", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const server = await updateManagedServerDraft(String(req.params.serverId || ""), req.body || {});
    res.json({
      server,
      servers: authorizedServersForRequest(req),
      runtimeActivationBlocked: false,
      foundation: foundationForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.get("/api/servers/:serverId/settings", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "view")) return;
  const server = getManagedServerById(req.params.serverId);
  if (!server) { res.status(404).json({ error: "SERVER_NOT_FOUND" }); return; }
  res.json({ serverId: server.id, settings: server.runtime.settings || {} });
});

router.patch("/api/servers/:serverId/settings", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const server = await updateManagedServerScopedSettings(req.params.serverId, req.body || {});
    res.json({ server, settings: server?.runtime.settings || {} });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.get("/api/servers/:serverId/catalog", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "view")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const catalog = await runInServerDataContext(serverId, async () => {
      await ensureShopCatalogLoaded();
      return getShopCatalog();
    });
    res.json({ serverId, catalog, isolation: catalogIsolationForRequest(req, serverId) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.post("/api/servers/:serverId/catalog/clone", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const target = getManagedServerById(req.params.serverId);
    if (!target) throw new Error("Servidor de destino nao encontrado.");
    const requestedSourceId = String(req.body?.sourceServerId || "").trim();
    const fallbackSource = listManagedServers().find((server) => server.organizationId === target.organizationId && server.id !== target.id);
    const sourceId = requestedSourceId || fallbackSource?.id || "";
    const source = sourceId ? getManagedServerById(sourceId) : undefined;
    if (!source) throw new Error("Nenhum servidor de origem da mesma organizacao foi informado para clonar o catalogo.");
    if (!hasPlatformBootstrapAccess(req) && source.organizationId !== target.organizationId) {
      res.status(403).json({ error: "CROSS_ORGANIZATION_CATALOG_CLONE_FORBIDDEN" });
      return;
    }
    const result = await runInServerDataContext(target.id, () => cloneShopCatalog(source.id, target.id));
    res.json({ ...result, isolation: catalogIsolationForRequest(req, target.id) });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.post("/api/servers/:serverId/catalog/categories", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const catalog = await runInServerDataContext(serverId, async () => {
      await ensureShopCatalogLoaded();
      await upsertShopCatalogCategoryItem(req.body || {});
      return getShopCatalog();
    });
    res.json({ serverId, catalog });
  } catch (err) { res.status(400).send(err instanceof Error ? err.message : String(err)); }
});

router.post("/api/servers/:serverId/catalog/items", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const catalog = await runInServerDataContext(serverId, async () => {
      await ensureShopCatalogLoaded();
      await upsertShopCatalogItem(req.body || {});
      return getShopCatalog();
    });
    res.json({ serverId, catalog });
  } catch (err) { res.status(400).send(err instanceof Error ? err.message : String(err)); }
});

router.delete("/api/servers/:serverId/catalog/items/:itemId", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const catalog = await runInServerDataContext(serverId, async () => {
      await ensureShopCatalogLoaded();
      await deleteShopCatalogItem(req.params.itemId);
      return getShopCatalog();
    });
    res.json({ serverId, catalog });
  } catch (err) { res.status(400).send(err instanceof Error ? err.message : String(err)); }
});

router.get("/api/servers/:serverId/nitrado/services", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const result = await discoverNitradoServices(String(req.params.serverId || ""));
    res.json({ ...result, backgroundPolling: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.post("/api/servers/:serverId/nitrado/validate", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const validation = await validateNitradoServiceSetup(serverId, req.body?.serviceId, req.body?.baseDir);
    const server = await markManagedServerNitradoValidated(serverId, {
      serviceId: validation.serviceId,
      baseDir: validation.baseDir,
    });
    res.json({
      server,
      validation,
      servers: authorizedServersForRequest(req),
      runtimeActivationBlocked: false,
      foundation: foundationForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.get("/api/servers/:serverId/discord/options", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    res.json(await listDiscordGuildOptions(String(req.params.serverId || ""), req.portalSession?.discordId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.get("/api/servers/:serverId/discord/guilds/:guildId/channels", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    res.json(await listDiscordGuildChannels(String(req.params.serverId || ""), req.params.guildId, req.portalSession?.discordId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.post("/api/servers/:serverId/economy/coins", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const result = await runInServerDataContext(serverId, async () => {
      const state = await getStateAsync();
      const gamertag = String(req.body?.gamertag || "").trim();
      const link = getPlayerLinkByGamertag(state, gamertag);
      if (!link) throw new Error("Vincule esta gamertag a uma conta Discord neste servidor antes de alterar moedas.");
      const action = String(req.body?.action || "add").trim().toLowerCase();
      const amount = Math.floor(Number(req.body?.amount || 0));
      if (!Number.isFinite(amount) || amount < 0 || (action !== "set" && amount <= 0)) throw new Error("Informe uma quantidade valida de moedas.");
      const reason = String(req.body?.reason || "SaaS server setup").trim().slice(0, 160);
      const createdBy = req.portalSession?.discordId || "platform-bootstrap";
      const changed = action === "remove"
        ? removeCoins({ state, link, amount, reason, createdBy })
        : action === "set"
          ? setCoins({ state, link, amount, reason, createdBy })
          : addCoins({ state, link, amount, reason, createdBy });
      await saveStateAsync(state, `phase16:server-economy:${serverId}`);
      return { gamertag: link.gamertag, wallet: changed.wallet, transaction: changed.transaction };
    });
    res.json({ serverId, ...result });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.post("/api/servers/:serverId/shop/deploy", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const result = await runInServerRuntimeContext(serverId, async () => {
      const state = await getStateAsync();
      const deployed = await deployPendingShopOrders(state);
      if (deployed?.deployed) await saveStateAsync(state, `phase16:manual-shop-deploy:${serverId}`);
      return deployed;
    });
    res.json({ serverId, result });
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
  }
});

router.post("/api/servers/:serverId/preflight", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const result = await runManagedServerActivationPreflight(String(req.params.serverId || ""));
    res.json({
      ...result,
      servers: authorizedServersForRequest(req),
      foundation: foundationForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.post("/api/servers/:serverId/runtime/activate", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const current = listManagedServers().find((candidate) => candidate.id === serverId && !candidate.primary);
    if (!current) {
      res.status(404).send("Servidor nao encontrado.");
      return;
    }
    if (current.runtimeEnabled) {
      res.status(409).send("Este runtime ja esta ativo.");
      return;
    }
    if (isServerRuntimeLocked(serverId)) {
      res.status(409).send("Este servidor ja possui um ciclo em andamento. Aguarde o ciclo terminar antes de alterar o runtime.");
      return;
    }

    // One live, metadata-only Nitrado check immediately before activation. It
    // prevents a Ready server with an expired/missing connection from entering
    // a 5-minute retry loop. No ADM file is downloaded here.
    const serviceId = String(current.integrations?.nitradoServiceId || "").trim();
    const baseDir = String(current.runtime?.nitradoBaseDir || "").trim();
    const liveValidation = await validateNitradoServiceSetup(serverId, serviceId, baseDir);
    if (liveValidation.serviceId !== serviceId || liveValidation.baseDir !== baseDir) {
      res.status(400).send("A validacao Nitrado ao vivo nao corresponde mais ao routing aprovado no preflight.");
      return;
    }

    const server = await setManagedServerRuntimeEnabled(serverId, true);
    resetManagedServerRuntimeCircuit(server.id);
    const cycleRequested = requestManagedServerRuntimeCycle(server.id, "activation", { forceCircuitProbe: true });
    res.json({
      server,
      servers: authorizedServersForRequest(req),
      cycleRequested,
      runtimeActivationBlocked: false,
      foundation: foundationForRequest(req),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.post("/api/servers/:serverId/runtime/deactivate", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const current = listManagedServers().find((server) => server.id === serverId && !server.primary);
    if (!current) {
      res.status(404).send("Servidor nao encontrado.");
      return;
    }
    const transition = await runWithServerMaintenanceLock(serverId, async () => {
      if (current.runtimeEnabled) {
        await runInServerMaintenanceContext(serverId, () => flushServerRuntimePendingStateAsync());
      }
      return setManagedServerRuntimeEnabled(serverId, false);
    });
    if (transition.skipped || !transition.value) {
      res.status(409).send("Existe um ciclo em andamento para este servidor. Aguarde ele terminar e tente desativar novamente.");
      return;
    }
    const server = transition.value;
    resetManagedServerRuntimeCircuit(serverId);
    res.json({
      server,
      servers: authorizedServersForRequest(req),
      runtimeActivationBlocked: false,
      foundation: foundationForRequest(req),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.get("/api/servers/:serverId/runtime/health", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "view")) return;
  const serverId = String(req.params.serverId || "");
  const diagnostics = runtimeCoordinatorForRequest(req);
  const server = diagnostics.servers.find((candidate: any) => candidate.serverId === serverId);
  if (!server) {
    res.status(404).send("Servidor nao encontrado.");
    return;
  }
  res.json({
    server,
    policy: diagnostics.healthPolicy,
    schedulerRunning: diagnostics.schedulerRunning,
    requestedImmediateRuns: diagnostics.requestedImmediateRuns,
  });
});

router.post("/api/servers/:serverId/runtime/pause", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const current = listManagedServers().find((server) => server.id === serverId && !server.primary);
    if (!current) {
      res.status(404).send("Servidor nao encontrado.");
      return;
    }
    if (!current.runtimeEnabled) {
      res.status(409).send("Este runtime esta desligado; use Ativar runtime em vez de pausar.");
      return;
    }
    if (current.runtime.operations?.paused === true) {
      res.status(409).send("Este runtime ja esta pausado.");
      return;
    }
    const transition = await runWithServerMaintenanceLock(serverId, async () => {
      await runInServerMaintenanceContext(serverId, () => flushServerRuntimePendingStateAsync());
      return setManagedServerRuntimePaused(serverId, true, req.body?.reason);
    });
    if (transition.skipped || !transition.value) {
      res.status(409).send("Existe um ciclo em andamento. Aguarde o ciclo terminar antes de pausar.");
      return;
    }
    const server = transition.value;
    res.json({
      server,
      servers: authorizedServersForRequest(req),
      foundation: foundationForRequest(req),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.post("/api/servers/:serverId/runtime/resume", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const current = listManagedServers().find((server) => server.id === serverId && !server.primary);
    if (!current) {
      res.status(404).send("Servidor nao encontrado.");
      return;
    }
    if (!current.runtimeEnabled) {
      res.status(409).send("Este runtime esta desligado; use Ativar runtime.");
      return;
    }
    if (current.runtime.operations?.paused !== true) {
      res.status(409).send("Este runtime nao esta pausado.");
      return;
    }
    if (isServerRuntimeLocked(serverId)) {
      res.status(409).send("Existe um ciclo em andamento. Aguarde antes de retomar.");
      return;
    }
    const server = await setManagedServerRuntimePaused(serverId, false);
    resetManagedServerRuntimeCircuit(serverId);
    const cycleRequested = requestManagedServerRuntimeCycle(serverId, "manual", { forceCircuitProbe: true });
    res.json({
      server,
      servers: authorizedServersForRequest(req),
      cycleRequested,
      foundation: foundationForRequest(req),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.post("/api/servers/:serverId/runtime/retry", async (req, res) => {
  if (!requireServerAdmin(req, res, req.params.serverId, "manage")) return;
  try {
    const serverId = String(req.params.serverId || "");
    const current = listManagedServers().find((server) => server.id === serverId && !server.primary);
    if (!current) {
      res.status(404).send("Servidor nao encontrado.");
      return;
    }
    if (!current.runtimeEnabled) {
      res.status(409).send("Este runtime esta desligado.");
      return;
    }
    if (current.runtime.operations?.paused === true) {
      res.status(409).send("Retome o runtime antes de executar um ciclo manual.");
      return;
    }
    if (isServerRuntimeLocked(serverId)) {
      res.status(409).send("Existe um ciclo em andamento para este servidor.");
      return;
    }
    const cycleRequested = requestManagedServerRuntimeCycle(serverId, "manual", { forceCircuitProbe: true });
    if (!cycleRequested) {
      res.status(409).send("Ja existe um ciclo manual/ativacao solicitado para este servidor.");
      return;
    }
    res.json({
      cycleRequested,
      servers: authorizedServersForRequest(req),
      foundation: foundationForRequest(req),
      runtimeCoordinator: runtimeCoordinatorForRequest(req),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(/nao encontrado/i.test(message) ? 404 : 400).send(message);
  }
});

router.get("/api/servers/current", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const server = getManagedServerById(getActiveServerId()) || getPrimaryServerDescriptor();
  res.json({ server, foundation: foundationForRequest(req) });
});

router.get("/api/overview", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const state = await getStateAsync();
    const overview = await buildOverviewPayload(state as AdminState);
    const serverDescriptor = getManagedServerById(getActiveServerId()) || getPrimaryServerDescriptor();
    res.json({
      ...overview,
      server: {
        ...overview.server,
        ...serverDescriptor,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/members", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const state = (await getStateAsync()) as AdminState;
    const cursor = Math.max(0, Math.floor(Number(req.query.cursor || 0)));
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(req.query.limit || DEFAULT_PAGE_SIZE))),
    );
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";
    const { rows: allRows, stats } = await buildMemberRows(state, {
      forceDiscordRefresh: forceRefresh,
    });
    const rows = filterMembers(allRows, { search, filter });
    const members = rows.slice(cursor, cursor + limit);

    res.json({
      members,
      total: rows.length,
      stats,
      nextCursor: cursor + members.length,
      hasMore: cursor + members.length < rows.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/members/:discordId", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const state = (await getStateAsync()) as AdminState;
    const discordId = String(req.params.discordId || "");
    const details = await buildMemberDetails(state, discordId);

    if (!details) {
      res.status(404).send("Member not found");
      return;
    }

    res.json(details);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/api/members/:discordId/coins", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const state = await getStateAsync();
    const discordId = String(req.params.discordId || "");
    const link = state.playerLinks?.[discordId];

    if (!link) {
      res.status(404).send("Member not found");
      return;
    }

    const action = String(req.body?.action || "");
    const amount = Math.floor(Number(req.body?.amount || 0));
    const reason = req.body?.reason
      ? String(req.body.reason).trim()
      : "Admin panel";
    const createdBy = "admin-panel";

    if (amount < 0 || (action !== "set" && amount <= 0)) {
      res.status(400).send("Invalid amount");
      return;
    }

    let result;
    if (action === "add") {
      result = addCoins({ state, link, amount, reason, createdBy });
    } else if (action === "remove") {
      result = removeCoins({ state, link, amount, reason, createdBy });
    } else if (action === "set") {
      result = setCoins({ state, link, amount, reason, createdBy });
    } else {
      res.status(400).send("Invalid action");
      return;
    }

    await saveStateAsync(state);
    const wallet = getOrCreateWalletForLink(state, link).wallet;
    res.json({ ok: true, wallet, transaction: result.transaction });
  } catch (err) {
    res.status(500).send(String(err));
  }
});

router.get("/api/dayz-items", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const limit = Math.min(
      25,
      Math.max(1, Math.floor(Number(req.query.limit || 12))),
    );
    const includeDisabled = req.query.includeDisabled === "true";
    const items = (
      await searchDayzItemsFromDatabase({
        query,
        limit,
        enabledOnly: !includeDisabled,
      })
    ).map((item) => ({
      className: item.className,
      popularName: item.popularName,
      imageUrl: item.imageUrl || "",
      spawnEventName: item.spawnEventName || "",
      enabled: item.enabled !== false,
    }));

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/items", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const cursor = Math.max(0, Math.floor(Number(req.query.cursor || 0)));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(req.query.limit || 30))),
    );
    const filter =
      req.query.filter === "enabled" ||
      req.query.filter === "disabled" ||
      req.query.filter === "missing_image"
        ? req.query.filter
        : "all";

    res.json(await getDayzItemsPage({ query, cursor, limit, filter }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch("/api/items/:className", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const input = (
      req.body && typeof req.body === "object" ? req.body : {}
    ) as Record<string, unknown>;
    const item = await updateDayzItemInDatabase(req.params.className, {
      popularName:
        input.popularName === undefined
          ? undefined
          : String(input.popularName || "").trim(),
      imageUrl:
        input.imageUrl === undefined
          ? undefined
          : String(input.imageUrl || "").trim(),
      spawnEventName:
        input.spawnEventName === undefined
          ? undefined
          : String(input.spawnEventName || "").trim(),
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    });

    if (!item) {
      res.status(404).send("DayZ item not found");
      return;
    }

    res.json({ ok: true, item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch("/api/items/:className/toggle", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      enabled?: boolean;
    };
    const item = await toggleDayzItemInDatabase(
      req.params.className,
      body.enabled,
    );

    if (!item) {
      res.status(404).send("DayZ item not found");
      return;
    }

    res.json({ ok: true, item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/api/shop-queue", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureShopCatalogLoaded();
    const state = (await getStateAsync()) as AdminState;
    res.json(buildShopQueuePayload(state));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/shop-transactions", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureShopCatalogLoaded();
    const state = (await getStateAsync()) as AdminState;
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const limit = Math.min(
      500,
      Math.max(1, Math.floor(Number(req.query.limit || 250))),
    );
    res.json(buildShopTransactionsPayload(state, { search, limit }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/catalog", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureShopCatalogLoaded();
    res.json(buildCatalogPayload());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch("/api/catalog/categories/reorder", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      categoryIds?: unknown;
    };
    const categoryIds = Array.isArray(body.categoryIds)
      ? body.categoryIds.map((id) => String(id))
      : [];
    await reorderShopCategories(categoryIds);
    await ensureShopCatalogLoaded();
    res.json({ ok: true, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch("/api/catalog/categories/:id/items/reorder", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      itemIds?: unknown;
    };
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.map((id) => String(id))
      : [];
    await reorderShopItems(req.params.id, itemIds);
    await ensureShopCatalogLoaded();
    res.json({ ok: true, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/catalog/categories", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const category = readCatalogCategoryPayload(req.body);
    await upsertShopCatalogCategoryItem(category);
    await ensureShopCatalogLoaded();
    res.json({ ok: true, category, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete("/api/catalog/categories/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const deleted = await deleteShopCatalogCategory(req.params.id);
    if (!deleted) {
      res.status(404).send("Catalog category not found");
      return;
    }
    res.json({ ok: true, deleted: true, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/catalog/items", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const item = await readCatalogItemPayload(req.body);
    const saved = await upsertShopCatalogItem(item);
    res.json({ ok: true, item: saved, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch("/api/catalog/items/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const item = await readCatalogItemPayload(req.body, req.params.id);
    const saved = await upsertShopCatalogItem(item);
    res.json({ ok: true, item: saved, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch("/api/catalog/items/:id/toggle", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      enabled?: boolean;
    };
    const item = await toggleShopCatalogItem(req.params.id, body.enabled);
    if (!item) {
      res.status(404).send("Catalog item not found");
      return;
    }
    res.json({ ok: true, item, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete("/api/catalog/items/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const deleted = await deleteShopCatalogItem(req.params.id);
    if (!deleted) {
      res.status(404).send("Catalog item not found");
      return;
    }
    res.json({ ok: true, deleted: true, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});


router.get("/api/spawn-zones", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  if (!state.mapRotation) await saveMapRotationState(state, rotation);
  res.json(rotation);
});


router.post("/api/spawn-zones/rotation/next", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const { zone, error } = findReadySpawnZone(rotation, req.body?.zoneId);
  if (!zone) {
    res.status(400).send(error || "Zona inválida");
    return;
  }
  rotation.nextZoneId = zone.id;
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
});

router.post("/api/spawn-zones/rotation/apply", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const targetZoneId = req.body?.zoneId || rotation.nextZoneId;
  const { zone, error } = findReadySpawnZone(rotation, targetZoneId);
  if (!zone) {
    res.status(400).send(error || "Zona inválida");
    return;
  }
  const now = new Date().toISOString();
  rotation.currentZoneId = zone.id;
  if (rotation.nextZoneId === zone.id) rotation.nextZoneId = undefined;
  rotation.voteHistory = [
    ...(Array.isArray(rotation.voteHistory) ? rotation.voteHistory : []),
    {
      id: crypto.randomUUID(),
      winnerZoneId: zone.id,
      winnerName: zone.name,
      totalVotes: 0,
      closedAt: now,
      appliedAt: now,
      source: "manual",
    },
  ].slice(-24);
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
});


router.patch("/api/spawn-zones/settings", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  mergeSpawnZonesRequestSnapshot(rotation, req.body);
  const incomingSettings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : req.body;
  rotation.settings = normalizeMapRotationSettings({
    ...(rotation.settings || {}),
    ...(incomingSettings && typeof incomingSettings === "object" ? incomingSettings : {}),
  });
  const saved = await saveMapRotationState(state, rotation);
  const runTimer = setTimeout(() => {
    runSpawnZoneAutomationNow().catch((err) => console.error("spawn zones automation after settings update failed", err));
  }, 0);
  if (typeof (runTimer as any).unref === "function") (runTimer as any).unref();
  res.json(saved);
  return;
});

router.post("/api/spawn-zones/rotation/apply-server", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const targetZoneId = req.body?.zoneId || rotation.nextZoneId;
  const { zone, error } = findReadySpawnZone(rotation, targetZoneId);
  if (!zone) {
    res.status(400).send(error || "Zona inválida");
    return;
  }
  try {
    const filePath = await applySpawnZoneToServer(rotation, zone, "server", 0);
    try {
      await updateMapVoteCategoryName(rotation, zone);
    } catch (err) {
      console.warn("map vote category rename failed", err);
      rotation.automation = { ...(rotation.automation || {}), lastError: `Categoria Discord: ${err instanceof Error ? err.message : String(err)}` };
    }
    const saved = await saveMapRotationState(state, rotation);
    res.json({ ok: true, path: filePath, rotation: saved });
    return;
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
    return;
  }
});


router.post("/api/spawn-zones/welcome/create", async (req, res) => {
  try {
    const state = (await getStateAsync()) as AdminState;
    const rotation = getMapRotationState(state);
    mergeSpawnZonesRequestSnapshot(rotation, req.body);
    const incomingSettings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : req.body;
    if (incomingSettings && typeof incomingSettings === "object") {
      rotation.settings = normalizeMapRotationSettings({ ...(rotation.settings || {}), ...incomingSettings });
    }
    await createOrUpdateMapVoteWelcomeMessage(rotation);
    const shouldCreatePoll = req.body?.createPoll !== false && !rotation.activePoll;
    if (shouldCreatePoll) {
      const readyZones = rotation.zones.filter((zone) => zone.enabled !== false && Array.isArray(zone.points) && zone.points.length > 0);
      if (readyZones.length >= 2) {
        try {
          rotation.activePoll = await createDiscordSpawnZonePoll(rotation);
        } catch (err) {
          rotation.automation = {
            ...(rotation.automation || {}),
            lastError: `Boas-vindas criada, mas a enquete não foi criada: ${err instanceof Error ? err.message : String(err)}`,
            lastCheckedAt: new Date().toISOString(),
          };
        }
      }
    }
    const saved = await saveMapRotationState(state, rotation);
    res.json(saved);
  } catch (err) {
    res.status(400).send(String((err as Error)?.message || err));
  }
  return;
});

router.post("/api/spawn-zones/poll/create", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  mergeSpawnZonesRequestSnapshot(rotation, req.body);
  const incomingSettings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : req.body;
  if (incomingSettings && typeof incomingSettings === "object") {
    rotation.settings = normalizeMapRotationSettings({ ...(rotation.settings || {}), ...incomingSettings });
  }
  try {
    const automation = rotation.automation || {};
    rotation.automation = automation;
    await deletePreviousClosedSpawnZonePoll(rotation, automation);
    rotation.activePoll = await createDiscordSpawnZonePoll(rotation);
    const saved = await saveMapRotationState(state, rotation);
    res.json(saved);
    return;
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
    return;
  }
});

router.post("/api/spawn-zones/poll/refresh", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  if (!rotation.activePoll) {
    res.status(404).send("Nenhuma enquete ativa para atualizar.");
    return;
  }
  try {
    rotation.activePoll = await fetchDiscordSpawnZonePoll(rotation.activePoll);
    const saved = await saveMapRotationState(state, rotation);
    res.json(saved);
    return;
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
    return;
  }
});

router.post("/api/spawn-zones/poll/finalize", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  try {
    const settings = normalizeMapRotationSettings(rotation.settings);
    await finalizeSpawnZonePoll(rotation, { apply: Boolean(req.body?.apply ?? settings.autoApplyWinner), source: req.body?.source || "poll-manual", state });
    const saved = await saveMapRotationState(state, rotation);
    res.json(saved);
    return;
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
    return;
  }
});

router.post("/api/spawn-zones/automation/run", async (req, res) => {
  try {
    const saved = await runSpawnZoneAutomationNow();
    res.json(saved);
    return;
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
    return;
  }
});

router.post("/api/spawn-zones/import", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  try {
    const now = new Date().toISOString();
    const points = extractFreshSpawnPointsFromCfg(req.body?.xml);
    const zone = normalizeSpawnZone({
      id: crypto.randomUUID(),
      name: normalizeSpawnZoneName(req.body?.name) || `Importado ${rotation.zones.length + 1}`,
      color: SPAWN_ZONE_COLORS[rotation.zones.length % SPAWN_ZONE_COLORS.length],
      enabled: true,
      points,
      createdAt: now,
      updatedAt: now,
    }, rotation.zones.length);
    rotation.zones.push(zone);
    if (!rotation.currentZoneId) rotation.currentZoneId = zone.id;
    const saved = await saveMapRotationState(state, rotation);
    res.json(saved);
    return;
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : String(err));
    return;
  }
});

router.post("/api/spawn-zones/zones", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const now = new Date().toISOString();
  const zone = normalizeSpawnZone({
    id: crypto.randomUUID(),
    name: normalizeSpawnZoneName(req.body?.name) || "Nova zona",
    color: normalizeSpawnZoneColor(req.body?.color, SPAWN_ZONE_COLORS[rotation.zones.length % SPAWN_ZONE_COLORS.length]),
    enabled: req.body?.enabled !== false,
    points: [],
    createdAt: now,
    updatedAt: now,
  }, rotation.zones.length);
  rotation.zones.push(zone);
  if (!rotation.currentZoneId) rotation.currentZoneId = zone.id;
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
});

router.patch("/api/spawn-zones/zones/:zoneId", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const zone = rotation.zones.find((item) => item.id === req.params.zoneId);
  if (!zone) {
    res.status(404).send("Zona não encontrada");
    return;
  }
  if (req.body?.name !== undefined) zone.name = normalizeSpawnZoneName(req.body.name) || zone.name;
  if (req.body?.color !== undefined) zone.color = normalizeSpawnZoneColor(req.body.color, zone.color);
  if (req.body?.enabled !== undefined) zone.enabled = Boolean(req.body.enabled);
  if (Array.isArray(req.body?.points)) zone.points = req.body.points.map((point: any) => makeSpawnZonePoint(point?.x, point?.z));
  zone.updatedAt = new Date().toISOString();
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
  return;
});

router.delete("/api/spawn-zones/zones/:zoneId", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const zone = rotation.zones.find((item) => item.id === req.params.zoneId);
  if (!zone) {
    res.status(404).send("Zona não encontrada");
    return;
  }
  rotation.zones = rotation.zones.filter((item) => item.id !== req.params.zoneId);
  if (rotation.currentZoneId === req.params.zoneId) rotation.currentZoneId = rotation.zones[0]?.id;
  if (rotation.nextZoneId === req.params.zoneId) rotation.nextZoneId = undefined;
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
  return;
});

router.post("/api/spawn-zones/zones/:zoneId/points", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const zone = rotation.zones.find((item) => item.id === req.params.zoneId);
  if (!zone) {
    res.status(404).send("Zona não encontrada");
    return;
  }
  zone.points.push(makeSpawnZonePoint(req.body?.x, req.body?.z));
  zone.updatedAt = new Date().toISOString();
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
  return;
});

router.delete("/api/spawn-zones/zones/:zoneId/points/:pointId", async (req, res) => {
  const state = (await getStateAsync()) as AdminState;
  const rotation = getMapRotationState(state);
  const zone = rotation.zones.find((item) => item.id === req.params.zoneId);
  if (!zone) {
    res.status(404).send("Zona não encontrada");
    return;
  }
  zone.points = zone.points.filter((point) => point.id !== req.params.pointId);
  zone.updatedAt = new Date().toISOString();
  const saved = await saveMapRotationState(state, rotation);
  res.json(saved);
  return;
});

router.get("/api/player-map/snapshot", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const state = await getStateAsync();
  const onlineEntries = Object.entries(state.onlinePlayers || {});
  const onlineNames = onlineEntries.map(([name]) => name);
  const positions = await getLatestPlayerPositionSnapshot(onlineNames);
  const byPlayer = new Map(positions.map((position) => [position.playerNormalized, position]));
  const now = Date.now();

  const players = onlineEntries.map(([name, online]) => {
    const normalized = String(name || "").trim().toLowerCase();
    const position = byPlayer.get(normalized);
    const connectedAtMs = online?.connectedAt ? Date.parse(online.connectedAt) : NaN;
    const positionAtMs = position?.observedAt ? Date.parse(position.observedAt) : NaN;
    const belongsToCurrentSession = !position
      ? false
      : !Number.isFinite(connectedAtMs) || !Number.isFinite(positionAtMs) || positionAtMs >= connectedAtMs - 5_000;

    return {
      name,
      connectedAt: online?.connectedAt || null,
      lastSeenAt: online?.lastSeenAt || null,
      x: belongsToCurrentSession ? position?.x ?? null : null,
      z: belongsToCurrentSession ? position?.z ?? null : null,
      observedAt: belongsToCurrentSession ? position?.observedAt ?? null : null,
      ageSeconds: belongsToCurrentSession && Number.isFinite(positionAtMs)
        ? Math.max(0, Math.round((now - positionAtMs) / 1000))
        : null,
      source: belongsToCurrentSession ? position?.source ?? null : null,
    };
  }).sort((a, b) => {
    const aPositioned = a.x != null && a.z != null ? 1 : 0;
    const bPositioned = b.x != null && b.z != null ? 1 : 0;
    if (aPositioned !== bPositioned) return bPositioned - aPositioned;
    return String(a.name).localeCompare(String(b.name), "pt-BR");
  });

  res.setHeader("Cache-Control", "no-store");
  res.json({
    generatedAt: new Date(now).toISOString(),
    onlineCount: players.length,
    positionedCount: players.filter((player) => player.x != null && player.z != null).length,
    players,
  });
});

router.get("/api/map-events/chernarus-map", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const mapPath = resolveChernarusMapPath();
  res.setHeader("Cache-Control", "private, max-age=3600");

  res.sendFile(mapPath, (err) => {
    if (err && !res.headersSent) res.status(404).send("Chernarus map image not found");
  });
});

router.get("/api/spawn-zones/chernarus-map-tile/:z/:x/:y.webp", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const z = Number.parseInt(String(req.params.z || ""), 10);
  const x = Number.parseInt(String(req.params.x || ""), 10);
  const y = Number.parseInt(String(req.params.y || ""), 10);
  if (!Number.isInteger(z) || z < 0 || z > SPAWN_ZONE_MAP_TILE_MAX_ZOOM) {
    res.status(400).send("Invalid tile zoom");
    return;
  }
  const tileCount = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
    res.status(400).send("Invalid tile coordinates");
    return;
  }

  const cachePath = path.resolve(process.cwd(), "data", "map-tiles", "chernarus", String(z), String(x), `${y}.webp`);
  const sendCachedTile = () => {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(cachePath, (err) => {
      if (err && !res.headersSent) res.status(404).send("Chernarus tile not found");
    });
  };

  try {
    await fs.access(cachePath);
    sendCachedTile();
    return;
  } catch (_) {
    // Generate on demand below.
  }

  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const outputSize = SPAWN_ZONE_MAP_TILE_SIZE * tileCount;
    await sharp(resolveChernarusMapPath())
      .resize(outputSize, outputSize, { fit: "fill", kernel: "lanczos3" })
      .extract({ left: x * SPAWN_ZONE_MAP_TILE_SIZE, top: y * SPAWN_ZONE_MAP_TILE_SIZE, width: SPAWN_ZONE_MAP_TILE_SIZE, height: SPAWN_ZONE_MAP_TILE_SIZE })
      .webp({ quality: 84, effort: 4 })
      .toFile(cachePath);
    sendCachedTile();
  } catch (err) {
    console.error("Failed to generate Chernarus map tile", err);
    if (!res.headersSent) res.status(500).send("Failed to generate Chernarus map tile");
  }
});

router.get("/api/map-events/presets", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getMapEventPresetPayload());
});

router.get("/api/settings/locked-containers/check", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await checkLockedContainerSetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/settings/locked-containers/install", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await ensureLockedContainerSetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/settings/locked-containers/uninstall", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await uninstallLockedContainerSetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});


router.get("/api/settings/airdrops/military/check", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await checkAirdropMilitarySetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/settings/airdrops/military/install", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await ensureAirdropMilitarySetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/settings/airdrops/military/uninstall", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await uninstallAirdropMilitarySetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/map-events/setup-locked-container", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await ensureLockedContainerSetupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/map-events/inject", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await injectMapEventNow((req.body || {}) as any);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});


router.get("/api/map-events/scheduled", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    res.json(listScheduledMapEvents());
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/map-events/scheduled", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = createScheduledMapEvent((req.body || {}) as any);
    res.json({ ok: true, event: result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/map-events/scheduled/:id/run", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await runScheduledMapEventNow(String(req.params.id || ""));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch("/api/map-events/scheduled/:id/status", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const status = String(req.body?.status || "active") as "paused" | "active" | "cancelled";
    const event = updateScheduledMapEventStatus(String(req.params.id || ""), status);
    res.json({ ok: true, event });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete("/api/map-events/scheduled/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    res.json(deleteScheduledMapEvent(String(req.params.id || "")));
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/map-events/cleanup", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await cleanupMapEventsNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
