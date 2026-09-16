import crypto from "node:crypto";
import postgres from "postgres";
import { Router } from "express";

const router = Router();
const CONFIRMATION = "RESET_DAYZ_TEST_DATA";
const TEST_USERNAME = "testadmin";
const TEST_PASSWORD = "DayZTest2026!";

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${digest}`;
}

function enabled() {
  return process.env.RESET_TEST_DATA_CONFIRM === CONFIRMATION;
}

router.get("/bootstrap-admin", async (_req, res) => {
  if (!enabled()) {
    res.status(404).send("Not found");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(503).send("DATABASE_URL is not configured.");
    return;
  }

  const sql = postgres(databaseUrl, { ssl: "require", max: 1 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS admin_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, server_id TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    const id = "admin-test-bootstrap";
    const passwordHash = hashPassword(TEST_PASSWORD);
    await sql`INSERT INTO admin_users (id, username, password_hash, server_id, active, created_at, updated_at) VALUES (${id}, ${TEST_USERNAME}, ${passwordHash}, NULL, TRUE, NOW(), NOW()) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE, updated_at = NOW()`;
    res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin de teste</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center}.card{width:min(520px,calc(100% - 40px));padding:28px;border:1px solid #292d36;border-radius:20px;background:#111318}p{color:#a0a6b0;line-height:1.5}.cred{padding:14px;border-radius:12px;background:#0b0d11;border:1px solid #303540;font-family:ui-monospace,monospace;line-height:1.8}a{display:inline-flex;margin-top:18px;padding:12px 16px;border-radius:11px;background:#f5f5f5;color:#090a0c;text-decoration:none;font-weight:800}</style></head><body><main class="card"><h1>Admin de teste criado</h1><p>Use estas credenciais para continuar o onboarding limpo.</p><div class="cred"><strong>Usuário:</strong> ${TEST_USERNAME}<br><strong>Senha:</strong> ${TEST_PASSWORD}</div><a href="/admin-panel/login">Ir para o login</a></main></body></html>`);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : String(error));
  } finally {
    await sql.end({ timeout: 5 });
  }
});

export default router;
