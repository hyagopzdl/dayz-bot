import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getShopRuntimeStatus } from "../lib/shop";
import { getShopCategories, getShopItems } from "../lib/shopCatalog";
import type { AppState } from "../lib/state";

const router = Router();

type DashboardState = AppState & Record<string, any>;

function getAdminTokenFromRequest(req: { query: any; headers: any }) {
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  const headerToken =
    typeof req.headers?.["x-admin-token"] === "string"
      ? req.headers["x-admin-token"]
      : "";

  return queryToken || headerToken;
}

function requireAdmin(req: any, res: any) {
  const configuredToken = process.env.SHOP_ADMIN_TOKEN;

  // Local/dev compatibility: if no token is configured, keep the route open.
  // In production, set SHOP_ADMIN_TOKEN.
  if (!configuredToken) return true;

  const receivedToken = getAdminTokenFromRequest(req);

  if (receivedToken !== configuredToken) {
    res.status(401).send("Unauthorized");
    return false;
  }

  return true;
}

async function readAppState(): Promise<DashboardState> {
  const candidates = [
    path.join(process.cwd(), "state.json"),
    path.join(process.cwd(), "artifacts/api-server/state.json"),
  ];

  let lastError: unknown = null;

  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as DashboardState;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

function countValue(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function formatDateTime(value: unknown) {
  if (!value) return null;

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toISOString();
}

function buildDashboardPayload(state: DashboardState) {
  const shopOrders = Array.isArray(state.shopOrders) ? state.shopOrders : [];
  const runtime = getShopRuntimeStatus(state);
  const categories = getShopCategories();
  const catalogItems = getShopItems(true);

  const pending = shopOrders.filter((order: any) => order.status === "pending_spawn");
  const included = shopOrders.filter((order: any) => order.status === "included_in_restart");
  const spawned = shopOrders.filter((order: any) => order.status === "spawned");
  const failed = shopOrders.filter((order: any) => order.status === "failed");

  return {
    shop: {
      state: runtime.state,
      canAcceptPurchase: runtime.canAcceptPurchase,
      reason: runtime.reason,
      nextRestart: runtime.nextRestartLabel || null,
      minutesUntilRestart: runtime.minutesUntilRestart ?? null,
      freezeWindowActive: runtime.state === "FROZEN",

      pending: pending.length,
      includedInRestart: included.length,
      spawned: spawned.length,
      failed: failed.length,

      batchWaitingClear: Boolean(state.shopResetMonitor?.sawOnlineAt),
      resetMonitor: state.shopResetMonitor || null,
      autoDeploy: state.shopAutoDeploy || null,
      savedLocations: Array.isArray(state.shopSavedLocations)
        ? state.shopSavedLocations.length
        : 0,
    },

    catalog: {
      categories: categories.length,
      items: catalogItems.length,
      enabledItems: catalogItems.filter((item: any) => item.enabled !== false).length,
      disabledItems: catalogItems.filter((item: any) => item.enabled === false).length,
    },

    leaderboard: {
      global: countValue(state.global),
      daily: countValue(state.daily),
      weekly: countValue(state.weekly),
      killfeed: countValue(state.killfeed),
      killStreakEvents: countValue(state.killStreakEvents),
      longShotEvents: countValue(state.longShotEvents),
    },

    online: countValue(state.online),

    meta: {
      timestamp: Date.now(),
      generatedAt: new Date().toISOString(),
      lastResetStatus: state.shopResetMonitor?.lastStatus || null,
      lastResetCheckedAt: formatDateTime(state.shopResetMonitor?.lastCheckedAt),
      lastAutoDeployAt: formatDateTime(state.shopAutoDeploy?.lastDeployAt),
      lastAutoDeployWindow: state.shopAutoDeploy?.lastWindowId || null,
    },
  };
}

function renderDashboardHtml(token: string) {
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DayZ Shop Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1115;
      --panel: #171a21;
      --panel-2: #1f2430;
      --text: #f4f7fb;
      --muted: #9aa4b2;
      --ok: #2ecc71;
      --warn: #f1c40f;
      --bad: #ff5c5c;
      --accent: #6c7cff;
      --border: #2b3140;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1c2230 0, var(--bg) 48%);
      color: var(--text);
    }

    header {
      padding: 28px 28px 8px;
      max-width: 1180px;
      margin: 0 auto;
    }

    h1 {
      margin: 0;
      font-size: 30px;
      letter-spacing: -0.03em;
    }

    .subtitle {
      margin-top: 8px;
      color: var(--muted);
    }

    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px 28px 48px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }

    .card {
      background: linear-gradient(180deg, var(--panel), #141720);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
    }

    .card h2 {
      margin: 0 0 8px;
      font-size: 13px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
    }

    .value {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .hint {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .wide {
      grid-column: span 2;
    }

    .full {
      grid-column: 1 / -1;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 11px;
      border-radius: 999px;
      background: var(--panel-2);
      border: 1px solid var(--border);
      font-weight: 700;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--muted);
    }

    .dot.ok { background: var(--ok); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--bad); }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      color: #d7def0;
      background: #0b0d12;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid var(--border);
      max-height: 420px;
      overflow: auto;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }

    button, a.button {
      border: 0;
      border-radius: 10px;
      padding: 10px 13px;
      font-weight: 800;
      background: var(--accent);
      color: white;
      text-decoration: none;
      cursor: pointer;
    }

    a.link {
      color: #aab4ff;
      text-decoration: none;
    }

    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wide { grid-column: 1 / -1; }
    }

    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>DayZ Shop Admin</h1>
    <div class="subtitle">Dashboard operacional da loja, deploy automático e ciclo de entrega.</div>
  </header>

  <main>
    <div class="toolbar">
      <button onclick="loadDashboard()">Atualizar</button>
      <a class="button" href="/admin/api/dashboard${tokenQuery}">Ver JSON</a>
      <a class="link" href="/admin/health${tokenQuery}">Health</a>
    </div>

    <section class="grid">
      <div class="card wide">
        <h2>Estado da shop</h2>
        <div id="shopStatus" class="status"><span class="dot"></span><span>Carregando...</span></div>
        <div id="shopReason" class="hint"></div>
      </div>

      <div class="card">
        <h2>Próximo restart</h2>
        <div id="nextRestart" class="value">-</div>
        <div id="restartHint" class="hint"></div>
      </div>

      <div class="card">
        <h2>Freeze window</h2>
        <div id="freeze" class="value">-</div>
        <div class="hint">Bloqueia checkout perto do reset.</div>
      </div>

      <div class="card">
        <h2>Pending</h2>
        <div id="pending" class="value">-</div>
        <div class="hint">Pedidos aguardando deploy.</div>
      </div>

      <div class="card">
        <h2>Batch aguardando clear</h2>
        <div id="waitingClear" class="value">-</div>
        <div class="hint">XML injetado/entrega em finalização.</div>
      </div>

      <div class="card">
        <h2>Included</h2>
        <div id="included" class="value">-</div>
        <div class="hint">Pedidos no próximo restart.</div>
      </div>

      <div class="card">
        <h2>Spawned</h2>
        <div id="spawned" class="value">-</div>
        <div class="hint">Pedidos entregues.</div>
      </div>

      <div class="card">
        <h2>Auto deploy</h2>
        <div id="autoDeploy" class="value">-</div>
        <div id="autoDeployHint" class="hint"></div>
      </div>

      <div class="card">
        <h2>Nitrado status</h2>
        <div id="nitrado" class="value">-</div>
        <div id="nitradoHint" class="hint"></div>
      </div>

      <div class="card">
        <h2>Online</h2>
        <div id="online" class="value">-</div>
        <div class="hint">Jogadores online pelo state atual.</div>
      </div>

      <div class="card">
        <h2>Catálogo</h2>
        <div id="catalog" class="value">-</div>
        <div id="catalogHint" class="hint"></div>
      </div>

      <div class="card full">
        <h2>Payload</h2>
        <pre id="payload">Carregando...</pre>
      </div>
    </section>
  </main>

  <script>
    const tokenQuery = ${JSON.stringify(tokenQuery)};

    function setText(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    }

    function setStatus(payload) {
      const wrapper = document.getElementById("shopStatus");
      const dot = wrapper.querySelector(".dot");
      const label = wrapper.querySelector("span:last-child");

      dot.className = "dot";
      if (payload.shop.canAcceptPurchase) dot.classList.add("ok");
      else if (payload.shop.state === "FROZEN") dot.classList.add("warn");
      else dot.classList.add("bad");

      label.textContent = payload.shop.state + (payload.shop.canAcceptPurchase ? " / Checkout aberto" : " / Checkout fechado");
    }

    async function loadDashboard() {
      const response = await fetch("/admin/api/dashboard" + tokenQuery);
      const payload = await response.json();

      setStatus(payload);
      setText("shopReason", payload.shop.reason || "-");
      setText("nextRestart", payload.shop.nextRestart || "unknown");
      setText("restartHint", payload.shop.minutesUntilRestart === null ? "Sem janela ativa" : payload.shop.minutesUntilRestart + " min");
      setText("freeze", payload.shop.freezeWindowActive ? "Ativa" : "Não");
      setText("pending", payload.shop.pending);
      setText("waitingClear", payload.shop.batchWaitingClear ? "Sim" : "Não");
      setText("included", payload.shop.includedInRestart);
      setText("spawned", payload.shop.spawned);
      setText("autoDeploy", payload.meta.lastAutoDeployWindow || "none");
      setText("autoDeployHint", payload.meta.lastAutoDeployAt ? "Último deploy: " + payload.meta.lastAutoDeployAt : "Sem deploy registrado");
      setText("nitrado", payload.meta.lastResetStatus || "unknown");
      setText("nitradoHint", payload.meta.lastResetCheckedAt ? "Última checagem: " + payload.meta.lastResetCheckedAt : "Sem checagem");
      setText("online", payload.online);
      setText("catalog", payload.catalog.items + " itens");
      setText("catalogHint", payload.catalog.categories + " categorias / " + payload.catalog.enabledItems + " ativos");
      setText("payload", JSON.stringify(payload, null, 2));
    }

    loadDashboard();
    setInterval(loadDashboard, 30000);
  </script>
</body>
</html>`;
}

router.get("/", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const token = getAdminTokenFromRequest(req);
  res.type("html").send(renderDashboardHtml(token));
});

router.get("/health", (req, res) => {
  if (!requireAdmin(req, res)) return;

  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

async function handleDashboard(req: any, res: any) {
  if (!requireAdmin(req, res)) return;

  try {
    const state = await readAppState();
    res.json(buildDashboardPayload(state));
  } catch (err) {
    res.status(500).json({
      error: String(err),
    });
  }
}

router.get("/dashboard", handleDashboard);
router.get("/api/dashboard", handleDashboard);

export default router;
