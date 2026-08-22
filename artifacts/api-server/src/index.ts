import app from "./app";
import { logger } from "./lib/logger";
import { downloadADM, setAdmDownloadMode } from "./lib/nitradoDownloader";
import { getLeaderboard } from "./lib/parser";
import { startDiscordBot } from "./lib/discordBot";
import { flushStateAsync, getStateAsync } from "./lib/state";
import { initializeShopCatalog } from "./lib/shopCatalog";
import { recordMainCycleCompleted, recordMainCycleSkippedOverlap, recordMainCycleStarted } from "./lib/runtimeMetrics";
import { normalizeServiceSettings } from "./lib/serviceSettings";
import { getPrimaryServerId } from "./lib/serverRegistry";
import { getServerRuntimeContext, runInServerRuntimeContext, runWithServerRuntimeLock } from "./lib/serverRuntime";

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
async function runCycle(serverId = getPrimaryServerId()) {
  const locked = await runWithServerRuntimeLock(serverId, async () => runInServerRuntimeContext(serverId, async () => {
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
    await downloadADM(serverId);
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
  }));
  if (locked.skipped) {
    recordMainCycleSkippedOverlap();
    console.log(`⏭️ ciclo ignorado para ${serverId}: execução anterior ainda rodando`);
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
      const primaryServerId = getPrimaryServerId();
      const state = await runInServerRuntimeContext(primaryServerId, () => getStateAsync());
      const runtime = getServerRuntimeContext(primaryServerId);
      console.log(`🧭 runtime isolado: ${runtime.server.name} (${runtime.serverId})`);
      const settings = normalizeServiceSettings(state.serviceSettings);
      setAdmDownloadMode(settings.admDownloadMode);
      console.log(`📥 ADM download mode: ${settings.admDownloadMode}`);
    } catch (err) {
      console.error("❌ unable to initialize ADM download mode; using shadow:", err);
      setAdmDownloadMode("shadow");
    }

    try {
      await initializeShopCatalog();
      console.log("🛒 shop catalog loaded from Neon");
    } catch (err) {
      console.error("❌ shop catalog unavailable:", err);
    }

    await runCycle();

    try {
      console.log("🚀 iniciando bot do Discord...");
      startDiscordBot(getPrimaryServerId());
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
