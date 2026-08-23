import crypto from "node:crypto";
import type { Request, Response } from "express";

export type AdminSession = {
  adminUserId: string;
  username: string;
  serverId: string | null;
  issuedAt: number;
  expiresAt: number;
};

const COOKIE = "adm_admin_session";
const TTL_SECONDS = 60 * 60 * 24 * 7;

function secret() {
  const value = process.env.AUTH_SESSION_SECRET || process.env.ADMIN_PANEL_TOKEN || process.env.SHOP_ADMIN_TOKEN;
  if (!value || value.length < 24) throw new Error("AUTH_SESSION_SECRET must be configured with at least 24 characters");
  return value;
}
function sign(value: string) { return crypto.createHmac("sha256", secret()).update(value).digest("base64url"); }
function encode(value: unknown) { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${payload}.${sign(payload)}`; }
function decode<T>(token: string): T | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const a = Buffer.from(signature); const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T; } catch { return null; }
}
function secure(req: Request) { return req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production"; }

export function createAdminSession(input: Pick<AdminSession, "adminUserId" | "username" | "serverId">): AdminSession {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { ...input, issuedAt, expiresAt: issuedAt + TTL_SECONDS };
}
export function setAdminSessionCookie(req: Request, res: Response, session: AdminSession) {
  res.cookie(COOKIE, encode(session), { path: "/", httpOnly: true, sameSite: "lax", secure: secure(req), maxAge: TTL_SECONDS * 1000 });
}
export function clearAdminSessionCookie(req: Request, res: Response) {
  res.clearCookie(COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: secure(req) });
}
export function readAdminSession(req: Request): AdminSession | null {
  const token = typeof req.cookies?.[COOKIE] === "string" ? req.cookies[COOKIE] : "";
  if (!token) return null;
  const value = decode<AdminSession>(token);
  if (!value?.adminUserId || !value.username || value.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return value;
}
