import app from "./app";
import { logger } from "./lib/logger";
import { startDiscordBot } from "./lib/discordBot";
import { installNitradoHttpTransport } from "./lib/nitradoHttpTransport";
import { flushExecutableManagedServerStates, startManagedServerRuntimeScheduler } from "./lib/serverRuntimeCoordinator";
import { refreshManagedServerRegistryFromDb } from "./lib/state";

function formatMb(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function logMemory(stage: string) {
  const memory = process.memoryUsage();
  const constrained = typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
  console.log("🧠 MEMORY", { stage, rss: formatMb(memory.rss), heapUsed: formatMb(memory.heapUsed), heapTotal: formatMb(memory.heapTotal), external: formatMb(memory.external), arrayBuffers: formatMb(memory.arrayBuffers), constrainedMemory: constrained ? formatMb(constrained) : "unknown" });
}
function installProcessDiagnostics() {
  process.on("unhandledRejection", (reason) => { console.error("💥 UNHANDLED REJECTION", reason); logMemory("unhandled-rejection"); });
  process.on("uncaughtException", (error) => { console.error("💥 UNCAUGHT EXCEPTION", error); logMemory("uncaught-exception"); process.exitCode = 1; });
  process.on("exit", (code) => { console.log("🛑 PROCESS EXIT", { code }); logMemory("process-exit"); });
}
function installStateFlushHooks() {
  let flushing = false;
  async function flushAndExit(signal: string) {
    if (flushing) return;
    flushing = true;
    try { console.log(`💾 flush final do state antes de ${signal}`); await flushExecutableManagedServerStates(); }
    catch (err) { console.error("❌ erro no flush final do state:", err); }
    finally { process.exit(0); }
  }
  process.once("SIGTERM", () => { void flushAndExit("SIGTERM"); });
  process.once("SIGINT", () => { void flushAndExit("SIGINT"); });
}
installProcessDiagnostics();
installStateFlushHooks();
installNitradoHttpTransport();
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

    setImmediate(() => {
      logMemory("post-listen-before-discord");
      void refreshManagedServerRegistryFromDb()
        .then(() => {
          const registry = require("./lib/serverRegistry") as typeof import("./lib/serverRegistry");
          console.log("🗂️ SERVER REGISTRY HYDRATED", {
            managedServers: registry.listManagedServers().length,
            registry: registry.getServerRegistryPersistenceStatus(),
            namespace: registry.getServerNamespacePersistenceStatus(),
          });
        })
        .catch((err) => {
          console.error("❌ erro ao hidratar registry multi-tenant no startup:", err);
        })
        .finally(() => {
          logMemory("post-registry-before-discord");
          try {
            console.log("🚀 iniciando bot do Discord multi-tenant...");
            void startDiscordBot().catch((err) => { console.error("❌ erro assíncrono ao iniciar Discord:", err); logMemory("discord-start-failed"); });
          } catch (err) { console.error("❌ erro ao iniciar Discord:", err); logMemory("discord-start-threw"); }
        });
    });

    startManagedServerRuntimeScheduler();
    logMemory("scheduler-started");
  });
  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") { started = false; startServer(port + 1); }
    else { console.error(err); process.exit(1); }
  });
}
startServer(Number(process.env.PORT) || 3000);
