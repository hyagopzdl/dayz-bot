import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getShopRuntimeStatus } from "../lib/shop";
import {
  deleteShopCatalogItem,
  getShopCatalog,
  getShopCategories,
  getShopItems,
  normalizeShopCatalogId,
  toggleShopCatalogItem,
  upsertShopCatalogItem,
  type ShopItem,
} from "../lib/shopCatalog";
import {
  findDayzItem,
  getDayzItems,
  searchDayzItems,
} from "../lib/dayzItemDatabase";
import type { AppState } from "../lib/state";

const router = Router();

type DashboardState = AppState & Record<string, any>;

function readCookie(headers: any, name: string) {
  const cookieHeader =
    typeof headers?.cookie === "string" ? headers.cookie : "";
  const cookies = cookieHeader.split(";").map((part: string) => part.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = cookie.slice(0, separatorIndex);
    const value = cookie.slice(separatorIndex + 1);

    if (key === name) return decodeURIComponent(value);
  }

  return "";
}

function getAdminTokenFromRequest(req: { query: any; headers: any }) {
  const queryToken =
    typeof req.query?.token === "string" ? req.query.token : "";
  const headerToken =
    typeof req.headers?.["x-admin-token"] === "string"
      ? req.headers["x-admin-token"]
      : "";
  const cookieToken = readCookie(req.headers, "shop_admin_token");

  // Fallback para requests do painel quando algum fetch/form perde a querystring.
  // Só funciona se a tela principal tiver sido aberta com ?token=...
  const referer =
    typeof req.headers?.referer === "string" ? req.headers.referer : "";
  let refererToken = "";
  try {
    if (referer)
      refererToken = new URL(referer).searchParams.get("token") || "";
  } catch {
    refererToken = "";
  }

  return queryToken || headerToken || cookieToken || refererToken;
}

function requireAdmin(req: any, res: any) {
  const configuredToken = process.env.SHOP_ADMIN_TOKEN;

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
  const categories = getShopCategories(true);
  const catalogItems = getShopItems(true);

  const pending = shopOrders.filter(
    (order: any) => order.status === "pending_spawn",
  );
  const included = shopOrders.filter(
    (order: any) => order.status === "included_in_restart",
  );
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
      enabledItems: catalogItems.filter((item: any) => item.enabled !== false)
        .length,
      disabledItems: catalogItems.filter((item: any) => item.enabled === false)
        .length,
      dayzItems: getDayzItems().length,
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

function renderBaseHtml(options: {
  title: string;
  token: string;
  body: string;
  script?: string;
}) {
  const tokenQuery = options.token
    ? `?token=${encodeURIComponent(options.token)}`
    : "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${options.title}</title>
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
    header { padding: 28px 28px 8px; max-width: 1180px; margin: 0 auto; }
    h1 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
    .subtitle { margin-top: 8px; color: var(--muted); }
    main { max-width: 1180px; margin: 0 auto; padding: 20px 28px 48px; }
    .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
    button, a.button {
      border: 0; border-radius: 10px; padding: 10px 13px; font-weight: 800;
      background: var(--accent); color: white; text-decoration: none; cursor: pointer;
    }
    button.secondary, a.secondary { background: var(--panel-2); border: 1px solid var(--border); }
    button.danger { background: #a73a3a; }
    a.link { color: #aab4ff; text-decoration: none; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .card {
      background: linear-gradient(180deg, var(--panel), #141720); border: 1px solid var(--border);
      border-radius: 16px; padding: 18px; box-shadow: 0 18px 50px rgba(0,0,0,.22);
    }
    .card h2 { margin: 0 0 8px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
    .value { font-size: 28px; font-weight: 800; letter-spacing: -.04em; }
    .hint { margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    .status { display: inline-flex; align-items: center; gap: 8px; padding: 8px 11px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); font-weight: 700; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
    table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 12px; }
    th, td { padding: 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    tr:hover td { background: rgba(255,255,255,.025); }
    input, select, textarea {
      width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: #0b0d12; color: var(--text); outline: none;
    }
    textarea { min-height: 70px; resize: vertical; }
    label { display: block; color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .span-2 { grid-column: span 2; }
    .item-img { width: 54px; height: 54px; border-radius: 12px; object-fit: cover; background: var(--panel-2); border: 1px solid var(--border); }
    .pill { display: inline-flex; border-radius: 999px; padding: 5px 9px; background: var(--panel-2); border: 1px solid var(--border); font-size: 12px; font-weight: 800; }
    .pill.ok { color: var(--ok); } .pill.bad { color: var(--bad); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .search-results { position: relative; }
    .dropdown { position: absolute; z-index: 20; left: 0; right: 0; top: 100%; background: #0b0d12; border: 1px solid var(--border); border-radius: 12px; max-height: 280px; overflow: auto; margin-top: 6px; box-shadow: 0 18px 50px rgba(0,0,0,.4); }
    .option { padding: 10px 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
    .option:hover { background: var(--panel-2); }
    .option small { color: var(--muted); display: block; margin-top: 2px; }
    .selected { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .selected code { color: #dfe5ff; }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0,1fr)); } .wide, .span-2 { grid-column: 1 / -1; } .form-grid { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${options.title}</h1>
    <div class="subtitle">Admin da loja DayZ. O campo Item busca na base e salva o className real para o spawn.</div>
  </header>
  <main>
    <div class="toolbar">
      <a class="button secondary" href="/admin${tokenQuery}">Dashboard</a>
      <a class="button secondary" href="/admin/catalog${tokenQuery}">Catálogo</a>
      <a class="link" href="/admin/health${tokenQuery}">Health</a>
    </div>
    ${options.body}
  </main>
  <script>
    const adminToken = ${JSON.stringify(options.token || "")};
    if (adminToken) {
      document.cookie = "shop_admin_token=" + encodeURIComponent(adminToken) + "; path=/admin; SameSite=Lax";
    }
    function apiUrl(path) {
      const separator = path.includes("?") ? "&" : "?";
      return adminToken ? path + separator + "token=" + encodeURIComponent(adminToken) : path;
    }
    function apiFetch(path, options) {
      const headers = Object.assign({}, (options && options.headers) || {});
      if (adminToken) headers["x-admin-token"] = adminToken;
      return fetch(apiUrl(path), Object.assign({}, options || {}, { headers, credentials: "same-origin" }));
    }
  </script>
  ${options.script || ""}
</body>
</html>`;
}

function renderDashboardHtml(token: string) {
  return renderBaseHtml({
    title: "DayZ Shop Admin",
    token,
    body: `
    <div class="toolbar">
      <button onclick="loadDashboard()">Atualizar</button>
    </div>
    <section class="grid">
      <div class="card wide"><h2>Estado da shop</h2><div id="shopStatus" class="status"><span class="dot"></span><span>Carregando...</span></div><div id="shopReason" class="hint"></div></div>
      <div class="card"><h2>Próximo restart</h2><div id="nextRestart" class="value">-</div><div id="restartHint" class="hint"></div></div>
      <div class="card"><h2>Freeze window</h2><div id="freeze" class="value">-</div><div class="hint">Bloqueia checkout perto do reset.</div></div>
      <div class="card"><h2>Pending</h2><div id="pending" class="value">-</div><div class="hint">Pedidos aguardando deploy.</div></div>
      <div class="card"><h2>Batch aguardando clear</h2><div id="waitingClear" class="value">-</div><div class="hint">XML injetado/entrega em finalização.</div></div>
      <div class="card"><h2>Included</h2><div id="included" class="value">-</div><div class="hint">Pedidos no próximo restart.</div></div>
      <div class="card"><h2>Spawned</h2><div id="spawned" class="value">-</div><div class="hint">Pedidos entregues.</div></div>
      <div class="card"><h2>Auto deploy</h2><div id="autoDeploy" class="value">-</div><div id="autoDeployHint" class="hint"></div></div>
      <div class="card"><h2>Nitrado status</h2><div id="nitrado" class="value">-</div><div id="nitradoHint" class="hint"></div></div>
      <div class="card"><h2>Online</h2><div id="online" class="value">-</div><div class="hint">Jogadores online pelo state atual.</div></div>
      <div class="card"><h2>Catálogo</h2><div id="catalog" class="value">-</div><div id="catalogHint" class="hint"></div></div>
    </section>`,
    script: `<script>
    function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
    function setStatus(payload) {
      const wrapper = document.getElementById("shopStatus"); const dot = wrapper.querySelector(".dot"); const label = wrapper.querySelector("span:last-child");
      dot.className = "dot"; if (payload.shop.canAcceptPurchase) dot.classList.add("ok"); else if (payload.shop.state === "FROZEN") dot.classList.add("warn"); else dot.classList.add("bad");
      label.textContent = payload.shop.state + (payload.shop.canAcceptPurchase ? " / Checkout aberto" : " / Checkout fechado");
    }
    async function loadDashboard() {
      const response = await apiFetch("/admin/api/dashboard");
      if (!response.ok) { alert(await response.text()); return; }
      const payload = await response.json();
      setStatus(payload); setText("shopReason", payload.shop.reason || "-"); setText("nextRestart", payload.shop.nextRestart || "unknown");
      setText("restartHint", payload.shop.minutesUntilRestart === null ? "Sem janela ativa" : payload.shop.minutesUntilRestart + " min");
      setText("freeze", payload.shop.freezeWindowActive ? "Ativa" : "Não"); setText("pending", payload.shop.pending); setText("waitingClear", payload.shop.batchWaitingClear ? "Sim" : "Não");
      setText("included", payload.shop.includedInRestart); setText("spawned", payload.shop.spawned); setText("autoDeploy", payload.meta.lastAutoDeployWindow || "none");
      setText("autoDeployHint", payload.meta.lastAutoDeployAt ? "Último deploy: " + payload.meta.lastAutoDeployAt : "Sem deploy registrado"); setText("nitrado", payload.meta.lastResetStatus || "unknown");
      setText("nitradoHint", payload.meta.lastResetCheckedAt ? "Última checagem: " + payload.meta.lastResetCheckedAt : "Sem checagem"); setText("online", payload.online);
      setText("catalog", payload.catalog.items + " itens"); setText("catalogHint", payload.catalog.categories + " categorias / " + payload.catalog.enabledItems + " ativos / " + payload.catalog.dayzItems + " classNames");
    }
    loadDashboard(); setInterval(loadDashboard, 30000);
    </script>`,
  });
}

function renderCatalogHtml(token: string) {
  return renderBaseHtml({
    title: "Gerenciar Catálogo",
    token,
    body: `
    <section class="card full">
      <h2>Novo / editar item</h2>
      <form id="catalogForm" class="form-grid">
        <input type="hidden" id="editingId" />
        <input type="hidden" id="className" />
        <div class="span-2 search-results">
          <label>Item</label>
          <input id="dayzSearch" autocomplete="off" required placeholder="Digite para buscar: ATOG, Barrel, M4A1, ACOGOptic..." />
          <div id="selectedItem" class="selected">Nenhum item selecionado.</div>
          <div id="dayzResults" class="dropdown" style="display:none"></div>
        </div>
        <div><label>Nome na loja</label><input id="name" required placeholder="Ex.: Mira ATOG" /></div>
        <div><label>Categoria</label><input id="category" required placeholder="Ex.: Optics" /></div>
        <div><label>URL da imagem</label><input id="imageUrl" placeholder="https://..." /></div>
        <div><label>Preço</label><input id="price" required type="number" min="0" step="1" placeholder="5000" /></div>
        <div class="span-2"><label>Descrição</label><textarea id="description" placeholder="Descrição opcional para aparecer na loja"></textarea></div>
        <div><label>Status</label><select id="enabled"><option value="true">Ativo</option><option value="false">Inativo</option></select></div>
        <div style="display:flex;align-items:end;gap:10px"><button type="submit">Salvar item</button><button type="button" class="secondary" onclick="resetForm()">Limpar</button></div>
      </form>
    </section>
    <section class="card full" style="margin-top:14px">
      <h2>Catálogo atual</h2>
      <div class="toolbar"><button onclick="loadCatalog()">Atualizar</button></div>
      <div style="overflow:auto"><table><thead><tr><th>Imagem</th><th>Nome na loja</th><th>Item real</th><th>Categoria</th><th>Preço</th><th>Status</th><th>Ações</th></tr></thead><tbody id="catalogRows"></tbody></table></div>
    </section>`,
    script: `<script>
    const form = document.getElementById("catalogForm");
    const results = document.getElementById("dayzResults");
    const search = document.getElementById("dayzSearch");
    function field(id) { return document.getElementById(id); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;"}[c] || c)); }
    function setSelected(item) {
      field("className").value = item?.className || "";
      field("selectedItem").innerHTML = item?.className ? "Selecionado: <b>" + escapeHtml(item.popularName || item.className) + "</b> <code>" + escapeHtml(item.className) + "</code>" : "Nenhum item selecionado.";
    }
    function resetForm() { form.reset(); field("editingId").value = ""; setSelected(null); results.style.display = "none"; }
    function selectDayzItem(item) {
      setSelected(item);
      field("dayzSearch").value = (item.popularName || item.className) + " — " + item.className;
      if (!field("name").value) field("name").value = item.popularName || item.className;
      results.style.display = "none";
    }
    async function searchDayz() {
      const q = search.value.trim();
      setSelected(null);
      if (!q) { results.style.display = "none"; return; }
      const response = await apiFetch("/admin/api/dayz-items?q=" + encodeURIComponent(q));
      if (!response.ok) { alert(await response.text()); return; }
      const payload = await response.json();
      results.innerHTML = payload.items.map(item => '<div class="option"><b>'+escapeHtml(item.popularName || item.className)+'</b><small>'+escapeHtml(item.className)+'</small></div>').join("");
      results.style.display = payload.items.length ? "block" : "none";
      Array.from(results.querySelectorAll(".option")).forEach((el, index) => el.addEventListener("click", () => selectDayzItem(payload.items[index])));
    }
    let searchTimer = null; search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchDayz, 180); });
    async function loadCatalog() {
      const response = await apiFetch("/admin/api/catalog");
      if (!response.ok) { alert(await response.text()); return; }
      const payload = await response.json(); const rows = document.getElementById("catalogRows");
      rows.innerHTML = payload.items.map(item => '<tr><td>'+(item.imageUrl ? '<img class="item-img" src="'+escapeHtml(item.imageUrl)+'" />' : '<div class="item-img"></div>')+'</td><td><b>'+escapeHtml(item.name)+'</b><div class="hint">ID: '+escapeHtml(item.id)+'</div></td><td><b>'+escapeHtml(item.popularName || item.className)+'</b><div class="hint"><code>'+escapeHtml(item.className)+'</code></div></td><td>'+escapeHtml(item.category || "misc")+'</td><td>'+Number(item.price || 0).toLocaleString('pt-BR')+'</td><td><span class="pill '+(item.enabled === false ? 'bad' : 'ok')+'">'+(item.enabled === false ? 'Inativo' : 'Ativo')+'</span></td><td><div class="actions"><button class="secondary" onclick=\'editItem("'+escapeHtml(item.id)+'")\'>Editar</button><button class="secondary" onclick=\'toggleItem("'+escapeHtml(item.id)+'")\'>Alternar</button><button class="danger" onclick=\'deleteItem("'+escapeHtml(item.id)+'")\'>Excluir</button></div></td></tr>').join(""); window.catalogItems = payload.items;
    }
    function editItem(id) {
      const item = (window.catalogItems || []).find(x => x.id === id); if (!item) return;
      field("editingId").value = item.id; setSelected({ className: item.className, popularName: item.popularName || item.className });
      field("dayzSearch").value = (item.popularName || item.className) + " — " + item.className;
      field("name").value = item.name || ""; field("category").value = item.category || "misc"; field("price").value = item.price || 0; field("imageUrl").value = item.imageUrl || ""; field("description").value = item.description || ""; field("enabled").value = item.enabled === false ? "false" : "true"; window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    async function toggleItem(id) { const response = await apiFetch("/admin/api/catalog/" + encodeURIComponent(id) + "/toggle", { method: "POST" }); if (!response.ok) { alert(await response.text()); return; } await loadCatalog(); }
    async function deleteItem(id) { if (!confirm("Excluir item do catálogo?")) return; const response = await apiFetch("/admin/api/catalog/" + encodeURIComponent(id), { method: "DELETE" }); if (!response.ok) { alert(await response.text()); return; } await loadCatalog(); }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!field("className").value) { alert("Selecione um item válido da lista de autocomplete."); return; }
      const body = { id: field("editingId").value || undefined, className: field("className").value, name: field("name").value, category: field("category").value, price: Number(field("price").value || 0), imageUrl: field("imageUrl").value, description: field("description").value, enabled: field("enabled").value !== "false" };
      const response = await apiFetch("/admin/api/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { alert(await response.text()); return; }
      resetForm(); await loadCatalog();
    });
    loadCatalog();
    </script>`,
  });
}

router.get("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = getAdminTokenFromRequest(req);
  if (token)
    res.cookie("shop_admin_token", token, { path: "/admin", sameSite: "lax" });
  res.type("html").send(renderDashboardHtml(token));
});

router.get("/catalog", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = getAdminTokenFromRequest(req);
  if (token)
    res.cookie("shop_admin_token", token, { path: "/admin", sameSite: "lax" });
  res.type("html").send(renderCatalogHtml(token));
});

router.get("/health", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, uptime: process.uptime(), timestamp: Date.now() });
});

async function handleDashboard(req: any, res: any) {
  if (!requireAdmin(req, res)) return;

  try {
    const state = await readAppState();
    res.json(buildDashboardPayload(state));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

router.get("/dashboard", handleDashboard);
router.get("/api/dashboard", handleDashboard);

router.get("/api/dayz-items", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const query = typeof req.query.q === "string" ? req.query.q : "";
  const limit = Math.min(Number(req.query.limit || 50), 100);
  res.json({
    items: searchDayzItems(query, limit),
    total: getDayzItems().length,
  });
});

router.get("/api/catalog", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getShopCatalog());
});

router.post("/api/catalog", (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const className = String(req.body?.className || "").trim();
    const dayzItem = findDayzItem(className);

    if (!dayzItem) {
      res.status(400).send(`Item inválido na base DayZ: ${className}`);
      return;
    }

    const item: ShopItem = {
      id: normalizeShopCatalogId(req.body?.id || req.body?.name || className),
      className: dayzItem.className,
      popularName: dayzItem.popularName,
      name: String(
        req.body?.name || dayzItem.popularName || dayzItem.className,
      ).trim(),
      category: normalizeShopCatalogId(req.body?.category || "misc"),
      price: Number(req.body?.price || 0),
      imageUrl: req.body?.imageUrl
        ? String(req.body.imageUrl).trim()
        : undefined,
      description: req.body?.description
        ? String(req.body.description).trim()
        : undefined,
      enabled: req.body?.enabled !== false,
    };

    res.json({ item: upsertShopCatalogItem(item), catalog: getShopCatalog() });
  } catch (err) {
    res.status(500).send(String(err));
  }
});

router.post("/api/catalog/:id/toggle", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const item = toggleShopCatalogItem(req.params.id);
  if (!item) {
    res.status(404).send("Catalog item not found");
    return;
  }

  res.json({ item, catalog: getShopCatalog() });
});

router.delete("/api/catalog/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const deleted = deleteShopCatalogItem(req.params.id);
  if (!deleted) {
    res.status(404).send("Catalog item not found");
    return;
  }

  res.json({ ok: true, catalog: getShopCatalog() });
});

export default router;
