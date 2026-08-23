import crypto from "node:crypto";
import { getDefaultOrganizationId } from "./organizationRegistry";

export type OrganizationIntegrationProvider = "nitrado";

export type OrganizationIntegrationRecord = {
  organizationId: string;
  provider: OrganizationIntegrationProvider;
  encryptedSecret: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  metadata: Record<string, unknown>;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationIntegrationStatus = {
  organizationId: string;
  provider: OrganizationIntegrationProvider;
  configured: boolean;
  credentialSource: "organization-secret" | "environment-fallback" | "missing";
  encryptedAtRest: boolean;
  metadata: Record<string, unknown>;
  updatedAt?: string;
};

const records = new Map<string, OrganizationIntegrationRecord>();

function integrationKey(organizationId: string, provider: OrganizationIntegrationProvider) {
  return `${organizationId}:${provider}`;
}

function getEncryptionKey() {
  const raw = String(process.env.ADM_SECRETS_KEY || "").trim();
  // The app derives a fixed AES-256 key, but still requires enough source
  // entropy so a short human password cannot silently become a tenant-secret key.
  if (raw.length < 32) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function isOrganizationSecretEncryptionConfigured() {
  return Boolean(getEncryptionKey());
}

export function encryptOrganizationSecret(secretInput: unknown) {
  const secret = String(secretInput || "").trim();
  if (!secret) throw new Error("Informe a credencial antes de salvar.");
  const key = getEncryptionKey();
  if (!key) {
    throw new Error("ADM_SECRETS_KEY precisa estar configurado com pelo menos 32 caracteres antes de armazenar credenciais de clientes.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedSecret: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: 1,
  };
}

function decryptOrganizationSecret(record: OrganizationIntegrationRecord) {
  const key = getEncryptionKey();
  if (!key) throw new Error("ADM_SECRETS_KEY nao esta configurado para descriptografar a integracao.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.encryptedSecret, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function setPersistedOrganizationIntegrations(nextRecords: OrganizationIntegrationRecord[]) {
  records.clear();
  for (const record of nextRecords) {
    if (!record.organizationId || record.provider !== "nitrado") continue;
    records.set(integrationKey(record.organizationId, record.provider), { ...record, metadata: { ...(record.metadata || {}) } });
  }
}

export function getOrganizationIntegrationRecord(
  organizationId: string,
  provider: OrganizationIntegrationProvider,
) {
  const record = records.get(integrationKey(organizationId, provider));
  return record ? { ...record, metadata: { ...(record.metadata || {}) } } : undefined;
}

export function getOrganizationNitradoCredential(organizationId: string) {
  const record = records.get(integrationKey(organizationId, "nitrado"));
  if (record?.active) {
    return {
      token: decryptOrganizationSecret(record),
      source: "organization-secret" as const,
    };
  }

  // Transitional compatibility is intentionally limited to the organization
  // that owns the existing production servers. Other tenants can never inherit
  // the platform environment token.
  if (organizationId === getDefaultOrganizationId()) {
    const token = String(process.env.NITRADO_TOKEN || "").trim();
    if (token) return { token, source: "environment-fallback" as const };
  }

  return { token: "", source: "missing" as const };
}

export function getOrganizationIntegrationStatus(organizationId: string): OrganizationIntegrationStatus {
  const record = records.get(integrationKey(organizationId, "nitrado"));
  const hasEncrypted = Boolean(record?.active);
  const hasEnvironmentFallback = organizationId === getDefaultOrganizationId() && Boolean(String(process.env.NITRADO_TOKEN || "").trim());
  return {
    organizationId,
    provider: "nitrado",
    configured: hasEncrypted || hasEnvironmentFallback,
    credentialSource: hasEncrypted ? "organization-secret" : hasEnvironmentFallback ? "environment-fallback" : "missing",
    encryptedAtRest: hasEncrypted,
    metadata: { ...(record?.metadata || {}) },
    updatedAt: record?.updatedAt,
  };
}

export function getOrganizationIntegrationsDiagnostics() {
  const configuredOrganizations = new Set<string>();
  for (const record of records.values()) if (record.active) configuredOrganizations.add(record.organizationId);
  return {
    phase: 16,
    encryptionConfigured: isOrganizationSecretEncryptionConfigured(),
    encryptedNitradoOrganizations: configuredOrganizations.size,
    legacyEnvironmentFallback: Boolean(process.env.NITRADO_TOKEN),
    environmentFallbackOrganizationId: getDefaultOrganizationId(),
    discordCredentialModel: "platform-bot" as const,
    discordGuildIsolation: "organization-owned-routing" as const,
    secretsExposedToBrowser: false,
  };
}
