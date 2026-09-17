import net from "net";
import { getServerNitradoConfig } from "./serverNitrado";
import { getActiveServerId } from "./serverRuntime";
import { getServerScopedSettings } from "./serverRegistry";

type FtpResponse = { code: number; message: string };

type UploadOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath: string;
  content: string;
};

class FtpClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending: Array<(response: FtpResponse) => void> = [];

  async connect(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.handleData(String(chunk)));
    this.socket.on("error", (error) => {
      const resolver = this.pending.shift();
      resolver?.({ code: 599, message: error.message });
    });
    this.expect(await this.readResponse(), [220]);
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
    if (!this.socket) throw new Error("FTP socket is not connected");
    const response = this.readResponse();
    this.socket.write(`${command}\r\n`);
    return response;
  }

  async pwd() {
    const response = await this.command("PWD");
    this.expect(response, [257]);
    const match = response.message.match(/\"([^\"]*)\"/);
    return match?.[1] || "/";
  }

  async uploadInDirectory(directory: string, fileName: string, content: string) {
    const cwd = directory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const cwdCommand = cwd ? `CWD ${cwd}` : "CWD /";
    this.expect(await this.command(cwdCommand), [250]);

    this.expect(await this.command("TYPE I"), [200]);
    const pasv = await this.command("PASV");
    this.expect(pasv, [227]);
    const endpoint = parsePasvEndpoint(pasv.message);
    const dataSocket = net.createConnection(endpoint);

    await new Promise<void>((resolve, reject) => {
      dataSocket.once("connect", resolve);
      dataSocket.once("error", reject);
    });

    const storePromise = this.command(`STOR ${fileName}`);
    const store = await storePromise;
    this.expect(store, [125, 150]);

    await new Promise<void>((resolve, reject) => {
      dataSocket.once("error", reject);
      dataSocket.end(Buffer.from(content, "utf8"), resolve);
    });

    this.expect(await this.readResponse(), [226, 250]);
  }

  async close() {
    try {
      if (this.socket && !this.socket.destroyed) await this.command("QUIT");
    } catch {
      // Cleanup only.
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
      if (!response) return;
      this.pending.shift()?.(response);
    }
  }

  private extractResponse(): FtpResponse | null {
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length <= 1) return null;
    const complete = lines.slice(0, -1);
    const first = complete[0];
    const match = first.match(/^(\d{3})([ -])/);
    if (!match) return null;

    const code = Number(match[1]);
    const multiline = match[2] === "-";
    let endIndex = 0;
    if (multiline) {
      const end = new RegExp(`^${code} `);
      endIndex = complete.findIndex((line, index) => index > 0 && end.test(line));
      if (endIndex < 0) return null;
    }

    const responseLines = complete.slice(0, endIndex + 1);
    const remaining = complete.slice(endIndex + 1);
    this.buffer = `${remaining.join("\r\n")}${remaining.length ? "\r\n" : ""}${lines.at(-1) || ""}`;
    return { code, message: responseLines.join("\n") };
  }

  private expect(response: FtpResponse, codes: number[]) {
    if (!codes.includes(response.code)) {
      throw new Error(`FTP ${response.code}: ${response.message}`);
    }
  }
}

function parsePasvEndpoint(message: string) {
  const match = message.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!match) throw new Error(`Unable to parse FTP PASV response: ${message}`);
  const [, a, b, c, d, p1, p2] = match;
  return { host: `${a}.${b}.${c}.${d}`, port: Number(p1) * 256 + Number(p2) };
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitPath(filePath: string) {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.pop();
  if (!file) throw new Error(`Invalid FTP file path: ${filePath}`);
  return { directory: parts.join("/"), file };
}

function candidateDirectories(filePath: string, configuredRoot?: string, missionDir?: string) {
  const { directory } = splitPath(filePath);
  const cleanRoot = normalizePath(configuredRoot || "");
  const candidates = [directory];
  if (cleanRoot) candidates.push(`${cleanRoot}/${directory}`);
  if (missionDir) {
    const mission = normalizePath(missionDir);
    if (directory === mission || directory.startsWith(`${mission}/`)) {
      candidates.push(directory);
    }
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

export async function uploadShopTextFileViaFtp(filePath: string, content: string, serverId = getActiveServerId()) {
  const config = getServerNitradoConfig(serverId);
  if (!config.ftp) throw new Error(`FTP nao configurado para o servidor ${serverId}.`);

  const { host, port, user, password, root } = config.ftp;
  const { file } = splitPath(filePath);
  const missionDir = getServerScopedSettings(serverId).dayzMissionDir;
  const directories = candidateDirectories(filePath, root, missionDir);
  const client = new FtpClient();
  let workingDirectory = "/";

  try {
    await client.connect(host, port);
    await client.login(user, password);
    workingDirectory = await client.pwd();

    const errors: string[] = [];
    for (const directory of directories) {
      try {
        console.log(`[nitrado-ftp] PWD=${workingDirectory}; trying CWD=${directory}`);
        await client.uploadInDirectory(directory, file, content);
        console.log(`[nitrado-ftp] upload succeeded: ${directory}/${file}`);
        return;
      } catch (error) {
        errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`FTP upload failed from PWD ${workingDirectory}. Attempts: ${errors.join(" | ")}`);
  } finally {
    await client.close();
  }
}
