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

export async function listNitradoDirectory(
  dir: string,
): Promise<NitradoEntry[]> {
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

export async function debugNitradoListRaw(dir: string): Promise<{
  dir: string;
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  entriesCount: number | null;
}> {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const serviceId = getNitradoServiceId();
  const normalizedDir = normalizeNitradoFileServerPath(dir);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(
    normalizedDir,
  )}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  const text = await res.text();
  let entriesCount: number | null = null;

  try {
    const json = JSON.parse(text);
    const entries = json?.data?.entries;
    entriesCount = Array.isArray(entries) ? entries.length : null;
  } catch {
    entriesCount = null;
  }

  return {
    dir: normalizedDir || "/",
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text: text.slice(0, 900),
    entriesCount,
  };
}

export async function probeNitradoUploadTokenForDirectory(
  dir: string,
  file = "shop_pending.json",
): Promise<{
  dir: string;
  file: string;
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}> {
  if (!process.env.NITRADO_TOKEN) {
    throw new Error("NITRADO_TOKEN não definido");
  }

  const serviceId = getNitradoServiceId();
  const normalizedDir = String(dir || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  const baseUrl = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;
  const url = `${baseUrl}?${new URLSearchParams({ path: normalizedDir, file }).toString()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    },
  });

  const text = await res.text();

  return {
    dir: normalizedDir || "/",
    file,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text: text.slice(0, 700),
  };
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<any> {
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

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getNoFtpRootFromAdmBaseDir() {
  const marker = "/noftp/";
  const index = BASE_DIR.indexOf(marker);

  if (index === -1) {
    return "";
  }

  return BASE_DIR.slice(0, index + marker.length - 1);
}

function buildUploadPathCandidates(pathValue: string) {
  const normalized = normalizeNitradoFileServerPath(pathValue);
  const noFtpRoot = getNoFtpRootFromAdmBaseDir();
  const candidates = [ensureTrailingSlash(normalized), normalized];

  if (noFtpRoot) {
    candidates.push(ensureTrailingSlash(`${noFtpRoot}/${normalized}`));
    candidates.push(`${noFtpRoot}/${normalized}`);
  }

  return uniqueStrings(candidates);
}

async function getUploadToken(
  filePath: string,
): Promise<{ url: string; token: string }> {
  const serviceId = getNitradoServiceId();
  const { path, file } = splitRemoteFilePath(filePath);
  const url = `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`;
  const errors: string[] = [];
  const pathCandidates = buildUploadPathCandidates(path);

  console.log(`📤 Nitrado upload token request: file=${file}`);
  console.log(
    `📤 Nitrado upload path candidates: ${pathCandidates.join(" | ")}`,
  );

  // Public SDK/issues show this endpoint receives path/file parameters and then
  // returns a temporary file-server URL + token. Nitrado is strict about the
  // directory path format, so we try the same directory with and without the
  // trailing slash and with the absolute /games/.../noftp prefix.
  for (const pathCandidate of pathCandidates) {
    for (const strategy of ["query", "form"] as const) {
      const body = { path: pathCandidate, file };

      try {
        console.log(
          `📤 Nitrado upload token strategy=${strategy} path=${pathCandidate} file=${file}`,
        );

        const json =
          strategy === "form"
            ? await postForm(url, body)
            : await postWithQueryParams(url, body);

        const token = json?.data?.token;

        if (!token?.url || !token?.token) {
          throw new Error(
            `Nitrado did not return an upload token for ${filePath}`,
          );
        }

        console.log(
          `✅ Nitrado upload token received: strategy=${strategy} path=${pathCandidate}`,
        );

        return {
          url: token.url,
          token: token.token,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${strategy} ${pathCandidate}: ${message}`);
        console.warn(
          `⚠️ Nitrado upload token failed (${strategy}, ${pathCandidate}): ${message}`,
        );
      }
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
