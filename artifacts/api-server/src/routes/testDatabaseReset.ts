import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import postgres from "postgres";

const execFileAsync = promisify(execFile);
const router = Router();
const CONFIRMATION = "RESET_DAYZ_TEST_DATA";

function esc(value: unknown) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>\"']/g, (c) => entities[c] || c);
}

function page(message = "", ok = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset de teste · ADM</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif}.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(520px,100%);padding:28px;border:1px solid #292d36;border-radius:20px;background:#111318}h1{margin:0 0 10px;font-size:26px}p{color:#969da9;line-height:1.5}.warning{margin:18px 0;padding:13px;border-radius:12px;background:#2a2112;border:1px solid #5d4820;color:#ffd98a;font-size:13px;line-height:1.5}.field{display:grid;gap:8px;margin:18px 0}.field label{font-size:13px;font-weight:700}.field input{width:100%;box-sizing:border-box;border:1px solid #303540;background:#0d0f13;color:#fff;border-radius:12px;padding:13px 14px;font:inherit}.button{width:100%;border:0;border-radius:12px;padding:14px 16px;background:#f5f5f5;color:#0a0b0d;font:inherit;font-weight:900;cursor:pointer}.message{margin-top:18px;padding:13px;border-radius:12px;line-height:1.5;font-size:13px;background:${ok ? "#14231a" : "#2a1518"};border:1px solid ${ok ? "#285039" : "#5c252b"};color:${ok ? "#b8efc8" : "#ffb5bd"}</style></head><body><main class="wrap"><section class="card"><h1>Reset de banco de teste</h1><p>Ferramenta temporária para limpar os dados da aplicação antes de validar o onboarding multi-tenant.</p><div class="warning"><strong>Atenção:</strong> esta operação é destrutiva. Ela limpa as tabelas de aplicação e preserva apenas o schema e o histórico de migrations. Não altera dados do Nitrado/DayZ.</div><form method="post" action="/admin-panel/test/reset-database"><div class="field"><label>Digite a confirmação</label><input name="confirmation" autocomplete="off" placeholder="RESET_DAYZ_TEST_DATA" required></div><button class="button">Limpar banco de teste</button></form>${message ? `<div class="message">${esc(message)}</div>` : ""}</section></main></body></html>`;
}

function enabled() {
  return process.env.RESET_TEST_DATA_CONFIRM === CONFIRMATION;
}

router.get("/reset-database", (req, res) => {
  if (!req.adminSession) {
    res.redirect("/admin-panel/login");
    return;
  }
  if (!enabled()) {
    res.status(404).send("Not found");
    return;
  }
  res.type("html").send(page());
});

router.post("/reset-database", async (req, res) => {
  if (!req.adminSession) {
    res.redirect("/admin-panel/login");
    return;
  }
  if (!enabled()) {
    res.status(404).send("Not found");
    return;
  }
  if (String(req.body?.confirmation || "").trim() !== CONFIRMATION) {
    res.status(400).type("html").send(page("Confirmação inválida. Nenhum dado foi alterado."));
    return;
  }

  try {
    const { stdout, stderr } = await execFileAsync("pnpm", ["--filter", "@workspace/scripts", "reset-test-data"], {
      cwd: process.cwd(),
      env: { ...process.env, RESET_TEST_DATA_CONFIRM: CONFIRMATION },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    res.type("html").send(page(output || "Banco de teste limpo com sucesso.", true));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    res.status(500).type("html").send(page(`Falha no reset. Nenhum teste deve continuar até revisar o erro: ${details}`));
  }
});

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
  const username = "testadmin";
  const password = `DayZ-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await sql`CREATE TABLE IF NOT EXISTS admin_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, server_id TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    const salt = crypto.randomBytes(16).toString("hex");
    const digest = crypto.scryptSync(password, salt, 64).toString("hex");
    const passwordHash = `scrypt$${salt}$${digest}`;
    await sql`INSERT INTO admin_users (id, username, password_hash, server_id, active, created_at, updated_at) VALUES (${"admin-test-bootstrap"}, ${username}, ${passwordHash}, NULL, TRUE, NOW(), NOW()) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE, updated_at = NOW()`;
    res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin de teste</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;background:#090a0c;color:#f7f7f8;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center}.card{width:min(520px,calc(100% - 40px));padding:28px;border:1px solid #292d36;border-radius:20px;background:#111318}p{color:#a0a6b0;line-height:1.5}.cred{padding:14px;border-radius:12px;background:#0b0d11;border:1px solid #303540;font-family:ui-monospace,monospace;line-height:1.8}a{display:inline-flex;margin-top:18px;padding:12px 16px;border-radius:11px;background:#f5f5f5;color:#090a0c;text-decoration:none;font-weight:800}</style></head><body><main class="card"><h1>Admin de teste criado</h1><p>Use estas credenciais para continuar o onboarding.</p><div class="cred"><strong>Usuário:</strong> ${username}<br><strong>Senha:</strong> ${password}</div><a href="/admin-panel/login">Ir para o login</a></main></body></html>`);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : String(error));
  } finally {
    await sql.end({ timeout: 5 });
  }
});

export default router;
