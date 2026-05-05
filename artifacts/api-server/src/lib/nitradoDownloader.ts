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

    // 🔥 ORDENA POR DATA (mais recente primeiro)
    admFiles.sort((a: any, b: any) => {
      const getDate = (p: string) => {
        const match = p.match(/_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
        if (!match) return 0;

        return new Date(match[1] + "T" + match[2].replace(/-/g, ":")).getTime();
      };

      return getDate(b.path) - getDate(a.path);
    });

    // 🔥 ESCOLHE APENAS O MAIS RECENTE
    const chosenFile = admFiles[0];

    console.log("📄 arquivo escolhido:", chosenFile.path);

    const downloadRes = await fetch(
      `https://api.nitrado.net/services/${SERVICE_ID}/gameservers/file_server/download?file=${encodeURIComponent(chosenFile.path)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
        },
      },
    );

    const downloadJson = await downloadRes.json();
    const url = downloadJson?.data?.token?.url;

    if (!url) {
      console.log("❌ erro ao obter URL");
      return;
    }

    const finalUrl = `${url}&t=${Date.now()}`;

    const fileRes = await fetch(finalUrl);
    const text = await fileRes.text();

    if (!text || text.length < 50) {
      console.log("⚠️ Arquivo vazio ou inválido");
      return;
    }

    console.log("📏 tamanho arquivo:", text.length);

    // 🔥 salva o conteúdo
    fs.writeFileSync(OUTPUT, text);

    // 🔥 salva o nome do arquivo ativo
    fs.writeFileSync(CURRENT_FILE, chosenFile.path);

    console.log("✅ ADM.log atualizado (arquivo ativo)");
  } catch (err) {
    console.error("❌ Erro no download:", err);
  }
}
