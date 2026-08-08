import crypto from "node:crypto";
import type { PortalSession } from "../auth/session";
import { getPlayerLinkByDiscordId } from "./playerLinks";
import type { AppState, Clan, ClanActivityEvent, ClanInvite, ClanMember, ClanRole, PlayerStats } from "./state";

export const CLAN_MAX_MEMBERS = 20;
export const CLAN_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanName(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function cleanTag(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function cleanDescription(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function ensureClanContainers(state: AppState) {
  state.clans ||= {};
  state.clanMemberships ||= {};
  state.clanInvites ||= [];
  pruneExpiredInvites(state);
}

function pruneExpiredInvites(state: AppState) {
  const cutoff = Date.now();
  state.clanInvites = (state.clanInvites || []).filter((invite) => {
    const expiresAt = new Date(invite.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt > cutoff;
  });
}

function assertLinked(state: AppState, session: PortalSession) {
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  if (!link) throw new Error("Link your DayZ account with /link on Discord before using clans.");
  return link;
}

function getMembership(state: AppState, discordId: string) {
  ensureClanContainers(state);
  const clanId = state.clanMemberships?.[discordId];
  if (!clanId) return null;
  const clan = state.clans?.[clanId];
  if (!clan) {
    delete state.clanMemberships?.[discordId];
    return null;
  }
  const member = clan.members.find((entry) => entry.discordId === discordId) || null;
  if (!member) {
    delete state.clanMemberships?.[discordId];
    return null;
  }
  return { clan, member };
}

function resolveMemberGamertag(state: AppState, member: ClanMember) {
  return state.playerLinks?.[member.discordId]?.gamertag || member.gamertag;
}

function roleWeight(role: ClanRole) {
  if (role === "owner") return 3;
  if (role === "officer") return 2;
  return 1;
}

function memberView(state: AppState, member: ClanMember) {
  const gamertag = resolveMemberGamertag(state, member);
  const stats = state.players?.[gamertag] || { kills: 0, deaths: 0 };
  const kills = Number(stats.kills || 0);
  const deaths = Number(stats.deaths || 0);
  return {
    discordId: member.discordId,
    gamertag,
    role: member.role,
    joinedAt: member.joinedAt,
    kills,
    deaths,
    kd: deaths > 0 ? Number((kills / deaths).toFixed(2)) : kills,
    linkedCharacters: 1 + (state.playerAlts?.[member.discordId]?.length || 0),
  };
}

function bestStreakFor(state: AppState, gamertag: string) {
  let best = Number(state.currentKillStreaks?.[gamertag] || 0);
  for (const event of state.killStreakEvents || []) {
    if (event.player === gamertag) best = Math.max(best, Number(event.streak || 0));
  }
  return best;
}

function bestLongshotFor(state: AppState, gamertag: string) {
  let best: { distance: number; weapon?: string; victim?: string } | null = null;
  for (const event of state.longShotEvents || []) {
    if (event.killer !== gamertag) continue;
    if (!best || Number(event.distance || 0) > best.distance) {
      best = { distance: Number(event.distance || 0), weapon: event.weapon, victim: event.victim };
    }
  }
  return best;
}

export function buildClanStats(state: AppState, clan: Clan, period: "overall" | "weekly" | "daily" = "overall") {
  const pool: Record<string, PlayerStats> = period === "daily" ? state.dailyPlayers || {} : period === "weekly" ? state.weeklyPlayers || {} : state.players || {};
  let kills = 0;
  let deaths = 0;
  let bestStreak = 0;
  let bestLongshot: { distance: number; weapon?: string; victim?: string; player?: string } | null = null;

  for (const member of clan.members) {
    const gamertag = resolveMemberGamertag(state, member);
    const stats = pool[gamertag];
    kills += Number(stats?.kills || 0);
    deaths += Number(stats?.deaths || 0);
    if (period === "overall") {
      bestStreak = Math.max(bestStreak, bestStreakFor(state, gamertag));
      const longshot = bestLongshotFor(state, gamertag);
      if (longshot && (!bestLongshot || longshot.distance > bestLongshot.distance)) bestLongshot = { ...longshot, player: gamertag };
    }
  }

  return {
    kills,
    deaths,
    kd: deaths > 0 ? Number((kills / deaths).toFixed(2)) : kills,
    streak: bestStreak,
    longshot: bestLongshot?.distance || 0,
    longshotWeapon: bestLongshot?.weapon || null,
    longshotPlayer: bestLongshot?.player || null,
    members: clan.members.length,
  };
}

function activity(state: AppState, clan: Clan, type: ClanActivityEvent["type"], actorDiscordId: string, subject?: string) {
  clan.activity ||= [];
  clan.activity.push({
    id: crypto.randomUUID(),
    type,
    actorDiscordId,
    actorGamertag: state.playerLinks?.[actorDiscordId]?.gamertag || "Unknown",
    subject,
    createdAt: nowIso(),
  });
  clan.activity = clan.activity.slice(-100);
  clan.updatedAt = nowIso();
}

function assertNameAndTag(state: AppState, name: string, tag: string, ignoreClanId?: string) {
  if (name.length < 3 || name.length > 32) throw new Error("Clan name must be between 3 and 32 characters.");
  if (!/^[A-Z0-9]{2,6}$/.test(tag)) throw new Error("Clan tag must be 2–6 letters or numbers.");
  for (const clan of Object.values(state.clans || {})) {
    if (clan.id === ignoreClanId) continue;
    if (normalized(clan.name) === normalized(name)) throw new Error("That clan name is already in use.");
    if (normalized(clan.tag) === normalized(tag)) throw new Error("That clan tag is already in use.");
  }
}

function clanPayload(state: AppState, clan: Clan, session: PortalSession) {
  const membership = getMembership(state, session.discordId);
  const members = clan.members
    .map((member) => memberView(state, member))
    .sort((a, b) => roleWeight(b.role) - roleWeight(a.role) || b.kills - a.kills || a.gamertag.localeCompare(b.gamertag));
  const stats = buildClanStats(state, clan, "overall");
  const currentRole = membership?.clan.id === clan.id ? membership.member.role : null;
  return {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    description: clan.description || "",
    createdAt: clan.createdAt,
    updatedAt: clan.updatedAt,
    members,
    stats,
    activity: (clan.activity || []).slice(-30).reverse(),
    permissions: {
      role: currentRole,
      canInvite: currentRole === "owner" || currentRole === "officer",
      canManageMembers: currentRole === "owner" || currentRole === "officer",
      canEditClan: currentRole === "owner",
      canTransferOwnership: currentRole === "owner",
      canDisband: currentRole === "owner",
    },
  };
}

export function buildPlayerClanDashboard(state: AppState, session: PortalSession) {
  ensureClanContainers(state);
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const membership = getMembership(state, session.discordId);
  const invites = (state.clanInvites || [])
    .filter((invite) => invite.invitedDiscordId === session.discordId)
    .map((invite) => ({
      ...invite,
      clanName: state.clans?.[invite.clanId]?.name || "Unknown clan",
      clanTag: state.clans?.[invite.clanId]?.tag || "?",
    }))
    .filter((invite) => Boolean(state.clans?.[invite.clanId]));

  return {
    profile: { linked: Boolean(link), gamertag: link?.gamertag || null },
    clan: membership ? clanPayload(state, membership.clan, session) : null,
    invites,
    config: {
      maxMembers: CLAN_MAX_MEMBERS,
      nameMin: 3,
      nameMax: 32,
      tagMin: 2,
      tagMax: 6,
      descriptionMax: 180,
    },
  };
}

export function createClan(state: AppState, session: PortalSession, input: { name?: unknown; tag?: unknown; description?: unknown }) {
  ensureClanContainers(state);
  const link = assertLinked(state, session);
  if (getMembership(state, session.discordId)) throw new Error("You are already in a clan.");
  const name = cleanName(input.name);
  const tag = cleanTag(input.tag);
  const description = cleanDescription(input.description);
  assertNameAndTag(state, name, tag);
  if (description.length > 180) throw new Error("Clan description cannot exceed 180 characters.");

  const createdAt = nowIso();
  const clan: Clan = {
    id: crypto.randomUUID(),
    name,
    tag,
    description,
    ownerDiscordId: session.discordId,
    createdAt,
    updatedAt: createdAt,
    members: [{ discordId: session.discordId, gamertag: link.gamertag, role: "owner", joinedAt: createdAt }],
    activity: [],
  };
  state.clans![clan.id] = clan;
  state.clanMemberships![session.discordId] = clan.id;
  activity(state, clan, "created", session.discordId, clan.name);
  return clanPayload(state, clan, session);
}

export function updateClan(state: AppState, session: PortalSession, input: { name?: unknown; tag?: unknown; description?: unknown }) {
  const membership = getMembership(state, session.discordId);
  if (!membership) throw new Error("You are not in a clan.");
  if (membership.member.role !== "owner") throw new Error("Only the clan owner can edit clan details.");
  const name = cleanName(input.name ?? membership.clan.name);
  const tag = cleanTag(input.tag ?? membership.clan.tag);
  const description = cleanDescription(input.description ?? membership.clan.description);
  assertNameAndTag(state, name, tag, membership.clan.id);
  if (description.length > 180) throw new Error("Clan description cannot exceed 180 characters.");
  membership.clan.name = name;
  membership.clan.tag = tag;
  membership.clan.description = description;
  activity(state, membership.clan, "updated", session.discordId, `${tag} · ${name}`);
  return clanPayload(state, membership.clan, session);
}

export function inviteClanMember(state: AppState, session: PortalSession, rawGamertag: unknown) {
  ensureClanContainers(state);
  const membership = getMembership(state, session.discordId);
  if (!membership) throw new Error("You are not in a clan.");
  if (membership.member.role !== "owner" && membership.member.role !== "officer") throw new Error("You do not have permission to invite members.");
  if (membership.clan.members.length >= CLAN_MAX_MEMBERS) throw new Error(`Clan is full (${CLAN_MAX_MEMBERS} members maximum).`);

  const gamertag = cleanName(rawGamertag);
  const invitedDiscordId = state.playerLinksByGamertag?.[normalized(gamertag)];
  if (!invitedDiscordId) throw new Error("That gamertag is not linked to a Discord account yet.");
  if (invitedDiscordId === session.discordId) throw new Error("You are already in this clan.");
  if (state.clanMemberships?.[invitedDiscordId]) throw new Error("That player is already in a clan.");
  const duplicate = (state.clanInvites || []).find((invite) => invite.clanId === membership.clan.id && invite.invitedDiscordId === invitedDiscordId);
  if (duplicate) throw new Error("That player already has a pending invite from this clan.");

  const now = Date.now();
  const invite: ClanInvite = {
    id: crypto.randomUUID(),
    clanId: membership.clan.id,
    invitedDiscordId,
    invitedGamertag: state.playerLinks?.[invitedDiscordId]?.gamertag || gamertag,
    invitedByDiscordId: session.discordId,
    invitedByGamertag: state.playerLinks?.[session.discordId]?.gamertag || membership.member.gamertag,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CLAN_INVITE_TTL_MS).toISOString(),
  };
  state.clanInvites!.push(invite);
  activity(state, membership.clan, "invited", session.discordId, invite.invitedGamertag);
  return invite;
}

export function respondToClanInvite(state: AppState, session: PortalSession, inviteId: string, accept: boolean) {
  ensureClanContainers(state);
  const index = state.clanInvites!.findIndex((invite) => invite.id === inviteId && invite.invitedDiscordId === session.discordId);
  if (index < 0) throw new Error("Clan invite was not found or has expired.");
  const invite = state.clanInvites![index];
  state.clanInvites!.splice(index, 1);
  if (!accept) return { accepted: false };
  if (getMembership(state, session.discordId)) throw new Error("You are already in a clan.");
  const clan = state.clans?.[invite.clanId];
  if (!clan) throw new Error("This clan no longer exists.");
  if (clan.members.length >= CLAN_MAX_MEMBERS) throw new Error("This clan is already full.");
  const link = assertLinked(state, session);
  const member: ClanMember = { discordId: session.discordId, gamertag: link.gamertag, role: "member", joinedAt: nowIso() };
  clan.members.push(member);
  state.clanMemberships![session.discordId] = clan.id;
  state.clanInvites = state.clanInvites!.filter((entry) => entry.invitedDiscordId !== session.discordId);
  activity(state, clan, "joined", session.discordId, link.gamertag);
  return { accepted: true, clan: clanPayload(state, clan, session) };
}

export function setClanMemberRole(state: AppState, session: PortalSession, targetDiscordId: string, role: ClanRole) {
  const membership = getMembership(state, session.discordId);
  if (!membership || membership.member.role !== "owner") throw new Error("Only the clan owner can change member roles.");
  if (role === "owner") throw new Error("Use transfer ownership to assign a new owner.");
  const target = membership.clan.members.find((member) => member.discordId === targetDiscordId);
  if (!target || target.role === "owner") throw new Error("Member was not found.");
  target.role = role === "officer" ? "officer" : "member";
  activity(state, membership.clan, role === "officer" ? "promoted" : "demoted", session.discordId, resolveMemberGamertag(state, target));
  return clanPayload(state, membership.clan, session);
}

export function removeClanMember(state: AppState, session: PortalSession, targetDiscordId: string) {
  const membership = getMembership(state, session.discordId);
  if (!membership) throw new Error("You are not in a clan.");
  if (targetDiscordId === session.discordId) throw new Error("Use Leave clan to leave your clan.");
  const target = membership.clan.members.find((member) => member.discordId === targetDiscordId);
  if (!target || target.role === "owner") throw new Error("Member was not found.");
  if (membership.member.role === "member") throw new Error("You do not have permission to remove members.");
  if (membership.member.role === "officer" && target.role !== "member") throw new Error("Officers can only remove regular members.");
  membership.clan.members = membership.clan.members.filter((member) => member.discordId !== targetDiscordId);
  delete state.clanMemberships?.[targetDiscordId];
  activity(state, membership.clan, "removed", session.discordId, resolveMemberGamertag(state, target));
  return clanPayload(state, membership.clan, session);
}

export function leaveClan(state: AppState, session: PortalSession) {
  const membership = getMembership(state, session.discordId);
  if (!membership) throw new Error("You are not in a clan.");
  if (membership.member.role === "owner") throw new Error("Transfer ownership or disband the clan before leaving.");
  membership.clan.members = membership.clan.members.filter((member) => member.discordId !== session.discordId);
  delete state.clanMemberships?.[session.discordId];
  activity(state, membership.clan, "left", session.discordId, resolveMemberGamertag(state, membership.member));
  return { left: true };
}

export function transferClanOwnership(state: AppState, session: PortalSession, targetDiscordId: string) {
  const membership = getMembership(state, session.discordId);
  if (!membership || membership.member.role !== "owner") throw new Error("Only the clan owner can transfer ownership.");
  const target = membership.clan.members.find((member) => member.discordId === targetDiscordId);
  if (!target || target.discordId === session.discordId) throw new Error("Choose another clan member.");
  membership.member.role = "officer";
  target.role = "owner";
  membership.clan.ownerDiscordId = target.discordId;
  activity(state, membership.clan, "ownership_transferred", session.discordId, resolveMemberGamertag(state, target));
  return clanPayload(state, membership.clan, session);
}

export function disbandClan(state: AppState, session: PortalSession) {
  const membership = getMembership(state, session.discordId);
  if (!membership || membership.member.role !== "owner") throw new Error("Only the clan owner can disband the clan.");
  const clanId = membership.clan.id;
  for (const member of membership.clan.members) delete state.clanMemberships?.[member.discordId];
  state.clanInvites = (state.clanInvites || []).filter((invite) => invite.clanId !== clanId);
  delete state.clans?.[clanId];
  return { disbanded: true };
}

export function listClans(state: AppState) {
  ensureClanContainers(state);
  return Object.values(state.clans || {});
}

export function getClanForDiscordId(state: AppState, discordId: string) {
  return getMembership(state, discordId)?.clan || null;
}
