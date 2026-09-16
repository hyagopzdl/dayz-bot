import {
  downloadNitradoTextFile,
  uploadNitradoTextFile,
} from "./nitradoDownloader";
import { getServerRuntimeContext } from "./serverRuntime";

export async function downloadServerTextFile(filePath: string) {
  const runtime = getServerRuntimeContext();
  return downloadNitradoTextFile(filePath, runtime.serverId);
}

export async function uploadServerTextFile(filePath: string, content: string) {
  const runtime = getServerRuntimeContext();
  await uploadNitradoTextFile(filePath, content, runtime.serverId);
}
