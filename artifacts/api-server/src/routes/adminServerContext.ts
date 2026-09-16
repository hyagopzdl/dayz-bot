import { Router } from "express";
import { createAdminSession, setAdminSessionCookie } from "../auth/adminSession";
import { getAdminServerAccess } from "../lib/adminUsers";
import { getManagedServerById, listManagedServers } from "../lib/serverRegistry";

const router = Router();

/**
 * Switches the active server context for the authenticated admin session.
 * The selected server is still authorized against the admin's persisted access,
 * so changing the UI context can never grant cross-tenant access.
 */
router.get("/context", async (req, res) => {
  const session = req.adminSession;
  if (!session) return res.redirect("/admin-panel/login");

  const servers = listManagedServers().filter((server) => server.enabled);
  return res.json({
    activeServerId: session.serverId,
    servers: servers.map((server) => ({ id: server.id, name: server.name, organizationId: server.organizationId, runtimeEnabled: server.runtimeEnabled })),
  });
});

router.get("/context/:serverId", async (req, res) => {
  const session = req.adminSession;
  if (!session) return res.redirect("/admin-panel/login");

  const serverId = String(req.params.serverId || "").trim();
  const server = getManagedServerById(serverId);
  if (!server || !server.enabled) return res.status(404).send("Servidor não encontrado ou desativado.");

  const access = await getAdminServerAccess(session.adminUserId, server.id);
  if (!access || access.organizationId !== server.organizationId) {
    return res.status(403).send("Você não tem acesso a este servidor.");
  }

  setAdminSessionCookie(req, res, createAdminSession({
    adminUserId: session.adminUserId,
    username: session.username,
    serverId: server.id,
  }));

  const redirectTo = typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/admin-panel")
    ? req.query.returnTo
    : "/admin-panel";
  return res.redirect(redirectTo);
});

export default router;
