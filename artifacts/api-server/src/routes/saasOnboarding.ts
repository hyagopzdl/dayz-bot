import crypto from "node:crypto";
import postgres from "postgres";
import { Router, type Request, type Response } from "express";
import { requirePortalAuth } from "../middlewares/portalAuth";
import { isOrganizationSecretEncryptionConfigured, decryptEncryptedSecret, getOrganizationIntegrationRecord } from "../lib/organizationIntegrations";
import { canOrganizationRole, getManagedOrganizationById, isSaasSelfServiceEnabled, listUserOrganizationMemberships } from "../lib/organizationRegistry";
import { getManagedServerById } from "../lib/serverRegistry";
import { renderSaasOnboarding } from "./saasOnboardingView";
import { testOrganizationNitradoCredential } from "../lib/serverIntegrations";
import { createManagedServerDraft, markManagedServerNitradoValidated, refreshManagedServerRegistryFromDb, saveOrganizationNitradoCredential, setManagedServerRuntimeEnabled } from "../lib/state";
import { runManagedServerActivationPreflight } from "../lib/serverPreflight";
import { requestManagedServerRuntimeCycle } from "../lib/serverRuntimeCoordinator";
import { ensureAdminUsersSchema } from "../lib/adminUsers";
import { clearAdminSessionCookie, createAdminSession, setAdminSessionCookie } from "../auth/adminSession";

const router = Router();
const NITRADO_API = "https://api.nitrado.net";
type NitradoService = { id: number|string; status?: string; type?: string; type_human?: string; username?: string; details?: { name?: string; game?: string; slots?: number; address?: string } };

function session(req: Request) {
  if (!req.portalSession) throw new Error("AUTH_REQUIRED");
  return req.portalSession;
}

function getOrganization(req: Request) {
  const membership = listUserOrganizationMemberships(session(req).discordId).find((item) => canOrganizationRole(item.role, "manage"));
  if (!membership) throw new Error("Sua conta não possui uma organização com permissão de gerenciamento.");
  const organization = getManagedOrganizationById(membership.organizationId);
  if (!organization?.active) throw new Error("A organização selecionada está inativa.");
  return organization;
}

function assertServerManageAccess(req: Request, serverId: string) {
  const server = getManagedServerById(serverId);
  if (!server) throw new Error("SERVER_NOT_FOUND");
  const membership = listUserOrganizationMemberships(session(req).discordId).find((item) => item.organizationId === server.organizationId && canOrganizationRole(item.role, "manage"));
  if (!membership) throw new Error("SERVER_FORBIDDEN");
  const organization = getManagedOrganizationById(server.organizationId);
  if (!organization?.active) throw new Error("ORGANIZATION_FORBIDDEN");
  return server;
}

async function nitrado<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${NITRADO_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* ignore malformed error body */ }
  if (!response.ok) throw new Error(`Nitrado HTTP ${response.status}: ${String(body?.message || body?.error || "requisição recusada")}`);
  return body as T;
}

function presentService(s: NitradoService) {
  const game = String(s.details?.game || s.type_human || s.type || "").trim();
  return { id: String(s.id), name: String(s.details?.name || s.username || `Nitrado ${s.id}`).trim(), game, status: String(s.status || "unknown"), slots: Number(s.details?.slots || 0) || null, address: String(s.details?.address || "").trim() || null, dayz: /dayz/i.test(game) };
}

async function servicesFor(token: string) {
  const body = await nitrado<{ data?: { services?: NitradoService[] } }>(token, "/services");
  return Array.isArray(body?.data?.services) ? body.data.services.map(presentService) : [];
}

function inferBaseDir(gameserver: any) {
  const raw = [gameserver?.game_specific?.path, gameserver?.game_specific?.config_path, gameserver?.path].find((value) => typeof value === "string" && value.trim());
  if (!raw) return "";
  const value = String(raw).trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return /\/config$/i.test(value) ? value : /\/dayzps$/i.test(value) ? `${value}/config` : value;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function fallbackPage(title: string, body: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · ${escapeHtml(title)}</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif}.shell{width:min(760px,calc(100% - 32px));margin:auto;padding:34px 0 70px}.top{font-weight:900;margin-bottom:38px}.progress{display:flex;gap:6px;margin-bottom:30px}.progress span{height:3px;flex:1;border-radius:99px;background:#292d36}.progress span.active{background:#f3f3f4}.card{padding:22px;border:1px solid #292d36;border-radius:18px;background:#111318;box-shadow:0 20px 70px #0003}h1{font-size:36px;letter-spacing:-.04em;margin:0 0 10px}h2{font-size:19px;margin:0 0 7px}p{color:#969da9;line-height:1.6;margin:0}.services{display:grid;gap:9px;margin-top:20px}.service{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px;border:1px solid #292d36;border-radius:13px;background:#15181d}.service strong{display:block;font-size:13px}.service small{display:block;color:#969da9;font-size:10px;margin-top:4px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}button,a{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 15px;border:1px solid #343943;border-radius:10px;background:#20242b;color:#f7f7f8;font-size:12px;font-weight:850;text-decoration:none;cursor:pointer}button.primary,a.primary{background:#f2f3f5;color:#101114;border-color:#f2f3f5}.status{margin-top:14px;padding:11px 12px;border-radius:11px;background:#171a20;color:#969da9;font-size:11px;line-height:1.5}.status.error{color:#ffadb4;border:1px solid #ff727e33;background:#ff727e0f}.status.ok{color:#62e6a2;border:1px solid #62e6a233;background:#62e6a20f}.meta{margin-top:16px;padding:13px;border:1px solid #292d36;border-radius:12px;background:#15181d}.meta strong{display:block}.meta span{display:block;color:#969da9;font-size:10px;margin-top:4px}</style></head><body><main class="shell"><div class="top">Advanced DayZ Management</div>${body}</main></body></html>`;
}

router.get("/onboarding", requirePortalAuth, (req, res) => {
  res.type("html").send(renderSaasOnboarding(req.portalSession!, isSaasSelfServiceEnabled() && isOrganizationSecretEncryptionConfigured()));
});

router.post("/onboarding/nitrado/connect", requirePortalAuth, async (req, res) => {
  try {
    const organization = getOrganization(req);
    const token = String(req.body?.token || "").trim();
    if (!token) throw new Error("Cole o Long-life token antes de continuar.");
    if (token.length > 4096) throw new Error("Token Nitrado inválido.");
    await testOrganizationNitradoCredential(token);
    await saveOrganizationNitradoCredential(organization.id, token, { source: "saas-onboarding" });
    return res.redirect("/admin-panel/onboarding/nitrado/services");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).type("html").send(fallbackPage("Erro", `<section class="card"><h1>Não foi possível validar o token.</h1><div class="status error">${escapeHtml(message)}</div><div class="actions"><a href="/saas">Voltar</a></div></section>`));
  }
});

router.get("/onboarding/nitrado/services", requirePortalAuth, async (req, res) => {
  try {
    const organization = getOrganization(req);
    const record = getOrganizationIntegrationRecord(organization.id, "nitrado");
    if (!record?.active) throw new Error("Conecte sua conta Nitrado primeiro.");
    const services = (await servicesFor(decryptEncryptedSecret(record))).filter((service) => service.dayz);
    const content = `<div class="progress"><span class="active"></span><span class="active"></span><span></span></div><section class="card"><h1>Qual servidor você quer adicionar?</h1><p>Token validado. Encontramos ${services.length} servidor(es) DayZ na sua conta Nitrado.</p>${services.length ? `<div class="services">${services.map((service) => `<form class="service" method="post" action="/admin-panel/onboarding/nitrado/import"><input type="hidden" name="serviceId" value="${escapeHtml(service.id)}"><div><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml([service.game, service.status, service.slots ? `${service.slots} slots` : ""].filter(Boolean).join(" · ") || "DayZ")}</small></div><button type="submit" class="primary">Selecionar</button></form>`).join("")}</div>` : `<div class="status error">Nenhum servidor DayZ foi encontrado nesta conta Nitrado.</div>`}<div class="actions"><a href="/saas">Voltar</a></div></section>`;
    return res.type("html").send(fallbackPage("Selecionar servidor", content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).type("html").send(fallbackPage("Erro", `<section class="card"><h1>Não foi possível carregar os servidores.</h1><div class="status error">${escapeHtml(message)}</div><div class="actions"><a href="/saas">Voltar</a></div></section>`));
  }
});

router.post("/onboarding/nitrado/import", requirePortalAuth, async (req, res) => {
  try {
    const organization = getOrganization(req);
    const serviceId = String(req.body?.serviceId || "").trim();
    if (!/^\d+$/.test(serviceId)) throw new Error("Selecione um serviço Nitrado válido.");
    const record = getOrganizationIntegrationRecord(organization.id, "nitrado");
    if (!record?.active) throw new Error("Conecte sua conta Nitrado primeiro.");
    const token = decryptEncryptedSecret(record);
    const service = (await servicesFor(token)).find((item) => item.id === serviceId);
    if (!service) throw new Error("Esse serviço não pertence à conta Nitrado conectada.");
    if (!service.dayz) throw new Error("Este serviço não parece ser um servidor DayZ.");
    const detail = await nitrado<{ data?: { gameserver?: any } }>(token, `/services/${encodeURIComponent(serviceId)}/gameservers`);
    const gameserver = detail?.data?.gameserver || {};
    const baseDir = inferBaseDir(gameserver);
    const name = String(gameserver?.query?.server_name || service.name || `DayZ ${serviceId}`).trim().slice(0, 100);
    const server = await createManagedServerDraft({ organizationId: organization.id, name, nitradoServiceId: serviceId, nitradoBaseDir: baseDir || undefined });
    return res.redirect(`/admin-panel/onboarding/nitrado/next?serverId=${encodeURIComponent(server.id)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).type("html").send(fallbackPage("Erro", `<section class="card"><h1>Não foi possível adicionar o servidor.</h1><div class="status error">${escapeHtml(message)}</div><div class="actions"><a href="/admin-panel/onboarding/nitrado/services">Voltar aos servidores</a></div></section>`));
  }
});

router.get("/onboarding/nitrado/next", requirePortalAuth, (req, res) => {
  try {
    const server = assertServerManageAccess(req, String(req.query.serverId || "").trim());
    const content = `<div class="progress"><span class="active"></span><span class="active"></span><span class="active"></span></div><section class="card"><h1>Servidor conectado.</h1><p>O servidor foi importado para o ADM. Agora você pode configurar o Discord ou continuar depois.</p><div class="meta"><strong>${escapeHtml(server.name)}</strong><span>Service ID ${escapeHtml(server.integrations.nitradoServiceId || "")}</span></div><div class="actions"><a class="primary" href="/admin-panel/onboarding/discord?serverId=${encodeURIComponent(server.id)}">Configurar Discord agora</a><a href="/admin-panel/onboarding/panel?serverId=${encodeURIComponent(server.id)}">Fazer depois</a></div></section>`;
    return res.type("html").send(fallbackPage("Servidor conectado", content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(message === "SERVER_FORBIDDEN" || message === "ORGANIZATION_FORBIDDEN" ? 403 : 400).type("html").send(fallbackPage("Erro", `<section class="card"><h1>Não foi possível continuar.</h1><div class="status error">${escapeHtml(message)}</div><div class="actions"><a href="/saas">Voltar</a></div></section>`));
  }
});

router.post("/onboarding/activate", requirePortalAuth, async (req, res) => {
  try {
    const server = assertServerManageAccess(req, String(req.body?.serverId || "").trim());
    if (!server.integrations.nitradoServiceId || !server.runtime.nitradoBaseDir) throw new Error("O servidor foi importado, mas os dados Nitrado ainda não estão completos.");
    let current = server;
    if (!current.runtime.nitradoValidation || current.runtime.nitradoValidation.serviceId !== current.integrations.nitradoServiceId || current.runtime.nitradoValidation.baseDir !== current.runtime.nitradoBaseDir) {
      const validation = await (await import("../lib/serverIntegrations")).validateNitradoServiceSetup(current.id, current.integrations.nitradoServiceId, current.runtime.nitradoBaseDir);
      current = await markManagedServerNitradoValidated(current.id, validation);
    }
    if (!current.runtime.activation?.everActivated || !current.runtimeEnabled) {
      const preflight = await runManagedServerActivationPreflight(current.id);
      if (!preflight.passed) {
        const failures = preflight.checks.filter((check) => check.status === "fail").map((check) => check.message).slice(0, 3);
        throw new Error(failures.length ? failures.join(" ") : "O servidor não passou nas verificações de ativação.");
      }
      current = await setManagedServerRuntimeEnabled(current.id, true);
      requestManagedServerRuntimeCycle(current.id, "activation");
    }
    await refreshManagedServerRegistryFromDb();
    const refreshed = getManagedServerById(current.id) || current;
    return res.json({ ready: true, server: { id: refreshed.id, name: refreshed.name, serviceId: refreshed.integrations.nitradoServiceId || null, status: refreshed.onboardingStatus, runtimeEnabled: refreshed.runtimeEnabled } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(message === "SERVER_FORBIDDEN" || message === "ORGANIZATION_FORBIDDEN" ? 403 : 400).json({ message });
  }
});

router.get("/onboarding/discord", requirePortalAuth, (req, res) => {
  try {
    const server = assertServerManageAccess(req, String(req.query.serverId || "").trim());
    clearAdminSessionCookie(req, res);
    return res.redirect(`/api/auth/discord/connect?serverId=${encodeURIComponent(server.id)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(message === "SERVER_FORBIDDEN" || message === "ORGANIZATION_FORBIDDEN" ? 403 : 400).send(message);
  }
});

router.get("/onboarding/panel", requirePortalAuth, async (req, res) => {
  try {
    const server = assertServerManageAccess(req, String(req.query.serverId || "").trim());
    await ensureAdminUsersSchema();
    const db = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
    if (!db) throw new Error("DATABASE_URL não está configurado.");
    const portalId = String(req.portalSession!.discordId).trim();
    const adminUserId = `portal-${portalId}`;
    const username = `portal-${portalId}`.slice(0, 80);
    const salt = crypto.randomBytes(16).toString("hex");
    const password = crypto.randomBytes(32).toString("hex");
    const passwordHash = `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
    try {
      await db`INSERT INTO admin_users (id, username, password_hash, server_id, active) VALUES (${adminUserId}, ${username}, ${passwordHash}, ${server.id}, TRUE) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, server_id = EXCLUDED.server_id, active = TRUE, updated_at = NOW()`;
      await db`INSERT INTO admin_organization_memberships (admin_user_id, organization_id, role, created_at, updated_at) VALUES (${adminUserId}, ${server.organizationId}, 'owner', NOW(), NOW()) ON CONFLICT (admin_user_id, organization_id) DO UPDATE SET role = 'owner', updated_at = NOW()`;
      await db`INSERT INTO admin_server_access (admin_user_id, server_id, organization_id, role, created_at, updated_at) VALUES (${adminUserId}, ${server.id}, ${server.organizationId}, 'owner', NOW(), NOW()) ON CONFLICT (admin_user_id, server_id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = 'owner', updated_at = NOW()`;
    } finally { await db.end({ timeout: 5 }).catch(() => undefined); }
    setAdminSessionCookie(req, res, createAdminSession({ adminUserId, username, serverId: server.id }));
    return res.redirect("/admin-panel");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(message === "SERVER_FORBIDDEN" || message === "ORGANIZATION_FORBIDDEN" ? 403 : 400).send(message);
  }
});

export default router;
