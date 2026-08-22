import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { discordAvatarUrl, type PortalSession } from "../auth/session";
import { getOrCreateWalletForLink } from "../lib/economy";
import { buildPlayerDashboard } from "../lib/playerPortalDashboard";
import { buildPlayerProfile, buildPublicPlayerProfile } from "../lib/playerProfile";
import { buildPlayerKillFeed } from "../lib/playerKillFeed";
import { addPlayerAlt, buildPlayerAccountsDashboard, getPlayerAccountGamertags, removePlayerAlt, setMainPlayerAccount } from "../lib/playerAccounts";
import { buildPlayerRankings } from "../lib/playerRankings";
import {
  buildPlayerClanDashboard,
  createClan,
  disbandClan,
  inviteClanMember,
  leaveClan,
  removeClanMember,
  respondToClanInvite,
  setClanMemberRole,
  transferClanOwnership,
  updateClan,
} from "../lib/playerClans";
import {
  buildPlayerPurchases,
  buildPlayerShopCatalog,
  buildPlayerShopCategory,
  buildPlayerShopItem,
  confirmPlayerShopCheckout,
  createPlayerShopCheckout,
  getPlayerShopCheckout,
} from "../lib/playerShop";
import { findKnownGamertag, getPlayerLinkByDiscordId, linkPlayerToGamertag } from "../lib/playerLinks";
import { getStateAsync, saveStateAsync, type AppState } from "../lib/state";
import { isShopServiceEnabled } from "../lib/serviceSettings";
import { requirePortalAuth } from "../middlewares/portalAuth";
import { renderPlayerPortal } from "./playerPortalView";
import { getPrimaryServerDescriptor, getPrimaryServerId } from "../lib/serverRegistry";
import { getActiveServerId, runInServerRuntimeContext } from "../lib/serverRuntime";
import {
  getPlayerPortalServerContext,
  playerPortalServerContextMiddleware,
  setPlayerPortalServerSelection,
} from "../lib/playerPortalServerContext";

const router = Router();

function sendApiError(res: any, error: unknown, status = 400) {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

function getRouteParam(value: string | string[] | undefined, name: string): string {
  const param = Array.isArray(value) ? value[0] : value;
  if (!param) throw new Error(`Missing route parameter: ${name}`);
  return param;
}

async function getPrimaryIdentityImportOptions(state: AppState, session: PortalSession) {
  const selectedServerId = getActiveServerId();
  const primaryServerId = getPrimaryServerId();
  if (selectedServerId === primaryServerId) return null;

  const primaryState = await runInServerRuntimeContext(primaryServerId, () => getStateAsync());
  const primaryLink = getPlayerLinkByDiscordId(primaryState, session.discordId);
  if (!primaryLink) return null;

  const candidates = (getPlayerAccountGamertags(primaryState, session.discordId) as string[])
    .map((gamertag) => findKnownGamertag(state, gamertag))
    .filter((gamertag): gamertag is string => Boolean(gamertag));

  return {
    sourceServer: { id: primaryServerId, name: getPrimaryServerDescriptor().name },
    candidates: Array.from(new Set(candidates)),
  };
}

router.get("/login", (req, res) => {
  if (req.portalSession) {
    res.redirect("/app");
    return;
  }

  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/app";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PZ Deathmatch</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090b;color:#fff;font-family:Inter,system-ui,sans-serif}.card{width:min(420px,calc(100% - 32px));padding:32px;border:1px solid #272a31;border-radius:20px;background:#111318;box-shadow:0 24px 80px #0008}.eyebrow{color:#8c93a3;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}h1{font-size:32px;line-height:1.05;margin:12px 0}p{color:#aeb4c0;line-height:1.55}.button{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:24px;padding:14px 18px;border-radius:12px;background:#5865f2;color:#fff;text-decoration:none;font-weight:800}.error{margin-top:16px;padding:12px;border-radius:10px;background:#39191d;color:#ffb4bd;font-size:14px}</style></head><body><main class="card"><div class="eyebrow">PZ Deathmatch</div><h1>Player Portal</h1><p>Sign in with Discord to access your profile, statistics, coins and purchases.</p><a class="button" href="/api/auth/discord?returnTo=${encodeURIComponent(returnTo)}">Continue with Discord</a>${error ? `<div class="error">Login failed. Please try again.</div>` : ""}</main></body></html>`);
});

// Phase 13 overrides the app-level primary context only for the Player Portal.
// Admin/map-event routes stay pinned to the primary until their own write paths
// are explicitly made multi-server safe.
router.use((req: Request, res: Response, next: NextFunction) => {
  const isPlayerPortalPath = req.path === "/app"
    || req.path.startsWith("/app/")
    || req.path === "/api/player"
    || req.path.startsWith("/api/player/");
  if (!isPlayerPortalPath) {
    next();
    return;
  }
  playerPortalServerContextMiddleware(req, res, next);
});

router.get(["/app", "/app/profile", "/app/players/:gamertag", "/app/rankings", "/app/killfeed", "/app/accounts", "/app/clan", "/app/shop", "/app/shop/category/:categoryId", "/app/shop/item/:itemId", "/app/purchases"], requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  const shopEnabled = isShopServiceEnabled(state);
  if (!shopEnabled && (req.path.startsWith("/app/shop") || req.path.startsWith("/app/purchases"))) {
    res.redirect("/app");
    return;
  }
  const view = req.path.startsWith("/app/players/") ? "public-profile" : req.path.startsWith("/app/profile") ? "profile" : req.path.startsWith("/app/rankings") ? "rankings" : req.path.startsWith("/app/killfeed") ? "killfeed" : req.path.startsWith("/app/accounts") ? "accounts" : req.path.startsWith("/app/clan") ? "clan" : req.path.startsWith("/app/purchases") ? "purchases" : req.path.startsWith("/app/shop") ? "shop" : "dashboard";
  res.type("html").send(renderPlayerPortal(req.portalSession!, view, {
    shopEnabled,
    serverContext: getPlayerPortalServerContext(res),
  }));
});

router.get("/api/player/server-context", requirePortalAuth, async (_req: Request, res: Response) => {
  res.json(getPlayerPortalServerContext(res));
});

router.post("/api/player/server-context", requirePortalAuth, async (req: Request, res: Response) => {
  try {
    const selectedServer = setPlayerPortalServerSelection(req, res, req.body?.serverId);
    res.json({ selectedServer });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.get("/api/player/dashboard", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json(buildPlayerDashboard(state, req.portalSession!));
});

router.get("/api/player/profile", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json(buildPlayerProfile(state, req.portalSession!));
});

router.get("/api/player/profiles/:gamertag", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  const profile = buildPublicPlayerProfile(state, getRouteParam(req.params.gamertag, "gamertag"));
  if (!profile) {
    res.status(404).json({ error: "Player not found." });
    return;
  }
  res.json(profile);
});


router.get("/api/player/accounts", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  const dashboard = buildPlayerAccountsDashboard(state, req.portalSession!);
  const primaryIdentityImport = dashboard.linked
    ? null
    : await getPrimaryIdentityImportOptions(state, req.portalSession!);
  res.json({
    ...dashboard,
    primaryIdentityImport,
    serverContext: getPlayerPortalServerContext(res),
  });
});

router.post("/api/player/accounts/import-primary", requirePortalAuth, async (req: Request, res: Response) => {
  try {
    const state = await getStateAsync();
    if (getActiveServerId() === getPrimaryServerId()) {
      throw new Error("Primary identity import is only available on secondary servers.");
    }

    const importOptions = await getPrimaryIdentityImportOptions(state, req.portalSession!);
    const requested = String(req.body?.gamertag || "").trim();
    const candidate = importOptions?.candidates.find((gamertag) => gamertag.toLowerCase() === requested.toLowerCase())
      || (!requested ? importOptions?.candidates[0] : undefined);
    if (!candidate) {
      throw new Error("No verified primary-server gamertag is available on this server yet.");
    }

    const result = linkPlayerToGamertag({
      state,
      discordId: req.portalSession!.discordId,
      gamertag: candidate,
    });
    if (!result.ok) {
      throw new Error(result.reason === "GAMERTAG_ALREADY_LINKED"
        ? "That gamertag is already linked to another Discord account on this server."
        : "Unable to link that gamertag on this server.");
    }

    await saveStateAsync(state, `player-portal:import-primary-identity:${getActiveServerId()}`);
    res.status(201).json({ gamertag: result.link.gamertag });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.post("/api/player/accounts/alts", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const gamertag = addPlayerAlt(state, req.portalSession!, req.body?.gamertag);
    await saveStateAsync(state, "player-portal:alt-add");
    res.status(201).json({ gamertag });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.delete("/api/player/accounts/alts/:gamertag", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const gamertag = removePlayerAlt(state, req.portalSession!, getRouteParam(req.params.gamertag, "gamertag"));
    await saveStateAsync(state, "player-portal:alt-remove");
    res.json({ gamertag });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.post("/api/player/accounts/main", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const gamertag = setMainPlayerAccount(state, req.portalSession!, req.body?.gamertag);
    await saveStateAsync(state, "player-portal:main-account");
    res.json({ gamertag });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.get("/api/player/killfeed", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json(buildPlayerKillFeed(state, req.query.limit));
});

router.get("/api/player/rankings", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json(buildPlayerRankings(state, req.portalSession!, {
    scope: req.query.scope,
    period: req.query.period,
    category: req.query.category,
    page: req.query.page,
    pageSize: req.query.pageSize,
  }));
});

router.get("/api/player/clan", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json(buildPlayerClanDashboard(state, req.portalSession!));
});

router.post("/api/player/clan", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const clan = createClan(state, req.portalSession!, req.body || {});
    await saveStateAsync(state, "player-portal:clan-create");
    res.status(201).json({ clan });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.patch("/api/player/clan", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const clan = updateClan(state, req.portalSession!, req.body || {});
    await saveStateAsync(state, "player-portal:clan-update");
    res.json({ clan });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.post("/api/player/clan/invites", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const invite = inviteClanMember(state, req.portalSession!, req.body?.gamertag);
    await saveStateAsync(state, "player-portal:clan-invite");
    res.status(201).json({ invite });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.post("/api/player/clan/invites/:inviteId/respond", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const result = respondToClanInvite(state, req.portalSession!, getRouteParam(req.params.inviteId, "inviteId"), Boolean(req.body?.accept));
    await saveStateAsync(state, "player-portal:clan-invite-response");
    res.json(result);
  } catch (error) {
    sendApiError(res, error);
  }
});

router.patch("/api/player/clan/members/:discordId", requirePortalAuth, async (req, res) => {
  try {
    const role = req.body?.role === "officer" ? "officer" : "member";
    const state = await getStateAsync();
    const clan = setClanMemberRole(state, req.portalSession!, getRouteParam(req.params.discordId, "discordId"), role);
    await saveStateAsync(state, "player-portal:clan-role");
    res.json({ clan });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.delete("/api/player/clan/members/:discordId", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const clan = removeClanMember(state, req.portalSession!, getRouteParam(req.params.discordId, "discordId"));
    await saveStateAsync(state, "player-portal:clan-remove");
    res.json({ clan });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.post("/api/player/clan/leave", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const result = leaveClan(state, req.portalSession!);
    await saveStateAsync(state, "player-portal:clan-leave");
    res.json(result);
  } catch (error) {
    sendApiError(res, error);
  }
});

router.post("/api/player/clan/transfer", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const clan = transferClanOwnership(state, req.portalSession!, String(req.body?.discordId || ""));
    await saveStateAsync(state, "player-portal:clan-transfer");
    res.json({ clan });
  } catch (error) {
    sendApiError(res, error);
  }
});

router.delete("/api/player/clan", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    const result = disbandClan(state, req.portalSession!);
    await saveStateAsync(state, "player-portal:clan-disband");
    res.json(result);
  } catch (error) {
    sendApiError(res, error);
  }
});

router.get("/api/player/shop", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    if (!isShopServiceEnabled(state)) {
      res.status(503).json({ error: "The shop is currently disabled on this server." });
      return;
    }
    res.json(await buildPlayerShopCatalog(state, req.portalSession!));
  } catch (error) {
    sendApiError(res, error);
  }
});

router.get("/api/player/shop/categories/:categoryId", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    if (!isShopServiceEnabled(state)) {
      res.status(503).json({ error: "The shop is currently disabled on this server." });
      return;
    }
    res.json(await buildPlayerShopCategory(state, req.portalSession!, getRouteParam(req.params.categoryId, "categoryId")));
  } catch (error) {
    sendApiError(res, error, 404);
  }
});

router.get("/api/player/shop/items/:itemId", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    if (!isShopServiceEnabled(state)) {
      res.status(503).json({ error: "The shop is currently disabled on this server." });
      return;
    }
    res.json(await buildPlayerShopItem(state, req.portalSession!, getRouteParam(req.params.itemId, "itemId")));
  } catch (error) {
    sendApiError(res, error, 404);
  }
});

router.get("/api/player/shop/map", requirePortalAuth, async (_req, res) => {
  const state = await getStateAsync();
  if (!isShopServiceEnabled(state)) {
    res.status(503).send("The shop is currently disabled on this server.");
    return;
  }
  const mapPath = path.resolve(process.cwd(), process.env.SHOP_MAP_IMAGE_PATH || "assets/maps/chernarus-map-pz-bot.png");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(mapPath, (error) => {
    if (error && !res.headersSent) res.status(404).send("Chernarus map image not found");
  });
});

router.post("/api/player/shop/checkouts", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    if (!isShopServiceEnabled(state)) {
      res.status(503).json({ error: "The shop is currently disabled on this server." });
      return;
    }
    const checkout = createPlayerShopCheckout({
      state,
      session: req.portalSession!,
      itemId: String(req.body?.itemId || ""),
      x: req.body?.x,
      z: req.body?.z,
      locationId: typeof req.body?.locationId === "string" ? req.body.locationId : undefined,
      saveLocationName: typeof req.body?.saveLocationName === "string" ? req.body.saveLocationName : undefined,
    });
    await saveStateAsync(state);
    res.status(201).json(checkout);
  } catch (error) {
    sendApiError(res, error);
  }
});

router.get("/api/player/shop/checkouts/:checkoutId", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    if (!isShopServiceEnabled(state)) {
      res.status(503).json({ error: "The shop is currently disabled on this server." });
      return;
    }
    res.json(getPlayerShopCheckout(state, req.portalSession!, getRouteParam(req.params.checkoutId, "checkoutId")));
  } catch (error) {
    sendApiError(res, error, 404);
  }
});

router.post("/api/player/shop/checkouts/:checkoutId/confirm", requirePortalAuth, async (req, res) => {
  try {
    const state = await getStateAsync();
    if (!isShopServiceEnabled(state)) {
      res.status(503).json({ error: "The shop is currently disabled on this server." });
      return;
    }
    const order = confirmPlayerShopCheckout(state, req.portalSession!, getRouteParam(req.params.checkoutId, "checkoutId"));
    await saveStateAsync(state);
    res.status(201).json(order);
  } catch (error) {
    sendApiError(res, error);
  }
});

router.get("/api/player/purchases", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json({ purchases: buildPlayerPurchases(state, req.portalSession!) });
});

router.get("/api/player/me", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  const session = req.portalSession!;
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const walletResult = link ? getOrCreateWalletForLink(state, link) : null;
  const player = link ? state.players?.[link.gamertag] || null : null;

  res.json({
    profile: {
      discordId: session.discordId,
      username: session.username,
      displayName: session.globalName || session.username,
      avatarUrl: discordAvatarUrl(session),
      role: session.role,
      gamertag: link?.gamertag || null,
      linked: Boolean(link),
    },
    wallet: walletResult?.wallet || null,
    stats: player,
  });
});

export default router;
