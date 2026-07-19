import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import adminRoutes from "./routes/admin";
import adminPanelRoutes from "./routes/adminPanel";
import { logger } from "./lib/logger";
import authRoutes from "./routes/auth";
import playerPortalRoutes from "./routes/playerPortal";
import { attachPortalSession } from "./middlewares/portalAuth";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.set("trust proxy", 1);
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/app-assets", express.static("assets/player-portal", { maxAge: "1h", etag: true }));

// Portal authentication is available to all following routes.
app.use(attachPortalSession);

// Keep the current root behavior so the existing Render URL remains compatible.
app.get("/", (_req, res) => {
  res.send("ok");
});

// Player portal and Discord OAuth.
app.use("/api/auth", authRoutes);
app.use(playerPortalRoutes);

// 🔐 ADMIN PANEL
app.use("/admin", adminRoutes);
app.use("/admin-panel", adminPanelRoutes);

// API
app.use("/api", router);

export default app;
