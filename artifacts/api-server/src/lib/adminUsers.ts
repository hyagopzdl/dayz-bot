import crypto from "node:crypto";
import postgres from "postgres";

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
let schemaPromise: Promise<void> | null = null;
const ADMIN_ACCESS_CACHE_TTL_MS = 30_000;
const adminAccessCache = new Map<string, { expiresAt: number; value: AdminServerAccess | null }>();

export type AdminRole = "owner" | "admin" | "moderator" | "viewer";

export type AdminUser = {
  id: string;
  username: string;
  serverId: string | null;
  active: boolean;
};

export type AdminOrganizationMembership = {
  adminUserId: string;
  organizationId: string;
  role: AdminRole;
};

export type AdminServerAccess = {
  adminUserId: string;
  serverId: string;
  organizationId: string;
  role: AdminRole;
};

function requireSql() {
  if (!sql) throw new Error("Admin authentication database is unavailable: DATABASE_URL is not configured.");
  return sql;
}

function normalizeUsername(value: unknown) {
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

function normalizeRole(value: unknown): AdminRole {
  const role = String(value || "").trim().toLowerCase();
  if (role === "owner" || role === "admin" || role === "moderator" || role === "viewer") return role;
  return "viewer";
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password: string, stored: string) {
  const [scheme, salt, expectedHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function ensureAdminUsersSchema() {
  if (schemaPromise) return schemaPromise;
  const db = requireSql();
  schemaPromise = (async () => {
    await db`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        server_id TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Phase 17A: admin_users.server_id becomes only the currently selected
    // compatibility server. Authorization lives in additive membership tables.
    await db`
      CREATE TABLE IF NOT EXISTS admin_organization_memberships (
        admin_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','moderator','viewer')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (admin_user_id, organization_id)
      )
    `;
    await db`CREATE INDEX IF NOT EXISTS admin_org_memberships_org_idx ON admin_organization_memberships (organization_id, admin_user_id)`;

    await db`
      CREATE TABLE IF NOT EXISTS admin_server_access (
        admin_user_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','moderator','viewer')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (admin_user_id, server_id)
      )
    `;
    await db`CREATE INDEX IF NOT EXISTS admin_server_access_server_idx ON admin_server_access (server_id, admin_user_id)`;
    await db`CREATE INDEX IF NOT EXISTS admin_server_access_org_idx ON admin_server_access (organization_id, admin_user_id)`;

    const seeds = [
      { id: "admin1", username: "admin1", serverId: "pz-deathmatch" },
      { id: "admin2", username: "admin2", serverId: "pz-survival" },
    ];
    for (const seed of seeds) {
      await db`
        INSERT INTO admin_users (id, username, password_hash, server_id, active)
        VALUES (${seed.id}, ${seed.username}, ${hashPassword("admin")}, ${seed.serverId}, TRUE)
        ON CONFLICT (username) DO NOTHING
      `;
    }

    // Repair only the temporary test accounts if an older build cleared the
    // selected server because the in-memory registry had not loaded yet.
    for (const seed of seeds) {
      await db`
        UPDATE admin_users
        SET server_id = ${seed.serverId}, updated_at = NOW()
        WHERE username = ${seed.username}
          AND (server_id IS NULL OR BTRIM(server_id) = '')
          AND EXISTS (SELECT 1 FROM managed_servers WHERE id = ${seed.serverId})
      `;
    }

    // Safe additive backfill: every legacy selected server becomes explicit
    // organization membership + server access. No existing ownership is moved.
    await db`
      INSERT INTO admin_organization_memberships (admin_user_id, organization_id, role, created_at, updated_at)
      SELECT au.id, ms.organization_id, 'owner', NOW(), NOW()
      FROM admin_users au
      JOIN managed_servers ms ON ms.id = au.server_id
      WHERE au.active = TRUE AND au.server_id IS NOT NULL AND BTRIM(au.server_id) <> ''
      ON CONFLICT (admin_user_id, organization_id) DO NOTHING
    `;
    await db`
      INSERT INTO admin_server_access (admin_user_id, server_id, organization_id, role, created_at, updated_at)
      SELECT au.id, ms.id, ms.organization_id, 'owner', NOW(), NOW()
      FROM admin_users au
      JOIN managed_servers ms ON ms.id = au.server_id
      WHERE au.active = TRUE AND au.server_id IS NOT NULL AND BTRIM(au.server_id) <> ''
      ON CONFLICT (admin_user_id, server_id) DO NOTHING
    `;
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function rowToAdminUser(row: any): AdminUser | null {
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    serverId: row.server_id ? String(row.server_id) : null,
    active: row.active !== false,
  };
}

export async function authenticateAdminUser(usernameInput: unknown, passwordInput: unknown): Promise<AdminUser | null> {
  await ensureAdminUsersSchema();
  const username = normalizeUsername(usernameInput);
  const password = String(passwordInput || "");
  if (!username || !password) return null;
  const rows = await requireSql()`
    SELECT id, username, password_hash, server_id, active
    FROM admin_users
    WHERE username = ${username}
    LIMIT 1
  ` as any[];
  const row = rows[0];
  if (!row || row.active === false || !verifyPassword(password, String(row.password_hash || ""))) return null;
  return rowToAdminUser(row);
}

export async function getAdminUserById(idInput: unknown): Promise<AdminUser | null> {
  await ensureAdminUsersSchema();
  const id = String(idInput || "").trim();
  if (!id) return null;
  const rows = await requireSql()`SELECT id, username, server_id, active FROM admin_users WHERE id = ${id} LIMIT 1` as any[];
  return rowToAdminUser(rows[0]);
}

export async function listAdminOrganizationMemberships(adminUserIdInput: unknown): Promise<AdminOrganizationMembership[]> {
  await ensureAdminUsersSchema();
  const adminUserId = String(adminUserIdInput || "").trim();
  if (!adminUserId) return [];
  const rows = await requireSql()`
    SELECT admin_user_id, organization_id, role
    FROM admin_organization_memberships
    WHERE admin_user_id = ${adminUserId}
    ORDER BY organization_id
  ` as any[];
  return rows.map((row) => ({
    adminUserId: String(row.admin_user_id),
    organizationId: String(row.organization_id),
    role: normalizeRole(row.role),
  }));
}

export async function listAdminServerAccess(adminUserIdInput: unknown): Promise<AdminServerAccess[]> {
  await ensureAdminUsersSchema();
  const adminUserId = String(adminUserIdInput || "").trim();
  if (!adminUserId) return [];
  const rows = await requireSql()`
    SELECT admin_user_id, server_id, organization_id, role
    FROM admin_server_access
    WHERE admin_user_id = ${adminUserId}
    ORDER BY server_id
  ` as any[];
  return rows.map((row) => ({
    adminUserId: String(row.admin_user_id),
    serverId: String(row.server_id),
    organizationId: String(row.organization_id),
    role: normalizeRole(row.role),
  }));
}

export async function getAdminServerAccess(adminUserIdInput: unknown, serverIdInput: unknown): Promise<AdminServerAccess | null> {
  await ensureAdminUsersSchema();
  const adminUserId = String(adminUserIdInput || "").trim();
  const serverId = String(serverIdInput || "").trim();
  if (!adminUserId || !serverId) return null;
  const cacheKey = `${adminUserId}:${serverId}`;
  const cached = adminAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value ? { ...cached.value } : null;
  const rows = await requireSql()`
    SELECT admin_user_id, server_id, organization_id, role
    FROM admin_server_access
    WHERE admin_user_id = ${adminUserId} AND server_id = ${serverId}
    LIMIT 1
  ` as any[];
  const row = rows[0];
  const value = row ? {
    adminUserId: String(row.admin_user_id),
    serverId: String(row.server_id),
    organizationId: String(row.organization_id),
    role: normalizeRole(row.role),
  } : null;
  adminAccessCache.set(cacheKey, { expiresAt: Date.now() + ADMIN_ACCESS_CACHE_TTL_MS, value });
  return value ? { ...value } : null;
}

export async function grantAdminServerAccess(adminUserIdInput: unknown, serverIdInput: unknown, roleInput: unknown = "owner") {
  await ensureAdminUsersSchema();
  const adminUserId = String(adminUserIdInput || "").trim();
  const serverId = String(serverIdInput || "").trim();
  const role = normalizeRole(roleInput);
  if (!adminUserId || !serverId) throw new Error("ADMIN_SERVER_ACCESS_INVALID");
  const serverRows = await requireSql()`SELECT id, organization_id FROM managed_servers WHERE id = ${serverId} LIMIT 1` as any[];
  const server = serverRows[0];
  if (!server) throw new Error("SERVER_NOT_FOUND");
  const organizationId = String(server.organization_id || "").trim();
  if (!organizationId) throw new Error("SERVER_ORGANIZATION_REQUIRED");
  await requireSql()`
    INSERT INTO admin_organization_memberships (admin_user_id, organization_id, role, created_at, updated_at)
    VALUES (${adminUserId}, ${organizationId}, ${role}, NOW(), NOW())
    ON CONFLICT (admin_user_id, organization_id)
    DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
  `;
  await requireSql()`
    INSERT INTO admin_server_access (admin_user_id, server_id, organization_id, role, created_at, updated_at)
    VALUES (${adminUserId}, ${serverId}, ${organizationId}, ${role}, NOW(), NOW())
    ON CONFLICT (admin_user_id, server_id)
    DO UPDATE SET organization_id = EXCLUDED.organization_id, role = EXCLUDED.role, updated_at = NOW()
  `;
  adminAccessCache.delete(`${adminUserId}:${serverId}`);
  return getAdminServerAccess(adminUserId, serverId);
}

export async function assignAdminUserServer(adminUserId: unknown, serverId: unknown) {
  await ensureAdminUsersSchema();
  const id = String(adminUserId || "").trim();
  const normalizedServerId = String(serverId || "").trim() || null;
  if (normalizedServerId) await grantAdminServerAccess(id, normalizedServerId, "owner");
  await requireSql()`UPDATE admin_users SET server_id = ${normalizedServerId}, updated_at = NOW() WHERE id = ${id}`;
  return getAdminUserById(id);
}

export async function getAdminTenantDiagnostics() {
  await ensureAdminUsersSchema();
  const rows = await requireSql()`
    SELECT
      (SELECT COUNT(*)::int FROM admin_users WHERE active = TRUE) AS admins,
      (SELECT COUNT(*)::int FROM admin_organization_memberships) AS memberships,
      (SELECT COUNT(*)::int FROM admin_server_access) AS server_access
  ` as any[];
  const row = rows[0] || {};
  return {
    admins: Number(row.admins || 0),
    memberships: Number(row.memberships || 0),
    serverAccessRows: Number(row.server_access || 0),
    authorizationModel: "admin-user->organization-membership->server-access",
    legacySelectedServerColumnRetained: true,
  };
}
