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
import { getStateAsync } from "../lib/state";

const router = Router();
const DISCORD_API = "https://discord.com/api/v10";

function publicBaseUrl(req: Request) {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function discordConfig(req: Request) {
  const clientId = process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_CLIENT_ID || "";
  const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET || "";
  const redirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI || `${publicBaseUrl(req)}/api/auth/discord/callback`;
  if (!clientId || !clientSecret) throw new Error("Discord OAuth is not configured");
  return { clientId, clientSecret, redirectUri };
}

router.get("/discord", (req, res) => {
  try {
    const { clientId, redirectUri } = discordConfig(req);
    const requestedReturnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/app";
    const { state } = createOAuthState(req, res, requestedReturnTo);
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
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
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
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) throw new Error("Discord access token missing");

    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw new Error(`Discord user request failed (${userResponse.status})`);
    const user = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
    };

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
  const state = await getStateAsync();
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  res.json({
    authenticated: true,
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
