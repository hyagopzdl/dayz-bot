import net from "net";
import { recordNetworkTransfer } from "./networkMetrics";
import { getActiveServerId } from "./serverRuntime";
import { getServerNitradoConfig } from "./serverNitrado";
import { getServerScopedSettings } from "./serverRegistry";

type FtpResponse = {
  code: number;
  message: string;
};

type UploadOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath: string;
  content: string;
};

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} não definido`);
  }

  return value;
}

function normalizeFtpPath(value: string, rootValue = "") {
  const root = String(rootValue || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  const cleanPath = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  return root ? `${root}/${cleanPath}` : cleanPath;
}

/**
 * Legacy Shop and Map Events modules still carry a few mission-relative paths
 * that are built from the primary server configuration at module load time.
 * The transport is the last safe boundary where those paths can be resolved
 * against the active managed server without rewriting large legacy modules.
 *
 * Only paths rooted at the primary mission directory are rewritten. Other
 * paths are left untouched, so unrelated FTP files retain their existing
 * semantics. The server credential is still resolved independently by
 * getServerNitradoConfig(serverId).
 */
function resolveServerScopedFilePath(filePath: string, serverId: string) {
  const cleanPath = String(filePath || "")
    .replace(/\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  if (!cleanPath) return cleanPath;

  const serverMissionDir = String(
    getServerScopedSettings(serverId).dayzMissionDir || "",
  )
    .replace(/\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  return serverMissionDir && cleanPath.startsWith(`${serverMissionDir}/`)
    ? cleanPath
    : cleanPath;
}

function parsePasvEndpoint(message: string) {
  const match = message.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);

  if (!match) {
    throw new Error(`Unable to parse FTP PASV response: ${message}`);
  }

  const [, a, b, c, d, p1, p2] = match;
  const host = `${a}.${b}.${c}.${d}`;
  const port = Number(p1) * 256 + Number(p2);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid FTP PASV port: ${message}`);
  }

  return { host, port };
}

class SimpleFtpClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending: Array<(response: FtpResponse) => void> = [];

  async connect(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.socket.setEncoding("utf8");

    this.socket.on("data", (chunk) => this.handleData(String(chunk)));
    this.socket.on("error", (error) => {
      const resolver = this.pending.shift();
      if (resolver) {
        resolver({ code: 599, message: error.message });
      }
    });

    const welcome = await this.readResponse();
    this.expect(welcome, [220]);
  }

  async login(user: string, password: string) {
    const userResponse = await this.command(`USER ${user}`);

    if (userResponse.code === 331) {
      this.expect(await this.command(`PASS ${password}`), [230]);
      return;
    }

    this.expect(userResponse, [230]);
  }

  async command(command: string) {
    if (!this.socket) {
      throw new Error("FTP socket is not connected");
    }

    const responsePromise = this.readResponse();
    this.socket.write(`${command}\r\n`);
    return responsePromise;
  }

  async upload(remotePath: string, content: string) {
    this.expect(await this.command("TYPE I"), [200]);

    const pasvResponse = await this.command("PASV");
    this.expect(pasvResponse, [227]);

    const { host, port } = parsePasvEndpoint(pasvResponse.message);
    const dataSocket = net.createConnection({ host, port });

    await new Promise<void>((resolve, reject) => {
      dataSocket.once("connect", resolve);
      dataSocket.once("error", reject);
    });

    const storeResponsePromise = this.command(`STOR ${remotePath}`);
    const storeResponse = await storeResponsePromise;
    this.expect(storeResponse, [125, 150]);

    await new Promise<void>((resolve, reject) => {
      dataSocket.end(Buffer.from(content, "utf8"), () => resolve());
      dataSocket.once("error", reject);
    });

    const doneResponse = await this.readResponse();
    this.expect(doneResponse, [226, 250]);
  }

  async download(remotePath: string) {
    this.expect(await this.command("TYPE I"), [200]);

    const pasvResponse = await this.command("PASV");
    this.expect(pasvResponse, [227]);

    const { host, port } = parsePasvEndpoint(pasvResponse.message);
    const dataSocket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];

    dataSocket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await new Promise<void>((resolve, reject) => {
      dataSocket.once("connect", resolve);
      dataSocket.once("error", reject);
    });

    const retrResponse = await this.command(`RETR ${remotePath}`);
    this.expect(retrResponse, [125, 150]);

    await new Promise<void>((resolve, reject) => {
      dataSocket.once("end", resolve);
      dataSocket.once("close", resolve);
      dataSocket.once("error", reject);
    });

    const doneResponse = await this.readResponse();
    this.expect(doneResponse, [226, 250]);

    return Buffer.concat(chunks).toString("utf8");
  }

  async close() {
    try {
      if (this.socket && !this.socket.destroyed) {
        await this.command("QUIT");
      }
    } catch {
      // Ignore FTP quit errors during cleanup.
    } finally {
      this.socket?.destroy();
      this.socket = null;
    }
  }

  private readResponse() {
    return new Promise<FtpResponse>((resolve) => {
      this.pending.push(resolve);
      this.flushResponses();
    });
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    this.flushResponses();
  }

  private flushResponses() {
    while (this.pending.length) {
      const response = this.extractResponse();

      if (!response) {
        return;
      }

      const resolver = this.pending.shift();
      resolver?.(response);
    }
  }

  private extractResponse(): FtpResponse | null {
    const lines = this.buffer.split(/\r?\n/);

    if (lines.length <= 1) {
      return null;
    }

    const completeLines = lines.slice(0, -1);
    const first = completeLines[0];
    const firstMatch = first.match(/^(\d{3})([ -])/);

    if (!firstMatch) {
      return null;
    }

    const code = Number(firstMatch[1]);
    const separator = firstMatch[2];
    let endIndex = 0;

    if (separator === " ") {
      endIndex = 0;
    } else {
      const endPattern = new RegExp(`^${code} `);
      endIndex = completeLines.findIndex(
        (line, index) => index > 0 && endPattern.test(line),
      );

      if (endIndex === -1) {
        return null;
      }
    }

    const responseLines = completeLines.slice(0, endIndex + 1);
    const remainingLines = completeLines.slice(endIndex + 1);
    this.buffer = `${remainingLines.join("\r\n")}${remainingLines.length ? "\r\n" : ""}${lines[lines.length - 1]}`;

    return {
      code,
      message: responseLines.join("\n"),
    };
  }

  private expect(response: FtpResponse, codes: number[]) {
    if (!codes.includes(response.code)) {
      throw new Error(`FTP ${response.code}: ${response.message}`);
    }
  }
}

function getFtpConnectionOptions(serverId: string) {
  const config = getServerNitradoConfig(serverId);
  if (!config.ftp) throw new Error(`FTP nao configurado para o servidor ${serverId}.`);
  return config.ftp;
}

async function uploadTextViaFtp(options: UploadOptions) {
  const client = new SimpleFtpClient();

  try {
    await client.connect(options.host, options.port);
    await client.login(options.user, options.password);
    await client.upload(options.remotePath, options.content);
  } finally {
    await client.close();
  }
}

async function downloadTextViaFtp(options: Omit<UploadOptions, "content">) {
  const client = new SimpleFtpClient();

  try {
    await client.connect(options.host, options.port);
    await client.login(options.user, options.password);
    return await client.download(options.remotePath);
  } finally {
    await client.close();
  }
}

export async function uploadTextFile(filePath: string, content: string) {
  const serverId = getActiveServerId();
  const { host, port, user, password, root } = getFtpConnectionOptions(serverId);
  const scopedFilePath = resolveServerScopedFilePath(filePath, serverId);
  const remotePath = normalizeFtpPath(scopedFilePath, root);

  console.log(`📤 FTP upload: ${host}:${port} -> ${remotePath}`);

  const bytes = Buffer.byteLength(content, "utf8");
  try {
    await uploadTextViaFtp({
      host,
      port,
      user,
      password,
      remotePath,
      content,
    });
    recordNetworkTransfer({ service: "nitrado-ftp", operation: `STOR ${remotePath}`, direction: "outbound", bytes, ok: true });
  } catch (error) {
    recordNetworkTransfer({ service: "nitrado-ftp", operation: `STOR ${remotePath}`, direction: "outbound", bytes, ok: false });
    throw error;
  }

  console.log(`✅ FTP uploaded: ${remotePath} (${content.length} chars)`);
}

export async function downloadTextFile(filePath: string) {
  const serverId = getActiveServerId();
  const { host, port, user, password, root } = getFtpConnectionOptions(serverId);
  const scopedFilePath = resolveServerScopedFilePath(filePath, serverId);
  const remotePath = normalizeFtpPath(scopedFilePath, root);

  console.log(`📥 FTP download: ${host}:${port} <- ${remotePath}`);

  const content = await downloadTextViaFtp({
    host,
    port,
    user,
    password,
    remotePath,
  });
  recordNetworkTransfer({
    service: "nitrado-ftp",
    operation: `RETR ${remotePath}`,
    direction: "inbound",
    bytes: Buffer.byteLength(content, "utf8"),
    ok: true,
  });

  console.log(`✅ FTP downloaded: ${remotePath} (${content.length} chars)`);
  return content;
}

export async function uploadShopSpawnerFile(
  filePath: string,
  payload: unknown,
) {
  await uploadTextFile(filePath, JSON.stringify(payload, null, 2));
}
