const NITRADO_API_HOST = "api.nitrado.net";
const RATE_LIMIT_COOLDOWN_MS = 180_000;
const MAX_DIAGNOSTIC_BODY = 320;

let blockedUntil = 0;
let requestTail: Promise<void> = Promise.resolve();

export class NitradoRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfter?: string;
  readonly cfRay?: string;
  readonly contentType?: string;

  constructor(details: { retryAfter?: string; cfRay?: string; contentType?: string }) {
    const retryAfter = details.retryAfter ? ` retry-after=${details.retryAfter}` : "";
    const cfRay = details.cfRay ? ` cf-ray=${details.cfRay}` : "";
    const contentType = details.contentType ? ` content-type=${details.contentType}` : "";
    super(`Nitrado API rate limited by upstream (HTTP 429).${retryAfter}${cfRay}${contentType}`);
    this.name = "NitradoRateLimitError";
    this.retryAfter = details.retryAfter;
    this.cfRay = details.cfRay;
    this.contentType = details.contentType;
  }
}

function isNitradoApiUrl(url: string) {
  try {
    return new URL(url).hostname === NITRADO_API_HOST;
  } catch {
    return false;
  }
}

function requestLabel(url: string, init: RequestInit) {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Keep the original URL only as a last-resort diagnostic.
  }
  return `${String(init.method || "GET").toUpperCase()} ${pathname}`;
}

function safePreview(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_BODY);
}

function cooldownFromRetryAfter(value: string | null) {
  if (!value) return RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(RATE_LIMIT_COOLDOWN_MS, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(RATE_LIMIT_COOLDOWN_MS, date - Date.now());
  return RATE_LIMIT_COOLDOWN_MS;
}

function acquireSlot() {
  const previous = requestTail;
  let release!: () => void;
  requestTail = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(() => release);
}

export function installNitradoHttpTransport() {
  const globalScope = globalThis as typeof globalThis & { __dayzNitradoTransportInstalled?: boolean };
  if (globalScope.__dayzNitradoTransportInstalled) return;
  globalScope.__dayzNitradoTransportInstalled = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  // RequestInfo is not exposed by the project's Node/TypeScript lib target.
  // Keep the fetch input compatible with Node's runtime Request implementation
  // without depending on the browser-only RequestInfo alias.
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!isNitradoApiUrl(url)) return originalFetch(input, init);

    const requestInit: RequestInit = { ...(init || {}) };
    const headers = new Headers(requestInit.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (!headers.has("user-agent")) headers.set("user-agent", "DayZ-Bot-NitradoClient/1.0");
    requestInit.headers = headers;

    const release = await acquireSlot();
    const label = requestLabel(url, requestInit);
    const startedAt = Date.now();

    try {
      const remaining = blockedUntil - Date.now();
      if (remaining > 0) {
        throw new NitradoRateLimitError({
          retryAfter: `${Math.ceil(remaining / 1000)}s`,
        });
      }

      console.log(`🌐 NITRADO HTTP → ${label}`);
      const response = await originalFetch(input, requestInit);
      const durationMs = Date.now() - startedAt;
      const contentType = response.headers.get("content-type") || undefined;
      const server = response.headers.get("server") || undefined;
      const cfRay = response.headers.get("cf-ray") || undefined;
      const retryAfter = response.headers.get("retry-after") || undefined;
      const cfCacheStatus = response.headers.get("cf-cache-status") || undefined;
      const contentLength = response.headers.get("content-length") || undefined;

      console.log("🌐 NITRADO HTTP ←", {
        label,
        status: response.status,
        durationMs,
        contentType,
        contentLength,
        server,
        cfRay,
        cfCacheStatus,
        retryAfter,
      });

      if (response.status === 429) {
        const cooldownMs = cooldownFromRetryAfter(retryAfter || null);
        blockedUntil = Math.max(blockedUntil, Date.now() + cooldownMs);
        let preview = "";
        try {
          preview = safePreview(await response.clone().text());
        } catch {
          preview = "<unable to read upstream response body>";
        }
        console.error("🚧 NITRADO RATE LIMIT", {
          label,
          status: response.status,
          cooldownMs,
          retryAfter,
          cfRay,
          contentType,
          server,
          bodyPreview: preview,
        });
        throw new NitradoRateLimitError({ retryAfter, cfRay, contentType });
      }

      if (!response.ok && contentType?.toLowerCase().includes("text/html")) {
        let preview = "";
        try {
          preview = safePreview(await response.clone().text());
        } catch {
          preview = "<unable to read upstream response body>";
        }
        console.warn("⚠️ NITRADO NON-JSON ERROR RESPONSE", { label, status: response.status, contentType, cfRay, server, bodyPreview: preview });
      }

      return response;
    } catch (error) {
      console.error("❌ NITRADO HTTP TRANSPORT ERROR", { label, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      release();
    }
  }) as typeof globalThis.fetch;

  console.log("🛡️ Nitrado HTTP transport installed: serialized API requests + 429 cooldown + response diagnostics");
}
