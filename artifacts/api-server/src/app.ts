import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import adminRoutes from "./routes/admin";
import adminPanelRoutes from "./routes/adminPanel";
import nitradoDiagnosticRoutes from "./routes/nitradoDiagnostic";
import { logger } from "./lib/logger";
import { recordNetworkTransfer } from "./lib/networkMetrics";
import authRoutes from "./routes/auth";
import playerPortalRoutes from "./routes/playerPortal";
import { attachPortalSession } from "./middlewares/portalAuth";
import { attachAdminSession } from "./middlewares/adminAuth";
import adminAuthRoutes from "./routes/adminAuth";

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

// Count bytes sent by this web service without buffering or changing responses.
// This is the closest in-app counterpart to Render HTTP Response bandwidth.
app.use((req, res, next) => {
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  (res as any).write = (chunk: any, ...args: any[]) => {
    if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return (originalWrite as any)(chunk, ...args);
  };

  (res as any).end = (chunk?: any, ...args: any[]) => {
    if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    recordNetworkTransfer({
      service: "http-responses",
      operation: `${req.method} ${req.path || req.url.split("?")[0]}`,
      direction: "http-response",
      bytes: responseBytes,
      ok: res.statusCode < 500,
    });
    return (originalEnd as any)(chunk, ...args);
  };
  next();
});

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  "/app-assets",
  express.static("assets/player-portal", {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

// Player and admin authentication are available to all following routes.
app.use(attachPortalSession);
app.use(attachAdminSession);

// Keep the current root behavior so the existing Render URL remains compatible.
app.get("/", (_req, res) => {
  res.send("ok");
});

// Player portal and Discord OAuth.
app.use("/api/auth", authRoutes);
app.use(playerPortalRoutes);

// 🔐 ADMIN PANEL
app.use("/admin", nitradoDiagnosticRoutes);
app.use("/admin", adminRoutes);
app.use("/admin-panel", adminAuthRoutes);
app.use("/admin-panel", adminPanelRoutes);

// API
app.use("/api", router);

export default app;
