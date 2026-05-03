import fs from "fs";
import path from "path";

const OUTPUT = path.resolve("ADM.log");

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

    if (!files) {
      console.log("❌ Não encontrou arquivos");
      console.log(listJson);
      return;
    }

    console.log("📂 arquivos encontrados:");
    files.forEach((f: any) => console.log(f.path));

    const admFiles = files.filter((f: any) => f.path.endsWith(".ADM"));

    if (!admFiles.length) {
      console.log("❌ Nenhum .ADM encontrado");
      return;
    }

    // 🔥 ORDENAÇÃO CORRETA POR DATA
    admFiles.sort((a: any, b: any) => {
      const getDate = (p: string) => {
        const match = p.match(/_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
        if (!match) return 0;

        return new Date(match[1] + "T" + match[2].replace(/-/g, ":")).getTime();
      };

      return getDate(b.path) - getDate(a.path);
    });

    const latest = admFiles[0];

    console.log("📄 Mais recente escolhido:", latest.path);

    const downloadRes = await fetch(
      `https://api.nitrado.net/services/${SERVICE_ID}/gameservers/file_server/download?file=${encodeURIComponent(latest.path)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
        },
      },
    );

    const downloadJson = await downloadRes.json();
    const url = downloadJson?.data?.token?.url;

    if (!url) {
      console.log("❌ Não conseguiu gerar URL");
      console.log(downloadJson);
      return;
    }

    console.log("🔗 Baixando arquivo real...");

    // 🔥 ANTI-CACHE (ESSENCIAL)
    const finalUrl = `${url}&t=${Date.now()}`;

    const fileRes = await fetch(finalUrl);
    const text = await fileRes.text();

    if (!text || text.length < 50) {
      console.log("⚠️ Arquivo suspeito ou vazio");
      console.log(text);
      return;
    }

    fs.writeFileSync(OUTPUT, text);

    console.log("📏 tamanho arquivo:", text.length);
    console.log("✅ ADM.log atualizado (mais recente REAL)");
  } catch (err) {
    console.error("❌ Erro no download:", err);
  }
}
