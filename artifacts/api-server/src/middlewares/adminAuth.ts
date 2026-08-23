import type { NextFunction, Request, Response } from "express";
import { readAdminSession, type AdminSession } from "../auth/adminSession";

declare global { namespace Express { interface Request { adminSession?: AdminSession; } } }
export function attachAdminSession(req: Request, _res: Response, next: NextFunction) { req.adminSession = readAdminSession(req) || undefined; next(); }
