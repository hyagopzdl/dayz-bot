export type OrganizationRole = "owner" | "admin" | "moderator" | "viewer";

export type ManagedOrganization = {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationMembership = {
  organizationId: string;
  discordId: string;
  role: OrganizationRole;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationRegistryPersistenceStatus = {
  enabled: boolean;
  initialized: boolean;
  organizationsTableReady: boolean;
  membershipsTableReady: boolean;
  serverOwnershipColumnReady: boolean;
  defaultOrganizationSeeded: boolean;
  serversBackfilled: number;
  serversWithoutOrganization: number;
  organizationsLoaded: number;
  membershipsLoaded: number;
  seededOwnerMemberships: number;
  lastLoadedAt?: string;
  lastError?: string;
};

const FALLBACK_ORGANIZATION_ID = "org-default";
const FALLBACK_ORGANIZATION_NAME = "ADM Workspace";

let organizations: ManagedOrganization[] = [];
let memberships: OrganizationMembership[] = [];
let persistenceStatus: OrganizationRegistryPersistenceStatus = {
  enabled: Boolean(process.env.DATABASE_URL),
  initialized: false,
  organizationsTableReady: false,
  membershipsTableReady: false,
  serverOwnershipColumnReady: false,
  defaultOrganizationSeeded: false,
  serversBackfilled: 0,
  serversWithoutOrganization: 0,
  organizationsLoaded: 0,
  membershipsLoaded: 0,
  seededOwnerMemberships: 0,
};

export function buildOrganizationId(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizeOrganizationName(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 100) || FALLBACK_ORGANIZATION_NAME;
}

export function normalizeOrganizationRole(value: unknown): OrganizationRole {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "owner" || normalized === "admin" || normalized === "moderator" || normalized === "viewer") {
    return normalized;
  }
  return "viewer";
}

export function getDefaultOrganizationId() {
  return buildOrganizationId(process.env.DEFAULT_ORGANIZATION_ID || FALLBACK_ORGANIZATION_ID) || FALLBACK_ORGANIZATION_ID;
}

export function getDefaultOrganizationDescriptor(): ManagedOrganization {
  return {
    id: getDefaultOrganizationId(),
    name: normalizeOrganizationName(process.env.ORGANIZATION_NAME || process.env.SERVER_DISPLAY_NAME || FALLBACK_ORGANIZATION_NAME),
    active: true,
  };
}

export function setPersistedOrganizations(nextOrganizations: ManagedOrganization[], nextMemberships: OrganizationMembership[]) {
  organizations = nextOrganizations.map((organization) => ({
    id: buildOrganizationId(organization.id),
    name: normalizeOrganizationName(organization.name),
    active: organization.active !== false,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  }));
  memberships = nextMemberships.map((membership) => ({
    organizationId: buildOrganizationId(membership.organizationId),
    discordId: String(membership.discordId || "").trim(),
    role: normalizeOrganizationRole(membership.role),
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  })).filter((membership) => membership.organizationId && membership.discordId);
}

export function listManagedOrganizations() {
  const source = organizations.length ? organizations : [getDefaultOrganizationDescriptor()];
  return source.map((organization) => ({ ...organization }));
}

export function getManagedOrganizationById(organizationId: unknown) {
  const id = buildOrganizationId(organizationId);
  return listManagedOrganizations().find((organization) => organization.id === id);
}

export function listOrganizationMemberships(organizationId?: unknown) {
  const normalizedOrganizationId = organizationId ? buildOrganizationId(organizationId) : undefined;
  return memberships
    .filter((membership) => !normalizedOrganizationId || membership.organizationId === normalizedOrganizationId)
    .map((membership) => ({ ...membership }));
}

export function listUserOrganizationMemberships(discordId: unknown) {
  const normalizedDiscordId = String(discordId || "").trim();
  if (!normalizedDiscordId) return [];
  return memberships.filter((membership) => membership.discordId === normalizedDiscordId).map((membership) => ({ ...membership }));
}

export function getUserOrganizationMembership(discordId: unknown, organizationId: unknown) {
  const normalizedDiscordId = String(discordId || "").trim();
  const normalizedOrganizationId = buildOrganizationId(organizationId);
  if (!normalizedDiscordId || !normalizedOrganizationId) return undefined;
  const membership = memberships.find((candidate) => candidate.discordId === normalizedDiscordId && candidate.organizationId === normalizedOrganizationId);
  return membership ? { ...membership } : undefined;
}

export function setOrganizationRegistryPersistenceStatus(status: Partial<OrganizationRegistryPersistenceStatus>) {
  persistenceStatus = { ...persistenceStatus, ...status };
}

export function getOrganizationRegistryPersistenceStatus() {
  return { ...persistenceStatus };
}

export function canOrganizationRole(role: OrganizationRole | undefined, capability: "view" | "moderate" | "manage" | "own") {
  if (!role) return false;
  const rank: Record<OrganizationRole, number> = { viewer: 1, moderator: 2, admin: 3, owner: 4 };
  const required = capability === "view" ? 1 : capability === "moderate" ? 2 : capability === "manage" ? 3 : 4;
  return rank[role] >= required;
}

export function getOrganizationFoundationDiagnostics() {
  const status = getOrganizationRegistryPersistenceStatus();
  return {
    phase: 15,
    enabled: status.enabled,
    initialized: status.initialized,
    defaultOrganizationId: getDefaultOrganizationId(),
    organizations: listManagedOrganizations().length,
    memberships: listOrganizationMemberships().length,
    ownershipColumnReady: status.serverOwnershipColumnReady,
    serversWithoutOrganization: status.serversWithoutOrganization,
    seededOwnerMemberships: status.seededOwnerMemberships,
    authorizationModel: "organization-membership-rbac",
    roles: ["owner", "admin", "moderator", "viewer"] as OrganizationRole[],
    legacyAdminTokenBootstrap: Boolean(process.env.ADMIN_PANEL_TOKEN || process.env.SHOP_ADMIN_TOKEN),
    credentialIsolation: "pending-phase-16",
    thirdPartyOnboardingReady: false,
    backgroundPollingAdded: false,
  };
}
