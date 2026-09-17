import {
  downloadNitradoTextFile,
  uploadNitradoTextFile,
} from "./nitradoDownloader";
import { uploadShopTextFileViaFtp } from "./nitradoFtpUpload";
import { getServerRuntimeContext } from "./serverRuntime";

export async function downloadServerTextFile(filePath: string) {
  const runtime = getServerRuntimeContext();
  return downloadNitradoTextFile(filePath, runtime.serverId);
}

export async function uploadServerTextFile(filePath: string, content: string) {
  const runtime = getServerRuntimeContext();
  let apiError: unknown;

  try {
    await uploadNitradoTextFile(filePath, content, runtime.serverId);
    return;
  } catch (error) {
    apiError = error;
    console.warn(
      `[nitrado-upload][${runtime.serverId}] File Server API upload failed for ${filePath}; trying configured FTP fallback.`,
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await uploadShopTextFileViaFtp(filePath, content, runtime.serverId);
    console.log(
      `[nitrado-upload][${runtime.serverId}] FTP fallback upload succeeded for ${filePath}.`,
    );
  } catch (ftpError) {
    const apiMessage = apiError instanceof Error ? apiError.message : String(apiError);
    const ftpMessage = ftpError instanceof Error ? ftpError.message : String(ftpError);
    throw new Error(
      `Nitrado upload failed via File Server API and FTP for ${filePath}. API: ${apiMessage}. FTP: ${ftpMessage}`,
    );
  }
}
