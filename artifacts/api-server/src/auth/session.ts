import crypto from "node:crypto";
import type { Request, Response } from "express";

export type PortalRole = "player" | "moderator" | "admin";

export type PortalSession = {
  discordId: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
  role: PortalRole;
  issuedAt: number;
  expiresAt: number;
};

const SESSION_COOKIE = "adm_portal_session";
const OAUTH_STATE_COOKIE = "adm_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const STATE_TTL_SECONDS = 10 * 60;

function requiredSessionSecret() {
  const secret = process.env.AUTH_SESSION_SECRET || process.env.ADMIN_PANEL_TOKEN || process.env.SHOP_ADMIN_TOKEN;
  if (!secret || secret.length < 24) {
    throw new Error("AUTH_SESSION_SECRET must be configured with at least 24 characters");
  }
  return secret;
}

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string) {
  return crypto.createHmac("sha256", requiredSessionSecret()).update(value).digest("base64url");
}

function encodeSignedJson(value: unknown) {
  const payload = base64Url(JSON.stringify(value));
  return `${payload}.${sign(payload)}`;
}

function decodeSignedJson<T>(token: string): T | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function isSecureRequest(req: Request) {
  return req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
}

export function resolvePortalRole(discordId: string): PortalRole {
  const adminIds = new Set(
    (process.env.DISCORD_ADMIN_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (adminIds.has(discordId)) return "admin";

  const moderatorIds = new Set(
    (process.env.DISCORD_MODERATOR_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (moderatorIds.has(discordId)) return "moderator";

  return "player";
}

export function createPortalSession(input: Omit<PortalSession, "issuedAt" | "expiresAt" | "role">): PortalSession {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    ...input,
    role: resolvePortalRole(input.discordId),
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
  };
}

export function setPortalSessionCookie(req: Request, res: Response, session: PortalSession) {
  res.cookie(SESSION_COOKIE, encodeSignedJson(session), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearPortalSessionCookie(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
  });
}

export function readPortalSession(req: Request): PortalSession | null {
  const token = typeof req.cookies?.[SESSION_COOKIE] === "string" ? req.cookies[SESSION_COOKIE] : "";
  if (!token) return null;

  const session = decodeSignedJson<PortalSession>(token);
  if (!session || !session.discordId || !session.expiresAt) return null;
  if (session.expiresAt <= Math.floor(Date.now() / 1000)) return null;

  return { ...session, role: resolvePortalRole(session.discordId) };
}

export type OAuthStateMetadata = {
  mode?: "portal-login" | "discord-install";
  serverId?: string;
  requesterDiscordId?: string;
  requesterAdminUserId?: string;
};

export function createOAuthState(
  req: Request,
  res: Response,
  returnTo: string,
  metadata: OAuthStateMetadata = {},
) {
  const state = {
    nonce: crypto.randomBytes(24).toString("base64url"),
    returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/app",
    expiresAt: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    metadata,
  };
  const token = encodeSignedJson(state);
  res.cookie(OAUTH_STATE_COOKIE, token, {
    path: "/api/auth/discord/callback",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    maxAge: STATE_TTL_SECONDS * 1000,
  });
  return { state: state.nonce, token };
}

export function consumeOAuthState(req: Request, res: Response, receivedState: string) {
  const token = typeof req.cookies?.[OAUTH_STATE_COOKIE] === "string" ? req.cookies[OAUTH_STATE_COOKIE] : "";
  res.clearCookie(OAUTH_STATE_COOKIE, {
    path: "/api/auth/discord/callback",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
  });
  if (!token) return null;

  const state = decodeSignedJson<{ nonce: string; returnTo: string; expiresAt: number; metadata?: OAuthStateMetadata }>(token);
  if (!state || state.nonce !== receivedState || state.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return state;
}

export function discordAvatarUrl(session: Pick<PortalSession, "discordId" | "avatar">) {
  if (!session.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${session.discordId}/${session.avatar}.png?size=128`;
}
