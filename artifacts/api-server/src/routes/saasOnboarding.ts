import crypto from "node:crypto";
import postgres from "postgres";
import { Router, type Request } from "express";
import { requirePortalAuth } from "../middlewares/portalAuth";
import { isOrganizationSecretEncryptionConfigured } from "../lib/organizationIntegrations";
import { canOrganizationRole, getManagedOrganizationById, isSaasSelfServiceEnabled, listUserOrganizationMemberships } from "../lib/organizationRegistry";
import { getManagedServerById } from "../lib/serverRegistry";
import { renderSaasOnboarding } from "./saasOnboardingView";
import { testOrganizationNitradoCredential } from "../lib/serverIntegrations";
import { markManagedServerNitradoValidated, refreshManagedServerRegistryFromDb, saveOrganizationNitradoCredential, setManagedServerRuntimeEnabled } from "../lib/state";
import { runManagedServerActivationPreflight } from "../lib/serverPreflight";
import { requestManagedServerRuntimeCycle } from "../lib/serverRuntimeCoordinator";
import { ensureAdminUsersSchema } from "../lib/adminUsers";
import { clearAdminSessionCookie, createAdminSession, setAdminSessionCookie } from "../auth/adminSession";

const router = Router();

function session(req: Request) {
  if (!req.portalSession) throw new Error("AUTH_REQUIRED");
  return req.portalSession;
}

function assertServerManageAccess(req: Request, serverId: string) {
  const server = getManagedServerById(serverId);
  if (!server) throw new Error("SERVER_NOT_FOUND");
  const membership = listUserOrganizationMemberships(session(req).discordId)
    .find((item) => item.organizationId === server.organizationId && canOrganizationRole(item.role, "manage"));
  if (!membership) throw new Error("SERVER_FORBIDDEN");
  const organization = getManagedOrganizationById(server.organizationId);
  if (!organization?.active) throw new Error("ORGANIZATION_FORBIDDEN");
  return server;
}

router.get("/onboarding", requirePortalAuth, (req, res) => {
  res.type("html").send(
    renderSaasOnboarding(
      req.portalSession!,
      isSaasSelfServiceEnabled() && isOrganizationSecretEncryptionConfigured(),
    ),
  );
});

// Native HTML fallback for the Nitrado token step. The browser-side flow uses
// fetch(), but this route guarantees that clicking the button or pressing Enter
// still performs a real server-side validation if client JS fails to initialize.
router.post("/onboarding/nitrado/connect", requirePortalAuth, async (req, res) => {
  try {
    const portal = session(req);
    const membership = listUserOrganizationMemberships(portal.discordId)
      .find((item) => canOrganizationRole(item.role, "manage"));
    if (!membership) throw new Error("Sua conta não possui uma organização com permissão de gerenciamento.");
    const organization = getManagedOrganizationById(membership.organizationId);
    if (!organization?.active) throw new Error("A organização selecionada está inativa.");

    const token = String(req.body?.token || "").trim();
    if (!token) throw new Error("Cole o Long-life token antes de continuar.");
    if (token.length > 4096) throw new Error("Token Nitrado inválido.");

    await testOrganizationNitradoCredential(token);
    await saveOrganizationNitradoCredential(organization.id, token, { source: "saas-onboarding" });
    return res.redirect("/saas?connected=1");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Erro</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090a0c;color:#f7f7f8;font-family:system-ui,sans-serif}.card{width:min(520px,calc(100% - 32px));padding:24px;border:1px solid #292d36;border-radius:16px;background:#111318}.error{margin-top:14px;padding:12px;border-radius:10px;background:#2a1518;color:#ffadb4}.back{display:inline-block;margin-top:16px;color:#fff}</style></head><body><main class="card"><strong>Não foi possível validar o token.</strong><div class="error">${String(message).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}</div><a class="back" href="/saas">Voltar</a></main></body></html>`);
  }
});

router.post("/onboarding/activate", requirePortalAuth, async (req, res) => {
  try {
    const server = assertServerManageAccess(req, String(req.body?.serverId || "").trim());
    if (!server.integrations.nitradoServiceId || !server.runtime.nitradoBaseDir) {
      throw new Error("O servidor foi importado, mas os dados Nitrado ainda não estão completos.");
    }

    let current = server;
    if (!current.runtime.nitradoValidation
      || current.runtime.nitradoValidation.serviceId !== current.integrations.nitradoServiceId
      || current.runtime.nitradoValidation.baseDir !== current.runtime.nitradoBaseDir) {
      const validation = await (await import("../lib/serverIntegrations")).validateNitradoServiceSetup(
        current.id,
        current.integrations.nitradoServiceId,
        current.runtime.nitradoBaseDir,
      );
      current = await markManagedServerNitradoValidated(current.id, validation);
    }

    if (!current.runtime.activation?.everActivated || !current.runtimeEnabled) {
      const preflight = await runManagedServerActivationPreflight(current.id);
      if (!preflight.passed) {
        const failures = preflight.checks
          .filter((check) => check.status === "fail")
          .map((check) => check.message)
          .slice(0, 3);
        throw new Error(failures.length ? failures.join(" ") : "O servidor não passou nas verificações de ativação.");
      }
      current = await setManagedServerRuntimeEnabled(current.id, true);
      requestManagedServerRuntimeCycle(current.id, "activation");
    }

    await refreshManagedServerRegistryFromDb();
    const refreshed = getManagedServerById(current.id) || current;
    return res.json({
      ready: true,
      server: {
        id: refreshed.id,
        name: refreshed.name,
        serviceId: refreshed.integrations.nitradoServiceId || null,
        status: refreshed.onboardingStatus,
        runtimeEnabled: refreshed.runtimeEnabled,
      },
    });
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
      await db`
        INSERT INTO admin_users (id, username, password_hash, server_id, active)
        VALUES (${adminUserId}, ${username}, ${passwordHash}, ${server.id}, TRUE)
        ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, server_id = EXCLUDED.server_id, active = TRUE, updated_at = NOW()
      `;
      await db`
        INSERT INTO admin_organization_memberships (admin_user_id, organization_id, role, created_at, updated_at)
        VALUES (${adminUserId}, ${server.organizationId}, 'owner', NOW(), NOW())
        ON CONFLICT (admin_user_id, organization_id) DO UPDATE SET role = 'owner', updated_at = NOW()
      `;
      await db`
        INSERT INTO admin_server_access (admin_user_id, server_id, organization_id, role, created_at, updated_at)
        VALUES (${adminUserId}, ${server.id}, ${server.organizationId}, 'owner', NOW(), NOW())
        ON CONFLICT (admin_user_id, server_id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = 'owner', updated_at = NOW()
      `;
    } finally {
      await db.end({ timeout: 5 }).catch(() => undefined);
    }

    setAdminSessionCookie(req, res, createAdminSession({
      adminUserId,
      username,
      serverId: server.id,
    }));
    return res.redirect("/admin-panel");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(message === "SERVER_FORBIDDEN" || message === "ORGANIZATION_FORBIDDEN" ? 403 : 400).send(message);
  }
});

export default router;
