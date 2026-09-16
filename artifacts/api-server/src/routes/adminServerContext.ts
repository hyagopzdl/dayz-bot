import { Router } from "express";
import { createAdminSession, setAdminSessionCookie } from "../auth/adminSession";
import { getAdminServerAccess, listAdminServerAccess } from "../lib/adminUsers";
import { getManagedServerById, listManagedServers } from "../lib/serverRegistry";

const router = Router();

/**
 * Returns only servers explicitly granted to the authenticated admin.
 * Organization membership alone is not enough to expose a server in the
 * selector: the server access row is the final authorization boundary.
 */
router.get("/context", async (req, res) => {
  const session = req.adminSession;
  if (!session) return res.status(401).json({ error: "ADMIN_AUTH_REQUIRED" });

  const accessRows = await listAdminServerAccess(session.adminUserId);
  const accessByServerId = new Map(accessRows.map((access) => [access.serverId, access]));
  const servers = listManagedServers().filter((server) => {
    if (!server.enabled) return false;
    const access = accessByServerId.get(server.id);
    return Boolean(access && access.organizationId === server.organizationId);
  });

  return res.json({
    activeServerId: session.serverId,
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      organizationId: server.organizationId,
      runtimeEnabled: server.runtimeEnabled,
      onboardingStatus: server.onboardingStatus,
      role: accessByServerId.get(server.id)?.role || "viewer",
    })),
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
