import fs from "fs";
import path from "path";

const SERVICE_ID = "19149785";
const BASE_DIR = "/games/ni13029176_1/noftp/dayzps/config";

export const LOG_DIR = path.resolve(process.cwd(), "adm_logs");
export const MANIFEST_FILE = path.resolve(process.cwd(), "adm_manifest.json");

const MAX_CANDIDATES = 6;

export type NitradoEntry = {
  path: string;
  size?: number;
  type?: string;
};

type Manifest = {
  files: string[];
  updatedAt: string;
};

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function safeLocalName(remotePath: string) {
  return path.basename(remotePath).replace(/[^\w.-]/g, "_");
}

function extractDateFromAdmPath(filePath: string) {
  const match = filePath.match(/_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
  if (!match) return 0;

  return new Date(`${match[1]}T${match[2].replace(/-/g, ":")}`).getTime();
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as any;
}

async function getDownloadUrl(filePath: string): Promise<string | null> {
  const json = await fetchJson(
    `https://api.nitrado.net/services/${SERVICE_ID}/gameservers/file_server/download?file=${encodeURIComponent(
      filePath,
    )}`,
  );

  return json?.data?.token?.url || null;
}

async function downloadText(filePath: string): Promise<string | null> {
  const url = await getDownloadUrl(filePath);
  if (!url) return null;

  const finalUrl = `${url}&t=${Date.now()}`;
  const res = await fetch(finalUrl);

  if (!res.ok) {
    throw new Error(`ADM download HTTP ${res.status}: ${await res.text()}`);
  }

  return res.text();
}

function saveManifest(files: string[]) {
  const manifest: Manifest = {
    files,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

export async function downloadADM() {
  ensureLogDir();

  if (!process.env.NITRADO_TOKEN) {
    console.error("❌ NITRADO_TOKEN não definido");
    return;
  }

  console.log("📂 Listando arquivos ADM...");

  const listJson = await fetchJson(
    `https://api.nitrado.net/services/${SERVICE_ID}/gameservers/file_server/list?dir=${encodeURIComponent(
      BASE_DIR,
    )}`,
  );

  const files: NitradoEntry[] = listJson?.data?.entries || [];

  const admFiles = files
    .filter((f) => f.path?.endsWith(".ADM"))
    .sort(
      (a, b) => extractDateFromAdmPath(b.path) - extractDateFromAdmPath(a.path),
    )
    .slice(0, MAX_CANDIDATES);

  if (!admFiles.length) {
    console.log("⚠️ nenhum .ADM encontrado");
    saveManifest([]);
    return;
  }

  console.log("📂 candidatos ADM:");
  admFiles.forEach((f) => console.log(`- ${f.path}`));

  const downloadedLocalFiles: string[] = [];

  for (const file of admFiles) {
    try {
      const text = await downloadText(file.path);

      if (!text) {
        console.log(`⚠️ sem URL de download: ${file.path}`);
        continue;
      }

      const localFile = path.join(LOG_DIR, safeLocalName(file.path));

      fs.writeFileSync(localFile, text, "utf-8");
      downloadedLocalFiles.push(localFile);

      console.log(`✅ ADM baixado: ${file.path} (${text.length} chars)`);
    } catch (err) {
      console.error(`❌ erro baixando ${file.path}:`, err);
    }
  }

  saveManifest(downloadedLocalFiles);

  console.log(`📦 ${downloadedLocalFiles.length} arquivos ADM disponíveis`);
}

function getNitradoServiceId() {
  return process.env.NITRADO_SERVICE_ID || SERVICE_ID;
}

function normalizeNitradoFileServerPath(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

export async function listNitradoDirectory(dir: string): Promise<NitradoEntry[]> {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const serviceId = getNitradoServiceId();
  const normalizedDir = normalizeNitradoFileServerPath(dir);

  console.log(`📂 Nitrado list request: dir=${normalizedDir || "/"}`);

  const json = await fetchJson(
    `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(
      normalizedDir,
    )}`,
  );

  return json?.data?.entries || [];
}

async function postForm(url: string, body: Record<string, string>): Promise<any> {
  const form = new URLSearchParams(body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as any;
}

async function postWithQueryParams(
  url: string,
  params: Record<string, string>,
): Promise<any> {
  const fullUrl = `${url}?${new URLSearchParams(params).toString()}`;

  const res = await fetch(fullUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Nitrado HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as any;
}

function splitRemoteFilePath(filePath: string) {
  const normalized = normalizeNitradoFileServerPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.pop();

  if (!file) {
    throw new Error(`Invalid Nitrado file path: ${filePath}`);
  }

  return {
    path: parts.join("/"),
    file,
  };
}

async function getUploadToken(filePath: string): Promise<{ url: string; token: string }> {
  const serviceId = getNitradoServiceId();
  const { path, file } = splitRemoteFilePath(filePath);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;
  const body = { path, file };
  const errors: string[] = [];

  console.log(`📤 Nitrado upload token request: path=${path} file=${file}`);

  // Nitrado's file_server/upload endpoint expects form/query style parameters,
  // not a JSON request body. Try form first, then query params as a fallback.
  for (const strategy of ["form", "query"] as const) {
    try {
      console.log(`📤 Nitrado upload token strategy=${strategy}`);
      const json =
        strategy === "form"
          ? await postForm(url, body)
          : await postWithQueryParams(url, body);

      const token = json?.data?.token;

      if (!token?.url || !token?.token) {
        throw new Error(`Nitrado did not return an upload token for ${filePath}`);
      }

      return {
        url: token.url,
        token: token.token,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${strategy}: ${message}`);
      console.warn(`⚠️ Nitrado upload token failed (${strategy}): ${message}`);
    }
  }

  throw new Error(
    `Nitrado upload token failed for ${filePath}. Attempts: ${errors.join(" | ")}`,
  );
}

export async function uploadShopSpawnerFile(
  filePath: string,
  payload: unknown,
) {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const { url, token } = await getUploadToken(filePath);
  const body = JSON.stringify(payload, null, 2);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/binary",
      token,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Nitrado upload HTTP ${res.status}: ${await res.text()}`);
  }

  console.log(`✅ Shop spawner uploaded: ${filePath} (${body.length} chars)`);
}
