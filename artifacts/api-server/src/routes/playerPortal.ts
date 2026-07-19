import { Router } from "express";
import { discordAvatarUrl } from "../auth/session";
import { getOrCreateWalletForLink } from "../lib/economy";
import { getPlayerLinkByDiscordId } from "../lib/playerLinks";
import { getStateAsync } from "../lib/state";
import { requirePortalAuth } from "../middlewares/portalAuth";

const router = Router();

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

router.get("/app", requirePortalAuth, async (req, res) => {
  const session = req.portalSession!;
  const state = await getStateAsync();
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const player = link ? state.players?.[link.gamertag] : null;
  const walletResult = link ? getOrCreateWalletForLink(state, link) : null;
  const wallet = walletResult?.wallet || null;
  const displayName = session.globalName || session.username;
  const avatar = discordAvatarUrl(session);
  const initials = displayName.slice(0, 2).toUpperCase();

  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PZ Deathmatch · Player Portal</title><style>
  :root{color-scheme:dark;--bg:#08090b;--panel:#111318;--panel2:#171a20;--border:#292d35;--muted:#969dab;--accent:#e63946}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#fff;font-family:Inter,system-ui,sans-serif}.layout{display:grid;grid-template-columns:240px 1fr;min-height:100vh}.side{border-right:1px solid var(--border);padding:28px 20px;background:#0d0f13}.brand{font-weight:900;font-size:18px;margin-bottom:32px}.nav{display:grid;gap:8px}.nav a{padding:12px;border-radius:10px;color:#aeb4c0;text-decoration:none}.nav a.active{background:#1b1e25;color:#fff}.soon{opacity:.45}.main{padding:32px;max-width:1200px;width:100%}.top{display:flex;align-items:center;justify-content:space-between;gap:20px}.identity{display:flex;align-items:center;gap:12px}.avatar{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#252934;font-weight:800;object-fit:cover}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:28px}.card{padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--panel)}.label{font-size:13px;color:var(--muted)}.value{font-size:28px;font-weight:900;margin-top:8px}.notice{margin-top:20px;padding:18px;border:1px solid #594126;background:#241b11;border-radius:14px;color:#f4cf98}.logout{border:0;background:transparent;color:#aeb4c0;cursor:pointer}.role{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#8f96a6}@media(max-width:800px){.layout{grid-template-columns:1fr}.side{display:none}.main{padding:20px}.grid{grid-template-columns:repeat(2,1fr)}}
  </style></head><body><div class="layout"><aside class="side"><div class="brand">PZ DEATHMATCH</div><nav class="nav"><a class="active" href="/app">Overview</a><a class="soon" href="#">Statistics · soon</a><a class="soon" href="#">Shop · soon</a><a class="soon" href="#">Purchases · soon</a></nav></aside><main class="main"><header class="top"><div><div class="muted">Welcome back</div><h1>${escapeHtml(displayName)}</h1></div><div class="identity">${avatar ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="">` : `<div class="avatar">${escapeHtml(initials)}</div>`}<div><strong>${escapeHtml(displayName)}</strong><div class="role">${escapeHtml(session.role)}</div></div><button class="logout" onclick="logout()">Sign out</button></div></header>${!link ? `<div class="notice">Your Discord account is not linked to a DayZ gamertag yet. Use the <strong>/link</strong> command in Discord to connect it.</div>` : ""}<section class="grid"><article class="card"><div class="label">Gamertag</div><div class="value">${escapeHtml(link?.gamertag || "Not linked")}</div></article><article class="card"><div class="label">Coins</div><div class="value">${wallet?.balance ?? 0}</div></article><article class="card"><div class="label">Kills</div><div class="value">${(player as any)?.kills ?? 0}</div></article><article class="card"><div class="label">Deaths</div><div class="value">${(player as any)?.deaths ?? 0}</div></article></section></main></div><script>async function logout(){await fetch('/api/auth/logout',{method:'POST'});location.href='/login'}</script></body></html>`);
});

router.get("/api/player/me", requirePortalAuth, async (req, res) => {
  const session = req.portalSession!;
  const state = await getStateAsync();
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const walletResult = link ? getOrCreateWalletForLink(state, link) : null;
  const wallet = walletResult?.wallet || null;
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
    wallet,
    stats: player,
  });
});

export default router;
