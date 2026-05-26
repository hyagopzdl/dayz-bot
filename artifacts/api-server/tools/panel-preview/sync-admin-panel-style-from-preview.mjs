#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(toolsDir, "..");
const previewPath = join(toolsDir, "admin-panel-preview.html");
const adminPanelPath = join(apiRoot, "src", "routes", "adminPanel.ts");

const sharedStart = "/* ADMIN_PANEL_SHARED_STYLE_START */";
const sharedEnd = "/* ADMIN_PANEL_SHARED_STYLE_END */";

function extractBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) throw new Error(`${label}: marcador inicial nao encontrado.`);
  const contentStart = startIndex + start.length;
  const endIndex = source.indexOf(end, contentStart);
  if (endIndex === -1) throw new Error(`${label}: marcador final nao encontrado.`);
  return source.slice(contentStart, endIndex).trim();
}

const previewHtml = await readFile(previewPath, "utf8");
const sharedCss = extractBetween(previewHtml, sharedStart, sharedEnd, "preview");

const adminPanelTs = await readFile(adminPanelPath, "utf8");
const styleOpen = "  <style>";
const styleClose = "  </style>";
const openIndex = adminPanelTs.indexOf(styleOpen);
if (openIndex === -1) throw new Error("adminPanel.ts: tag <style> nao encontrada.");
const cssStart = openIndex + styleOpen.length;
const closeIndex = adminPanelTs.indexOf(styleClose, cssStart);
if (closeIndex === -1) throw new Error("adminPanel.ts: tag </style> nao encontrada.");

const next = `${adminPanelTs.slice(0, cssStart)}
${sharedCss}
${adminPanelTs.slice(closeIndex)}`;
await writeFile(adminPanelPath, next);
console.log("CSS do preview sincronizado em src/routes/adminPanel.ts");
