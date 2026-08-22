import type { NextFunction, Request, Response } from "express";
import {
  getPrimaryServerId,
  listExecutableManagedServers,
  setServerRuntimeIsolationStatus,
  type ManagedServerDescriptor,
} from "./serverRegistry";
import { runInServerRuntimeContext } from "./serverRuntime";

const PLAYER_SERVER_COOKIE = "adm_player_server";
const PLAYER_SERVER_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let contextResolutions = 0;
let contextSwitches = 0;
let invalidSelections = 0;

function publicServer(server: ManagedServerDescriptor) {
  return {
    id: server.id,
    name: server.name,
    primary: server.primary,
    runtimeEnabled: server.runtimeEnabled,
    onboardingStatus: server.onboardingStatus,
  };
}

export type PlayerPortalServerContext = {
  selectedServer: ReturnType<typeof publicServer>;
  servers: ReturnType<typeof publicServer>[];
  requestedServerId?: string;
  fellBackToPrimary: boolean;
};

function requestedServerId(req: Request) {
  const queryValue = typeof req.query.server === "string" ? req.query.server : undefined;
  const headerValue = typeof req.headers["x-adm-server-id"] === "string"
    ? req.headers["x-adm-server-id"]
    : undefined;
  const cookieValue = typeof req.cookies?.[PLAYER_SERVER_COOKIE] === "string"
    ? req.cookies[PLAYER_SERVER_COOKIE]
    : undefined;
  return String(queryValue || headerValue || cookieValue || "").trim() || undefined;
}

export function listPlayerPortalServers() {
  return listExecutableManagedServers().map(publicServer);
}

export function resolvePlayerPortalServerContext(req: Request): PlayerPortalServerContext {
  const servers = listPlayerPortalServers();
  const primaryId = getPrimaryServerId();
  const requested = requestedServerId(req);
  const selected = (requested ? servers.find((server) => server.id === requested) : undefined)
    || servers.find((server) => server.id === primaryId)
    || servers[0];

  if (!selected) {
    throw new Error("No executable server is available for the Player Portal.");
  }

  const fellBackToPrimary = Boolean(requested && requested !== selected.id);
  contextResolutions += 1;
  if (fellBackToPrimary) invalidSelections += 1;

  return {
    selectedServer: selected,
    servers,
    requestedServerId: requested,
    fellBackToPrimary,
  };
}

function setSelectedServerCookie(req: Request, res: Response, serverId: string) {
  res.cookie(PLAYER_SERVER_COOKIE, serverId, {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(req.secure),
    path: "/",
    maxAge: PLAYER_SERVER_COOKIE_MAX_AGE_MS,
  });
}

export function setPlayerPortalServerSelection(req: Request, res: Response, serverIdInput: unknown) {
  const serverId = String(serverIdInput || "").trim();
  const server = listExecutableManagedServers().find((candidate) => candidate.id === serverId);
  if (!server) {
    throw new Error("This server is not currently available in the Player Portal.");
  }
  setSelectedServerCookie(req, res, server.id);
  contextSwitches += 1;
  return publicServer(server);
}

export function getPlayerPortalServerContext(res: Response): PlayerPortalServerContext {
  const context = res.locals.playerPortalServerContext as PlayerPortalServerContext | undefined;
  if (!context) throw new Error("Player Portal server context was not initialized.");
  return context;
}

export function playerPortalServerContextMiddleware(req: Request, res: Response, next: NextFunction) {
  let context: PlayerPortalServerContext;
  try {
    context = resolvePlayerPortalServerContext(req);
  } catch (error) {
    next(error);
    return;
  }

  res.locals.playerPortalServerContext = context;
  if (context.fellBackToPrimary || req.cookies?.[PLAYER_SERVER_COOKIE] !== context.selectedServer.id) {
    setSelectedServerCookie(req, res, context.selectedServer.id);
  }

  setServerRuntimeIsolationStatus({ playerPortalContextNamespaced: true });
  runInServerRuntimeContext(context.selectedServer.id, next);
}

export function getPlayerPortalContextDiagnostics() {
  return {
    enabled: true,
    cookie: PLAYER_SERVER_COOKIE,
    executableServers: listPlayerPortalServers().length,
    contextResolutions,
    contextSwitches,
    invalidSelections,
    policy: "active-runtime-only",
  };
}
