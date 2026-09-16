import app from "./app";
import { logger } from "./lib/logger";
import { startDiscordBot } from "./lib/discordBot";
import { getPrimaryServerId } from "./lib/serverRegistry";
import {
  flushExecutableManagedServerStates,
  startManagedServerRuntimeScheduler,
} from "./lib/serverRuntimeCoordinator";

function formatMb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function logMemory(stage: string) {
  const memory = process.memoryUsage();
  const constrained = typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
  console.log("🧠 MEMORY", {
    stage,
    rss: formatMb(memory.rss),
    heapUsed: formatMb(memory.heapUsed),
    heapTotal: formatMb(memory.heapTotal),
    external: formatMb(memory.external),
    arrayBuffers: formatMb(memory.arrayBuffers),
    constrainedMemory: constrained ? formatMb(constrained) : "unknown",
  });
}

function installProcessDiagnostics() {
  process.on("unhandledRejection", (reason) => {
    console.error("💥 UNHANDLED REJECTION", reason);
    logMemory("unhandled-rejection");
  });

  process.on("uncaughtException", (error) => {
    console.error("💥 UNCAUGHT EXCEPTION", error);
    logMemory("uncaught-exception");
    // Let Render restart the process after a fatal exception instead of keeping
    // a potentially corrupted runtime alive.
    process.exitCode = 1;
  });

  process.on("exit", (code) => {
    console.log("🛑 PROCESS EXIT", { code });
    logMemory("process-exit");
  });
}

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
    void flushAndExit("SIGTERM");
  });

  process.once("SIGINT", () => {
    void flushAndExit("SIGINT");
  });
}

installProcessDiagnostics();
installStateFlushHooks();

let started = false;

function startServer(port: number) {
  if (started) return;
  started = true;

  const HOST = "0.0.0.0";
  logMemory("before-listen");

  const server = app.listen(port, HOST, () => {
    console.log("🌐 SERVER ONLINE");
    console.log(`🚀 Running on http://${HOST}:${port}`);
    logger.info({ port }, "Server listening");
    logMemory("http-listening");

    const primaryServerId = getPrimaryServerId();

    // Production boot must be cheap and deterministic. Database migrations,
    // registry hydration, Nitrado discovery and runtime activation are NOT boot
    // work. They are request/runtime work and must never be allowed to make the
    // HTTP process miss its resource budget during a deploy.
    //
    // The previous boot path executed all of those operations before Discord,
    // which meant one Render restart could trigger several DB scans, registry
    // materializations and state initializations at once. That is exactly the
    // wrong lifecycle boundary for a memory-constrained web service.
    setImmediate(() => {
      logMemory("post-listen-before-discord");
      try {
        console.log("🚀 iniciando bot do Discord multi-tenant...");
        void startDiscordBot(primaryServerId).catch((err) => {
          console.error("❌ erro assíncrono ao iniciar Discord:", err);
          logMemory("discord-start-failed");
        });
      } catch (err) {
        console.error("❌ erro ao iniciar Discord:", err);
        logMemory("discord-start-threw");
      }
    });

    // The scheduler is deliberately started independently of boot. It remains
    // the single owner of periodic tenant runtime execution and will only touch
    // state after the process is already healthy and serving HTTP.
    startManagedServerRuntimeScheduler();
    logMemory("scheduler-started");
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
