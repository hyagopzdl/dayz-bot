import { Router } from "express";
import { authenticateAdminUser, assignAdminUserServer, getAdminUserById } from "../lib/adminUsers";
import { clearAdminSessionCookie, createAdminSession, setAdminSessionCookie } from "../auth/adminSession";
import { buildManagedServerId, getManagedServerById } from "../lib/serverRegistry";
import { createManagedOrganization, createManagedServerDraft, markManagedServerNitradoValidated, saveOrganizationNitradoCredential } from "../lib/state";
import { validateNitradoServiceSetup } from "../lib/serverIntegrations";

const router = Router();
const LEGACY_PANEL_COOKIE = "admin_panel_token";

function clearLegacyPanelCookie(res: any) {
  res.clearCookie(LEGACY_PANEL_COOKIE, { path: "/admin-panel", sameSite: "lax" });
  res.clearCookie(LEGACY_PANEL_COOKIE, { path: "/", sameSite: "lax" });
}

function esc(value: unknown) { const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "\'": "&#39;" }; return String(value ?? "").replace(/[&<>\"']/g, (char) => entities[char] || char); }

function shell(content: string, title = "ADM") {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{color-scheme:dark;--bg:#090a0c;--surface:#111318;--surface2:#171a20;--border:#272b33;--text:#f7f7f8;--muted:#969da9;--accent:#fff;--danger:#ff7474}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#20242c 0,#0b0c0f 42%,#07080a 100%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(460px,100%);background:rgba(17,19,24,.96);border:1px solid var(--border);border-radius:24px;padding:32px;box-shadow:0 30px 90px #0009}.brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:-.03em}.mark{width:34px;height:34px;border:1px solid #3b404a;border-radius:10px;display:grid;place-items:center;background:#191c22}.step{margin-top:32px;color:#7f8794;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1{font-size:30px;line-height:1.08;letter-spacing:-.04em;margin:10px 0 10px}p{color:var(--muted);line-height:1.55;margin:0 0 24px}.field{display:grid;gap:8px;margin:16px 0}.field label{font-size:13px;font-weight:700;color:#c9ced6}.field input{width:100%;border:1px solid #303540;background:#0d0f13;color:#fff;border-radius:12px;padding:14px 15px;font:inherit;outline:none}.field input:focus{border-color:#737b89}.button{width:100%;border:0;border-radius:12px;padding:14px 16px;margin-top:12px;background:#f5f5f5;color:#0a0b0d;font:inherit;font-weight:900;cursor:pointer}.button.secondary{background:#1b1e24;color:#fff;border:1px solid #303540;text-decoration:none;display:flex;justify-content:center}.error{margin:18px 0 0;padding:12px 14px;background:#2a1518;border:1px solid #5c252b;color:#ffb5bd;border-radius:12px;font-size:14px}.ok{margin:18px 0;padding:14px;background:#14231a;border:1px solid #285039;color:#b8efc8;border-radius:12px}.progress{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:22px 0}.progress span{height:4px;border-radius:99px;background:#2a2e36}.progress span.on{background:#f3f3f3}.server{padding:14px;border:1px solid #303540;border-radius:14px;background:#0d0f13;margin:16px 0}.server strong{display:block}.server small{color:#8d95a2}</style></head><body><div class="wrap">${content}</div></body></html>`;
}

function loginPage(error = "") {
  return shell(`<main class="card"><div class="brand"><div class="mark">A</div>Advanced DayZ Management</div><div class="step">Admin</div><h1>Entre no seu painel</h1><p>Use o acesso administrativo criado para o seu servidor.</p><form method="post" action="/admin-panel/auth/login"><div class="field"><label>Usuário</label><input name="username" autocomplete="username" required autofocus></div><div class="field"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required></div><button class="button" type="submit">Entrar</button></form>${error ? `<div class="error">${esc(error)}</div>` : ""}</main>`, "Login · ADM");
}

function setupPage(username: string, serverId: string | null, error = "", connected = false) {
  if (!serverId) return shell(`<main class="card"><div class="brand"><div class="mark">A</div>Advanced DayZ Management</div><div class="progress"><span class="on"></span><span></span></div><div class="step">Etapa 1 de 2</div><h1>Configure seu servidor</h1><p>Conecte seu servidor DayZ pela Nitrado. Vamos validar os dados antes de avançar.</p><form method="post" action="/admin-panel/setup/server"><div class="field"><label>Nome do servidor</label><input name="name" placeholder="Ex.: Meu servidor DayZ" required></div><div class="field"><label>Nitrado Service ID</label><input name="serviceId" inputmode="numeric" placeholder="12345678" required></div><div class="field"><label>Token da Nitrado</label><input name="token" type="password" autocomplete="off" required></div><div class="field"><label>Base dir <span style="color:#777">(opcional)</span></label><input name="baseDir" placeholder="Detectado automaticamente quando possível"></div><button class="button" type="submit">Validar e continuar</button></form>${error ? `<div class="error">${esc(error)}</div>` : ""}</main>`, "Configurar servidor · ADM");
  const server = getManagedServerById(serverId);
  return shell(`<main class="card"><div class="brand"><div class="mark">A</div>Advanced DayZ Management</div><div class="progress"><span class="on"></span><span class="on"></span></div><div class="step">Etapa 2 de 2</div><h1>Conecte seu Discord</h1><p>Adicione o bot à comunidade do seu servidor. O Discord será usado para a integração do servidor, não para o login do ADM.</p><div class="server"><strong>${esc(server?.name || serverId)}</strong><small>${esc(serverId)}</small></div>${connected || server?.integrations.discordGuildId ? `<div class="ok">Discord conectado com sucesso.</div><a class="button secondary" href="/admin-panel">Ir para o painel</a>` : `<a class="button secondary" href="/api/auth/discord/connect?serverId=${encodeURIComponent(serverId)}&admin=1">Conectar Discord</a>`}${error ? `<div class="error">${esc(error)}</div>` : ""}</main>`, "Conectar Discord · ADM");
}

router.get("/login", async (req, res) => {
  if (req.adminSession) {
    const serverId = req.adminSession.serverId;
    if (serverId && getManagedServerById(serverId)) {
      res.redirect("/admin-panel");
      return;
    }
    if (serverId) {
      await assignAdminUserServer(req.adminSession.adminUserId, null);
      setAdminSessionCookie(req, res, createAdminSession({ adminUserId: req.adminSession.adminUserId, username: req.adminSession.username, serverId: null }));
    }
    res.redirect("/admin-panel/setup");
    return;
  }
  res.type("html").send(loginPage(String(req.query.error || "")));
});
router.post("/auth/login", async (req, res) => {
  try {
    const user = await authenticateAdminUser(req.body?.username, req.body?.password);
    if (!user) { res.status(401).type("html").send(loginPage("Usuário ou senha inválidos.")); return; }
    clearLegacyPanelCookie(res);
    const resolvedServerId = user.serverId && getManagedServerById(user.serverId) ? user.serverId : null;
    if (user.serverId && !resolvedServerId) await assignAdminUserServer(user.id, null);
    setAdminSessionCookie(req, res, createAdminSession({ adminUserId: user.id, username: user.username, serverId: resolvedServerId }));
    res.redirect(resolvedServerId ? "/admin-panel" : "/admin-panel/setup");
  } catch (error) { res.status(503).type("html").send(loginPage(error instanceof Error ? error.message : String(error))); }
});
router.post("/auth/logout", (req, res) => { clearAdminSessionCookie(req, res); clearLegacyPanelCookie(res); res.redirect("/admin-panel/login"); });
router.get("/setup", async (req, res) => {
  if (!req.adminSession) { res.redirect("/admin-panel/login"); return; }
  let fresh = await getAdminUserById(req.adminSession.adminUserId);
  if (!fresh) { clearAdminSessionCookie(req, res); res.redirect("/admin-panel/login"); return; }
  if (fresh.serverId && !getManagedServerById(fresh.serverId)) {
    fresh = await assignAdminUserServer(fresh.id, null);
    if (!fresh) { clearAdminSessionCookie(req, res); res.redirect("/admin-panel/login"); return; }
  }
  if (fresh.serverId !== req.adminSession.serverId) setAdminSessionCookie(req, res, createAdminSession({ adminUserId: fresh.id, username: fresh.username, serverId: fresh.serverId }));
  res.type("html").send(setupPage(fresh.username, fresh.serverId, String(req.query.error || ""), req.query.discord === "connected"));
});
router.post("/setup/server", async (req, res) => {
  if (!req.adminSession) { res.redirect("/admin-panel/login"); return; }
  try {
    const name = String(req.body?.name || "").trim();
    const serviceId = String(req.body?.serviceId || "").trim();
    const token = String(req.body?.token || "").trim();
    const requestedId = buildManagedServerId(name);
    if (!name || !serviceId || !token || !requestedId) throw new Error("Preencha nome, Service ID e token da Nitrado.");
    const organizationId = `org-${buildManagedServerId(req.adminSession.username)}`;
    try { await createManagedOrganization({ id: organizationId, name: `${name} Workspace` }); } catch (error) { if (!/ja existe/i.test(String((error as Error)?.message || error))) throw error; }
    await saveOrganizationNitradoCredential(organizationId, token, { source: "admin-onboarding" });
    let server = getManagedServerById(requestedId);
    if (!server) server = await createManagedServerDraft({ id: requestedId, name, organizationId, nitradoServiceId: serviceId, nitradoBaseDir: String(req.body?.baseDir || "").trim() || undefined });
    if (!server || server.organizationId !== organizationId) throw new Error("Este Server ID já pertence a outro workspace.");
    const validation = await validateNitradoServiceSetup(server.id, serviceId, req.body?.baseDir);
    await markManagedServerNitradoValidated(server.id, validation);
    const updated = await assignAdminUserServer(req.adminSession.adminUserId, server.id);
    if (!updated) throw new Error("Não foi possível vincular o admin ao servidor.");
    setAdminSessionCookie(req, res, createAdminSession({ adminUserId: updated.id, username: updated.username, serverId: updated.serverId }));
    res.redirect("/admin-panel/setup");
  } catch (error) { res.status(400).type("html").send(setupPage(req.adminSession.username, null, error instanceof Error ? error.message : String(error))); }
});

export default router;
