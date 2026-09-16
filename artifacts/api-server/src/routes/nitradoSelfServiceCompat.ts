import { Router, type Request, type Response } from "express";
import { readPortalSession } from "../auth/session";
import { canOrganizationRole, listUserOrganizationMemberships } from "../lib/organizationRegistry";
import { getManagedServerById } from "../lib/serverRegistry";
import { discoverOrganizationNitradoServices, validateNitradoServiceSetup } from "../lib/serverIntegrations";

const router = Router();
function session(req: Request) { const value = req.portalSession || readPortalSession(req); if (!value) throw new Error("Sessão do portal não encontrada."); return value; }
function assertPortalServerAccess(req: Request, serverId: string) {
  const server = getManagedServerById(serverId); if (!server) throw new Error("Servidor não encontrado.");
  const memberships = listUserOrganizationMemberships(session(req).discordId);
  const membership = memberships.find((m) => m.organizationId === server.organizationId && canOrganizationRole(m.role, "manage"));
  if (!membership) throw new Error("SERVER_FORBIDDEN");
  return server;
}
function fail(res: Response, error: unknown, status = 403) { return res.status(status).json({ error: error instanceof Error ? error.message : String(error) }); }

router.get("/api/servers/:serverId/nitrado/services", async (req, res) => {
  try {
    const server = assertPortalServerAccess(req, String(req.params.serverId || ""));
    const result = await discoverOrganizationNitradoServices(server.organizationId);
    return res.json(result);
  } catch (error) { return fail(res, error); }
});

router.post("/api/servers/:serverId/nitrado/validate", async (req, res) => {
  try {
    const server = assertPortalServerAccess(req, String(req.params.serverId || ""));
    const serviceId = String(req.body?.serviceId || "").trim();
    const baseDir = String(req.body?.baseDir || "").trim();
    if (!serviceId) return fail(res, new Error("Selecione um serviço Nitrado."), 400);
    const validation = await validateNitradoServiceSetup(server.id, serviceId, baseDir);
    return res.json({ validation, serverId: server.id });
  } catch (error) { return fail(res, error, 400); }
});

export default router;
