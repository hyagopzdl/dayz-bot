import type { NextFunction, Request, Response } from "express";
import {
  getPrimaryServerDescriptor,
  getPrimaryServerId,
  listExecutableManagedServers,
  listManagedServers,
  setServerRuntimeIsolationStatus,
  type ManagedServerDescriptor,
} from "./serverRegistry";
import { runInServerDataContext } from "./serverRuntime";

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

export function listPlayerPortalServers(organizationId = getPrimaryServerDescriptor().organizationId) {
  // Phase 16 keeps discovery tenant-scoped. A player enters another tenant only
  // through an explicit server entrypoint (?server=<id>); once inside, the
  // switcher lists only active servers owned by that same organization.
  return listManagedServers()
    .filter((server) => server.enabled && server.organizationId === organizationId)
    .map(publicServer);
}

export function resolvePlayerPortalServerContext(req: Request): PlayerPortalServerContext {
  const available = listManagedServers().filter((server) => server.enabled);
  const primaryId = getPrimaryServerId();
  const requested = requestedServerId(req);
  const requestedDescriptor = requested ? available.find((server) => server.id === requested) : undefined;
  if (requested && !requestedDescriptor) {
    invalidSelections += 1;
    throw new Error("PLAYER_PORTAL_SERVER_NOT_FOUND");
  }
  const seed = requestedDescriptor
    || available.find((server) => server.id === primaryId)
    || available[0];

  if (!seed) {
    throw new Error("No managed server is available for the Player Portal.");
  }

  const servers = listPlayerPortalServers(seed.organizationId);
  const selected = servers.find((server) => server.id === seed.id) || servers[0];
  if (!selected) {
    throw new Error("No executable server is available for this organization.");
  }

  const fellBackToPrimary = false;
  contextResolutions += 1;

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
  const currentContext = getPlayerPortalServerContext(res);
  const currentDescriptor = listManagedServers().find((candidate) => candidate.enabled && candidate.id === currentContext.selectedServer.id);
  const server = listManagedServers().find((candidate) => candidate.enabled && candidate.id === serverId);
  if (!server || !currentDescriptor || server.organizationId !== currentDescriptor.organizationId) {
    throw new Error("This server is not available in the current organization portal.");
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
  runInServerDataContext(context.selectedServer.id, next);
}

export function getPlayerPortalContextDiagnostics() {
  return {
    enabled: true,
    cookie: PLAYER_SERVER_COOKIE,
    executableServers: listExecutableManagedServers().length,
    primaryOrganizationServers: listPlayerPortalServers().length,
    contextResolutions,
    contextSwitches,
    invalidSelections,
    policy: "explicit-server-entrypoint+same-organization-switcher+invalid-server-fail-closed",
    organizationId: getPrimaryServerDescriptor().organizationId,
  };
}
