import type { NextFunction, Request, Response } from "express";
import { readPortalSession, type PortalRole, type PortalSession } from "../auth/session";

declare global {
  namespace Express {
    interface Request {
      portalSession?: PortalSession;
    }
  }
}

export function attachPortalSession(req: Request, _res: Response, next: NextFunction) {
  req.portalSession = readPortalSession(req) || undefined;
  next();
}

export function requirePortalAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.portalSession) {
    if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) {
      res.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl || "/app")}`);
    return;
  }
  next();
}

export function requirePortalRole(...roles: PortalRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.portalSession) {
      res.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    if (!roles.includes(req.portalSession.role)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    next();
  };
}
