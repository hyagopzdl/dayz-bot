import { Router, type Request } from "express";
import { requirePortalAuth } from "../middlewares/portalAuth";
import { canOrganizationRole, getManagedOrganizationById, listUserOrganizationMemberships } from "../lib/organizationRegistry";
import { getManagedServerById } from "../lib/serverRegistry";
import { markManagedServerNitradoValidated, refreshManagedServerRegistryFromDb, setManagedServerRuntimeEnabled } from "../lib/state";
import { validateNitradoServiceSetup } from "../lib/serverIntegrations";
import { runManagedServerActivationPreflight } from "../lib/serverPreflight";

const router = Router();

function getServer(req: Request) {
  if (!req.portalSession) throw new Error("AUTH_REQUIRED");
  const server = getManagedServerById(String(req.query.serverId || "").trim());
  if (!server) throw new Error("SERVER_NOT_FOUND");
  const membership = listUserOrganizationMemberships(req.portalSession.discordId)
    .find((item) => item.organizationId === server.organizationId && canOrganizationRole(item.role, "manage"));
  if (!membership) throw new Error("SERVER_FORBIDDEN");
  const organization = getManagedOrganizationById(server.organizationId);
  if (!organization?.active) throw new Error("ORGANIZATION_FORBIDDEN");
  return server;
}

router.get("/onboarding/nitrado/activate-and-continue", requirePortalAuth, async (req, res) => {
  try {
    let server = getServer(req);
    if (!server.integrations.nitradoServiceId || !server.runtime.nitradoBaseDir) {
      throw new Error("O servidor foi importado, mas os dados Nitrado ainda não estão completos.");
    }

    if (!server.runtime.nitradoValidation ||
        server.runtime.nitradoValidation.serviceId !== server.integrations.nitradoServiceId ||
        server.runtime.nitradoValidation.baseDir !== server.runtime.nitradoBaseDir) {
      const validation = await validateNitradoServiceSetup(
        server.id,
        server.integrations.nitradoServiceId,
        server.runtime.nitradoBaseDir,
      );
      server = await markManagedServerNitradoValidated(server.id, validation);
    }

    if (!server.runtime.activation?.everActivated || !server.runtimeEnabled) {
      const preflight = await runManagedServerActivationPreflight(server.id);
      if (!preflight.passed) {
        const failures = preflight.checks
          .filter((check) => check.status === "fail")
          .map((check) => check.message)
          .slice(0, 3);
        throw new Error(failures.length ? failures.join(" ") : "O servidor não passou nas verificações de ativação.");
      }
      // Enable the runtime, but do not launch an extra immediate parser/download
      // from the onboarding request. The centralized scheduler is responsible for
      // the next runtime cycle, preventing an activation-time memory/CPU spike.
      server = await setManagedServerRuntimeEnabled(server.id, true);
    }

    await refreshManagedServerRegistryFromDb();
    return res.redirect(`/admin-panel/onboarding/panel?serverId=${encodeURIComponent(server.id)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = ["SERVER_FORBIDDEN", "ORGANIZATION_FORBIDDEN"].includes(message) ? 403 : 400;
    const safe = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return res.status(status).type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Ativação</title></head><body style="margin:0;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif"><main style="width:min(700px,calc(100% - 32px));margin:auto;padding:50px 0"><section style="padding:24px;border:1px solid #292d36;border-radius:18px;background:#111318"><h1>Não foi possível ativar o servidor</h1><p style="color:#ffadb4;line-height:1.5">${safe}</p><a href="/saas" style="color:#f7f7f8">Voltar ao onboarding</a></section></main></body></html>`);
  }
});

export default router;
