import app from "./app";
import { logger } from "./lib/logger";
import { setAdmDownloadMode } from "./lib/nitradoDownloader";
import { startDiscordBot } from "./lib/discordBot";
import { getStateAsync } from "./lib/state";
import { initializeShopCatalog } from "./lib/shopCatalog";
import { normalizeServiceSettings } from "./lib/serviceSettings";
import { getPrimaryServerId } from "./lib/serverRegistry";
import { getServerRuntimeContext, runInServerRuntimeContext } from "./lib/serverRuntime";
import {
  flushExecutableManagedServerStates,
  runManagedServerRuntimeBatch,
  runManagedServerRuntimeCycle,
  startManagedServerRuntimeScheduler,
} from "./lib/serverRuntimeCoordinator";

function installStateFlushHooks() {
  let flushing = false;

  async function flushAndExit(signal: string) {
    if (flushing) return;
    flushing = true;

    try {
      console.log(`💾 flush final do state antes de ${signal}`);
      await flushExecutableManagedServerStates();
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

function startServer(port: number) {
  if (started) return;
  started = true;

  const HOST = "0.0.0.0";

  const server = app.listen(port, HOST, async () => {
    console.log("🌐 SERVER ONLINE");
    console.log(`🚀 Running on http://${HOST}:${port}`);

    logger.info({ port }, "Server listening");
    const primaryServerId = getPrimaryServerId();

    try {
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

    // Keep the production PZ startup path first. A newly activated secondary
    // may need a larger one-time ADM download and must never delay PZ Discord.
    await runManagedServerRuntimeCycle(primaryServerId, "startup");
    startManagedServerRuntimeScheduler();

    try {
      console.log("🚀 iniciando bot do Discord...");
      startDiscordBot(primaryServerId);
    } catch (err) {
      console.error("❌ erro ao iniciar Discord:", err);
    }

    // Resume already-activated secondary runtimes without blocking the primary
    // startup. They still run sequentially under the same centralized coordinator.
    runManagedServerRuntimeBatch("startup", { includePrimary: false }).catch((err) => {
      console.error("❌ erro iniciando runtimes secundarios:", err);
    });
  });

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
