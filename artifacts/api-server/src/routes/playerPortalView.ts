import type { PortalSession } from "../auth/session";

const PLAYER_PORTAL_ASSET_VERSION = "20260808-accounts-1";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderPlayerPortal(session: PortalSession, initialView: "dashboard" | "rankings" | "accounts" | "clan" | "shop" | "purchases" = "dashboard", options: { shopEnabled?: boolean } = {}) {
  const shopEnabled = options.shopEnabled !== false;
  const displayName = session.globalName || session.username;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#070709">
  <title>PZ Deathmatch · Player Portal</title>
  <link rel="stylesheet" href="/app-assets/player-portal.css?v=${PLAYER_PORTAL_ASSET_VERSION}">
</head>
<body data-view="${initialView}">
  <div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <a class="brand" href="/app" aria-label="PZ Deathmatch home">
        <span class="brand-mark">PZ</span>
        <span><strong>PZ Deathmatch</strong><small>Player portal</small></span>
      </a>
      <nav class="nav" aria-label="Player portal navigation">
        <a class="nav-item ${initialView === "dashboard" ? "active" : ""}" href="/app" data-route="dashboard"><span class="nav-icon">⌂</span>Dashboard</a>
        <a class="nav-item ${initialView === "rankings" ? "active" : ""}" href="/app/rankings" data-route="rankings"><span class="nav-icon">◫</span>Rankings</a>
        <a class="nav-item ${initialView === "accounts" ? "active" : ""}" href="/app/accounts" data-route="accounts"><span class="nav-icon">◎</span>Accounts</a>
        <a class="nav-item ${initialView === "clan" ? "active" : ""}" href="/app/clan" data-route="clan"><span class="nav-icon">◉</span>Clan</a>
${shopEnabled ? `<a class="nav-item ${initialView === "shop" ? "active" : ""}" href="/app/shop" data-route="shop"><span class="nav-icon">◇</span>Shop</a>
        <a class="nav-item ${initialView === "purchases" ? "active" : ""}" href="/app/purchases" data-route="purchases"><span class="nav-icon">▣</span>Purchases</a>` : ""}
        <a class="nav-item disabled" href="#" aria-disabled="true"><span class="nav-icon">◎</span>Economy<span class="soon">Soon</span></a>
        <a class="nav-item disabled" href="#" aria-disabled="true"><span class="nav-icon">○</span>Profile<span class="soon">Soon</span></a>
      </nav>
      <div class="sidebar-footer">
        <div class="server-status"><span class="status-dot"></span><div><strong>Server online</strong><small>Live connection</small></div></div>
        <button class="sign-out" id="logoutButton" type="button">Sign out</button>
      </div>
    </aside>

    <main class="main-content">
      <header class="mobile-header">
        <a class="brand compact" href="/app"><span class="brand-mark">PZ</span><strong>PZ</strong></a>
        <button class="menu-button" id="menuButton" type="button" aria-label="Open menu">☰</button>
      </header>

      <div class="content-wrap" id="contentRoot">
        <header class="page-header">
          <div>
            <p class="eyebrow">Player dashboard</p>
            <h1>Welcome back, <span>${escapeHtml(displayName)}</span></h1>
            <p class="page-subtitle">Your progress, combat performance and server activity in one place.</p>
          </div>
          <div class="profile-chip" id="profileChip">
            <div class="avatar skeleton"></div>
            <div><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(session.role)}</small></div>
          </div>
        </header>

        <div class="link-notice hidden" id="linkNotice">
          <div><strong>Connect your DayZ account</strong><span>Use <code>/link</code> on Discord to sync your gamertag, stats and coins.</span></div>
          <span class="notice-badge">Action needed</span>
        </div>

        <section class="metrics-grid" id="metricsGrid" aria-label="Player metrics">
          ${Array.from({ length: 6 }, (_, index) => `<article class="metric-card skeleton-card"><div class="metric-icon">${index + 1}</div><div><span class="metric-label">Loading</span><strong class="metric-value">—</strong></div></article>`).join("")}
        </section>

        <section class="dashboard-grid">
          <article class="panel activity-panel">
            <div class="panel-header"><div><p class="eyebrow">Combat log</p><h2>Latest activity</h2></div><span class="live-pill"><i></i>Live</span></div>
            <div class="activity-list" id="activityList"><div class="empty-state compact"><div class="loader"></div><p>Loading recent activity...</p></div></div>
          </article>

          <article class="panel leaderboard-panel">
            <div class="panel-header"><div><p class="eyebrow">Global ranking</p><h2>Leaderboard</h2></div><a class="text-button" href="/app/rankings">View all</a></div>
            <div class="leaderboard-list" id="leaderboardList"><div class="empty-state compact"><div class="loader"></div><p>Loading ranking...</p></div></div>
          </article>
        </section>

${shopEnabled ? `<section class="panel shop-panel">
          <div class="panel-header"><div><p class="eyebrow">Spend your coins</p><h2>Featured shop items</h2></div><a class="primary-button" href="/app/shop">Open shop <span>→</span></a></div>
          <div class="shop-grid" id="shopGrid"><div class="empty-state"><div class="loader"></div><p>Loading shop...</p></div></div>
        </section>` : ""}
      </div>
    </main>
  </div>
  <div class="backdrop" id="backdrop"></div>
  <script src="/app-assets/player-portal.js?v=${PLAYER_PORTAL_ASSET_VERSION}" defer></script>
</body>
</html>`;
}
