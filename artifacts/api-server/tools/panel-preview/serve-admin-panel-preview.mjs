#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || process.env.ADMIN_PANEL_PREVIEW_PORT || 4173);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function safePath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  const requested = pathname === "/" ? "/admin-panel-preview.html" : pathname;
  const normalized = normalize(requested).replace(/^([.][.][\/])+/, "");
  return join(__dirname, normalized);
}

const server = createServer(async (req, res) => {
  try {
    const filePath = safePath(req.url || "/");
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes.get(extname(filePath)) || "text/plain; charset=utf-8" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Arquivo nao encontrado.");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Admin panel preview: http://localhost:${port}`);
});
