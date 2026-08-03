import app from "./app";
import { logger } from "./lib/logger";
import { downloadADM } from "./lib/nitradoDownloader";
import { getLeaderboard } from "./lib/parser";
import { startDiscordBot } from "./lib/discordBot";
import { flushStateAsync } from "./lib/state";
import { initializeShopCatalog } from "./lib/shopCatalog";
import { recordMainCycleCompleted, recordMainCycleSkippedOverlap, recordMainCycleStarted } from "./lib/runtimeMetrics";

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
    recordMainCycleSkippedOverlap();
    console.log("⏭️ ciclo ignorado: execução anterior ainda rodando");
    return;
  }

  cycleRunning = true;
  recordMainCycleStarted();
  const startedAt = new Date().toISOString();
  const cycleStarted = Date.now();
  let downloadDurationMs = 0;
  let parserDurationMs = 0;
  let downloadOk = true;
  let parserOk = true;
  console.log("🔁 LOOP PRINCIPAL");

  const downloadStarted = Date.now();
  try {
    await downloadADM();
  } catch (err) {
    downloadOk = false;
    console.error("❌ erro download:", err);
  } finally {
    downloadDurationMs = Date.now() - downloadStarted;
  }

  const parserStarted = Date.now();
  try {
    console.log("🔥 PARSER AUTOMÁTICO");
    await getLeaderboard();
  } catch (err) {
    parserOk = false;
    console.error("❌ erro parser:", err);
  } finally {
    parserDurationMs = Date.now() - parserStarted;
    cycleRunning = false;
    recordMainCycleCompleted({
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - cycleStarted,
      downloadDurationMs,
      parserDurationMs,
      downloadOk,
      parserOk,
    });
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

    try {
      await initializeShopCatalog();
      console.log("🛒 shop catalog loaded from Neon");
    } catch (err) {
      console.error("❌ shop catalog unavailable:", err);
    }

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
