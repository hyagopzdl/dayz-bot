import { uploadTextFile, downloadTextFile } from "./nitradoFtp";

export type NitradoTransportMode = "api" | "ftp";

export type ServerNitradoTransportConfig = {
  mode: NitradoTransportMode;
  apiBaseUrl?: string;
  apiToken?: string;
  ftp?: {
    host: string;
    port: number;
    user: string;
    password: string;
    root?: string;
  };
};

/**
 * Server-scoped transport boundary.
 *
 * Important: this module deliberately does not resolve credentials from global
 * NITRADO_* environment variables. Callers must supply the credentials for the
 * managed server they are operating on. The legacy FTP helper remains available
 * for the primary runtime until all call sites are migrated.
 */
export async function uploadServerTextFile(
  _serverId: string,
  _config: ServerNitradoTransportConfig,
  _filePath: string,
  _content: string,
): Promise<void> {
  throw new Error(
    "Server-scoped Nitrado transport is not wired yet. Refusing to fall back to global/primary credentials.",
  );
}

export async function downloadServerTextFile(
  _serverId: string,
  _config: ServerNitradoTransportConfig,
  _filePath: string,
): Promise<string> {
  throw new Error(
    "Server-scoped Nitrado transport is not wired yet. Refusing to fall back to global/primary credentials.",
  );
}
