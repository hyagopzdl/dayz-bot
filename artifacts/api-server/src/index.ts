import app from "./app";
import { logger } from "./lib/logger";
import { startDiscordBot } from "./lib/discordBot";
import { getPrimaryServerId } from "./lib/serverRegistry";
import {
  hydrateServerNitradoSecretsFromDb,
  migratePrimaryNitradoCredentialToServerScope,
  normalizeManagedServerRuntimeConfig,
} from "./lib/serverNitradoMigration";
import {
  flushExecutableManagedServerStates,
  reconcileManagedServerRuntimeActivation,
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
    void flushAndExit("SIGTERM");
  });

  process.once("SIGINT", () => {
    void flushAndExit("SIGINT");
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

    // Keep registry migrations and secret hydration serialized. These operations
    // are database/bootstrap work and must not overlap the first runtime cycle.
    try {
      await normalizeManagedServerRuntimeConfig();
      await migratePrimaryNitradoCredentialToServerScope();
      await hydrateServerNitradoSecretsFromDb();
    } catch (err) {
      console.error("❌ unable to prepare server-scoped Nitrado registry:", err);
    }

    // The Discord control plane starts independently. It is responsible for its
    // own lazy state initialization; the HTTP boot path must not initialize the
    // same primary state a second time just to prepare the first runtime cycle.
    try {
      console.log("🚀 iniciando bot do Discord multi-tenant...");
      void startDiscordBot(primaryServerId);
    } catch (err) {
      console.error("❌ erro ao iniciar Discord:", err);
    }

    // Reconciliation only updates persisted runtime flags. Do not execute a full
    // ADM download/parser cycle during boot: the centralized scheduler will run
    // the first cycle after startup. This prevents two expensive initialization
    // paths from competing for memory/CPU immediately after a Render deploy.
    try {
      await reconcileManagedServerRuntimeActivation();
    } catch (err) {
      console.error("❌ erro reconciliando runtimes no startup:", err);
    }

    // One centralized scheduler for every tenant. There is intentionally no
    // immediate startup batch here. The first cycle is handled by the scheduler,
    // keeping startup memory bounded and avoiding an activation/deploy burst.
    startManagedServerRuntimeScheduler();
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