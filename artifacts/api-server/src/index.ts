import app from "./app";
import { logger } from "./lib/logger";
import { downloadADM } from "./lib/nitradoDownloader";
import { getLeaderboard } from "./lib/parser";
import { startDiscordBot } from "./lib/discordBot";

let started = false;

function startServer(port: number) {
  if (started) return;
  started = true;

  const HOST = "0.0.0.0";

  const server = app.listen(port, HOST, async () => {
    console.log("🌐 SERVER ONLINE");
    console.log(`🚀 Running on http://${HOST}:${port}`);

    logger.info({ port }, "Server listening");

    // 🔥 primeira execução (protegida)
    try {
      await downloadADM();
      console.log("🔥 FORÇANDO PARSER AGORA:");
      getLeaderboard();
    } catch (err) {
      console.error("❌ erro na execução inicial:", err);
    }

    // 🔁 loop robusto (NUNCA MORRE)
    setInterval(async () => {
      console.log("🔁 LOOP PRINCIPAL RODANDO");

      try {
        await downloadADM();
      } catch (err) {
        console.error("❌ erro download:", err);
      }

      try {
        console.log("🔥 PARSER AUTOMÁTICO:");
        getLeaderboard();
      } catch (err) {
        console.error("❌ erro parser:", err);
      }
    }, 60 * 1000); // 1 minuto

    // 🤖 Discord
    try {
      console.log("🚀 iniciando bot do Discord...");
      startDiscordBot(getLeaderboard);
    } catch (err) {
      console.error("❌ erro ao iniciar Discord:", err);
    }
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      startServer(port + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

startServer(Number(process.env.PORT) || 3000);
