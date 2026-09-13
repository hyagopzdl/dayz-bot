import { decryptEncryptedSecret, getOrganizationNitradoCredential } from "./organizationIntegrations";
import { getManagedServerById, type ManagedServerDescriptor } from "./serverRegistry";

export type ServerNitradoConfig = {
  serverId: string;
  serviceId: string;
  baseDir: string;
  apiToken: string;
  apiTokenSource: "server-secret" | "organization-bootstrap";
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

  const encryptedToken = server.runtime.nitradoApiTokenEncrypted;
  let apiToken = "";
  let apiTokenSource: ServerNitradoConfig["apiTokenSource"] = "server-secret";

  if (encryptedToken?.encryptedSecret) {
    apiToken = decryptServerSecret(encryptedToken, "api token");
  } else {
    // Bootstrap-only compatibility: onboarding stores one Nitrado credential at
    // organization scope, while the durable runtime contract is server-scoped.
    // If a newly created server has not been hydrated yet, use the credential
    // from its own organization only. Never read another server's credential or
    // the global primary server as a fallback.
    const organizationCredential = getOrganizationNitradoCredential(server.organizationId);
    apiToken = String(organizationCredential.token || "").trim();
    apiTokenSource = "organization-bootstrap";
  }

  if (!apiToken) throw new Error(`Nitrado nao conectado para ${server.id}.`);

  const f = server.runtime.nitradoFtp;
  const ftp = f?.host && f.user && f.passwordEncrypted?.encryptedSecret
    ? {
        host: f.host,
        port: Number(f.port || 21),
        user: f.user,
        password: decryptServerSecret(f.passwordEncrypted, "ftp password"),
        root: f.root,
        secure: f.secure === true,
      }
    : undefined;

  return { serverId: server.id, serviceId, baseDir, apiToken, apiTokenSource, ftp };
}
