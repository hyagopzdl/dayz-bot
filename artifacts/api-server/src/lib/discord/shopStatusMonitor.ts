import {
  autoDeployPendingShopOrdersIfNeeded,
  getShopResetMonitorPersistenceKey,
  pollShopResetStatusAndAutoClear,
} from "../shop";

type ShopStatusMonitorContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

export function startShopStatusMonitor(ctx: ShopStatusMonitorContext) {
  let running = false;

  return setInterval(
    async () => {
      if (running) return;

      running = true;

      try {
        const state = await ctx.getState();

        const deployResult = await autoDeployPendingShopOrdersIfNeeded(state);
        if (deployResult) {
          await ctx.saveState(state);
          console.log(
            `✅ SHOP_BOT auto-deploy completed: deployed=${deployResult.deployed} batch=${deployResult.batchId || "none"}`,
          );
        }

        const resetMonitorBefore = getShopResetMonitorPersistenceKey(state);
        const clearResult = await pollShopResetStatusAndAutoClear(state);
        const resetMonitorChanged =
          getShopResetMonitorPersistenceKey(state) !== resetMonitorBefore;

        if (clearResult || resetMonitorChanged) {
          await ctx.saveState(state);
        }

        if (clearResult) {
          console.log(
            `✅ SHOP_BOT auto-clear completed: cleared=${clearResult.cleared} cancelled=${clearResult.cancelled}`,
          );
        }
      } catch (err) {
        console.error("❌ erro no monitor de status da shop:", err);
      } finally {
        running = false;
      }
    },
    30 * 1000,
  );
}
