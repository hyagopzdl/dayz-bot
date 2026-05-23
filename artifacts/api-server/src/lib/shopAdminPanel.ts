import { IncomingMessage, ServerResponse } from "http";
import {
  deleteShopCatalogItem,
  ensureShopCatalogFile,
  getShopCatalog,
  saveShopCatalog,
  upsertShopCatalogItem,
  type ShopItem,
} from "./shopCatalog";

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requireAdminToken(url: URL) {
  const configured = process.env.SHOP_ADMIN_TOKEN;
  if (!configured) return true;
  return url.searchParams.get("token") === configured;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(body: string) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

export async function renderShopAdminPanel(message = "") {
  const catalog = getShopCatalog();
  const catalogFile = ensureShopCatalogFile();
  const rows = catalog.items
    .map(
      (item) => `
        <tr>
          <td><code>${htmlEscape(item.id)}</code></td>
          <td>${htmlEscape(item.name)}</td>
          <td><code>${htmlEscape(item.className)}</code></td>
          <td>${htmlEscape(item.category || "misc")}</td>
          <td>${htmlEscape(item.price)}</td>
          <td>${item.enabled === false ? "Disabled" : "Enabled"}</td>
          <td>${item.imageUrl ? `<img src="${htmlEscape(item.imageUrl)}" alt="${htmlEscape(item.name)}" />` : "—"}</td>
        </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DayZ Shop Admin</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; margin: 24px; background: #0f1115; color: #f4f4f5; }
    .card { background: #181b22; border: 1px solid #2b303b; border-radius: 16px; padding: 20px; margin-bottom: 20px; }
    input, textarea, select { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 6px; border-radius: 10px; border: 1px solid #343a46; background: #0f1115; color: #f4f4f5; }
    label { display: block; margin: 12px 0; color: #d4d4d8; }
    button { padding: 10px 14px; border: 0; border-radius: 10px; background: #22c55e; color: #07130a; font-weight: 700; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid #2b303b; text-align: left; vertical-align: middle; }
    img { width: 64px; height: 64px; object-fit: cover; border-radius: 10px; }
    code { background: #0f1115; padding: 2px 6px; border-radius: 6px; }
    .muted { color: #a1a1aa; }
    .message { background: #052e16; border: 1px solid #16a34a; color: #dcfce7; padding: 10px; border-radius: 10px; }
  </style>
</head>
<body>
  <h1>🛒 DayZ Shop Admin</h1>
  <p class="muted">Catalog file: <code>${htmlEscape(catalogFile)}</code></p>
  ${message ? `<p class="message">${htmlEscape(message)}</p>` : ""}

  <div class="card">
    <h2>Add / update item</h2>
    <form method="post" action="/admin/shop/catalog/item">
      <label>Item ID <input name="id" placeholder="barrel_red" required /></label>
      <label>Store name <input name="name" placeholder="Barril Vermelho" required /></label>
      <label>DayZ className <input name="className" placeholder="Barrel_Red" required /></label>
      <label>Category <input name="category" placeholder="containers" required /></label>
      <label>Price <input name="price" type="number" min="0" step="1" value="0" required /></label>
      <label>Image URL <input name="imageUrl" placeholder="https://..." /></label>
      <label>Description <textarea name="description" rows="3" placeholder="Delivered on next restart."></textarea></label>
      <label>Status
        <select name="enabled">
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </label>
      <button type="submit">Save item</button>
    </form>
  </div>

  <div class="card">
    <h2>Current catalog</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>Name</th><th>Class</th><th>Category</th><th>Price</th><th>Status</th><th>Image</th></tr>
      </thead>
      <tbody>${rows || "<tr><td colspan=\"7\">No items yet.</td></tr>"}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>Raw JSON</h2>
    <form method="post" action="/admin/shop/catalog/raw">
      <textarea name="catalog" rows="18">${htmlEscape(JSON.stringify(catalog, null, 2))}</textarea>
      <button type="submit">Save raw catalog</button>
    </form>
  </div>
</body>
</html>`;
}

export async function handleShopAdminRequest(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);

  if (!requireAdminToken(url)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unauthorized");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/shop") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await renderShopAdminPanel());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/shop/catalog.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(getShopCatalog(), null, 2));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/shop/catalog/item") {
    const form = parseForm(await readBody(req));
    const item = await upsertShopCatalogItem({
      id: form.id,
      name: form.name,
      className: form.className,
      category: form.category,
      price: Number(form.price || 0),
      imageUrl: form.imageUrl,
      description: form.description,
      enabled: form.enabled !== "false",
    } as ShopItem);

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await renderShopAdminPanel(`Saved ${item.name}.`));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/shop/catalog/raw") {
    const form = parseForm(await readBody(req));
    const catalog = JSON.parse(String(form.catalog || "{}"));
    throw new Error("Raw local catalog editing is disabled after Neon catalog migration.");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await renderShopAdminPanel("Raw catalog saved."));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/shop/catalog/delete") {
    const form = parseForm(await readBody(req));
    const deleted = await deleteShopCatalogItem(String(form.id || ""));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await renderShopAdminPanel(deleted ? "Item deleted." : "Item not found."));
    return true;
  }

  return false;
}

export function registerShopAdminRoutes(app: {
  get?: Function;
  post?: Function;
}) {
  app.get?.("/admin/shop", async (_request: unknown, reply: any) => {
    reply.type?.("text/html");
    return renderShopAdminPanel();
  });

  app.get?.("/admin/shop/catalog.json", async () => getShopCatalog());

  app.post?.("/admin/shop/catalog/item", async (request: any) => {
    return upsertShopCatalogItem(request.body as ShopItem);
  });
}
