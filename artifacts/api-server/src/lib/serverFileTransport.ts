import {
  downloadNitradoTextFile,
  uploadNitradoTextFile,
} from "./nitradoDownloader";
import {
  downloadTextFile as downloadTextFileViaFtp,
  uploadTextFile as uploadTextFileViaFtp,
} from "./nitradoFtp";
import { getServerRuntimeContext } from "./serverRuntime";

export async function downloadServerTextFile(filePath: string) {
  const runtime = getServerRuntimeContext();
  if (runtime.isPrimary) {
    return downloadTextFileViaFtp(filePath);
  }
  return downloadNitradoTextFile(filePath, runtime.serverId);
}

export async function uploadServerTextFile(filePath: string, content: string) {
  const runtime = getServerRuntimeContext();
  if (runtime.isPrimary) {
    await uploadTextFileViaFtp(filePath, content);
    return;
  }
  await uploadNitradoTextFile(filePath, content, runtime.serverId);
}
