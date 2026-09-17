import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import adminRoutes from "./routes/admin";
import adminPanelRoutes from "./routes/adminPanel";
import serverControlPanelRoutes from "./routes/serverControlPanel";
import nitradoDiagnosticRoutes from "./routes/nitradoDiagnostic";
import nitradoSetupRoutes from "./routes/nitradoSetup";
import nitradoSelfServiceCompatRoutes from "./routes/nitradoSelfServiceCompat";
import saasOnboardingRoutes from "./routes/saasOnboarding";
import onboardingActivationCompatRoutes from "./routes/onboardingActivationCompat";
import { logger } from "./lib/logger";
import { recordNetworkTransfer } from "./lib/networkMetrics";
import authRoutes from "./routes/auth";
import playerPortalRoutes from "./routes/playerPortal";
import { attachPortalSession } from "./middlewares/portalAuth";
import { attachAdminSession } from "./middlewares/adminAuth";
import adminAuthRoutes from "./routes/adminAuth";
import adminServerContextRoutes from "./routes/adminServerContext";
import testDatabaseResetRoutes from "./routes/testDatabaseReset";
import { canOrganizationRole, getManagedOrganizationById, listUserOrganizationMemberships } from "./lib/organizationRegistry";
import { refreshManagedServerRegistryFromDb } from "./lib/state";

const app: Express = express();

app.use(pinoHttp({ logger, serializers: {
  req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
  res(res) { return { statusCode: res.statusCode }; },
} }));
app.set("trust proxy", 1);
app.use(cors());
app.use((req, res, next) => {
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  (res as any).write = (chunk: any, ...args: any[]) => { if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)); return (originalWrite as any)(chunk, ...args); };
  (res as any).end = (chunk?: any, ...args: any[]) => { if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)); recordNetworkTransfer({ service: "http-responses", operation: `${req.method} ${req.path || req.url.split("?")[0]}`, direction: "http-response", bytes: responseBytes, ok: res.statusCode < 500 }); return (originalEnd as any)(chunk, ...args); };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/app-assets", express.static("assets/player-portal", { etag: true, lastModified: true, maxAge: 0, setHeaders(res) { res.setHeader("Cache-Control", "no-cache"); } }));
app.use(attachPortalSession);
app.use(attachAdminSession);

// The dashboard is server-rendered and intentionally large. Keep the server
// context switcher outside that surface so adding a second linked server never
// requires duplicating the entire dashboard implementation.
app.use((req, res, next) => {
  if (!req.path.startsWith("/admin-panel") || req.path.startsWith("/admin-panel/context")) return next();
  const originalSend = res.send.bind(res);
  (res as any).send = (body: any) => {
    if (typeof body !== "string" || !body.includes("<body")) return originalSend(body);
    const switcher = `<div id="saas-server-context" style="position:fixed;top:14px;right:14px;z-index:2147483647;display:none;font-family:Inter,ui-sans-serif,system-ui,sans-serif"><label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(20,22,28,.92);backdrop-filter:blur(18px);box-shadow:0 10px 35px rgba(0,0,0,.25);font-size:12px;color:#9aa2af"><span>Servidor</span><select id="saas-server-context-select" style="border:0;outline:0;background:transparent;color:#fff;font:inherit;font-weight:800;cursor:pointer"></select></label></div><script>(async()=>{try{const r=await fetch('/admin-panel/context',{credentials:'same-origin'});if(!r.ok)return;const d=await r.json();if(!Array.isArray(d.servers)||d.servers.length<2)return;const root=document.getElementById('saas-server-context');const select=document.getElementById('saas-server-context-select');if(!root||!select)return;for(const s of d.servers){const o=document.createElement('option');o.value=s.id;o.textContent=s.name+(s.runtimeEnabled?'':' · pausado');o.selected=s.id===d.activeServerId;select.appendChild(o)}root.style.display='block';select.addEventListener('change',()=>{const returnTo=encodeURIComponent(location.pathname+location.search);location.href='/admin-panel/context/'+encodeURIComponent(select.value)+'?returnTo='+returnTo})}catch{}})();</script>`;
    return originalSend(body.replace(/<body([^>]*)>/i, `<body$1>${switcher}`));
  };
  next();
});

app.get("/", (_req, res) => { res.send("ok"); });
app.use("/api/auth", authRoutes);
app.get("/saas", (req, res, next) => {
  const serverId = String(req.query.server || "").trim();
  const discordConnected = String(req.query.discord || "") === "connected";
  if (req.portalSession && discordConnected && serverId) return res.redirect(`/admin-panel/onboarding/panel?serverId=${encodeURIComponent(serverId)}`);
  return next();
});
app.use(playerPortalRoutes);
app.use("/admin", nitradoDiagnosticRoutes);
app.use("/admin", adminRoutes);

app.post("/admin-panel/onboarding/nitrado/import", async (req, res, next) => {
  try {
    if (!req.portalSession) return next();
    const membership = listUserOrganizationMemberships(req.portalSession.discordId).find((item) => canOrganizationRole(item.role, "manage"));
    if (!membership) return next();
    const organization = getManagedOrganizationById(membership.organizationId);
    if (!organization?.active) return next();
    const serviceId = String(req.body?.serviceId || "").trim();
    if (!/^\d+$/.test(serviceId)) return next();
    const servers = await refreshManagedServerRegistryFromDb();
    const existing = servers.find((server) => server.integrations.nitradoServiceId === serviceId);
    if (!existing) return next();
    if (existing.organizationId !== organization.id) {
      return res.status(409).type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Servidor já conectado</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif}.shell{width:min(700px,calc(100% - 32px));margin:auto;padding:50px 0}.card{padding:24px;border:1px solid #292d36;border-radius:18px;background:#111318}.status{margin-top:14px;padding:12px;border-radius:11px;background:#171a20;color:#ffadb4;border:1px solid #ff727e33;line-height:1.5;font-size:12px}.actions{display:flex;gap:8px;margin-top:18px}a{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 15px;border:1px solid #343943;border-radius:10px;background:#20242b;color:#f7f7f8;font-size:12px;font-weight:850;text-decoration:none}</style></head><body><main class="shell"><section class="card"><h1>Servidor já conectado</h1><div class="status">O Nitrado Service ID ${serviceId} já está vinculado a outro workspace. Por segurança, este servidor não pode ser importado para esta organização.</div><div class="actions"><a href="/saas">Voltar ao onboarding</a></div></section></main></body></html>`);
    }
    return res.redirect(`/admin-panel/onboarding/nitrado/activate-and-continue?serverId=${encodeURIComponent(existing.id)}`);
  } catch (error) {
    return res.status(409).type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Erro no onboarding</title></head><body style="margin:0;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif"><main style="width:min(700px,calc(100% - 32px));margin:auto;padding:50px 0"><section style="padding:24px;border:1px solid #292d36;border-radius:18px;background:#111318"><h1>Não foi possível continuar</h1><p style="color:#ffadb4">${String(error instanceof Error ? error.message : error).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}</p><a href="/saas" style="color:#f7f7f8">Voltar ao onboarding</a></section></main></body></html>`);
  }
});

app.use("/admin-panel/test", testDatabaseResetRoutes);
app.use("/admin-panel", onboardingActivationCompatRoutes);
app.use("/admin-panel", saasOnboardingRoutes);
app.use("/admin-panel", adminServerContextRoutes);
app.use("/admin-panel", adminAuthRoutes);
app.use("/admin-panel", serverControlPanelRoutes);

app.use("/api/setup/nitrado", nitradoSetupRoutes);
app.use("/api/setup/nitrado", nitradoSelfServiceCompatRoutes);

app.use(router);

export default app;
