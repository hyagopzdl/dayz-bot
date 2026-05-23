import { Router, type Request, type Response } from "express";
import { getShopRuntimeStatus } from "../lib/shop";
import { addCoins, removeCoins, setCoins, getOrCreateWalletForLink } from "../lib/economy";
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
        status: isOnline ? "online" : "offline",
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
      --surface: #2B2D31;
      --surface-2: #313338;
      --surface-3: #383A40;
      --primary: #5865F2;
      --primary-soft: rgba(88, 101, 242, .18);
      --text: #F2F3F5;
      --text-2: #B5BAC1;
      --text-3: #949BA4;
      --success: #23A55A;
      --warning: #F0B232;
      --danger: #F23F43;
      --border: rgba(255,255,255,.075);
      --shadow: 0 24px 80px rgba(0,0,0,.24);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(88,101,242,.18), transparent 34rem),
        radial-gradient(circle at top right, rgba(35,165,90,.08), transparent 30rem),
        var(--bg);
      color: var(--text);
    }
    button, input, select { font: inherit; }
    button { border: 0; }
    .app { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
    .sidebar {
      position: sticky; top: 0; height: 100vh; padding: 20px 14px;
      background: rgba(43,45,49,.82); border-right: 1px solid var(--border); backdrop-filter: blur(18px);
      display: flex; flex-direction: column; gap: 18px;
    }
    .brand { display: flex; gap: 12px; align-items: center; padding: 4px 8px 16px; border-bottom: 1px solid var(--border); }
    .logo { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: linear-gradient(135deg, var(--primary), #7C89FF); box-shadow: 0 14px 34px rgba(88,101,242,.3); }
    .brand-title { font-size: 15px; font-weight: 800; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { display: inline-flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 12px; margin-top: 3px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--success); box-shadow: 0 0 0 4px rgba(35,165,90,.12); }
    .nav-label { color: var(--text-3); font-size: 11px; font-weight: 800; letter-spacing: .18em; padding: 0 12px; text-transform: uppercase; }
    .nav { display: grid; gap: 6px; }
    .nav button {
      position: relative; display: flex; align-items: center; gap: 10px; width: 100%; color: var(--text-2);
      padding: 12px 13px; border-radius: 13px; background: transparent; cursor: pointer; transition: background .18s ease, color .18s ease, transform .18s ease;
    }
    .nav button:hover { background: rgba(255,255,255,.045); color: var(--text); transform: translateX(1px); }
    .nav button.active { background: var(--primary-soft); color: var(--text); }
    .nav button.active::before { content: ""; position: absolute; left: -6px; top: 10px; bottom: 10px; width: 3px; border-radius: 999px; background: var(--primary); }
    .sidebar-footer { margin-top: auto; padding: 14px 8px 4px; border-top: 1px solid var(--border); color: var(--text-2); font-size: 13px; display: flex; gap: 10px; align-items: center; }
    .avatar { width: 38px; height: 38px; border-radius: 999px; display: grid; place-items: center; background: linear-gradient(135deg, #5865F2, #23A55A); color: white; font-weight: 900; flex: 0 0 auto; }
    .main { min-width: 0; }
    .topbar {
      height: 72px; display: flex; align-items: center; gap: 16px; justify-content: space-between; padding: 0 28px;
      background: rgba(30,31,34,.74); border-bottom: 1px solid var(--border); backdrop-filter: blur(16px); position: sticky; top: 0; z-index: 10;
    }
    .page-title { font-size: 22px; font-weight: 800; letter-spacing: -.03em; }
    .top-actions { display: flex; align-items: center; gap: 10px; }
    .global-search { width: min(460px, 42vw); position: relative; }
    .global-search input, .search input, select {
      width: 100%; height: 42px; border: 1px solid var(--border); border-radius: 13px; color: var(--text);
      background: rgba(49,51,56,.76); outline: none; padding: 0 14px; transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
    }
    .global-search input:focus, .search input:focus, select:focus { border-color: rgba(88,101,242,.75); box-shadow: 0 0 0 4px rgba(88,101,242,.12); background: #313338; }
    .icon-btn, .primary-btn, .ghost-btn, .danger-btn {
      height: 42px; border-radius: 13px; padding: 0 14px; color: var(--text); cursor: pointer; transition: transform .16s ease, background .16s ease, box-shadow .16s ease, opacity .16s ease;
    }
    .icon-btn, .ghost-btn { background: rgba(49,51,56,.88); border: 1px solid var(--border); }
    .primary-btn { background: var(--primary); box-shadow: 0 14px 34px rgba(88,101,242,.22); font-weight: 800; }
    .danger-btn { background: rgba(242,63,67,.14); color: #ffb4b6; border: 1px solid rgba(242,63,67,.25); }
    .icon-btn:hover, .ghost-btn:hover, .primary-btn:hover, .danger-btn:hover { transform: translateY(-1px); }
    .content { padding: 28px; }
    .view { display: none; animation: fadeIn .22s ease both; }
    .view.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
    .card {
      background: linear-gradient(180deg, rgba(49,51,56,.95), rgba(43,45,49,.96)); border: 1px solid var(--border);
      border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; transition: transform .18s ease, border-color .18s ease, background .18s ease;
    }
    .card:hover { transform: translateY(-1px); border-color: rgba(255,255,255,.12); }
    .metric-label { color: var(--text-3); font-size: 12px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .metric-value { margin-top: 10px; font-size: 28px; font-weight: 900; letter-spacing: -.05em; }
    .metric-hint { margin-top: 8px; color: var(--text-2); font-size: 13px; }
    .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) 360px; gap: 16px; margin-top: 16px; align-items: start; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .section-title h2 { margin: 0; font-size: 17px; letter-spacing: -.02em; }
    .chart { display: flex; align-items: end; gap: 10px; height: 240px; padding-top: 20px; }
    .bar-wrap { flex: 1; min-width: 0; display: grid; gap: 8px; align-items: end; height: 100%; }
    .bar { border-radius: 999px 999px 6px 6px; background: linear-gradient(180deg, #7C89FF, var(--primary)); min-height: 14px; box-shadow: 0 10px 24px rgba(88,101,242,.2); transition: height .25s ease; }
    .bar-label { color: var(--text-3); font-size: 11px; text-align: center; white-space: nowrap; }
    .settings-list { display: grid; gap: 12px; }
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border-radius: 14px; background: rgba(30,31,34,.38); border: 1px solid var(--border); }
    .setting-row b { font-size: 14px; } .setting-row span { display:block; color: var(--text-3); font-size: 12px; margin-top: 3px; }
    .members-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px auto; gap: 10px; margin-bottom: 16px; }
    .member-list { display: grid; gap: 12px; }
    .member-card {
      display: grid; grid-template-columns: 52px minmax(220px, 1.1fr) minmax(160px,.8fr) auto; gap: 16px; align-items: center;
      padding: 16px; border-radius: 18px; background: rgba(43,45,49,.92); border: 1px solid var(--border); box-shadow: 0 14px 44px rgba(0,0,0,.13);
      transition: transform .18s ease, background .18s ease, border-color .18s ease;
    }
    .member-card:hover { transform: translateY(-1px); background: rgba(49,51,56,.95); border-color: rgba(255,255,255,.12); }
    .member-name { font-weight: 850; letter-spacing: -.02em; }
    .member-meta { color: var(--text-3); font-size: 12px; margin-top: 4px; }
    .chips { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 9px; }
    .chip { color: var(--text-2); border: 1px solid var(--border); background: rgba(30,31,34,.5); border-radius: 999px; padding: 5px 8px; font-size: 12px; font-weight: 750; }
    .chip.online { color: #b6ffd0; background: rgba(35,165,90,.12); border-color: rgba(35,165,90,.25); }
    .wallet-number { font-size: 20px; font-weight: 950; letter-spacing: -.03em; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .mini-btn { height: 34px; border-radius: 10px; padding: 0 10px; background: rgba(88,101,242,.16); color: #dfe3ff; border: 1px solid rgba(88,101,242,.24); cursor: pointer; font-weight: 800; transition: background .16s ease, transform .16s ease; }
    .mini-btn:hover { background: rgba(88,101,242,.26); transform: translateY(-1px); }
    .mini-btn.danger { background: rgba(242,63,67,.12); border-color: rgba(242,63,67,.22); color: #ffd3d4; }
    .mini-btn.disabled { opacity: .45; cursor: not-allowed; }
    .skeleton { position: relative; overflow: hidden; background: rgba(255,255,255,.06); border-radius: 14px; min-height: 84px; }
    .skeleton::after { content:""; position:absolute; inset:0; transform:translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent); animation: shimmer 1.2s infinite; }
    @keyframes shimmer { to { transform: translateX(100%); } }
    .empty { padding: 36px; text-align: center; color: var(--text-2); }
    .sentinel { height: 24px; }
    .catalog-placeholder { min-height: 360px; display: grid; place-items: center; text-align: center; color: var(--text-2); }
    .catalog-placeholder h2 { color: var(--text); margin: 0 0 8px; }
    .modal-backdrop { position: fixed; inset: 0; display: none; place-items: center; padding: 20px; background: rgba(0,0,0,.48); backdrop-filter: blur(8px); z-index: 100; }
    .modal-backdrop.open { display: grid; }
    .modal { width: min(520px, 100%); background: #2B2D31; border: 1px solid var(--border); border-radius: 20px; box-shadow: 0 40px 120px rgba(0,0,0,.48); padding: 20px; animation: modalIn .18s ease both; }
    @keyframes modalIn { from { opacity: 0; transform: scale(.98) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .modal h2 { margin: 0; font-size: 20px; letter-spacing: -.03em; }
    .modal p { color: var(--text-2); margin: 8px 0 18px; line-height: 1.5; }
    .form-grid { display: grid; gap: 12px; }
    label { display: grid; gap: 7px; color: var(--text-2); font-size: 13px; font-weight: 800; }
    .form-grid input, .form-grid textarea { width: 100%; border: 1px solid var(--border); border-radius: 13px; background: #1E1F22; color: var(--text); padding: 12px; outline: none; }
    .form-grid textarea { min-height: 90px; resize: vertical; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
    .toast { position: fixed; right: 22px; bottom: 22px; max-width: 380px; background: #313338; border: 1px solid var(--border); color: var(--text); padding: 14px 16px; border-radius: 14px; box-shadow: var(--shadow); display: none; z-index: 120; }
    .toast.show { display: block; animation: fadeIn .18s ease both; }
    @media (max-width: 1120px) { .metric-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } .dashboard-grid { grid-template-columns: 1fr; } .member-card { grid-template-columns: 52px minmax(0, 1fr); } .member-economy, .actions { grid-column: 2; justify-content: flex-start; } }
    @media (max-width: 760px) { .app { grid-template-columns: 1fr; } .sidebar { display: none; } .topbar { padding: 0 16px; } .global-search { display:none; } .content { padding: 18px; } .metric-grid, .members-toolbar { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">🎮</div>
        <div style="min-width:0">
          <div id="serverName" class="brand-title">DayZ Server</div>
          <div class="status"><span class="dot"></span><span>Online</span></div>
        </div>
      </div>
      <div class="nav-label">Main</div>
      <nav class="nav">
        <button class="active" data-view="general">🏠 Geral</button>
        <button data-view="members">👥 Membros</button>
        <button data-view="catalog">🛒 Catálogo</button>
      </nav>
      <div class="sidebar-footer"><div class="avatar">A</div><div><b>Admin</b><div class="member-meta">Painel seguro</div></div></div>
    </aside>
    <section class="main">
      <header class="topbar">
        <div class="page-title" id="pageTitle">Geral</div>
        <div class="global-search"><input id="globalSearch" placeholder="Buscar membros, gamertags ou Discord ID..." /></div>
        <div class="top-actions">
          <select id="languageSelect" aria-label="Idioma"><option value="pt-BR">Português</option><option value="en-US">English</option></select>
          <button class="icon-btn" id="refreshButton">↻ Refresh</button>
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
              <div class="section-title"><h2>Atividade do servidor</h2><span class="chip">últimas janelas</span></div>
              <div id="activityChart" class="chart"></div>
            </div>
            <aside class="card">
              <div class="section-title"><h2>Configurações rápidas</h2><span class="chip">read-only V1</span></div>
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
            <button class="ghost-btn" id="membersRefresh">↻ Refresh</button>
          </div>
          <div id="memberList" class="member-list"></div>
          <div id="memberLoading" class="member-list" style="display:none"><div class="skeleton"></div><div class="skeleton"></div></div>
          <div id="memberEmpty" class="empty" style="display:none">Nenhum membro encontrado.</div>
          <div id="memberSentinel" class="sentinel"></div>
        </section>
        <section id="view-catalog" class="view">
          <div class="card catalog-placeholder">
            <div>
              <h2>Catálogo</h2>
              <p>O funcionamento atual do catálogo foi preservado nesta V1.</p>
              <button class="primary-btn" onclick="location.href='/admin/catalog' + (adminToken ? '?token=' + encodeURIComponent(adminToken) : '')">Abrir catálogo atual</button>
            </div>
          </div>
        </section>
      </main>
    </section>
  </div>
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
  <div id="toast" class="toast"></div>
  <script>
    const adminToken = ${tokenJson};
    if (adminToken) document.cookie = "${TOKEN_COOKIE}=" + encodeURIComponent(adminToken) + "; path=/admin-panel; SameSite=Lax";
    const state = { view: "general", cursor: 0, hasMore: true, loadingMembers: false, search: "", filter: "", modal: null };
    const els = {
      pageTitle: document.getElementById("pageTitle"), serverName: document.getElementById("serverName"),
      memberList: document.getElementById("memberList"), memberLoading: document.getElementById("memberLoading"), memberEmpty: document.getElementById("memberEmpty"),
      modalBackdrop: document.getElementById("modalBackdrop"), modalTitle: document.getElementById("modalTitle"), modalSubtitle: document.getElementById("modalSubtitle"),
      coinAmount: document.getElementById("coinAmount"), coinReason: document.getElementById("coinReason"), toast: document.getElementById("toast")
    };
    function apiUrl(path) { const separator = path.includes("?") ? "&" : "?"; return adminToken ? path + separator + "token=" + encodeURIComponent(adminToken) : path; }
    async function apiFetch(path, options) { const headers = Object.assign({ "Content-Type": "application/json" }, (options && options.headers) || {}); if (adminToken) headers["x-admin-token"] = adminToken; return fetch(apiUrl(path), Object.assign({}, options || {}, { headers, credentials: "same-origin" })); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[char] || char)); }
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
    function switchView(view) {
      state.view = view; document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + view));
      document.querySelectorAll(".nav button").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
      els.pageTitle.textContent = view === "general" ? "Geral" : view === "members" ? "Membros" : "Catálogo";
      if (view === "members" && !els.memberList.children.length) loadMembers(true);
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
      els.modalBackdrop.classList.remove("open"); showToast("Carteira atualizada com sucesso."); await loadOverview(); await loadMembers(true);
    }
    document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    document.getElementById("refreshButton").addEventListener("click", async () => { await loadOverview(); if (state.view === "members") await loadMembers(true); showToast("Dados atualizados."); });
    document.getElementById("membersRefresh").addEventListener("click", () => loadMembers(true));
    let searchTimer = null;
    function updateSearch(value) { state.search = value; clearTimeout(searchTimer); searchTimer = setTimeout(() => loadMembers(true), 240); }
    document.getElementById("memberSearch").addEventListener("input", (event) => updateSearch(event.target.value));
    document.getElementById("globalSearch").addEventListener("input", (event) => { document.getElementById("memberSearch").value = event.target.value; updateSearch(event.target.value); if (state.view !== "members") switchView("members"); });
    document.getElementById("memberFilter").addEventListener("change", (event) => { state.filter = event.target.value; loadMembers(true); });
    els.memberList.addEventListener("click", (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; openCoinModal(button.dataset.action, button.closest(".member-card")); });
    document.getElementById("modalCancel").addEventListener("click", () => els.modalBackdrop.classList.remove("open"));
    document.getElementById("modalConfirm").addEventListener("click", confirmCoinAction);
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting) && state.view === "members") loadMembers(false); }, { rootMargin: "420px" });
    observer.observe(document.getElementById("memberSentinel"));
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

export default router;
