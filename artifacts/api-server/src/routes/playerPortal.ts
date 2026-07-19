import { Router } from "express";
import { discordAvatarUrl } from "../auth/session";
import { getOrCreateWalletForLink } from "../lib/economy";
import { buildPlayerDashboard } from "../lib/playerPortalDashboard";
import { getPlayerLinkByDiscordId } from "../lib/playerLinks";
import { getStateAsync } from "../lib/state";
import { requirePortalAuth } from "../middlewares/portalAuth";
import { renderPlayerPortal } from "./playerPortalView";

const router = Router();

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

router.get("/app", requirePortalAuth, (req, res) => {
  res.type("html").send(renderPlayerPortal(req.portalSession!));
});

router.get("/api/player/dashboard", requirePortalAuth, async (req, res) => {
  const state = await getStateAsync();
  res.json(buildPlayerDashboard(state, req.portalSession!));
});

// Kept for compatibility with Phase 1 clients. New dashboard consumers should
// use /api/player/dashboard, which already exposes the complete initial view model.
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
