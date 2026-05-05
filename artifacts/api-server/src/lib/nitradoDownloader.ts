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

    const admFiles = files.filter((f: any) => f.path.endsWith(".ADM"));

    if (!admFiles.length) {
      console.log("❌ Nenhum .ADM encontrado");
      return;
    }

    // 🔥 ORDENA POR DATA (mantém sua lógica)
    admFiles.sort((a: any, b: any) => {
      const getDate = (p: string) => {
        const match = p.match(/_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
        if (!match) return 0;

        return new Date(match[1] + "T" + match[2].replace(/-/g, ":")).getTime();
      };

      return getDate(b.path) - getDate(a.path);
    });

    // 🔥 PEGA OS 3 MAIS RECENTES
    const candidates = admFiles.slice(0, 3);

    console.log("📂 candidatos:");
    candidates.forEach((f: any) => console.log(f.path));

    // 🔥 BUSCA TAMANHO REAL E ESCOLHE O MAIOR
    let chosenFile: any = null;
    let biggestSize = 0;

    for (const file of candidates) {
      try {
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

        const fileRes = await fetch(finalUrl);
        const text = await fileRes.text();

        const size = text.length;

        console.log(`📏 ${file.path} → ${size}`);

        if (size > biggestSize) {
          biggestSize = size;
          chosenFile = { path: file.path, text };
        }
      } catch (err) {
        console.log("⚠️ erro ao testar arquivo:", file.path);
      }
    }

    if (!chosenFile) {
      console.log("❌ Nenhum arquivo válido encontrado");
      return;
    }

    console.log("📄 arquivo escolhido:", chosenFile.path);
    console.log("📏 tamanho arquivo:", chosenFile.text.length);

    fs.writeFileSync(OUTPUT, chosenFile.text);

    console.log("✅ ADM.log atualizado (arquivo ativo)");
  } catch (err) {
    console.error("❌ Erro no download:", err);
  }
}
