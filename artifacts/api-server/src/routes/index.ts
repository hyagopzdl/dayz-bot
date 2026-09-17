import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dayzItemOverridesRouter from "./dayzItemOverrides";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin-panel", dayzItemOverridesRouter);

export default router;
