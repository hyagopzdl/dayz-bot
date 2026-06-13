import path from "path";
import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { Routes } from "discord.js";
import { getShopRuntimeStatus } from "../lib/shop";
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
  getStateAsync,
  saveStateAsync,
  type AppState,
  type PlayerLink,
  type Wallet,
} from "../lib/state";
import { getDiscordClient } from "../lib/discordBot";

const router = Router();
startMapEventScheduler();
const TOKEN_COOKIE = "admin_panel_token";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

type AdminState = AppState & Record<string, any>;


type SpawnZonePointPayload = { id: string; x: number; z: number; createdAt?: string; updatedAt?: string };
type SpawnZonePayload = { id: string; name: string; color: string; enabled: boolean; points: SpawnZonePointPayload[]; createdAt: string; updatedAt: string };
type MapRotationPayload = { zones: SpawnZonePayload[]; currentZoneId?: string; nextZoneId?: string; voteHistory: any[]; updatedAt: string };

const SPAWN_ZONE_COLORS = ["#e11d48", "#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"];
const SPAWN_ZONE_WORLD_SIZE = 15360;

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

function getMapRotationState(state: AdminState): MapRotationPayload {
  const stored = (state.mapRotation || {}) as Partial<MapRotationPayload>;
  let zones = Array.isArray(stored.zones) ? stored.zones.map((zone: any, index: number) => normalizeSpawnZone(zone, index)) : [];
  if (zones.length === 0) zones = [defaultSpawnZone()];
  return {
    zones,
    currentZoneId: stored.currentZoneId || zones[0]?.id,
    nextZoneId: stored.nextZoneId,
    voteHistory: Array.isArray(stored.voteHistory) ? stored.voteHistory : [],
    updatedAt: stored.updatedAt || new Date().toISOString(),
  };
}

async function saveMapRotationState(state: AdminState, rotation: MapRotationPayload) {
  state.mapRotation = {
    ...rotation,
    updatedAt: new Date().toISOString(),
  };
  await saveStateAsync(state);
  return state.mapRotation;
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

function requireAdmin(req: Request, res: Response) {
  const configuredToken = getConfiguredToken();
  if (!configuredToken) return true;

  const receivedToken = getTokenFromRequest(req);
  if (receivedToken !== configuredToken) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
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
let discordMembersCache: DiscordMembersCache = {
  expiresAt: 0,
  members: [],
  error: null,
};

async function fetchDiscordMemberSnapshots(
  forceRefresh = false,
): Promise<DiscordMembersCache> {
  const now = Date.now();
  if (!forceRefresh && discordMembersCache.expiresAt > now)
    return discordMembersCache;

  try {
    const client = getDiscordClient();
    if (!client.isReady()) throw new Error("Discord client is not ready yet.");

    const configuredGuildId =
      process.env.DISCORD_SERVER_ID || process.env.DISCORD_GUILD_ID || "";
    const guild = configuredGuildId
      ? await client.guilds.fetch(configuredGuildId)
      : client.guilds.cache.first();

    if (!guild)
      throw new Error(
        "Discord guild not found. Set DISCORD_GUILD_ID or DISCORD_SERVER_ID.",
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

    discordMembersCache = {
      expiresAt: now + DISCORD_MEMBERS_CACHE_TTL_MS,
      members,
      error: fetchError,
    };
  } catch (err) {
    discordMembersCache = {
      expiresAt: now + Math.min(DISCORD_MEMBERS_CACHE_TTL_MS, 15_000),
      members: discordMembersCache.members,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return discordMembersCache;
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
    .spawn-zone-map-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .spawn-zone-map-title { display: grid; gap: 3px; }
    .spawn-zone-map-title b { font-size: 14px; }
    .spawn-zone-map-title span { color: var(--text-3); font-size: 12px; }
    .spawn-zone-map-viewport { width: 100%; aspect-ratio: 1 / 1; overflow: hidden; background: #10131b; cursor: crosshair; position: relative; overscroll-behavior: contain; }
    .spawn-zone-map-inner { position: relative; width: 100%; aspect-ratio: 1 / 1; }
    .spawn-zone-map-inner img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; display: block; user-select: none; -webkit-user-drag: none; }
    .spawn-zone-marker { position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 999px; border: 3px solid #fff; box-shadow: 0 0 0 5px rgba(255,255,255,.12), 0 8px 30px rgba(0,0,0,.45); transform: translate(-50%, -50%); cursor: pointer; z-index: 2; }
    .spawn-zone-marker.highlight { width: 28px; height: 28px; box-shadow: 0 0 0 8px rgba(255,255,255,.16), 0 10px 34px rgba(0,0,0,.5); z-index: 3; }
    .spawn-zone-marker::after { content: ''; position: absolute; inset: 5px; border-radius: 999px; background: rgba(255,255,255,.92); }
    .spawn-zone-map-footer { display: flex; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); color: var(--text-3); font-size: 12px; }
    .spawn-zone-sidebar { display: grid; gap: 10px; }
    .spawn-zone-create { width: 100%; height: 46px; border-radius: 14px; font-size: 14px; }
    .spawn-zone-list { display: grid; gap: 8px; max-height: 70vh; overflow: auto; padding-right: 3px; }
    .spawn-zone-card { border: 1px solid var(--border); border-radius: 14px; background: rgba(255,255,255,.025); overflow: hidden; }
    .spawn-zone-card.selected { border-color: rgba(88,101,242,.78); background: rgba(88,101,242,.08); }
    .spawn-zone-card-header { display: grid; grid-template-columns: 20px 1fr auto auto; align-items: center; gap: 8px; padding: 10px 12px; }
    .spawn-zone-color { width: 14px; height: 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,.42); }
    .spawn-zone-name-input { width: 100%; border: 0; background: transparent; color: var(--text); outline: none; font-weight: 700; font-size: 14px; min-width: 0; }
    .spawn-zone-count { color: var(--text-3); font-weight: 700; font-variant-numeric: tabular-nums; }
    .spawn-zone-actions { display: flex; align-items: center; gap: 6px; }
    .spawn-zone-mini-btn { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: rgba(255,255,255,.04); color: var(--text-2); cursor: pointer; border: 1px solid var(--border); }
    .spawn-zone-mini-btn:hover { background: rgba(255,255,255,.08); color: var(--text); }
    .spawn-zone-points { display: none; padding: 0 12px 12px 42px; gap: 5px; }
    .spawn-zone-card.selected .spawn-zone-points { display: grid; }
    .spawn-zone-point-row { display: grid; grid-template-columns: 1fr 28px; align-items: center; gap: 6px; color: var(--text-3); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .spawn-zone-point-row button:first-child { text-align: left; color: inherit; background: transparent; cursor: pointer; padding: 5px 0; border-radius: 8px; }
    .spawn-zone-point-row button:first-child:hover { color: var(--text); }
    .spawn-zone-color-input { width: 28px; height: 28px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .spawn-zone-empty { border: 1px dashed var(--border); border-radius: 14px; padding: 16px; color: var(--text-3); background: rgba(255,255,255,.025); font-size: 13px; }
    .spawn-zone-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .spawn-zone-setting-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 1100px) { .spawn-zones-editor { grid-template-columns: 1fr; } .spawn-zone-list { max-height: none; } }

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
        <button data-view="settings"><svg class="nav-icon"><use href="#icon-database"></use></svg><span>Settings</span></button>
      </nav>
      <div class="sidebar-footer"><div class="avatar">A</div><div><b>Admin</b><div class="member-meta">Painel seguro</div></div></div>
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
              <div class="catalog-breadcrumb">Iteração 1: editor visual de zonas e pontos com auto-save. A automação Discord entra nas próximas iterações.</div>
            </div>

            <div id="spawnZonesTabRotation" class="spawn-zone-tab active">
              <div class="spawn-zone-summary-grid">
                <div class="card"><div class="metric-label">Zona atual</div><div id="spawnZonesCurrentZone" class="metric-value">—</div><div class="metric-hint">Aplicação no servidor entra na próxima iteração</div></div>
                <div class="card"><div class="metric-label">Próxima zona</div><div id="spawnZonesNextZone" class="metric-value">—</div><div class="metric-hint">Será definida pela votação semanal</div></div>
                <div class="card"><div class="metric-label">Zonas habilitadas</div><div id="spawnZonesEnabledCount" class="metric-value">0</div><div class="metric-hint">Entrarão na votação quando habilitada</div></div>
              </div>
              <div class="card" style="margin-top:14px">
                <div class="section-title"><div><h2>Histórico de votações</h2><div class="member-meta">Os resultados das enquetes nativas do Discord aparecerão aqui na iteração 3.</div></div><span class="chip">em breve</span></div>
                <div id="spawnZonesVoteHistory" class="settings-empty-note">Nenhuma votação registrada ainda.</div>
              </div>
            </div>

            <div id="spawnZonesTabPoints" class="spawn-zone-tab">
              <div class="spawn-zones-editor">
                <div class="card spawn-zone-map-card">
                  <div class="spawn-zone-map-toolbar">
                    <div class="spawn-zone-map-title"><b id="spawnZonesMapTitle">Selecione uma zona</b><span id="spawnZonesMapHint">Clique no mapa para adicionar pontos. Clique direito em um ponto para remover.</span></div>
                    <span id="spawnZonesAutosaveStatus" class="chip">auto-save</span>
                  </div>
                  <div id="spawnZonesMapViewport" class="spawn-zone-map-viewport">
                    <div id="spawnZonesMapInner" class="spawn-zone-map-inner">
                      <img src="/admin-panel/api/map-events/chernarus-map" alt="Mapa de Chernarus" draggable="false" />
                      <div id="spawnZonesMarkers"></div>
                    </div>
                  </div>
                  <div class="spawn-zone-map-footer"><span id="spawnZonesCursor">X: — | Z: —</span><span>Mapa Chernarus · 15360 x 15360</span></div>
                </div>
                <aside class="spawn-zone-sidebar">
                  <button id="spawnZoneCreate" class="primary-btn spawn-zone-create"><svg class="icon"><use href="#icon-plus"></use></svg>Nova zona</button>
                  <div id="spawnZoneList" class="spawn-zone-list"></div>
                </aside>
              </div>
            </div>

            <div id="spawnZonesTabSettings" class="spawn-zone-tab">
              <div class="spawn-zone-setting-grid">
                <div class="card">
                  <div class="section-title"><div><h2>Discord Poll</h2><div class="member-meta">Configurações da enquete nativa do Discord entram na iteração 3.</div></div><span class="chip">em breve</span></div>
                  <div class="settings-empty-note">Aqui ficarão canal da enquete, mensagem, abertura/fechamento, política de empate e mínimo de votos.</div>
                </div>
                <div class="card">
                  <div class="section-title"><div><h2>Aplicação no servidor</h2><div class="member-meta">A troca do arquivo de spawn entra na iteração 2.</div></div><span class="chip">em breve</span></div>
                  <div class="settings-empty-note">Aqui ficarão path do arquivo ativo, snapshot automático e aplicação no próximo restart.</div>
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
                <button class="settings-tab active" type="button" data-settings-tab="server">Server Settings</button>
                <button class="settings-tab" type="button" data-settings-tab="events">Events Settings</button>
                <button class="settings-tab" type="button" data-settings-tab="integrations">Integrações</button>
              </div>
            </div>

            <div id="settingsPanelServer" class="settings-panel active">
              <div class="card">
                <div class="section-title">
                  <div><h2>Server Settings</h2><div class="member-meta">Configurações gerais do servidor aparecerão aqui.</div></div>
                </div>
                <div class="settings-empty-note">Nenhuma configuração geral disponível ainda. Use Events Settings para instalar recursos de eventos.</div>
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
    const state = { view: "general", cursor: 0, hasMore: true, loadingMembers: false, memberForceRefresh: false, search: "", filter: "", modal: null, catalogModal: null, selectedDiscordId: null, catalog: null, catalogSearch: "", catalogCategory: "", catalogMode: "categories", catalogDrag: null, catalogJustDragged: false, shopQueue: null, shopTransactions: null, shopHistorySearch: "", shopQueueModeBefore: "categories", itemsCursor: 0, itemsHasMore: true, itemsLoading: false, itemsSearch: "", itemsFilter: "all", dayzItems: [], itemsStats: null, itemModal: null, mapEventPresets: [], selectedMapEventPresetId: "locked_container_red_military", mapEventRewardStorageItem: null, mapEventLootItems: [], scheduledMapEvents: [], mapEventBuilderOpen: false, settingsTab: "server", lockedContainerSetup: null, spawnZonesTab: "rotation", spawnZones: null, selectedSpawnZoneId: null, highlightedSpawnPointId: null };
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
      spawnZonesCurrentZone: document.getElementById("spawnZonesCurrentZone"), spawnZonesNextZone: document.getElementById("spawnZonesNextZone"), spawnZonesEnabledCount: document.getElementById("spawnZonesEnabledCount"), spawnZonesVoteHistory: document.getElementById("spawnZonesVoteHistory"),
      spawnZonesMapTitle: document.getElementById("spawnZonesMapTitle"), spawnZonesMapHint: document.getElementById("spawnZonesMapHint"), spawnZonesAutosaveStatus: document.getElementById("spawnZonesAutosaveStatus"), spawnZonesMapViewport: document.getElementById("spawnZonesMapViewport"), spawnZonesMapInner: document.getElementById("spawnZonesMapInner"), spawnZonesMarkers: document.getElementById("spawnZonesMarkers"), spawnZonesCursor: document.getElementById("spawnZonesCursor"), spawnZoneCreate: document.getElementById("spawnZoneCreate"), spawnZoneList: document.getElementById("spawnZoneList")
    };
    function apiUrl(path) { const separator = path.includes("?") ? "&" : "?"; return adminToken ? path + separator + "token=" + encodeURIComponent(adminToken) : path; }
    async function apiFetch(path, options) { const headers = Object.assign({ "Content-Type": "application/json" }, (options && options.headers) || {}); if (adminToken) headers["x-admin-token"] = adminToken; return fetch(apiUrl(path), Object.assign({}, options || {}, { headers, credentials: "same-origin" })); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[char] || char)); }
    function icon(name, className) { return '<svg class="icon ' + escapeHtml(className || '') + '"><use href="#icon-' + escapeHtml(name) + '"></use></svg>'; }
    function formatNumber(value) { return new Intl.NumberFormat("pt-BR").format(Number(value || 0)); }
    function formatCoins(value) { return new Intl.NumberFormat("pt-BR").format(Number(value || 0)); }
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
      const history = state.spawnZones?.voteHistory || [];
      if (els.spawnZonesVoteHistory) {
        els.spawnZonesVoteHistory.innerHTML = history.length ? history.map((item) => '<div class="map-event-result"><b>' + escapeHtml(item.winnerName || item.winnerZoneId || 'Zona') + '</b><br><span class="member-meta">' + escapeHtml(item.closedAt || '') + '</span></div>').join('') : 'Nenhuma votação registrada ainda.';
      }
    }
    function renderSpawnZones() {
      renderSpawnZonesSummary();
      const zones = spawnZoneList();
      if (!state.selectedSpawnZoneId && zones[0]) state.selectedSpawnZoneId = zones[0].id;
      const selected = selectedSpawnZone();
      if (els.spawnZonesMapTitle) els.spawnZonesMapTitle.textContent = selected ? selected.name : 'Selecione uma zona';
      if (els.spawnZonesMapHint) els.spawnZonesMapHint.textContent = selected ? 'Clique no mapa para adicionar pontos em ' + selected.name + '. Clique direito em um ponto para remover.' : 'Crie uma zona para começar.';
      if (els.spawnZoneList) {
        els.spawnZoneList.innerHTML = zones.length ? zones.map((zone) => {
          const selectedClass = zone.id === state.selectedSpawnZoneId ? ' selected' : '';
          const checked = zone.enabled !== false ? 'checked' : '';
          const points = (zone.points || []).map((point) => '<div class="spawn-zone-point-row" data-spawn-point-id="' + escapeHtml(point.id) + '"><button type="button" data-spawn-point-focus="' + escapeHtml(point.id) + '">' + spawnZoneCoord(point.x) + ', ' + spawnZoneCoord(point.z) + '</button><button type="button" class="spawn-zone-mini-btn" data-spawn-point-delete="' + escapeHtml(point.id) + '">×</button></div>').join('');
          return '<article class="spawn-zone-card' + selectedClass + '" data-spawn-zone-id="' + escapeHtml(zone.id) + '">' +
            '<div class="spawn-zone-card-header">' +
              '<button type="button" class="spawn-zone-mini-btn" data-spawn-zone-select="' + escapeHtml(zone.id) + '">›</button>' +
              '<div style="display:flex;align-items:center;gap:8px;min-width:0"><input class="spawn-zone-color-input" type="color" value="' + escapeHtml(zone.color || '#e11d48') + '" data-spawn-zone-color="' + escapeHtml(zone.id) + '" /><input class="spawn-zone-name-input" value="' + escapeHtml(zone.name || 'Zona') + '" data-spawn-zone-name="' + escapeHtml(zone.id) + '" /></div>' +
              '<span class="spawn-zone-count">(' + String((zone.points || []).length) + ')</span>' +
              '<div class="spawn-zone-actions"><label class="switch" title="Habilitar na votação"><input type="checkbox" data-spawn-zone-enabled="' + escapeHtml(zone.id) + '" ' + checked + ' /><span class="switch-slider"></span></label><button type="button" class="spawn-zone-mini-btn" data-spawn-zone-delete="' + escapeHtml(zone.id) + '">×</button></div>' +
            '</div>' +
            '<div class="spawn-zone-points">' + (points || '<div class="member-meta">Clique no mapa para adicionar pontos.</div>') + '</div>' +
          '</article>';
        }).join('') : '<div class="spawn-zone-empty">Nenhuma zona criada ainda.</div>';
      }
      renderSpawnZoneMarkers();
    }
    function renderSpawnZoneMarkers() {
      if (!els.spawnZonesMarkers) return;
      const selected = selectedSpawnZone();
      const points = selected?.points || [];
      els.spawnZonesMarkers.innerHTML = points.map((point) => {
        const left = Math.max(0, Math.min(100, (Number(point.x || 0) / SPAWN_ZONE_WORLD_SIZE) * 100));
        const top = Math.max(0, Math.min(100, (1 - Number(point.z || 0) / SPAWN_ZONE_WORLD_SIZE) * 100));
        const highlight = point.id === state.highlightedSpawnPointId ? ' highlight' : '';
        return '<button type="button" class="spawn-zone-marker' + highlight + '" data-spawn-marker="' + escapeHtml(point.id) + '" title="' + spawnZoneCoord(point.x) + ', ' + spawnZoneCoord(point.z) + '" style="left:' + left + '%;top:' + top + '%;background:' + escapeHtml(selected?.color || '#e11d48') + '"></button>';
      }).join('');
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
      const rect = els.spawnZonesMapInner.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const relativeX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const relativeY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      const x = Number((relativeX * SPAWN_ZONE_WORLD_SIZE).toFixed(2));
      const z = Number(((1 - relativeY) * SPAWN_ZONE_WORLD_SIZE).toFixed(2));
      setSpawnZonesAutosaveStatus('salvando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones/' + encodeURIComponent(zone.id) + '/points', { method: 'POST', body: JSON.stringify({ x, z }) });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json();
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    async function deleteSpawnZonePoint(zoneId, pointId) {
      setSpawnZonesAutosaveStatus('salvando...');
      const response = await apiFetch('/admin-panel/api/spawn-zones/zones/' + encodeURIComponent(zoneId) + '/points/' + encodeURIComponent(pointId), { method: 'DELETE' });
      if (!response.ok) { showToast(await response.text()); setSpawnZonesAutosaveStatus('erro'); return; }
      state.spawnZones = await response.json(); state.highlightedSpawnPointId = null;
      setSpawnZonesAutosaveStatus('salvo'); renderSpawnZones();
    }
    function focusSpawnZonePoint(pointId) {
      const zone = selectedSpawnZone();
      const point = (zone?.points || []).find((item) => item.id === pointId);
      if (!point || !els.spawnZonesMapViewport) return;
      state.highlightedSpawnPointId = pointId;
      renderSpawnZoneMarkers();
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
    function switchSettingsTab(tab) {
      state.settingsTab = tab;
      document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
      ['server', 'events', 'integrations'].forEach((key) => {
        const panel = document.getElementById('settingsPanel' + key.charAt(0).toUpperCase() + key.slice(1));
        if (panel) panel.classList.toggle('active', key === tab);
      });
      if (tab === 'events') renderLockedContainerCards();
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
    function switchView(view) {
      state.view = view; document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + view));
      document.querySelectorAll(".nav button").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
      els.pageTitle.textContent = view === "general" ? "Geral" : view === "members" ? "Membros" : view === "catalog" ? "Shop" : view === "map-events" ? "Eventos do Mapa" : view === "spawn-zones" ? "Spawn Zones" : view === "settings" ? "Settings" : "Itens";
      if (view === "members" && !els.memberList.children.length) loadMembers(true);
      if (view === "catalog" && !state.catalog) loadCatalog();
      if (view === "items" && !state.dayzItems.length) loadDayzItems(true);
      if (view === "map-events") { if (!state.mapEventPresets.length) loadMapEventPresets(); loadScheduledMapEvents(); }
      if (view === "spawn-zones") { if (!state.spawnZones) loadSpawnZones(); else renderSpawnZones(); }
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
    document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => { switchView(button.dataset.view); setMobileMenuOpen(false); }));
    if (mobileMenuButton) mobileMenuButton.addEventListener("click", () => setMobileMenuOpen(!(sidebar && sidebar.classList.contains("open"))));
    if (mobileNavBackdrop) mobileNavBackdrop.addEventListener("click", () => setMobileMenuOpen(false));
    window.addEventListener("keydown", (event) => { if (event.key === "Escape") setMobileMenuOpen(false); });
    document.getElementById("refreshButton").addEventListener("click", async () => { await loadOverview(); if (state.view === "members") await loadMembers(true); if (state.view === "catalog") { if (state.catalogMode === "queue") await loadShopQueue(); else await loadCatalog(); } if (state.view === "items") await loadDayzItems(true); if (state.view === "map-events") { await loadMapEventPresets(); await loadScheduledMapEvents(); } if (state.view === "spawn-zones") await loadSpawnZones(); if (state.view === "settings") renderLockedContainerCards(); showToast("Dados atualizados."); });
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
    document.querySelectorAll(".settings-tab").forEach((button) => button.addEventListener("click", () => switchSettingsTab(button.dataset.settingsTab || "server")));
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
    loadOverview();
  </script>
</body>
</html>`;
}

router.get("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  setPanelCookie(req, res);
  res.type("html").send(renderAdminPanelHtml(getTokenFromRequest(req)));
});

router.get("/api/overview", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const state = await getStateAsync();
    res.json(await buildOverviewPayload(state as AdminState));
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
  rotation.zones = rotation.zones.filter((item) => item.id !== req.params.zoneId);
  if (rotation.zones.length === 0) rotation.zones = [defaultSpawnZone()];
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

router.get("/api/map-events/chernarus-map", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const mapPath = path.resolve(
    process.cwd(),
    process.env.SHOP_MAP_IMAGE_PATH || "assets/maps/chernarus-map-pz-bot.png",
  );

  res.sendFile(mapPath, (err) => {
    if (err && !res.headersSent) res.status(404).send("Chernarus map image not found");
  });
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
