import fs from "fs";
import path from "path";

const OUTPUT = path.resolve("ADM.log");
const CURRENT_FILE = path.resolve("currentFile.txt");

const SERVICE_ID = "19149785";
const BASE_DIR = "/games/ni13029176_1/noftp/dayzps/config";

export async function downloadADM() {
  try {
    console.log("📂 Listando arquivos...");

    const listRes = await fetch(
      `https://api.nitrado.net/services/${SERVICE_ID}/gameservers/file_server/list?dir=${encodeURIComponent(BASE_DIR)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
        },
      },
    );

    const listJson = await listRes.json();
    const files = listJson?.data?.entries;

    if (!files) return;

    const admFiles = files.filter((f: any) => f.path.endsWith(".ADM"));

    if (!admFiles.length) return;

    // 🔥 ordena por data
    admFiles.sort((a: any, b: any) => {
      const getDate = (p: string) => {
        const match = p.match(/_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
        if (!match) return 0;

        return new Date(match[1] + "T" + match[2].replace(/-/g, ":")).getTime();
      };

      return getDate(b.path) - getDate(a.path);
    });

    const candidates = admFiles.slice(0, 3);

    console.log("📂 candidatos:");
    candidates.forEach((f: any) => console.log(f.path));

    // 🔥 lê arquivo atual
    let currentFile = "";
    try {
      currentFile = fs.readFileSync(CURRENT_FILE, "utf-8");
    } catch {}

    // 🔥 se ainda existe → continua usando
    const stillExists = candidates.find((f) => f.path === currentFile);

    if (stillExists) {
      console.log("📌 mantendo arquivo atual:", currentFile);
      return; // 🔥 não troca
    }

    // 🔥 senão escolhe o maior (uma única vez)
    let chosenFile: any = null;
    let biggestSize = 0;

    for (const file of candidates) {
      const downloadRes = await fetch(
        `https://api.nitrado.net/services/${SERVICE_ID}/gameservers/file_server/download?file=${encodeURIComponent(file.path)}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
          },
        },
      );

      const downloadJson = await downloadRes.json();
      const url = downloadJson?.data?.token?.url;

      if (!url) continue;

      const finalUrl = `${url}&t=${Date.now()}`;
      const text = await (await fetch(finalUrl)).text();

      const size = text.length;

      console.log(`📏 ${file.path} → ${size}`);

      if (size > biggestSize) {
        biggestSize = size;
        chosenFile = { path: file.path, text };
      }
    }

    if (!chosenFile) return;

    console.log("📄 novo arquivo escolhido:", chosenFile.path);

    fs.writeFileSync(OUTPUT, chosenFile.text);
    fs.writeFileSync(CURRENT_FILE, chosenFile.path);

    console.log("✅ arquivo atualizado");
  } catch (err) {
    console.error("❌ erro:", err);
  }
}
