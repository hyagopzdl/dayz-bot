import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dayzItemImageAdminRouter from "./dayzItemImageAdmin";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin-panel/system/dayz-images", dayzItemImageAdminRouter);

export default router;
