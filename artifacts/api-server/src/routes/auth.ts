import { Router, type Request } from "express";
import {
  clearPortalSessionCookie,
  consumeOAuthState,
  createOAuthState,
  createPortalSession,
  discordAvatarUrl,
  setPortalSessionCookie,
} from "../auth/session";
import { getPlayerLinkByDiscordId } from "../lib/playerLinks";
import { logger } from "../lib/logger";
import { bindManagedServerDiscordGuild, getStateAsync } from "../lib/state";
import { byteLengthOfBody, recordNetworkTransfer } from "../lib/networkMetrics";
import { canOrganizationRole, getUserOrganizationMembership } from "../lib/organizationRegistry";
import { getManagedServerById } from "../lib/serverRegistry";
import { runInServerDataContext } from "../lib/serverRuntime";
import { getAdminServerAccess } from "../lib/adminUsers";
import { getDiscordClient, syncDiscordCommandsForManagedServer } from "../lib/discordBot";

const router = Router();
const DISCORD_API = "https://discord.com/api/v10";

function publicBaseUrl(req: Request) {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

async function trackedDiscordOAuthFetch(url: string, init: RequestInit = {}) {
  const outboundBytes = byteLengthOfBody(init.body);
  try {
    const response = await globalThis.fetch(url, init);
    recordNetworkTransfer({
      service: "discord-oauth",
      operation: `${String(init.method || "GET").toUpperCase()} ${new URL(url).pathname}`,
      direction: "outbound",
      bytes: outboundBytes,
      ok: response.ok,
    });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 0) {
      recordNetworkTransfer({
        service: "discord-oauth",
        operation: `${String(init.method || "GET").toUpperCase()} ${new URL(url).pathname}`,
        direction: "inbound",
        bytes: contentLength,
        ok: response.ok,
      });
    }
    return response;
  } catch (error) {
    recordNetworkTransfer({
      service: "discord-oauth",
      operation: `${String(init.method || "GET").toUpperCase()} ${new URL(url).pathname}`,
      direction: "outbound",
      bytes: outboundBytes,
      ok: false,
    });
    throw error;
  }
}

function discordConfig(req: Request) {
  const clientId = process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_CLIENT_ID || "";
  const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET || "";
  const redirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI || `${publicBaseUrl(req)}/api/auth/discord/callback`;
  if (!clientId || !clientSecret) throw new Error("Discord OAuth is not configured");
  return { clientId, clientSecret, redirectUri };
}

const DISCORD_INSTALL_PERMISSIONS = "117760"; // ViewChannel + SendMessages + EmbedLinks + AttachFiles + ReadMessageHistory

function canManageDiscordGuild(guild: { owner?: boolean; permissions?: string }) {
  if (guild.owner) return true;
  try {
    const permissions = BigInt(String(guild.permissions || "0"));
    const ADMINISTRATOR = 1n << 3n;
    const MANAGE_GUILD = 1n << 5n;
    return (permissions & ADMINISTRATOR) !== 0n || (permissions & MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

async function assertServerManageAccess(req: Request, serverId: string) {
  const server = getManagedServerById(serverId);
  if (!server) throw new Error("SERVER_NOT_FOUND");

  if (req.adminSession) {
    if (!req.adminSession.serverId || req.adminSession.serverId !== server.id) throw new Error("SERVER_FORBIDDEN");
    const access = await getAdminServerAccess(req.adminSession.adminUserId, server.id);
    if (!access || access.organizationId !== server.organizationId) throw new Error("SERVER_FORBIDDEN");
    return { session: req.portalSession || null, adminSession: req.adminSession, server };
  }

  const session = req.portalSession;
  if (!session) throw new Error("AUTH_REQUIRED");
  const membership = getUserOrganizationMembership(session.discordId, server.organizationId);
  if (!membership || !canOrganizationRole(membership.role, "manage")) throw new Error("ORGANIZATION_FORBIDDEN");
  return { session, adminSession: null, server };
}

async function fetchInstallingUserGuilds(accessToken: string) {
  const response = await trackedDiscordOAuthFetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Discord guild permission request failed (${response.status})`);
  return await response.json() as Array<{ id: string; name: string; owner?: boolean; permissions?: string }>;
}

async function confirmBotJoinedGuild(guildId: string) {
  const client = getDiscordClient();
  if (!client.isReady()) throw new Error("Discord bot is still starting. Try connecting again in a few seconds.");
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`ADM bot was not found in the authorized Discord guild (${String((lastError as Error)?.message || lastError)}).`);
}

router.get("/discord", (req, res) => {
  try {
    const { clientId, redirectUri } = discordConfig(req);
    const requestedReturnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/app";
    const { state } = createOAuthState(req, res, requestedReturnTo, { mode: "portal-login" });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  } catch (error) {
    logger.error({ error }, "Discord OAuth start failed");
    res.status(503).send("Discord login is not configured yet.");
  }
});

router.get("/discord/connect", async (req, res) => {
  try {
    const serverId = String(req.query.serverId || "").trim();
    const { session, adminSession, server } = await assertServerManageAccess(req, serverId);
    const { clientId, redirectUri } = discordConfig(req);
    const returnTo = adminSession ? "/admin-panel/setup" : `/saas?server=${encodeURIComponent(server.id)}`;
    const { state } = createOAuthState(req, res, returnTo, {
      mode: "discord-install",
      serverId: server.id,
      requesterDiscordId: session?.discordId,
      requesterAdminUserId: adminSession?.adminUserId,
    });

    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "bot applications.commands identify guilds");
    url.searchParams.set("permissions", DISCORD_INSTALL_PERMISSIONS);
    url.searchParams.set("integration_type", "0");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  } catch (error) {
    logger.error({ error }, "Discord install start failed");
    const message = error instanceof Error ? error.message : String(error);
    if (message === "AUTH_REQUIRED") { res.redirect("/login?returnTo=/saas"); return; }
    if (message === "SERVER_FORBIDDEN") { res.status(403).send(message); return; }
    res.status(message === "ORGANIZATION_FORBIDDEN" ? 403 : 400).send(message);
  }
});

router.get("/discord/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const receivedState = typeof req.query.state === "string" ? req.query.state : "";
  const oauthState = consumeOAuthState(req, res, receivedState);
  if (!code || !oauthState) {
    res.redirect("/login?error=invalid_oauth_state");
    return;
  }

  try {
    const { clientId, clientSecret, redirectUri } = discordConfig(req);
    const tokenResponse = await trackedDiscordOAuthFetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status})`);
    const token = (await tokenResponse.json()) as {
      access_token?: string;
      scope?: string;
      guild?: { id?: string; name?: string };
    };
    if (!token.access_token) throw new Error("Discord access token missing");

    const userResponse = await trackedDiscordOAuthFetch(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw new Error(`Discord user request failed (${userResponse.status})`);
    const user = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
    };

    if (oauthState.metadata?.mode === "discord-install") {
      const serverId = String(oauthState.metadata.serverId || "").trim();
      const requesterDiscordId = String(oauthState.metadata.requesterDiscordId || "").trim();
      const requesterAdminUserId = String(oauthState.metadata.requesterAdminUserId || "").trim();
      if (!serverId) throw new Error("Missing server context for Discord installation.");
      if (requesterAdminUserId) {
        if (!req.adminSession || req.adminSession.adminUserId !== requesterAdminUserId) {
          throw new Error("ADM admin session does not match the Discord installation request.");
        }
      } else if (!requesterDiscordId || user.id !== requesterDiscordId || req.portalSession?.discordId !== requesterDiscordId) {
        throw new Error("Discord installer identity does not match the signed-in ADM owner/admin.");
      }

      const { server, adminSession } = await assertServerManageAccess(req, serverId);
      const callbackGuildId = typeof req.query.guild_id === "string" ? req.query.guild_id : "";
      const guildId = String(token.guild?.id || callbackGuildId || "").trim();
      if (!guildId) throw new Error("Discord did not return the guild selected during bot authorization.");
      if (callbackGuildId && token.guild?.id && callbackGuildId !== token.guild.id) {
        throw new Error("Discord guild authorization mismatch.");
      }

      const userGuilds = await fetchInstallingUserGuilds(token.access_token);
      const installingGuild = userGuilds.find((guild) => guild.id === guildId);
      if (!installingGuild || !canManageDiscordGuild(installingGuild)) {
        throw new Error("You must own the Discord server or have Manage Server permission to connect it to ADM.");
      }

      const botGuild = await confirmBotJoinedGuild(guildId);
      const bound = await bindManagedServerDiscordGuild(server.id, guildId);
      if (!bound) throw new Error("Unable to persist the Discord server binding.");
      await syncDiscordCommandsForManagedServer(server.id);

      logger.info({ serverId: server.id, guildId, guildName: botGuild.name, discordId: user.id }, "Discord guild connected to managed server");
      res.redirect(adminSession ? "/admin-panel/setup?discord=connected" : `/saas?server=${encodeURIComponent(server.id)}&discord=connected`);
      return;
    }

    setPortalSessionCookie(
      req,
      res,
      createPortalSession({
        discordId: user.id,
        username: user.username,
        globalName: user.global_name || null,
        avatar: user.avatar || null,
      }),
    );
    res.redirect(oauthState.returnTo || "/app");
  } catch (error) {
    logger.error({ error }, "Discord OAuth callback failed");
    if (oauthState.metadata?.mode === "discord-install") {
      const serverId = String(oauthState.metadata.serverId || "").trim();
      if (oauthState.metadata.requesterAdminUserId) {
        res.redirect(`/admin-panel/setup?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
      } else {
        const suffix = serverId ? `&server=${encodeURIComponent(serverId)}` : "";
        res.redirect(`/saas?discord=error${suffix}`);
      }
      return;
    }
    res.redirect("/login?error=discord_oauth_failed");
  }
});

router.post("/logout", (req, res) => {
  clearPortalSessionCookie(req, res);
  res.status(204).end();
});

router.get("/me", async (req, res) => {
  const session = req.portalSession;
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  const requestedServerId = String(req.query.serverId || req.headers["x-adm-server-id"] || "").trim();
  const server = requestedServerId ? getManagedServerById(requestedServerId) : undefined;
  const link = server
    ? await runInServerDataContext(server.id, async () => getPlayerLinkByDiscordId(await getStateAsync(), session.discordId))
    : undefined;
  res.json({
    authenticated: true,
    serverId: server?.id || null,
    user: {
      discordId: session.discordId,
      username: session.username,
      displayName: session.globalName || session.username,
      avatarUrl: discordAvatarUrl(session),
      role: session.role,
      gamertag: link?.gamertag || null,
      linked: Boolean(link),
    },
  });
});

export default router;
