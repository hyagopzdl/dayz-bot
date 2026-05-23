import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import adminRoutes from "./routes/admin";
import adminPanelRoutes from "./routes/adminPanel";
import { logger } from "./lib/logger";

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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔥 ROTA PRINCIPAL
app.get("/", (_req, res) => {
  console.log("🔥 ROTA / OK");
  res.send("ok");
});

// 🔐 ADMIN PANEL
app.use("/admin", adminRoutes);
app.use("/admin-panel", adminPanelRoutes);

// API
app.use("/api", router);

export default app;
