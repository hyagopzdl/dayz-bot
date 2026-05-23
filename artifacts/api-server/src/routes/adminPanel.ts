import { Router, type Request, type Response } from "express";
import { getShopRuntimeStatus } from "../lib/shop";
import {
  deleteShopCatalogCategory,
  deleteShopCatalogItem,
  ensureShopCatalogLoaded,
  getShopCatalog,
  normalizeShopCatalogId,
  toggleShopCatalogItem,
  upsertShopCatalogCategoryItem,
  upsertShopCatalogItem,
  type ShopCatalog,
  type ShopItem,
} from "../lib/shopCatalog";
import { addCoins, removeCoins, setCoins, getOrCreateWalletForLink } from "../lib/economy";
import {
  getDayzItemByClassName,
  getDayzItemsPage,
  searchDayzItemsFromDatabase,
  toggleDayzItemInDatabase,
  updateDayzItemInDatabase,
} from "../lib/dayzItemsService";
import { getStateAsync, saveStateAsync, type AppState, type PlayerLink, type Wallet } from "../lib/state";

const router = Router();
const TOKEN_COOKIE = "admin_panel_token";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

type AdminState = AppState & Record<string, any>;

type MemberRow = {
  discordId: string;
  discordName: string;
  gamertag: string;
  gamertagNormalized: string;
  locale: string;
  avatarUrl: string | null;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  onlineRewardMinutes: number;
  status: "online" | "offline";
  linkedAt: string | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
};

function readCookie(req: Request, name: string) {
  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const cookies = cookieHeader.split(";").map((part) => part.trim()).filter(Boolean);

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
  const headerToken = typeof req.headers["x-admin-token"] === "string" ? req.headers["x-admin-token"] : "";
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const cookieToken = readCookie(req, TOKEN_COOKIE);

  const referer = typeof req.headers.referer === "string" ? req.headers.referer : "";
  let refererToken = "";
  try {
    if (referer) refererToken = new URL(referer).searchParams.get("token") || "";
  } catch {
    refererToken = "";
  }

  return queryToken || headerToken || bearerToken || cookieToken || refererToken;
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
  return String(value || "").trim().toLowerCase();
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
    const sessionValue = value as { lastSeenAt?: string; connectedAt?: string } | undefined;
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

function buildMemberRows(state: AdminState): MemberRow[] {
  const links = Object.values(state.playerLinks || {}) as PlayerLink[];
  const onlineNames = getOnlinePlayerNames(state);

  return links
    .filter((link) => link?.discordId && link?.gamertag)
    .map((link) => {
      const wallet = state.wallets?.[link.discordId] as Wallet | undefined;
      const numbers = walletToNumbers(wallet);
      const isOnline = onlineNames.has(normalizeText(link.gamertag));

      return {
        discordId: link.discordId,
        discordName: `Discord User ${link.discordId.slice(-4)}`,
        gamertag: link.gamertag,
        gamertagNormalized: link.gamertagNormalized || normalizeText(link.gamertag),
        locale: link.locale || "en",
        avatarUrl: null,
        balance: numbers.balance,
        totalEarned: numbers.totalEarned,
        totalSpent: numbers.totalSpent,
        onlineRewardMinutes: numbers.onlineRewardMinutes,
        status: (isOnline ? "online" : "offline") as "online" | "offline",
        linkedAt: formatIso(link.linkedAt),
        updatedAt: formatIso(link.updatedAt),
        lastSeenAt: getLastSeenAt(state, link.gamertag),
      };
    })
    .sort((a, b) => b.balance - a.balance || a.gamertag.localeCompare(b.gamertag));
}

function filterMembers(rows: MemberRow[], params: { search: string; filter: string }) {
  const search = normalizeText(params.search);
  const filter = normalizeText(params.filter);

  return rows.filter((member) => {
    if (filter === "online" && member.status !== "online") return false;
    if (filter === "offline" && member.status !== "offline") return false;
    if (filter === "pt" && member.locale !== "pt") return false;
    if (filter === "en" && member.locale !== "en") return false;

    if (!search) return true;
    return [member.discordId, member.discordName, member.gamertag, member.gamertagNormalized]
      .some((value) => normalizeText(value).includes(search));
  });
}

function buildMemberTransactions(state: AdminState, discordId: string, limit = 20) {
  const transactions = Array.isArray(state.economyTransactions) ? state.economyTransactions : [];

  return transactions
    .filter((transaction) => String((transaction as { discordId?: string }).discordId || "") === discordId)
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

function buildMemberDetails(state: AdminState, discordId: string) {
  const member = buildMemberRows(state).find((row) => row.discordId === discordId);
  if (!member) return null;

  return {
    member,
    transactions: buildMemberTransactions(state, discordId, 24),
  };
}

function getEconomyConfig() {
  const rewardCoins = Number(process.env.ECONOMY_PLAYTIME_REWARD_COINS || 60);
  const rewardMinutes = Number(process.env.ECONOMY_PLAYTIME_REWARD_MINUTES || 60);
  const tickMinutes = Number(process.env.ECONOMY_PLAYTIME_TICK_MINUTES || 5);
  const enabled = process.env.ECONOMY_PLAYTIME_REWARD_ENABLED === "true";

  return {
    enabled,
    rewardCoins,
    rewardMinutes,
    tickMinutes,
    coinsPerHour: rewardMinutes > 0 ? Math.round((rewardCoins / rewardMinutes) * 60) : rewardCoins,
  };
}

function buildOverviewPayload(state: AdminState) {
  const runtime = getShopRuntimeStatus(state);
  const members = buildMemberRows(state);
  const wallets = Object.values(state.wallets || {}) as Wallet[];
  const transactions = Array.isArray(state.economyTransactions) ? state.economyTransactions : [];
  const totalCoins = wallets.reduce((sum, wallet) => sum + Math.floor(Number(wallet.balance || 0)), 0);
  const totalEarned = wallets.reduce((sum, wallet) => sum + Math.floor(Number(wallet.totalEarned || 0)), 0);
  const totalSpent = wallets.reduce((sum, wallet) => sum + Math.floor(Number(wallet.totalSpent || 0)), 0);

  return {
    server: {
      name: process.env.ADMIN_PANEL_SERVER_NAME || process.env.SERVER_NAME || "DayZ Server",
      status: "online",
      onlinePlayers: countObject(state.onlinePlayers),
      knownPlayers: countObject(state.players),
      linkedMembers: members.length,
      nextRestart: runtime.nextRestartLabel || "unknown",
      minutesUntilRestart: runtime.minutesUntilRestart ?? null,
    },
    economy: {
      ...getEconomyConfig(),
      wallets: wallets.length,
      totalCoins,
      totalEarned,
      totalSpent,
      transactions: transactions.length,
    },
    locale: {
      active: process.env.ADMIN_PANEL_DEFAULT_LOCALE || "pt-BR",
      available: ["pt-BR", "en-US"],
    },
    shop: {
      state: runtime.state,
      canAcceptPurchase: runtime.canAcceptPurchase,
      reason: runtime.reason,
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
      itemCount: categoryCounts.get(category.id) || 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const knownCategoryIds = new Set(categories.map((category) => category.id));
  for (const [categoryId, itemCount] of categoryCounts.entries()) {
    if (knownCategoryIds.has(categoryId)) continue;
    categories.push({
      id: categoryId,
      label: categoryId,
      emoji: "",
      description: "",
      enabled: true,
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
      maxPerRestart: Number.isFinite(Number(item.maxPerRestart)) ? Number(item.maxPerRestart) : null,
    }))
    .sort((a, b) => a.categoryLabel.localeCompare(b.categoryLabel) || a.name.localeCompare(b.name));

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
        ? Math.round(items.reduce((sum, item) => sum + item.price, 0) / items.length)
        : 0,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function readCatalogItemPayload(body: unknown, fallbackId?: string): Promise<ShopItem> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const requestedClassName = String(input.className || input.class_name || input.id || fallbackId || "").trim();
  const definition = await getDayzItemByClassName(requestedClassName);

  if (!definition || definition.enabled === false) {
    throw new Error("Select a valid enabled DayZ item from the database before saving.");
  }

  const className = definition.className;
  const id = normalizeShopCatalogId(String(input.id || className));
  const name = String(input.name || definition.popularName || definition.className).trim();
  const category = normalizeShopCatalogId(String(input.category || "misc")) || "misc";
  const price = Math.floor(Number(input.price || 0));
  const enabled = typeof input.enabled === "boolean" ? input.enabled : input.enabled !== false;
  const imageUrl = String(input.imageUrl || definition.imageUrl || "").trim();

  if (!id) throw new Error("Item id is required.");
  if (!name) throw new Error("Store item name is required.");
  if (!Number.isFinite(price) || price < 0) throw new Error("Item price must be a valid positive number.");

  return {
    id,
    name,
    className,
    popularName: definition.popularName || name,
    category,
    price,
    description: input.description ? String(input.description).trim() : undefined,
    imageUrl: imageUrl || undefined,
    enabled,
  };
}


function readCatalogCategoryPayload(body: unknown) {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const label = String(input.label || input.name || "").trim();
  const requestedId = String(input.id || label).trim();
  const id = normalizeShopCatalogId(requestedId);
  const description = String(input.description || "").trim();
  const emoji = String(input.emoji || "").trim();
  const enabled = typeof input.enabled === "boolean" ? input.enabled : input.enabled !== false;

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

function buildActivitySeries(state: AdminState) {
  const online = countObject(state.onlinePlayers);
  const weekly = countObject(state.weeklyPlayers);
  const daily = countObject(state.dailyPlayers);
  const transactions = Array.isArray(state.economyTransactions) ? state.economyTransactions.length : 0;
  const base = Math.max(online, 1);

  return Array.from({ length: 12 }, (_, index) => {
    const hour = `${String((index * 2) % 24).padStart(2, "0")}:00`;
    return {
      hour,
      players: Math.max(0, Math.round(base + Math.sin(index / 1.7) * Math.max(1, base * 0.45) + index / 2)),
      joins: Math.max(0, Math.round((weekly + index * 3) % 18)),
      economy: Math.max(0, Math.round((transactions + daily + index * 11) % 120)),
    };
  });
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
    .member-list { display: grid; gap: 10px; }
    .member-card {
      display: grid;
      grid-template-columns: 48px minmax(220px, 1.15fr) minmax(170px,.8fr) auto;
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
    .member-name { font-weight: 650; letter-spacing: -.02em; }
    .member-meta { color: var(--text-3); font-size: 12px; margin-top: 4px; line-height: 1.35; }
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
    .catalog-category-card.new { border-style: dashed; color: var(--text-3); }
    .category-icon { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; border: 1px solid var(--border); background: #25262A; font-size: 22px; }
    .category-title { font-size: 14px; font-weight: 650; letter-spacing: -.025em; color: var(--text); text-align: center; }
    .category-subtitle { color: var(--text-3); font-size: 12px; text-align: center; }
    .category-delete { position: absolute; top: 10px; right: 10px; opacity: .72; }
    .catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .catalog-item {
      min-width: 0;
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
    .catalog-item-top { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 12px; align-items: center; }
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
    .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .form-grid .full { grid-column: 1 / -1; }
    .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border-radius: 14px; background: #25262A; border: 1px solid var(--border); }
    .toggle-row input { width: auto; }
    .catalog-empty { padding: 42px; text-align: center; color: var(--text-3); border: 1px dashed var(--border-strong); border-radius: 18px; background: #2B2D31; }

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
      .metric-grid, .members-toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">DZ</div>
        <div style="min-width:0">
          <div id="serverName" class="brand-title">DayZ Server</div>
          <div class="status"><span class="dot"></span><span>Online</span></div>
        </div>
      </div>
      <div class="nav-label">Navegação</div>
      <nav class="nav">
        <button class="active" data-view="general">🏠 Geral</button>
        <button data-view="members">👥 Membros</button>
        <button data-view="catalog">🛒 Catálogo</button>
        <button data-view="items">📦 Itens</button>
      </nav>
      <div class="sidebar-footer"><div class="avatar">A</div><div><b>Admin</b><div class="member-meta">Painel seguro</div></div></div>
    </aside>
    <section class="main">
      <header class="topbar">
        <div class="page-title" id="pageTitle">Geral</div>
        <div class="global-search"><input id="globalSearch" placeholder="Buscar membros, gamertags ou Discord ID..." /></div>
        <div class="top-actions">
          <select id="languageSelect" aria-label="Idioma"><option value="pt-BR">Português</option><option value="en-US">English</option></select>
          <button class="icon-btn" id="refreshButton">Refresh</button>
          <div class="avatar">PZ</div>
        </div>
      </header>
      <main class="content">
        <section id="view-general" class="view active">
          <div class="metric-grid">
            <div class="card"><div class="metric-label">Players Online</div><div class="metric-value" id="metricOnline">—</div><div class="metric-hint" id="metricOnlineHint">Carregando...</div></div>
            <div class="card"><div class="metric-label">Próximo Reset</div><div class="metric-value" id="metricReset">—</div><div class="metric-hint" id="metricResetHint">Countdown do servidor</div></div>
            <div class="card"><div class="metric-label">Economia</div><div class="metric-value" id="metricEconomy">—</div><div class="metric-hint" id="metricEconomyHint">Reward por tempo online</div></div>
            <div class="card"><div class="metric-label">Idioma Ativo</div><div class="metric-value" id="metricLocale">—</div><div class="metric-hint">Preferência do painel</div></div>
          </div>
          <div class="dashboard-grid">
            <div class="card">
              <div class="section-title"><h2>Atividade do servidor</h2><span class="chip">tempo real</span></div>
              <div id="activityChart" class="chart"></div>
            </div>
            <aside class="card">
              <div class="section-title"><h2>Configurações rápidas</h2><span class="chip">config</span></div>
              <div class="settings-list">
                <div class="setting-row"><div><b>Pontos por hora</b><span id="quickCoins">—</span></div><button class="mini-btn disabled">Editar</button></div>
                <div class="setting-row"><div><b>Idioma</b><span id="quickLocale">—</span></div><button class="mini-btn disabled">Alterar</button></div>
                <div class="setting-row"><div><b>Próximo reset</b><span id="quickReset">—</span></div><button class="mini-btn disabled">Configurar</button></div>
                <div class="setting-row"><div><b>Shop</b><span id="quickShop">—</span></div><button class="mini-btn disabled">Ver</button></div>
              </div>
            </aside>
          </div>
        </section>
        <section id="view-members" class="view">
          <div class="members-toolbar">
            <div class="search"><input id="memberSearch" placeholder="Buscar por Discord, ID ou gamertag..." /></div>
            <select id="memberFilter"><option value="">Todos</option><option value="online">Online</option><option value="offline">Offline</option><option value="pt">Português</option><option value="en">English</option></select>
            <button class="ghost-btn" id="membersRefresh">Refresh</button>
          </div>
          <div id="memberList" class="member-list"></div>
          <div id="memberLoading" class="member-list" style="display:none"><div class="skeleton"></div><div class="skeleton"></div></div>
          <div id="memberEmpty" class="empty" style="display:none">Nenhum membro encontrado.</div>
          <div id="memberSentinel" class="sentinel"></div>
        </section>
        <section id="view-catalog" class="view">
          <div class="catalog-shell">
            <div class="catalog-stats">
              <div class="card"><div class="metric-label">Itens</div><div id="catalogTotal" class="metric-value">—</div><div class="metric-hint">total no catálogo</div></div>
              <div class="card"><div class="metric-label">Ativos</div><div id="catalogEnabled" class="metric-value">—</div><div class="metric-hint">disponíveis no shop</div></div>
              <div class="card"><div class="metric-label">Categorias</div><div id="catalogCategories" class="metric-value">—</div><div class="metric-hint">grupos encontrados</div></div>
              <div class="card"><div class="metric-label">Preço médio</div><div id="catalogAverage" class="metric-value">—</div><div class="metric-hint">coins por item</div></div>
            </div>
            <div id="catalogCategoryView" class="catalog-shell">
              <div class="card">
                <div class="section-title">
                  <h2>Categorias</h2>
                  <div style="display:flex;align-items:center;gap:8px"><span class="chip">Neon</span><button id="catalogCategoryCreate" class="primary-btn">Nova categoria</button><button id="catalogRefresh" class="ghost-btn">Refresh</button></div>
                </div>
                <div class="catalog-breadcrumb">Escolha uma categoria para gerenciar os itens dentro dela.</div>
              </div>
              <div id="catalogCategoryGrid" class="catalog-category-grid"></div>
            </div>
            <div id="catalogItemsView" class="catalog-shell" style="display:none">
              <div class="card">
                <div class="section-title">
                  <h2 id="catalogCurrentCategoryTitle">Itens</h2>
                  <div style="display:flex;align-items:center;gap:8px"><button id="catalogBack" class="ghost-btn">← Categorias</button><button id="catalogCreate" class="primary-btn">Novo item</button></div>
                </div>
                <div class="catalog-breadcrumb"><span>Catálogo</span><span>›</span><b id="catalogCurrentCategoryLabel">Categoria</b></div>
                <div class="catalog-toolbar" style="margin-top:12px">
                  <div class="search"><input id="catalogSearch" placeholder="Buscar por item ou classe" /></div>
                  <button id="catalogItemsRefresh" class="ghost-btn">Refresh</button>
                </div>
              </div>
              <div id="catalogLoading" class="catalog-grid" style="display:none"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
              <div id="catalogGrid" class="catalog-grid"></div>
              <div id="catalogEmpty" class="catalog-empty" style="display:none">Nenhum item encontrado nessa categoria.</div>
            </div>
          </div>
        </section>
        <section id="view-items" class="view">
          <div class="items-shell">
            <div class="catalog-stats">
              <div class="card"><div class="metric-label">Itens</div><div id="itemsTotal" class="metric-value">—</div><div class="metric-hint">base mestre DayZ</div></div>
              <div class="card"><div class="metric-label">Habilitados</div><div id="itemsEnabled" class="metric-value">—</div><div class="metric-hint">disponíveis para catálogo</div></div>
              <div class="card"><div class="metric-label">Desabilitados</div><div id="itemsDisabled" class="metric-value">—</div><div class="metric-hint">ocultos no autocomplete</div></div>
              <div class="card"><div class="metric-label">Sem imagem</div><div id="itemsMissingImage" class="metric-value">—</div><div class="metric-hint">precisam revisão</div></div>
            </div>
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
      <h2 id="catalogModalTitle">Item do catálogo</h2>
      <p id="catalogModalSubtitle">Gerencie o item diretamente no Neon.</p>
      <div class="form-grid two">
        <label class="full autocomplete-wrap">ID / Item base
          <input id="catalogItemId" autocomplete="off" placeholder="Digite para buscar na base DayZ" />
          <div id="catalogItemAutocomplete" class="autocomplete-menu"></div>
        </label>
        <label class="full">Nome na loja<input id="catalogItemName" placeholder="Nome exibido no shop" /></label>
        <label>Categoria<select id="catalogItemCategory"></select></label>
        <label>Preço<input id="catalogItemPrice" type="number" min="0" step="1" /></label>
        <label class="full">URL da imagem<input id="catalogItemImage" placeholder="https://..." /></label>
        <label class="full">Descrição<textarea id="catalogItemDescription" placeholder="Descrição exibida no painel/shop..."></textarea></label>
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
        <div id="itemModalPreviewImage" class="dayz-item-image">🎒</div>
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
  <div id="toast" class="toast"></div>
  <script>
    const adminToken = ${tokenJson};
    if (adminToken) document.cookie = "${TOKEN_COOKIE}=" + encodeURIComponent(adminToken) + "; path=/admin-panel; SameSite=Lax";
    const state = { view: "general", cursor: 0, hasMore: true, loadingMembers: false, search: "", filter: "", modal: null, catalogModal: null, selectedDiscordId: null, catalog: null, catalogSearch: "", catalogCategory: "", catalogMode: "categories", itemsCursor: 0, itemsHasMore: true, itemsLoading: false, itemsSearch: "", itemsFilter: "all", dayzItems: [], itemsStats: null, itemModal: null };
    const els = {
      pageTitle: document.getElementById("pageTitle"), serverName: document.getElementById("serverName"),
      memberList: document.getElementById("memberList"), memberLoading: document.getElementById("memberLoading"), memberEmpty: document.getElementById("memberEmpty"),
      modalBackdrop: document.getElementById("modalBackdrop"), modalTitle: document.getElementById("modalTitle"), modalSubtitle: document.getElementById("modalSubtitle"),
      coinAmount: document.getElementById("coinAmount"), coinReason: document.getElementById("coinReason"), toast: document.getElementById("toast"),
      detailDrawer: document.getElementById("detailDrawer"), drawerBody: document.getElementById("drawerBody"), drawerAvatar: document.getElementById("drawerAvatar"), drawerName: document.getElementById("drawerName"), drawerMeta: document.getElementById("drawerMeta"),
      catalogGrid: document.getElementById("catalogGrid"), catalogLoading: document.getElementById("catalogLoading"), catalogEmpty: document.getElementById("catalogEmpty"), catalogSearch: document.getElementById("catalogSearch"), catalogCategoryView: document.getElementById("catalogCategoryView"), catalogItemsView: document.getElementById("catalogItemsView"), catalogCategoryGrid: document.getElementById("catalogCategoryGrid"), catalogCurrentCategoryTitle: document.getElementById("catalogCurrentCategoryTitle"), catalogCurrentCategoryLabel: document.getElementById("catalogCurrentCategoryLabel"),
      catalogModalBackdrop: document.getElementById("catalogModalBackdrop"), catalogModalTitle: document.getElementById("catalogModalTitle"), catalogModalSubtitle: document.getElementById("catalogModalSubtitle"), catalogItemId: document.getElementById("catalogItemId"), catalogItemAutocomplete: document.getElementById("catalogItemAutocomplete"), catalogItemCategory: document.getElementById("catalogItemCategory"), catalogItemName: document.getElementById("catalogItemName"), catalogItemPrice: document.getElementById("catalogItemPrice"), catalogItemImage: document.getElementById("catalogItemImage"), catalogItemDescription: document.getElementById("catalogItemDescription"), catalogItemEnabled: document.getElementById("catalogItemEnabled"), catalogCategoryModalBackdrop: document.getElementById("catalogCategoryModalBackdrop"), catalogCategoryName: document.getElementById("catalogCategoryName"), catalogCategoryId: document.getElementById("catalogCategoryId"), catalogCategoryDescription: document.getElementById("catalogCategoryDescription"), catalogCategoryEnabled: document.getElementById("catalogCategoryEnabled"),
      itemsList: document.getElementById("itemsList"), itemsLoading: document.getElementById("itemsLoading"), itemsEmpty: document.getElementById("itemsEmpty"), itemsSearch: document.getElementById("itemsSearch"), itemsFilter: document.getElementById("itemsFilter"), itemsRefresh: document.getElementById("itemsRefresh"), itemsSentinel: document.getElementById("itemsSentinel"), itemsTotal: document.getElementById("itemsTotal"), itemsEnabled: document.getElementById("itemsEnabled"), itemsDisabled: document.getElementById("itemsDisabled"), itemsMissingImage: document.getElementById("itemsMissingImage"),
      itemModalBackdrop: document.getElementById("itemModalBackdrop"), itemModalTitle: document.getElementById("itemModalTitle"), itemModalSubtitle: document.getElementById("itemModalSubtitle"), itemModalPreviewImage: document.getElementById("itemModalPreviewImage"), itemModalPreviewName: document.getElementById("itemModalPreviewName"), itemModalPreviewClass: document.getElementById("itemModalPreviewClass"), itemModalPopularName: document.getElementById("itemModalPopularName"), itemModalImageUrl: document.getElementById("itemModalImageUrl"), itemModalSpawnEventName: document.getElementById("itemModalSpawnEventName"), itemModalEnabled: document.getElementById("itemModalEnabled")
    };
    function apiUrl(path) { const separator = path.includes("?") ? "&" : "?"; return adminToken ? path + separator + "token=" + encodeURIComponent(adminToken) : path; }
    async function apiFetch(path, options) { const headers = Object.assign({ "Content-Type": "application/json" }, (options && options.headers) || {}); if (adminToken) headers["x-admin-token"] = adminToken; return fetch(apiUrl(path), Object.assign({}, options || {}, { headers, credentials: "same-origin" })); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[char] || char)); }
    function formatNumber(value) { return new Intl.NumberFormat("pt-BR").format(Number(value || 0)); }
    function formatCoins(value) { return new Intl.NumberFormat("pt-BR").format(Number(value || 0)); }
    function relativeDate(value) { if (!value) return "Nunca"; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value); return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }
    function showToast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 3200); }
    function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
    function renderActivity(series) { const chart = document.getElementById("activityChart"); const max = Math.max(1, ...series.map((item) => item.players)); chart.innerHTML = series.map((item) => '<div class="bar-wrap"><div class="bar" style="height:' + Math.max(8, Math.round((item.players / max) * 190)) + 'px"></div><div class="bar-label">' + escapeHtml(item.hour) + '</div></div>').join(""); }
    async function loadOverview() {
      const response = await apiFetch("/admin-panel/api/overview");
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      els.serverName.textContent = payload.server.name;
      setText("metricOnline", payload.server.onlinePlayers + " / " + Math.max(payload.server.knownPlayers, payload.server.onlinePlayers));
      setText("metricOnlineHint", payload.server.linkedMembers + " membros vinculados");
      setText("metricReset", payload.server.nextRestart || "unknown");
      setText("metricResetHint", payload.server.minutesUntilRestart === null ? "Sem countdown ativo" : payload.server.minutesUntilRestart + " minutos restantes");
      setText("metricEconomy", payload.economy.coinsPerHour + " coins/h");
      setText("metricEconomyHint", payload.economy.enabled ? "Reward automático ativo" : "Reward automático desligado");
      setText("metricLocale", payload.locale.active === "pt-BR" ? "Português 🇧🇷" : "English 🇺🇸");
      setText("quickCoins", payload.economy.rewardCoins + " coins a cada " + payload.economy.rewardMinutes + " min");
      setText("quickLocale", payload.locale.active);
      setText("quickReset", payload.server.nextRestart || "unknown");
      setText("quickShop", payload.shop.canAcceptPurchase ? "Checkout aberto" : "Checkout fechado");
      renderActivity(payload.activity || []);
    }
    function memberCard(member) {
      const statusChip = member.status === "online" ? '<span class="chip online">● Online</span>' : '<span class="chip">○ Offline</span>';
      return '<article class="member-card" data-discord-id="' + escapeHtml(member.discordId) + '">' +
        '<div class="avatar">' + escapeHtml((member.gamertag || "?").slice(0,2).toUpperCase()) + '</div>' +
        '<div><div class="member-name">' + escapeHtml(member.discordName) + '</div><div class="member-meta">' + escapeHtml(member.discordId) + '</div><div class="chips"><span class="chip">🎮 ' + escapeHtml(member.gamertag) + '</span><span class="chip">' + escapeHtml(member.locale.toUpperCase()) + '</span>' + statusChip + '</div></div>' +
        '<div class="member-economy"><div class="wallet-number">' + formatCoins(member.balance) + ' coins</div><div class="member-meta">Earned ' + formatCoins(member.totalEarned) + ' · Spent ' + formatCoins(member.totalSpent) + '</div><div class="member-meta">Último acesso: ' + escapeHtml(relativeDate(member.lastSeenAt)) + '</div></div>' +
        '<div class="actions"><button class="mini-btn" data-action="add">Add</button><button class="mini-btn" data-action="remove">Remove</button><button class="mini-btn" data-action="set">Set</button><button class="mini-btn danger disabled" title="Próxima versão">Temp Ban</button><button class="mini-btn danger disabled" title="Próxima versão">Ban</button></div>' +
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
      els.drawerAvatar.textContent = (member.gamertag || "??").slice(0, 2).toUpperCase();
      els.drawerName.textContent = member.discordName || member.gamertag;
      els.drawerMeta.textContent = member.gamertag + " · " + member.discordId;
      const transactions = payload.transactions || [];
      els.drawerBody.innerHTML =
        '<div class="drawer-card"><div class="drawer-stats">' +
          '<div class="drawer-stat"><span>Balance</span><b>' + formatCoins(member.balance) + '</b></div>' +
          '<div class="drawer-stat"><span>Earned</span><b>' + formatCoins(member.totalEarned) + '</b></div>' +
          '<div class="drawer-stat"><span>Spent</span><b>' + formatCoins(member.totalSpent) + '</b></div>' +
        '</div></div>' +
        '<div class="drawer-card"><div class="section-title"><h2>Perfil</h2><span class="chip ' + (member.status === "online" ? "online" : "") + '">' + (member.status === "online" ? "● Online" : "○ Offline") + '</span></div>' +
          '<div class="settings-list">' +
            '<div class="setting-row"><div><b>Gamertag</b><span>' + escapeHtml(member.gamertag) + '</span></div></div>' +
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
      const params = new URLSearchParams({ cursor: String(state.cursor), limit: "20", search: state.search, filter: state.filter });
      const response = await apiFetch("/admin-panel/api/members?" + params.toString());
      els.memberLoading.style.display = "none"; state.loadingMembers = false;
      if (!response.ok) { showToast(await response.text()); return; }
      const payload = await response.json();
      state.cursor = payload.nextCursor || state.cursor; state.hasMore = Boolean(payload.hasMore);
      els.memberList.insertAdjacentHTML("beforeend", payload.members.map(memberCard).join(""));
      els.memberEmpty.style.display = els.memberList.children.length ? "none" : "block";
    }

    function findCatalogCategory(categoryId) {
      return (state.catalog?.categories || []).find((category) => category.id === categoryId) || null;
    }
    function categoryIcon(category) {
      return category.emoji || "📁";
    }
    function catalogCategoryCard(category) {
      const countLabel = formatCoins(category.itemCount || 0) + " item" + (Number(category.itemCount || 0) === 1 ? "" : "s");
      const deleteButton = Number(category.itemCount || 0) > 0
        ? ""
        : '<button class="mini-btn danger category-delete" data-category-action="delete" title="Excluir categoria">🗑</button>';
      return '<article class="catalog-category-card" data-category-id="' + escapeHtml(category.id) + '">' +
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
        : '🛒';
      const enabledChip = item.enabled
        ? '<span class="chip online">● Active</span>'
        : '<span class="chip">○ Disabled</span>';
      const maxChip = item.maxPerRestart === null || item.maxPerRestart === undefined
        ? ''
        : '<span class="chip">Max ' + escapeHtml(String(item.maxPerRestart)) + '/restart</span>';
      const toggleLabel = item.enabled ? 'Desativar' : 'Ativar';
      return '<article class="catalog-item" data-item-id="' + escapeHtml(item.id) + '">' +
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
      const stats = state.catalog.stats || {};
      setText("catalogTotal", formatCoins(stats.totalItems || 0));
      setText("catalogEnabled", formatCoins(stats.enabledItems || 0));
      setText("catalogCategories", formatCoins(stats.categories || 0));
      setText("catalogAverage", formatCoins(stats.averagePrice || 0));
      renderCatalogCategoryOptions(state.catalog);

      const isItems = state.catalogMode === "items" && state.catalogCategory;
      els.catalogCategoryView.style.display = isItems ? "none" : "grid";
      els.catalogItemsView.style.display = isItems ? "grid" : "none";

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
          : '<div class="autocomplete-fallback">🎒</div>';
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
      els.catalogModalSubtitle.textContent = mode === "create" ? "Escolha um item da base DayZ e publique no catálogo do Neon." : "Atualize os dados exibidos no shop.";
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
      return imageUrl ? '<img src="' + escapeHtml(imageUrl) + '" alt="" loading="lazy" onerror="this.parentElement.textContent=\'🎒\'" />' : '🎒';
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
      if (els.itemsTotal && state.itemsStats) {
        els.itemsTotal.textContent = formatNumber(state.itemsStats.total || 0);
        els.itemsEnabled.textContent = formatNumber(state.itemsStats.enabled || 0);
        els.itemsDisabled.textContent = formatNumber(state.itemsStats.disabled || 0);
        els.itemsMissingImage.textContent = formatNumber(state.itemsStats.missingImage || 0);
      }
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

    function switchView(view) {
      state.view = view; document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + view));
      document.querySelectorAll(".nav button").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
      els.pageTitle.textContent = view === "general" ? "Geral" : view === "members" ? "Membros" : view === "catalog" ? "Catálogo" : "Itens";
      if (view === "members" && !els.memberList.children.length) loadMembers(true);
      if (view === "catalog" && !state.catalog) loadCatalog();
      if (view === "items" && !state.dayzItems.length) loadDayzItems(true);
    }
    function openCoinModal(action, memberCardEl) {
      const discordId = memberCardEl.getAttribute("data-discord-id");
      const gamertag = memberCardEl.querySelector(".chip")?.textContent?.replace("🎮", "").trim() || discordId;
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
    document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    document.getElementById("refreshButton").addEventListener("click", async () => { await loadOverview(); if (state.view === "members") await loadMembers(true); if (state.view === "catalog") await loadCatalog(); if (state.view === "items") await loadDayzItems(true); showToast("Dados atualizados."); });
    document.getElementById("membersRefresh").addEventListener("click", () => loadMembers(true));
    let searchTimer = null;
    function updateSearch(value) { state.search = value; clearTimeout(searchTimer); searchTimer = setTimeout(() => loadMembers(true), 240); }
    document.getElementById("memberSearch").addEventListener("input", (event) => updateSearch(event.target.value));
    document.getElementById("globalSearch").addEventListener("input", (event) => { document.getElementById("memberSearch").value = event.target.value; updateSearch(event.target.value); if (state.view !== "members") switchView("members"); });
    document.getElementById("memberFilter").addEventListener("change", (event) => { state.filter = event.target.value; loadMembers(true); });
    document.getElementById("catalogSearch").addEventListener("input", (event) => { state.catalogSearch = event.target.value; renderCatalog(); });
    document.getElementById("catalogRefresh").addEventListener("click", loadCatalog);
    document.getElementById("catalogItemsRefresh").addEventListener("click", loadCatalog);
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
    els.catalogCategoryGrid.addEventListener("click", (event) => {
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
    res.json(buildOverviewPayload(state as AdminState));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/api/members", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const state = (await getStateAsync()) as AdminState;
    const cursor = Math.max(0, Math.floor(Number(req.query.cursor || 0)));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(req.query.limit || DEFAULT_PAGE_SIZE))));
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const rows = filterMembers(buildMemberRows(state), { search, filter });
    const members = rows.slice(cursor, cursor + limit);

    res.json({
      members,
      total: rows.length,
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
    const details = buildMemberDetails(state, discordId);

    if (!details) {
      res.status(404).send("Linked member not found");
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
      res.status(404).send("Linked member not found");
      return;
    }

    const action = String(req.body?.action || "");
    const amount = Math.floor(Number(req.body?.amount || 0));
    const reason = req.body?.reason ? String(req.body.reason).trim() : "Admin panel";
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
    const limit = Math.min(25, Math.max(1, Math.floor(Number(req.query.limit || 12))));
    const includeDisabled = req.query.includeDisabled === "true";
    const items = (await searchDayzItemsFromDatabase({
      query,
      limit,
      enabledOnly: !includeDisabled,
    })).map((item) => ({
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
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit || 30))));
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
    const input = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const item = await updateDayzItemInDatabase(req.params.className, {
      popularName: input.popularName === undefined ? undefined : String(input.popularName || "").trim(),
      imageUrl: input.imageUrl === undefined ? undefined : String(input.imageUrl || "").trim(),
      spawnEventName: input.spawnEventName === undefined ? undefined : String(input.spawnEventName || "").trim(),
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    });

    if (!item) {
      res.status(404).send("DayZ item not found");
      return;
    }

    res.json({ ok: true, item });
  } catch (err) {
    res.status(400).send(String(err));
  }
});

router.patch("/api/items/:className/toggle", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { enabled?: boolean };
    const item = await toggleDayzItemInDatabase(req.params.className, body.enabled);

    if (!item) {
      res.status(404).send("DayZ item not found");
      return;
    }

    res.json({ ok: true, item });
  } catch (err) {
    res.status(400).send(String(err));
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

router.post("/api/catalog/categories", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const category = readCatalogCategoryPayload(req.body);
    await upsertShopCatalogCategoryItem(category);
    await ensureShopCatalogLoaded();
    res.json({ ok: true, category, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).send(String(err));
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
    res.status(400).send(String(err));
  }
});

router.post("/api/catalog/items", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const item = await readCatalogItemPayload(req.body);
    const saved = await upsertShopCatalogItem(item);
    res.json({ ok: true, item: saved, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).send(String(err));
  }
});

router.patch("/api/catalog/items/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const item = await readCatalogItemPayload(req.body, req.params.id);
    const saved = await upsertShopCatalogItem(item);
    res.json({ ok: true, item: saved, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).send(String(err));
  }
});

router.patch("/api/catalog/items/:id/toggle", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { enabled?: boolean };
    const item = await toggleShopCatalogItem(req.params.id, body.enabled);
    if (!item) {
      res.status(404).send("Catalog item not found");
      return;
    }
    res.json({ ok: true, item, catalog: buildCatalogPayload() });
  } catch (err) {
    res.status(400).send(String(err));
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
    res.status(400).send(String(err));
  }
});

export default router;
