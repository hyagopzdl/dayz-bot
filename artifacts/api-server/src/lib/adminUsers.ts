import crypto from "node:crypto";
import postgres from "postgres";

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
let schemaPromise: Promise<void> | null = null;

export type AdminUser = {
  id: string;
  username: string;
  serverId: string | null;
  active: boolean;
};

function requireSql() {
  if (!sql) throw new Error("Admin authentication database is unavailable: DATABASE_URL is not configured.");
  return sql;
}

function normalizeUsername(value: unknown) {
  return String(value || "").trim().toLowerCase().slice(0, 80);
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
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
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
  return { id: String(row.id), username: String(row.username), serverId: row.server_id ? String(row.server_id) : null, active: true };
}

export async function getAdminUserById(idInput: unknown): Promise<AdminUser | null> {
  await ensureAdminUsersSchema();
  const id = String(idInput || "").trim();
  if (!id) return null;
  const rows = await requireSql()`SELECT id, username, server_id, active FROM admin_users WHERE id = ${id} LIMIT 1` as any[];
  const row = rows[0];
  return row ? { id: String(row.id), username: String(row.username), serverId: row.server_id ? String(row.server_id) : null, active: row.active !== false } : null;
}

export async function assignAdminUserServer(adminUserId: unknown, serverId: unknown) {
  await ensureAdminUsersSchema();
  const id = String(adminUserId || "").trim();
  const normalizedServerId = String(serverId || "").trim() || null;
  await requireSql()`UPDATE admin_users SET server_id = ${normalizedServerId}, updated_at = NOW() WHERE id = ${id}`;
  return getAdminUserById(id);
}
