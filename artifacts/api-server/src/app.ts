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
import { logger } from "./lib/logger";
import { recordNetworkTransfer } from "./lib/networkMetrics";
import authRoutes from "./routes/auth";
import playerPortalRoutes from "./routes/playerPortal";
import { attachPortalSession } from "./middlewares/portalAuth";
import { attachAdminSession } from "./middlewares/adminAuth";
import adminAuthRoutes from "./routes/adminAuth";
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
app.get("/", (_req, res) => { res.send("ok"); });
app.use("/api/auth", authRoutes);
app.use(playerPortalRoutes);
app.use("/admin", nitradoDiagnosticRoutes);
app.use("/admin", adminRoutes);

// The browser can arrive here immediately after selecting a Nitrado server,
// before an admin-server session exists. Keep this page behind the Discord portal
// session, not the legacy admin-panel server binding middleware.
//
// Reconciliation guard: onboarding must reuse a service already registered for
// the same organization instead of sending it through createManagedServerDraft,
// which correctly rejects duplicate Service IDs. A service owned by another
// organization remains blocked for tenant isolation.
app.post("/admin-panel/onboarding/nitrado/import", async (req, res, next) => {
  try {
    if (!req.portalSession) return next();
    const membership = listUserOrganizationMemberships(req.portalSession.discordId)
      .find((item) => canOrganizationRole(item.role, "manage"));
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

    return res.redirect(`/admin-panel/onboarding/nitrado/next?serverId=${encodeURIComponent(existing.id)}`);
  } catch (error) {
    return res.status(409).type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Erro no onboarding</title></head><body style="margin:0;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif"><main style="width:min(700px,calc(100% - 32px));margin:auto;padding:50px 0"><section style="padding:24px;border:1px solid #292d36;border-radius:18px;background:#111318"><h1>Não foi possível continuar</h1><p style="color:#ffadb4">${String(error instanceof Error ? error.message : error).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}</p><a href="/saas" style="color:#f7f7f8">Voltar ao onboarding</a></section></main></body></html>`);
  }
});

app.use("/admin-panel", saasOnboardingRoutes);
app.use("/admin-panel", adminAuthRoutes);
app.use("/admin-panel", serverControlPanelRoutes);
app.use("/admin-panel", nitradoSetupRoutes);
app.use("/admin-panel", nitradoSelfServiceCompatRoutes);
app.use("/admin-panel", adminPanelRoutes);
app.use("/api", router);
export default app;
