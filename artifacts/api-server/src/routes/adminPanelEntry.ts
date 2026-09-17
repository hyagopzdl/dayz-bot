import { Router } from "express";
import { getManagedServerById } from "../lib/serverRegistry";

const router = Router();

// A browser that has no admin session cannot safely be associated with an
// account yet. Send it to the real admin login instead of the setup flow.
// After login, adminAuth resolves the user's persisted server access and
// creates the session with the correct serverId.
router.get("/", (req, res) => {
  const session = req.adminSession;
  if (!session) return res.redirect("/admin-panel/login");

  const serverId = String(session.serverId || "").trim();
  if (serverId && getManagedServerById(serverId)) {
    return res.redirect("/admin-panel");
  }

  return res.redirect("/admin-panel/setup");
});

export default router;
