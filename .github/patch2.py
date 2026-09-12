from pathlib import Path
import re


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old in text:
        p.write_text(text.replace(old, new, 1))
        return
    if new in text:
        return
    raise SystemExit(f"missing expected block in {path}: {old[:120]!r}")


# 1) Server registry carries encrypted per-server Nitrado credentials internally.
replace(
    "artifacts/api-server/src/lib/serverRegistry.ts",
    "export type ServerRuntimeConfig = {\n  nitradoBaseDir?: string;",
    """export type ServerRuntimeConfig = {
  nitradoBaseDir?: string;
  nitradoApiTokenEncrypted?: {
    encryptedSecret: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  };
  nitradoFtp?: {
    host: string;
    port: number;
    user: string;
    passwordEncrypted: {
      encryptedSecret: string;
      iv: string;
      authTag: string;
      keyVersion: number;
    };
    root?: string;
    secure?: boolean;
  };""",
)
replace(
    "artifacts/api-server/src/lib/serverRegistry.ts",
    '      nitradoBaseDir: String(server.runtime?.nitradoBaseDir || "").trim() || undefined,\n      nitradoValidation:',
    '''      nitradoBaseDir: String(server.runtime?.nitradoBaseDir || "").trim() || undefined,
      nitradoApiTokenEncrypted: server.runtime?.nitradoApiTokenEncrypted && typeof server.runtime.nitradoApiTokenEncrypted === "object"
        ? { ...server.runtime.nitradoApiTokenEncrypted }
        : undefined,
      nitradoFtp: server.runtime?.nitradoFtp && typeof server.runtime.nitradoFtp === "object"
        ? {
            host: String(server.runtime.nitradoFtp.host || "").trim(),
            port: Number(server.runtime.nitradoFtp.port || 21),
            user: String(server.runtime.nitradoFtp.user || "").trim(),
            passwordEncrypted: { ...(server.runtime.nitradoFtp.passwordEncrypted || {}) },
            root: String(server.runtime.nitradoFtp.root || "").trim() || undefined,
            secure: server.runtime.nitradoFtp.secure === true,
          }
        : undefined,
      nitradoValidation:''',
)
# No registry-empty -> primary fallback. Unknown servers fail closed.
replace("artifacts/api-server/src/lib/serverRegistry.ts", "  return [getPrimaryServerDescriptor()];", "  return [];")

# 2) State registry accepts only encrypted credential containers, not plaintext secrets.
replace(
    "artifacts/api-server/src/lib/state.ts",
    '    if (SERVER_SECRET_KEY_PATTERN.test(key)) {\n      throw new Error(`Server onboarding does not persist secrets in managed_servers (${pathName}.${key}). Nitrado credentials stay server-side and are never accepted by this registry form.`);\n    }',
    '    if (SERVER_SECRET_KEY_PATTERN.test(key) && key !== "nitradoApiTokenEncrypted" && key !== "passwordEncrypted") {\n      throw new Error(`Server onboarding does not persist plaintext secrets in managed_servers (${pathName}.${key}).`);\n    }',
)

# 3) Reusable decrypt primitive.
org = Path("artifacts/api-server/src/lib/organizationIntegrations.ts")
text = org.read_text()
text = text.replace(
    "function decryptOrganizationSecret(record: OrganizationIntegrationRecord) {",
    'export function decryptEncryptedSecret(record: Pick<OrganizationIntegrationRecord, "encryptedSecret" | "iv" | "authTag">) {',
    1,
)
text = re.sub(r"\bdecryptOrganizationSecret\(record\)", "decryptEncryptedSecret(record)", text, count=1)
org.write_text(text)

# 4) Common resolver: service/base/token are resolved from the requested server.
Path("artifacts/api-server/src/lib/serverNitrado.ts").write_text('''import { decryptEncryptedSecret, getOrganizationNitradoCredential } from "./organizationIntegrations";
import { getManagedServerById, getPrimaryServerId, type ManagedServerDescriptor } from "./serverRegistry";

export type ServerNitradoConfig = {
  serverId: string;
  serviceId: string;
  baseDir: string;
  apiToken: string;
  apiTokenSource: "server-secret" | "organization-secret" | "environment-fallback";
  ftp?: { host: string; port: number; user: string; password: string; root?: string; secure: boolean };
};

function resolveDescriptor(serverId: string): ManagedServerDescriptor {
  const descriptor = getManagedServerById(serverId);
  if (!descriptor) throw new Error(`Servidor ${serverId} nao encontrado para resolver Nitrado.`);
  return descriptor;
}

function decryptServerSecret(value: unknown, label: string) {
  const secret = value as { encryptedSecret?: string; iv?: string; authTag?: string } | undefined;
  if (!secret?.encryptedSecret || !secret.iv || !secret.authTag) {
    throw new Error(`Credencial Nitrado incompleta: ${label}.`);
  }
  return decryptEncryptedSecret(secret as Parameters<typeof decryptEncryptedSecret>[0]);
}

export function getServerNitradoConfig(serverId: string): ServerNitradoConfig {
  const server = resolveDescriptor(serverId);
  const serviceId = String(server.integrations.nitradoServiceId || "").trim();
  const baseDir = String(server.runtime.nitradoBaseDir || "").trim();
  if (!serviceId) throw new Error(`Nitrado Service ID nao configurado para ${server.id}.`);
  if (!baseDir) throw new Error(`Nitrado baseDir nao configurado para ${server.id}.`);

  let apiToken = "";
  let apiTokenSource: ServerNitradoConfig["apiTokenSource"];
  if (server.runtime.nitradoApiTokenEncrypted?.encryptedSecret) {
    apiToken = decryptServerSecret(server.runtime.nitradoApiTokenEncrypted, "api token");
    apiTokenSource = "server-secret";
  } else if (server.id === getPrimaryServerId()) {
    const credential = getOrganizationNitradoCredential(server.organizationId);
    apiToken = credential.token;
    apiTokenSource = credential.source;
  } else {
    throw new Error(`Credencial Nitrado server-scoped obrigatoria para ${server.id}.`);
  }
  if (!apiToken) throw new Error(`Nitrado nao conectado para ${server.id}.`);

  const f = server.runtime.nitradoFtp;
  const ftp = f?.host && f.user && f.passwordEncrypted?.encryptedSecret
    ? { host: f.host, port: Number(f.port || 21), user: f.user, password: decryptServerSecret(f.passwordEncrypted, "ftp password"), root: f.root, secure: f.secure === true }
    : undefined;
  return { serverId: server.id, serviceId, baseDir, apiToken, apiTokenSource, ftp };
}
''')

# 5) Downloader: no hardcoded service/base fallback; all credentials through resolver.
p = Path("artifacts/api-server/src/lib/nitradoDownloader.ts")
text = p.read_text()
text = text.replace('import { getOrganizationNitradoCredential } from "./organizationIntegrations";\n', '', 1)
if 'from "./serverNitrado"' not in text:
    text = text.replace(
        'import { getActiveServerId, getServerRuntimeContext } from "./serverRuntime";',
        'import { getActiveServerId, getServerRuntimeContext } from "./serverRuntime";\nimport { getServerNitradoConfig } from "./serverNitrado";',
        1,
    )
text = re.sub(r'const LEGACY_SERVICE_ID = "19149785";\nconst LEGACY_BASE_DIR = "/games/ni13029176_1/noftp/dayzps/config";\n\n', '', text, count=1)
text = re.sub(
    r'function getNitradoToken\(serverId = getActiveServerId\(\)\) \{.*?\n\}',
    'function getNitradoToken(serverId = getActiveServerId()) {\n  return getServerNitradoConfig(serverId).apiToken;\n}',
    text, count=1, flags=re.S,
)
text = text.replace(
    'const baseDir = runtime.nitrado.baseDir || LEGACY_BASE_DIR;',
    'const baseDir = runtime.nitrado.baseDir;\n  if (!baseDir) throw new Error(`Nitrado baseDir nao configurado para o servidor ${serverId}.`);',
    1,
)
text = re.sub(
    r'function getNitradoServiceId\(serverId = getActiveServerId\(\)\) \{.*?\n\}',
    'function getNitradoServiceId(serverId = getActiveServerId()) {\n  return getServerNitradoConfig(serverId).serviceId;\n}',
    text, count=1, flags=re.S,
)
p.write_text(text)

# 6) FTP: same server-scoped resolver, no primary-only assertion/global credential use.
p = Path("artifacts/api-server/src/lib/nitradoFtp.ts")
text = p.read_text()
text = text.replace(
    'import { assertPrimaryRuntimeServer, getActiveServerId } from "./serverRuntime";',
    'import { getActiveServerId } from "./serverRuntime";\nimport { getServerNitradoConfig } from "./serverNitrado";',
    1,
)
text = text.replace(
    'function normalizeFtpPath(value: string) {\n  const root = String(process.env.NITRADO_FTP_ROOT || "")',
    'function normalizeFtpPath(value: string, rootValue = "") {\n  const root = String(rootValue || "")',
    1,
)
a = text.find("function getFtpConnectionOptions()")
b = text.find("async function uploadTextViaFtp", a)
if a >= 0 and b >= 0:
    text = text[:a] + '''function getFtpConnectionOptions(serverId: string) {
  const config = getServerNitradoConfig(serverId);
  if (!config.ftp) throw new Error(`FTP nao configurado para o servidor ${serverId}.`);
  return config.ftp;
}

''' + text[b:]
text = re.sub(
    r'  const serverId = getActiveServerId\(\);\n(?:  // Phase 8.*?\n)?  (?:assertPrimaryRuntimeServer\(serverId\);\n  )?const \{ host, port, user, password \} = getFtpConnectionOptions\(\);\n  const remotePath = normalizeFtpPath\(filePath\);',
    '  const serverId = getActiveServerId();\n  const { host, port, user, password, root } = getFtpConnectionOptions(serverId);\n  const remotePath = normalizeFtpPath(filePath, root);',
    text, count=2, flags=re.S,
)
p.write_text(text)

print("Patch 2 source transformation complete")
