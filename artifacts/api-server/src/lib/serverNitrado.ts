import { decryptEncryptedSecret, getOrganizationNitradoCredential } from "./organizationIntegrations";
import { getManagedServerById, getPrimaryServerId, type ManagedServerDescriptor } from "./serverRegistry";

export type ServerNitradoConfig = {
  serverId: string;
  serviceId: string;
  baseDir: string;
  apiToken: string;
  apiTokenSource: "server-secret" | "organization-secret" | "environment-fallback" | "missing";
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
