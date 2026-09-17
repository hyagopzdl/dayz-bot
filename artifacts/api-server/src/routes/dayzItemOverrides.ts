import { Router, type Request, type Response } from "express";
import {
  listDayzItemImageOverrides,
  setDayzItemImageOverride,
} from "../lib/dayzItemOverridesService";

const router = Router();

function isSystemOwner(req: Request) {
  const configuredOwnerId = String(process.env.SYSTEM_OWNER_ADMIN_USER_ID || "").trim();
  return Boolean(configuredOwnerId && req.adminSession?.adminUserId === configuredOwnerId);
}

function requireAdmin(req: Request, res: Response) {
  if (!req.adminSession) {
    res.status(401).json({ error: "Admin authentication required." });
    return false;
  }
  return true;
}

function requireSystemOwner(req: Request, res: Response) {
  if (!requireAdmin(req, res)) return false;
  if (!isSystemOwner(req)) {
    res.status(403).json({ error: "System owner access required." });
    return false;
  }
  return true;
}

router.get("/shop/dayz-item-image-overrides", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!isSystemOwner(req)) {
      res.status(403).json({ error: "System owner access required." });
      return;
    }
    res.json({ overrides: await listDayzItemImageOverrides() });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put("/shop/dayz-item-image-overrides/:className", async (req, res) => {
  try {
    if (!requireSystemOwner(req, res)) return;
    const className = decodeURIComponent(String(req.params.className || "")).trim();
    const imageUrl = typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : "";
    if (!className) {
      res.status(400).json({ error: "className is required." });
      return;
    }
    if (!/^https?:\/\//i.test(imageUrl)) {
      res.status(400).json({ error: "imageUrl must be an http(s) URL." });
      return;
    }
    const saved = await setDayzItemImageOverride(className, imageUrl);
    res.json({ className, imageUrl: saved });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete("/shop/dayz-item-image-overrides/:className", async (req, res) => {
  try {
    if (!requireSystemOwner(req, res)) return;
    const className = decodeURIComponent(String(req.params.className || "")).trim();
    if (!className) {
      res.status(400).json({ error: "className is required." });
      return;
    }
    await setDayzItemImageOverride(className, null);
    res.status(204).end();
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
