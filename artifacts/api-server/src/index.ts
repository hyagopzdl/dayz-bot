import app from "./app";
import { logger } from "./lib/logger";
import { downloadADM } from "./lib/nitradoDownloader";
import { getLeaderboard } from "./lib/parser";
import { startDiscordBot } from "./lib/discordBot";
import { flushStateAsync } from "./lib/state";

function installStateFlushHooks() {
  let flushing = false;

  async function flushAndExit(signal: string) {
    if (flushing) return;
    flushing = true;

    try {
      console.log(`💾 flush final do state antes de ${signal}`);
      await flushStateAsync();
    } catch (err) {
      console.error("❌ erro no flush final do state:", err);
    } finally {
      process.exit(0);
    }
  }

  process.once("SIGTERM", () => {
    flushAndExit("SIGTERM");
  });

  process.once("SIGINT", () => {
    flushAndExit("SIGINT");
  });
}

installStateFlushHooks();

let started = false;
let cycleRunning = false;

async function runCycle() {
  if (cycleRunning) {
    console.log("⏭️ ciclo ignorado: execução anterior ainda rodando");
    return;
  }

  cycleRunning = true;
  console.log("🔁 LOOP PRINCIPAL");

  try {
    await downloadADM();
  } catch (err) {
    console.error("❌ erro download:", err);
  }

  try {
    console.log("🔥 PARSER AUTOMÁTICO");
    await getLeaderboard();
  } catch (err) {
    console.error("❌ erro parser:", err);
  } finally {
    cycleRunning = false;
  }
}

function startServer(port: number) {
  if (started) return;
  started = true;

  const HOST = "0.0.0.0";

  const server = app.listen(port, HOST, async () => {
    console.log("🌐 SERVER ONLINE");
    console.log(`🚀 Running on http://${HOST}:${port}`);

    logger.info({ port }, "Server listening");

    await runCycle();

    try {
      console.log("🚀 iniciando bot do Discord...");
      startDiscordBot();
    } catch (err) {
      console.error("❌ erro ao iniciar Discord:", err);
    }
  });

  setInterval(
    () => {
      runCycle().catch((err) => {
        console.error("❌ erro fatal no ciclo:", err);
      });
    },
    5 * 60 * 1000,
  );

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      started = false;
      startServer(port + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

startServer(Number(process.env.PORT) || 3000);
