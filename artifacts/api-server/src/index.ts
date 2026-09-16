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

    // Keep all database bootstrap work serialized before starting Discord.
    // Discord's ready handler calls getStateAsync(); starting it before
    // reconciliation allowed two cold state initializations to overlap and
    // temporarily materialize multiple copies of the primary state in memory.
    try {
      await normalizeManagedServerRuntimeConfig();
      await migratePrimaryNitradoCredentialToServerScope();
      await hydrateServerNitradoSecretsFromDb();

      // Reconciliation can initialize/read runtime state as part of activation
      // checks, so it must complete before Discord is allowed to call getStateAsync.
      await reconcileManagedServerRuntimeActivation();
    } catch (err) {
      console.error("❌ unable to prepare server-scoped registry/runtime startup:", err);
    }

    // Start Discord only after the DB/registry bootstrap and reconciliation are
    // complete. This prevents concurrent cold state loads during Render boot.
    try {
      console.log("🚀 iniciando bot do Discord multi-tenant...");
      void startDiscordBot(primaryServerId);
    } catch (err) {
      console.error("❌ erro ao iniciar Discord:", err);
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
